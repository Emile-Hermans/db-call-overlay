using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace DbProbe
{
    /// <summary>
    /// Tiny hand-rolled JSON object writer. Hand-rolled on purpose: the probe is
    /// injected into a foreign process, so it must not depend on any assembly the
    /// host might load at a different version.
    /// </summary>
    internal sealed class Jsonw
    {
        // U+2028 / U+2029 are valid JSON but break JavaScript string parsing.
        private const int LINE_SEPARATOR = 0x2028;
        private const int PARAGRAPH_SEPARATOR = 0x2029;

        private readonly StringBuilder _sb = new StringBuilder(512);
        private bool _first = true;

        public Jsonw()
        {
            _sb.Append('{');
        }

        public Jsonw Str(string name, string value)
        {
            if (value == null)
            {
                return this;
            }
            Sep(name);
            Escape(value);
            return this;
        }

        public Jsonw Num(string name, long value)
        {
            Sep(name);
            _sb.Append(value.ToString(CultureInfo.InvariantCulture));
            return this;
        }

        public Jsonw Num(string name, double value)
        {
            Sep(name);
            _sb.Append(value.ToString("0.###", CultureInfo.InvariantCulture));
            return this;
        }

        public Jsonw Bool(string name, bool value)
        {
            Sep(name);
            _sb.Append(value ? "true" : "false");
            return this;
        }

        public Jsonw StrArray(string name, IEnumerable<string> values)
        {
            if (values == null)
            {
                return this;
            }
            Sep(name);
            _sb.Append('[');
            var first = true;
            foreach (var v in values)
            {
                if (!first)
                {
                    _sb.Append(',');
                }
                first = false;
                Escape(v ?? string.Empty);
            }
            _sb.Append(']');
            return this;
        }

        /// <summary>Writes an already-serialised JSON fragment (array or object).</summary>
        public Jsonw Raw(string name, string json)
        {
            if (json == null)
            {
                return this;
            }
            Sep(name);
            _sb.Append(json);
            return this;
        }

        public override string ToString()
        {
            return _sb.ToString() + "}";
        }

        private void Sep(string name)
        {
            if (!_first)
            {
                _sb.Append(',');
            }
            _first = false;
            Escape(name);
            _sb.Append(':');
        }

        private void Escape(string s)
        {
            _sb.Append('"');
            for (var i = 0; i < s.Length; i++)
            {
                var c = s[i];
                switch (c)
                {
                    case '"': _sb.Append("\\\""); break;
                    case '\\': _sb.Append("\\\\"); break;
                    case '\n': _sb.Append("\\n"); break;
                    case '\r': _sb.Append("\\r"); break;
                    case '\t': _sb.Append("\\t"); break;
                    case '\b': _sb.Append("\\b"); break;
                    case '\f': _sb.Append("\\f"); break;
                    default:
                        if (c < 0x20 || c == LINE_SEPARATOR || c == PARAGRAPH_SEPARATOR)
                        {
                            _sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            _sb.Append(c);
                        }
                        break;
                }
            }
            _sb.Append('"');
        }
    }
}
