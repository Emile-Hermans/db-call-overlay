using System;
using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace DbProbe
{
    /// <summary>
    /// Ships newline-delimited JSON to the collector over a plain TCP socket.
    /// Never blocks the caller, never throws, drops events when the queue backs up.
    /// </summary>
    internal static class Emitter
    {
        private const int MAX_QUEUE = 50000;

        private static readonly BlockingCollection<string> _queue =
            new BlockingCollection<string>(new ConcurrentQueue<string>(), MAX_QUEUE);

        private static int _dropped;
        private static string _host = "127.0.0.1";
        private static int _port = 8477;
        private static string _hello;

        public static void Start(string host, int port, string hello)
        {
            _host = host;
            _port = port;
            _hello = hello;

            var t = new Thread(PumpLoop)
            {
                IsBackground = true,
                Name = "dbprobe-emit",
                Priority = ThreadPriority.BelowNormal
            };
            t.Start();
        }

        public static void Send(string json)
        {
            try
            {
                if (!_queue.TryAdd(json))
                {
                    Interlocked.Increment(ref _dropped);
                }
            }
            catch
            {
            }
        }

        private const int HEARTBEAT_MS = 2000;
        private static readonly string _heartbeat = new Jsonw().Str("kind", "ping").ToString();

        private static void PumpLoop()
        {
            // Survives the collector being restarted: a heartbeat notices the dead
            // socket while the app is idle, and an event that failed to send is kept
            // and written again once the connection is back, so nothing is lost.
            string unsent = null;

            while (true)
            {
                TcpClient client = null;
                try
                {
                    client = new TcpClient();
                    client.NoDelay = true;
                    client.Connect(_host, _port);

                    using (var stream = client.GetStream())
                    {
                        WriteLine(stream, _hello);

                        if (unsent != null)
                        {
                            WriteLine(stream, unsent);
                            unsent = null;
                        }

                        while (true)
                        {
                            string line;
                            if (!_queue.TryTake(out line, HEARTBEAT_MS))
                            {
                                // Nothing to send: prove the socket is still alive.
                                WriteLine(stream, _heartbeat);
                                continue;
                            }

                            try
                            {
                                WriteLine(stream, line);
                            }
                            catch
                            {
                                unsent = line;
                                throw;
                            }

                            var dropped = Interlocked.Exchange(ref _dropped, 0);
                            if (dropped > 0)
                            {
                                WriteLine(stream, new Jsonw()
                                    .Str("kind", "dropped")
                                    .Num("count", dropped)
                                    .ToString());
                            }
                        }
                    }
                }
                catch
                {
                    // Collector not running yet, or it went away. Back off and retry.
                }
                finally
                {
                    try
                    {
                        client?.Close();
                    }
                    catch
                    {
                    }
                }

                Thread.Sleep(2000);
            }
        }

        private static void WriteLine(NetworkStream stream, string line)
        {
            if (string.IsNullOrEmpty(line))
            {
                return;
            }
            var bytes = Encoding.UTF8.GetBytes(line + "\n");
            stream.Write(bytes, 0, bytes.Length);
        }

        public static long NowMs()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }

        public static string Env(string name, string fallback)
        {
            var v = Environment.GetEnvironmentVariable(name);
            return string.IsNullOrWhiteSpace(v) ? fallback : v;
        }

        public static int EnvInt(string name, int fallback)
        {
            var v = Environment.GetEnvironmentVariable(name);
            int parsed;
            if (!string.IsNullOrWhiteSpace(v) && int.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed))
            {
                return parsed;
            }
            return fallback;
        }
    }
}
