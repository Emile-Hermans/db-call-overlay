using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Data.Common;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text;
using System.Threading;

namespace DbProbe
{
    internal static class Probe
    {
        private const string HDR_ACTION = "X-DbProbe-Action";
        private const string HDR_LABEL = "X-DbProbe-Label";
        private const string HDR_KIND = "X-DbProbe-Kind";

        private static readonly AsyncLocal<ReqScope> _current = new AsyncLocal<ReqScope>();
        private static readonly ConcurrentDictionary<string, ReqScope> _byTrace = new ConcurrentDictionary<string, ReqScope>();
        private static readonly ConcurrentDictionary<Guid, PendingCommand> _pending = new ConcurrentDictionary<Guid, PendingCommand>();
        private static readonly ConditionalWeakTable<object, object> _efOwned = new ConditionalWeakTable<object, object>();

        private static string _app;
        private static int _pid;
        private static bool _captureParams = true;
        private static bool _rawSql;
        private static int _sqlMaxChars = 20000;
        private static long _seq;

        public static void Start(string friendlyName)
        {
            _app = Clean(friendlyName);
            _pid = Process.GetCurrentProcess().Id;
            _captureParams = Emitter.Env("DBPROBE_PARAMS", "on") != "off";
            _rawSql = Emitter.Env("DBPROBE_RAWSQL", "off") == "on";
            _sqlMaxChars = Emitter.EnvInt("DBPROBE_SQL_MAX", 20000);

            StackCapture.Configure();

            var hello = new Jsonw()
                .Str("kind", "hello")
                .Str("app", _app)
                .Num("pid", _pid)
                .Num("ts", Emitter.NowMs())
                .Str("probeVersion", "1.0")
                .ToString();

            Emitter.Start(
                Emitter.Env("DBPROBE_HOST", "127.0.0.1"),
                Emitter.EnvInt("DBPROBE_PORT", 8477),
                hello);

            DiagnosticListener.AllListeners.Subscribe(new ListenerObserver());
        }

        // ---------------------------------------------------------------- listeners

        private sealed class ListenerObserver : IObserver<DiagnosticListener>
        {
            public void OnNext(DiagnosticListener listener)
            {
                try
                {
                    switch (listener.Name)
                    {
                        case "Microsoft.AspNetCore":
                            listener.Subscribe(new EventObserver(OnAspNet));
                            break;
                        case "Microsoft.EntityFrameworkCore":
                            listener.Subscribe(new EventObserver(OnEf));
                            break;
                        case "SqlClientDiagnosticListener":
                            if (_rawSql)
                            {
                                listener.Subscribe(new EventObserver(OnSqlClient));
                            }
                            break;
                    }
                }
                catch
                {
                }
            }

            public void OnCompleted()
            {
            }

            public void OnError(Exception error)
            {
            }
        }

        private sealed class EventObserver : IObserver<KeyValuePair<string, object>>
        {
            private readonly Action<string, object> _handler;

            public EventObserver(Action<string, object> handler)
            {
                _handler = handler;
            }

            public void OnNext(KeyValuePair<string, object> evt)
            {
                try
                {
                    _handler(evt.Key, evt.Value);
                }
                catch
                {
                }
            }

            public void OnCompleted()
            {
            }

            public void OnError(Exception error)
            {
            }
        }

        // ---------------------------------------------------------------- ASP.NET

        private static void OnAspNet(string key, object value)
        {
            switch (key)
            {
                case "Microsoft.AspNetCore.Hosting.HttpRequestIn.Start":
                    RequestStart(HttpContextOf(value));
                    break;

                case "Microsoft.AspNetCore.Hosting.HttpRequestIn.Stop":
                    RequestStop(HttpContextOf(value));
                    break;

                case "Microsoft.AspNetCore.Mvc.BeforeAction":
                    var scope = Current();
                    if (scope != null)
                    {
                        var descriptor = Reflect.Get(value, "actionDescriptor") ?? Reflect.Get(value, "ActionDescriptor");
                        var display = Reflect.GetString(descriptor, "DisplayName");
                        scope.Handler = ShortenHandler(display);
                    }
                    break;
            }
        }

        private static object HttpContextOf(object payload)
        {
            if (payload == null)
            {
                return null;
            }
            var ctx = Reflect.Get(payload, "HttpContext") ?? Reflect.Get(payload, "httpContext");
            return ctx ?? payload;
        }

