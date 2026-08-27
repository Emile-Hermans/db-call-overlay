using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Reflection;

namespace DbProbe
{
    /// <summary>
    /// Property access by name over the anonymous / internal payload types that
    /// DiagnosticSource hands us, with a per-(type,name) cache.
    /// </summary>
    internal static class Reflect
    {
        private static readonly ConcurrentDictionary<string, PropertyInfo> _cache =
            new ConcurrentDictionary<string, PropertyInfo>();

        public static object Get(object target, string name)
        {
            if (target == null)
            {
                return null;
            }

            try
            {
                var type = target.GetType();
                var key = type.FullName + "|" + name;

                var prop = _cache.GetOrAdd(key, _ =>
                    type.GetProperty(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.FlattenHierarchy));

                return prop?.GetValue(target);
            }
            catch
            {
                return null;
            }
        }

        public static object Get(object target, string a, string b)
        {
            return Get(Get(target, a), b);
        }

        public static string GetString(object target, string name)
        {
            var v = Get(target, name);
            return v?.ToString();
        }

        public static string GetString(object target, string a, string b)
        {
            var v = Get(target, a, b);
            return v?.ToString();
        }

        /// <summary>
        /// Reads one header out of an ASP.NET Core HttpContext without referencing
        /// the ASP.NET assemblies: walks IHeaderDictionary as a plain IEnumerable of
        /// KeyValuePair&lt;string, StringValues&gt;.
        /// </summary>
        public static string Header(object httpContext, string headerName)
        {
            try
            {
                var headers = Get(httpContext, "Request", "Headers") as IEnumerable;
                if (headers == null)
                {
                    return null;
                }

                foreach (var entry in headers)
                {
                    var key = GetString(entry, "Key");
                    if (string.Equals(key, headerName, StringComparison.OrdinalIgnoreCase))
                    {
                        var value = Get(entry, "Value");
                        return value?.ToString();
                    }
                }
            }
            catch
            {
            }

            return null;
        }
    }
}
