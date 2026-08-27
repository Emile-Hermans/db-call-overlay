using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Text;

namespace DbProbe
{
    /// <summary>
    /// Turns the live stack at "about to execute SQL" into the readable application
    /// call path that triggered it, with file:line so the smoke tester can jump
    /// straight to the method in the code.
    /// </summary>
    internal static class StackCapture
    {
        private static string[] _appNamespaces;
        private static bool _withFileInfo = true;
        private static bool _enabled = true;
        private static int _maxFrames = 14;

        /// <summary>
        /// Namespaces and assemblies that are never the application's own code. Used
        /// as a deny list so any codebase works without configuration - listing what
        /// to include would mean every project had to configure it first.
        /// </summary>
        private static readonly string[] _framework =
        {
            "System", "Microsoft", "Internal.", "Interop", "MS.",
            "Newtonsoft", "AutoMapper", "MediatR", "Serilog", "NLog", "log4net",
            "Dapper", "EntityFramework", "Npgsql", "MySql", "Oracle", "SQLite",
            "Castle", "DynamicProxy", "Polly", "FluentValidation", "Swashbuckle",
            "StackExchange", "Azure", "Amazon", "Google", "Grpc", "Hangfire",
            "Quartz", "AspNetCore", "NetEscapades", "Scrutor", "Mapster",
            "xunit", "NUnit", "Moq", "NSubstitute", "FluentAssertions",
            "DbProbe", "Anonymously Hosted", "<>", "lambda_method",
        };

        public static void Configure()
        {
            // Optional allow list. Left unset - the normal case - anything that is not
            // framework code counts as application code.
            var ns = Emitter.Env("DBPROBE_NS", string.Empty);
            _appNamespaces = ns.Split(new[] { ';', ',' }, StringSplitOptions.RemoveEmptyEntries);

            var mode = Emitter.Env("DBPROBE_STACK", "full").ToLowerInvariant();
            _enabled = mode != "off";
            _withFileInfo = mode != "nofile";
            _maxFrames = Emitter.EnvInt("DBPROBE_STACK_FRAMES", 14);
        }

        /// <summary>Returns a JSON array fragment of frames, closest caller first.</summary>
        public static string CaptureJson()
        {
            if (!_enabled)
            {
                return "[]";
            }

            try
            {
                var trace = new StackTrace(2, _withFileInfo);
                var frames = trace.GetFrames();
                if (frames == null)
                {
                    return "[]";
                }

                var sb = new StringBuilder(256);
                sb.Append('[');

                var written = 0;
                string lastLabel = null;

                for (var i = 0; i < frames.Length && written < _maxFrames; i++)
                {
                    var method = frames[i].GetMethod();
                    if (method == null)
                    {
                        continue;
                    }

                    var declaring = method.DeclaringType;
                    if (declaring == null)
                    {
                        continue;
                    }

                    string typeName;
                    string methodName;
                    Unmangle(declaring, method, out typeName, out methodName);

                    if (!IsApp(declaring))
                    {
                        continue;
                    }

                    var label = typeName + "." + methodName;
                    if (label == lastLabel)
                    {
                        // async state machines can produce repeated adjacent frames
                        continue;
                    }
                    lastLabel = label;

                    var file = _withFileInfo ? frames[i].GetFileName() : null;
                    var line = _withFileInfo ? frames[i].GetFileLineNumber() : 0;

                    if (written > 0)
                    {
                        sb.Append(',');
                    }

                    var j = new Jsonw().Str("m", label);
                    if (!string.IsNullOrEmpty(file))
                    {
                        j.Str("f", file);
                    }
                    if (line > 0)
                    {
                        j.Num("l", line);
                    }
                    sb.Append(j.ToString());
                    written++;
                }

                sb.Append(']');
                return sb.ToString();
            }
            catch
            {
                return "[]";
            }
        }

        /// <summary>
        /// A frame is application code when either its namespace or the assembly it
        /// lives in matches a configured prefix. Matching on the assembly as well
        /// keeps top-level-statement classes (no namespace) from being skipped.
        /// </summary>
        private static bool IsApp(Type declaring)
        {
            var ns = declaring.Namespace ?? string.Empty;

            string assembly;
            try
            {
                assembly = declaring.Assembly.GetName().Name ?? string.Empty;
            }
            catch
            {
                assembly = string.Empty;
            }

            // An explicit allow list wins when one is configured.
            if (_appNamespaces != null && _appNamespaces.Length > 0)
            {
                for (var i = 0; i < _appNamespaces.Length; i++)
                {
                    var prefix = _appNamespaces[i];
                    if (ns.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ||
                        assembly.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }
                return false;
            }

            for (var i = 0; i < _framework.Length; i++)
            {
                var prefix = _framework[i];
                if (ns.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ||
                    assembly.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }
            }

            return true;
        }

        /// <summary>
        /// Async methods and lambdas show up as compiler-generated types
        /// (Foo+&lt;BarAsync&gt;d__12.MoveNext). Recover "Foo.BarAsync".
        /// </summary>
        private static void Unmangle(Type declaring, MethodBase method, out string typeName, out string methodName)
        {
            typeName = declaring.Name;
            methodName = method.Name;

            var isGenerated = declaring.IsDefined(typeof(System.Runtime.CompilerServices.CompilerGeneratedAttribute), false);
            if (isGenerated && declaring.DeclaringType != null)
            {
                var recovered = ExtractAngleName(declaring.Name);
                if (!string.IsNullOrEmpty(recovered))
                {
                    methodName = recovered;
                }
                else
                {
                    methodName = method.Name;
                }

                typeName = declaring.DeclaringType.Name;
            }
            else
            {
                var recovered = ExtractAngleName(method.Name);
                if (!string.IsNullOrEmpty(recovered))
                {
                    methodName = recovered + " (lambda)";
                }
            }

            var tick = typeName.IndexOf('`');
            if (tick > 0)
            {
                typeName = typeName.Substring(0, tick);
            }
        }

        private static string ExtractAngleName(string name)
        {
            var open = name.IndexOf('<');
            var close = name.IndexOf('>');
            if (open == 0 && close > 1)
            {
                return name.Substring(1, close - 1);
            }
            return null;
        }

        /// <summary>Best "this is the method to look at" label for a captured stack.</summary>
        public static string FirstFrameLabel(List<string> labels)
        {
            return labels != null && labels.Count > 0 ? labels[0] : null;
        }
    }
}