        private static void RequestStart(object httpContext)
        {
            if (httpContext == null)
            {
                return;
            }

            var scope = new ReqScope
            {
                Id = NextId("r"),
                StartedMs = Emitter.NowMs(),
                Method = Reflect.GetString(httpContext, "Request", "Method"),
                Path = Reflect.GetString(httpContext, "Request", "Path"),
                Query = Reflect.GetString(httpContext, "Request", "QueryString")
            };

            scope.ActionId = Reflect.Header(httpContext, HDR_ACTION);
            scope.ActionLabel = DecodeLabel(Reflect.Header(httpContext, HDR_LABEL));
            scope.ActionKind = Reflect.Header(httpContext, HDR_KIND);

            if (string.IsNullOrEmpty(scope.ActionId))
            {
                ReadActionFromQuery(scope);
            }

            _current.Value = scope;

            var root = RootActivityId();
            if (root != null)
            {
                scope.TraceKey = root;
                _byTrace[root] = scope;
            }

            Emitter.Send(new Jsonw()
                .Str("kind", "req")
                .Str("id", scope.Id)
                .Str("app", _app)
                .Num("pid", _pid)
                .Num("ts", scope.StartedMs)
                .Str("method", scope.Method)
                .Str("path", scope.Path)
                .Str("actionId", scope.ActionId)
                .Str("actionLabel", scope.ActionLabel)
                .Str("actionKind", scope.ActionKind)
                .ToString());
        }

        private static void RequestStop(object httpContext)
        {
            var scope = Current();
            if (scope == null || scope.Ended)
            {
                return;
            }
            scope.Ended = true;

            var status = 0;
            var raw = Reflect.Get(httpContext, "Response", "StatusCode");
            if (raw != null)
            {
                int.TryParse(raw.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out status);
            }

            Emitter.Send(new Jsonw()
                .Str("kind", "reqend")
                .Str("id", scope.Id)
                .Num("ts", Emitter.NowMs())
                .Num("durationMs", Emitter.NowMs() - scope.StartedMs)
                .Num("status", status)
                .Str("handler", scope.Handler)
                .ToString());

            if (scope.TraceKey != null)
            {
                ReqScope removed;
                _byTrace.TryRemove(scope.TraceKey, out removed);
            }
        }

        private static void ReadActionFromQuery(ReqScope scope)
        {
            var q = scope.Query;
            if (string.IsNullOrEmpty(q))
            {
                return;
            }

            foreach (var pair in q.TrimStart('?').Split('&'))
            {
                var eq = pair.IndexOf('=');
                if (eq <= 0)
                {
                    continue;
                }
                var name = pair.Substring(0, eq);
                var val = Uri.UnescapeDataString(pair.Substring(eq + 1));

                if (name == "_dbact")
                {
                    scope.ActionId = val;
                }
                else if (name == "_dblbl")
                {
                    scope.ActionLabel = val;
                }
            }
        }

        private static string DecodeLabel(string encoded)
        {
            if (string.IsNullOrEmpty(encoded))
            {
                return null;
            }
            try
            {
                return Encoding.UTF8.GetString(Convert.FromBase64String(encoded));
            }
            catch
            {
                return encoded;
            }
        }

        private static ReqScope Current()
        {
            var scope = _current.Value;
            if (scope != null)
            {
                return scope;
            }

            var root = RootActivityId();
            if (root != null && _byTrace.TryGetValue(root, out scope))
            {
                return scope;
            }
            return null;
        }

        private static string RootActivityId()
        {
            var activity = Activity.Current;
            if (activity == null)
            {
                return null;
            }
            if (activity.IdFormat == ActivityIdFormat.W3C)
            {
                return activity.TraceId.ToHexString();
            }
            return activity.RootId ?? activity.Id;
        }

        // ---------------------------------------------------------------- EF Core

        private static void OnEf(string key, object value)
        {
            switch (key)
            {
                case "Microsoft.EntityFrameworkCore.Database.Command.CommandExecuting":
                    CommandExecuting(value);
                    break;

                case "Microsoft.EntityFrameworkCore.Database.Command.CommandExecuted":
                    CommandFinished(value, null);
                    break;

                case "Microsoft.EntityFrameworkCore.Database.Command.CommandError":
                    CommandFinished(value, Reflect.GetString(Reflect.Get(value, "Exception"), "Message") ?? "error");
                    break;

                case "Microsoft.EntityFrameworkCore.Database.Command.DataReaderDisposing":
                    ReaderDisposing(value);
                    break;

                case "Microsoft.EntityFrameworkCore.Update.SaveChangesCompleted":
                    SaveChangesCompleted(value);
                    break;
            }
        }

