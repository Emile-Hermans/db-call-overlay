using System;
using System.Runtime.CompilerServices;

/// <summary>
/// Entry point for DOTNET_STARTUP_HOOKS. Must be a non-namespaced type called
/// StartupHook with a public static void Initialize().
/// </summary>
internal class StartupHook
{
    public static void Initialize()
    {
        try
        {
            if (Environment.GetEnvironmentVariable("DBPROBE_OFF") == "1")
            {
                return;
            }

            // DOTNET_STARTUP_HOOKS applies to every dotnet process started from the
            // same environment - including build servers and CLI tools. Skip those,
            // and otherwise attach to anything unless an explicit filter says not to.
            var friendlyName = AppDomain.CurrentDomain.FriendlyName ?? string.Empty;

            if (IsBuildOrTooling(friendlyName))
            {
                return;
            }

            var filter = Environment.GetEnvironmentVariable("DBPROBE_APPS");
            if (!string.IsNullOrWhiteSpace(filter) && filter.Trim() != "*")
            {
                var matched = false;
                foreach (var token in filter.Split(new[] { ';', ',' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    var t = token.Trim();
                    if (t.Length > 0 && friendlyName.IndexOf(t, StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        matched = true;
                        break;
                    }
                }

                if (!matched)
                {
                    return;
                }
            }

            Attach(friendlyName);
        }
        catch
        {
            // A startup hook must never take the host process down.
        }
    }

    /// <summary>
    /// Build servers, compilers and CLI tools run constantly and never touch a
    /// database. Attaching to them would cost time and tell nobody anything.
    /// </summary>
    private static bool IsBuildOrTooling(string friendlyName)
    {
        string[] tooling =
        {
            "MSBuild", "VBCSCompiler", "csc", "vbc", "dotnet", "testhost",
            "vstest", "ServiceHub", "devenv", "NuGet", "Razor", "rzc",
            "func", "ef", "OmniSharp", "Roslyn", "JetBrains", "ReSharper",
        };

        foreach (var name in tooling)
        {
            if (string.Equals(friendlyName, name, StringComparison.OrdinalIgnoreCase) ||
                friendlyName.StartsWith(name + ".", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }

    // Separated so that the JIT only resolves DbProbe types once we know we want them.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Attach(string friendlyName)
    {
        DbProbe.Probe.Start(friendlyName);
    }
}