        private static void CommandExecuting(object payload)
        {
            var command = Reflect.Get(payload, "Command") as DbCommand;
            if (command == null)
            {
                return;
            }

            var commandId = AsGuid(Reflect.Get(payload, "CommandId"));

            _efOwned.Remove(command);
            _efOwned.Add(command, Boxed.True);

            var scope = Current();

            _pending[commandId] = new PendingCommand
            {
                Id = NextId("q"),
                StartedMs = Emitter.NowMs(),
                Sql = Truncate(command.CommandText, _sqlMaxChars),
                Parameters = _captureParams ? DescribeParameters(command) : "[]",
                Stack = StackCapture.CaptureJson(),
                Database = SafeDatabase(command),
                ExecuteMethod = Reflect.GetString(payload, "ExecuteMethod"),
                Source = Reflect.GetString(payload, "CommandSource"),
                ReqId = scope?.Id,
                ActionId = scope?.ActionId,
                ActionLabel = scope?.ActionLabel,
                Handler = scope?.Handler,
                Path = scope?.Path,
                Method = scope?.Method
            };
        }

        private static void CommandFinished(object payload, string error)
        {
            var commandId = AsGuid(Reflect.Get(payload, "CommandId"));

            PendingCommand pending;
            if (!_pending.TryRemove(commandId, out pending))
            {
                return;
            }

            var command = Reflect.Get(payload, "Command") as DbCommand;
            if (command != null)
            {
                _efOwned.Remove(command);
            }

            double durationMs = 0;
            var duration = Reflect.Get(payload, "Duration");
            if (duration is TimeSpan)
            {
                durationMs = ((TimeSpan)duration).TotalMilliseconds;
            }

            long rowsAffected = -1;
            var result = Reflect.Get(payload, "Result");
            if (result is int)
            {
                rowsAffected = (int)result;
            }

            // A pending scope may only become resolvable now (handler set by MVC).
            var scope = Current();

            var json = new Jsonw()
                .Str("kind", "sql")
                .Str("id", pending.Id)
                .Str("app", _app)
                .Num("pid", _pid)
                .Num("ts", pending.StartedMs)
                .Num("durationMs", durationMs)
                .Num("rowsAffected", rowsAffected)
                .Str("sql", pending.Sql)
                .Raw("params", pending.Parameters)
                .Raw("stack", pending.Stack)
                .Str("db", pending.Database)
                .Str("exec", pending.ExecuteMethod)
                .Str("source", pending.Source)
                .Str("reqId", pending.ReqId ?? scope?.Id)
                .Str("actionId", pending.ActionId ?? scope?.ActionId)
                .Str("actionLabel", pending.ActionLabel ?? scope?.ActionLabel)
                .Str("handler", pending.Handler ?? scope?.Handler)
                .Str("path", pending.Path ?? scope?.Path)
                .Str("httpMethod", pending.Method ?? scope?.Method)
                .Str("commandId", commandId.ToString("N"))
                .Str("error", error)
                .ToString();

            Emitter.Send(json);
        }

        /// <summary>
        /// Where write counts actually come from. EF's tracked SaveChanges executes a
        /// reader (the RETURNING 1 / SELECT @@ROWCOUNT concurrency check), so the
        /// CommandExecuted result is a DbDataReader and carries no row count at all -
        /// only ExecuteUpdate/ExecuteDelete return an int. The count shows up here,
        /// on the reader, as RecordsAffected.
        /// </summary>
        private static void ReaderDisposing(object payload)
        {
            var commandId = AsGuid(Reflect.Get(payload, "CommandId"));

            var readCount = Reflect.Get(payload, "ReadCount");
            var recordsAffected = Reflect.Get(payload, "RecordsAffected");
            if (readCount == null && recordsAffected == null)
            {
                return;
            }

            var json = new Jsonw()
                .Str("kind", "sqlrows")
                .Str("commandId", commandId.ToString("N"));

            if (readCount != null)
            {
                json.Num("rowsRead", Convert.ToInt64(readCount, CultureInfo.InvariantCulture));
            }
            if (recordsAffected != null)
            {
                json.Num("recordsAffected", Convert.ToInt64(recordsAffected, CultureInfo.InvariantCulture));
            }

            Emitter.Send(json.ToString());
        }

        private static void SaveChangesCompleted(object payload)
        {
            var count = Reflect.Get(payload, "EntitiesSavedCount");
            var scope = Current();

            Emitter.Send(new Jsonw()
                .Str("kind", "savechanges")
                .Str("app", _app)
                .Num("ts", Emitter.NowMs())
                .Num("entities", count == null ? 0 : Convert.ToInt64(count, CultureInfo.InvariantCulture))
                .Raw("stack", StackCapture.CaptureJson())
                .Str("reqId", scope?.Id)
                .Str("actionId", scope?.ActionId)
                .Str("actionLabel", scope?.ActionLabel)
                .ToString());
        }

        // ---------------------------------------------------------------- raw ADO

        private static void OnSqlClient(string key, object value)
        {
            if (key != "Microsoft.Data.SqlClient.WriteCommandAfter" &&
                key != "System.Data.SqlClient.WriteCommandAfter")
            {
                return;
            }

            var command = Reflect.Get(value, "Command") as DbCommand;
            if (command == null)
            {
                return;
            }

            object owned;
            if (_efOwned.TryGetValue(command, out owned))
            {
                // already reported through the EF Core listener
                return;
            }

            var scope = Current();

            Emitter.Send(new Jsonw()
                .Str("kind", "sql")
                .Str("id", NextId("q"))
                .Str("app", _app)
                .Num("pid", _pid)
                .Num("ts", Emitter.NowMs())
                .Num("durationMs", 0)
                .Num("rowsAffected", -1)
                .Str("sql", Truncate(command.CommandText, _sqlMaxChars))
                .Raw("params", _captureParams ? DescribeParameters(command) : "[]")
                .Raw("stack", StackCapture.CaptureJson())
                .Str("db", SafeDatabase(command))
                .Str("source", "AdoNet")
                .Str("reqId", scope?.Id)
                .Str("actionId", scope?.ActionId)
                .Str("actionLabel", scope?.ActionLabel)
                .Str("handler", scope?.Handler)
                .Str("path", scope?.Path)
                .Str("httpMethod", scope?.Method)
                .ToString());
        }

        // ---------------------------------------------------------------- helpers

        private static string DescribeParameters(DbCommand command)
        {
            try
            {
                if (command.Parameters == null || command.Parameters.Count == 0)
                {
                    return "[]";
                }

                var sb = new StringBuilder(128);
                sb.Append('[');

                var max = Math.Min(command.Parameters.Count, 40);
                for (var i = 0; i < max; i++)
                {
                    var p = command.Parameters[i];
                    if (i > 0)
                    {
                        sb.Append(',');
                    }

                    var value = p.Value;
                    string text;
                    if (value == null || value == DBNull.Value)
                    {
                        text = "NULL";
                    }
                    else if (value is byte[])
                    {
                        text = "0x[" + ((byte[])value).Length + " bytes]";
                    }
                    else if (value is IFormattable)
                    {
                        text = ((IFormattable)value).ToString(null, CultureInfo.InvariantCulture);
                    }
                    else
                    {
                        text = value.ToString();
                    }

                    sb.Append(new Jsonw()
                        .Str("n", p.ParameterName)
                        .Str("v", Truncate(text, 120))
                        .ToString());
                }

                sb.Append(']');
                return sb.ToString();
            }
            catch
            {
                return "[]";
            }
        }

        private static string SafeDatabase(DbCommand command)
        {
            try
            {
                return command.Connection?.Database;
            }
            catch
            {
                return null;
            }
        }

        private static Guid AsGuid(object value)
        {
            if (value is Guid)
            {
                return (Guid)value;
            }
            Guid parsed;
            if (value != null && Guid.TryParse(value.ToString(), out parsed))
            {
                return parsed;
            }
            return Guid.Empty;
        }

        private static string Truncate(string value, int max)
        {
            if (string.IsNullOrEmpty(value) || value.Length <= max)
            {
                return value;
            }
            return value.Substring(0, max) + " /* ...truncated */";
        }

        private static string ShortenHandler(string displayName)
        {
            if (string.IsNullOrEmpty(displayName))
            {
                return null;
            }

            // "Namespace.FooController.Bar (WebApi.X)" -> "FooController.Bar"
            var paren = displayName.IndexOf(" (", StringComparison.Ordinal);
            var name = paren > 0 ? displayName.Substring(0, paren) : displayName;

            var parts = name.Split('.');
            if (parts.Length >= 2)
            {
                return parts[parts.Length - 2] + "." + parts[parts.Length - 1];
            }
            return name;
        }

        private static string Clean(string friendlyName)
        {
            if (string.IsNullOrEmpty(friendlyName))
            {
                return "app";
            }
            return friendlyName.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)
                ? friendlyName.Substring(0, friendlyName.Length - 4)
                : friendlyName;
        }

        private static string NextId(string prefix)
        {
            return prefix + _pid.ToString(CultureInfo.InvariantCulture) + "-" +
                   Interlocked.Increment(ref _seq).ToString(CultureInfo.InvariantCulture);
        }

        private sealed class ReqScope
        {
            public string Id;
            public long StartedMs;
            public string Method;
            public string Path;
            public string Query;
            public string Handler;
            public string ActionId;
            public string ActionLabel;
            public string ActionKind;
            public string TraceKey;
            public bool Ended;
        }

        private sealed class PendingCommand
        {
            public string Id;
            public long StartedMs;
            public string Sql;
            public string Parameters;
            public string Stack;
            public string Database;
            public string ExecuteMethod;
            public string Source;
            public string ReqId;
            public string ActionId;
            public string ActionLabel;
            public string Handler;
            public string Path;
            public string Method;
        }

        private static class Boxed
        {
            public static readonly object True = true;
        }
    }
}
