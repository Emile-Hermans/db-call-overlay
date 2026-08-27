using System.Diagnostics;
using System.Runtime.InteropServices;

namespace DbCallOverlay;

internal sealed record ApiProcess(int Pid, string Name, string ExePath, string? StartedBy)
{
    public bool FromVisualStudio =>
        StartedBy is not null &&
        (StartedBy.Contains("devenv", StringComparison.OrdinalIgnoreCase) ||
         StartedBy.Contains("VsDebugConsole", StringComparison.OrdinalIgnoreCase) ||
         StartedBy.Contains("ServiceHub", StringComparison.OrdinalIgnoreCase));
}

/// <summary>
/// One-time machine setup, done from the app so nobody has to touch a terminal.
///
/// A .NET startup hook can only attach while a process is starting, which is why
/// an API that is already running cannot be recorded until it starts again. What
/// we can do is make that automatic from then on: set the variable once, and every
/// API started afterwards - from Visual Studio or anywhere else - is recorded.
/// </summary>
internal static class Setup
{
    private const string HOOK_VAR = "DOTNET_STARTUP_HOOKS";
    private const string FILTER_VAR = "DBPROBE_APPS";

    /// <summary>
    /// Process names that are .NET but never worth recording: build servers,
    /// compilers, test hosts and IDE helpers.
    /// </summary>
    private static readonly string[] _tooling =
    {
        "MSBuild", "VBCSCompiler", "csc", "vbc", "dotnet", "testhost", "vstest",
        "ServiceHub", "devenv", "NuGet", "Razor", "rzc", "func", "OmniSharp",
        "PerfWatson2", "Microsoft.CodeAnalysis", "JetBrains", "ReSharper",
        "DbCallOverlay", "node",
    };

    public static string? Installed()
    {
        var value = Environment.GetEnvironmentVariable(HOOK_VAR, EnvironmentVariableTarget.User);
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }

    public static bool IsInstalled(string? probeDll) =>
        probeDll is not null &&
        string.Equals(Installed(), probeDll, StringComparison.OrdinalIgnoreCase);

    public static void Install(string probeDll)
    {
        Environment.SetEnvironmentVariable(HOOK_VAR, probeDll, EnvironmentVariableTarget.User);
        Environment.SetEnvironmentVariable(FILTER_VAR, null, EnvironmentVariableTarget.User);
    }

    public static void Uninstall()
    {
        Environment.SetEnvironmentVariable(HOOK_VAR, null, EnvironmentVariableTarget.User);
        Environment.SetEnvironmentVariable(FILTER_VAR, null, EnvironmentVariableTarget.User);
    }

    /// <summary>
    /// A startup hook pointing at a file that no longer exists stops EVERY dotnet
    /// command from running. If the tool folder was moved or the probe deleted,
    /// take the variable back out before that can bite anyone.
    /// </summary>
    public static bool RepairIfBroken(string? probeDll)
    {
        var current = Installed();
        if (current is null)
        {
            return false;
        }

        if (File.Exists(current))
        {
            return false;
        }

        if (probeDll is not null && File.Exists(probeDll))
        {
            Install(probeDll);
        }
        else
        {
            Uninstall();
        }
        return true;
    }

    /// <summary>
    /// When Visual Studio started. It passes its own environment to everything it
    /// debugs, and it captured that environment at launch - so a VS that was already
    /// open when recording was switched on cannot pass the recorder to F5.
    /// </summary>
    public static DateTime? VisualStudioStartedAt()
    {
        try
        {
            return Process.GetProcessesByName("devenv")
                .Select(p =>
                {
                    try
                    {
                        return (DateTime?)p.StartTime;
                    }
                    catch
                    {
                        return null;
                    }
                })
                .Where(t => t is not null)
                .OrderBy(t => t)
                .FirstOrDefault();
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Running .NET applications worth recording, and who started them.
    ///
    /// A process counts as a .NET app when a runtimeconfig.json sits next to its
    /// executable - that works for any project, rather than assuming a naming
    /// convention. An optional filter narrows it further.
    /// </summary>
    public static IReadOnlyList<ApiProcess> FindApis(string? filter = null)
    {
        var found = new List<ApiProcess>();
        var parents = ParentNames();

        foreach (var process in Process.GetProcesses())
        {
            try
            {
                var name = process.ProcessName;

                if (_tooling.Any(t => name.Equals(t, StringComparison.OrdinalIgnoreCase) ||
                                      name.StartsWith(t + ".", StringComparison.OrdinalIgnoreCase)))
                {
                    continue;
                }

                if (!string.IsNullOrWhiteSpace(filter) &&
                    name.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0)
                {
                    continue;
                }

                string exePath;
                try
                {
                    exePath = process.MainModule?.FileName ?? string.Empty;
                }
                catch
                {
                    continue; // not ours to inspect (system or elevated process)
                }

                if (!IsDotnetApp(exePath))
                {
                    continue;
                }

                found.Add(new ApiProcess(
                    process.Id,
                    name,
                    exePath,
                    parents.TryGetValue(process.Id, out var parent) ? parent : null));
            }
            catch
            {
                // process exited while we were looking at it
            }
        }

        return found.OrderBy(a => a.Name).ToList();
    }

    private static bool IsDotnetApp(string exePath)
    {
        if (string.IsNullOrEmpty(exePath))
        {
            return false;
        }

        try
        {
            var directory = Path.GetDirectoryName(exePath);
            var name = Path.GetFileNameWithoutExtension(exePath);
            return directory is not null &&
                   File.Exists(Path.Combine(directory, name + ".runtimeconfig.json"));
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// pid -> name of the process that started it, from a toolhelp snapshot.
    /// Used only to recognise "this was launched by Visual Studio", so the restart
    /// warning can say that debugging will stop.
    /// </summary>
    private static Dictionary<int, string> ParentNames()
    {
        var names = new Dictionary<int, string>();
        var parentOf = new Dictionary<int, int>();
        var snapshot = IntPtr.Zero;

        try
        {
            snapshot = NativeMethods.CreateToolhelp32Snapshot(NativeMethods.TH32CS_SNAPPROCESS, 0);
            if (snapshot == NativeMethods.INVALID_HANDLE)
            {
                return new Dictionary<int, string>();
            }

            var entry = new NativeMethods.PROCESSENTRY32 { dwSize = Marshal.SizeOf<NativeMethods.PROCESSENTRY32>() };
            if (!NativeMethods.Process32First(snapshot, ref entry))
            {
                return new Dictionary<int, string>();
            }

            do
            {
                names[(int)entry.th32ProcessID] = entry.szExeFile ?? string.Empty;
                parentOf[(int)entry.th32ProcessID] = (int)entry.th32ParentProcessID;
            }
            while (NativeMethods.Process32Next(snapshot, ref entry));
        }
        catch
        {
            return new Dictionary<int, string>();
        }
        finally
        {
            if (snapshot != IntPtr.Zero && snapshot != NativeMethods.INVALID_HANDLE)
            {
                NativeMethods.CloseHandle(snapshot);
            }
        }

        var result = new Dictionary<int, string>();
        foreach (var (pid, parentPid) in parentOf)
        {
            if (names.TryGetValue(parentPid, out var parentName))
            {
                result[pid] = parentName;
            }
        }
        return result;
    }

    private static class NativeMethods
    {
        public const uint TH32CS_SNAPPROCESS = 0x00000002;
        public static readonly IntPtr INVALID_HANDLE = new(-1);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct PROCESSENTRY32
        {
            public int dwSize;
            public uint cntUsage;
            public uint th32ProcessID;
            public IntPtr th32DefaultHeapID;
            public uint th32ModuleID;
            public uint cntThreads;
            public uint th32ParentProcessID;
            public int pcPriClassBase;
            public uint dwFlags;

            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string szExeFile;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);
    }

    /// <summary>
    /// Restarts an API so the probe attaches.
    ///
    /// This has to reproduce how the project is normally launched, or the API comes
    /// back misconfigured: the working directory decides where appsettings is read
    /// from, and launchSettings.json carries ASPNETCORE_ENVIRONMENT and the ports.
    /// Getting either wrong starts a process that dies or binds nothing.
    /// </summary>
    public static (bool Ok, string Message) Restart(ApiProcess api, string probeDll)
    {
        if (api.FromVisualStudio)
        {
            return (false, $"{api.Name}: started by Visual Studio — restart it from there.");
        }

        if (string.IsNullOrEmpty(api.ExePath) || !File.Exists(api.ExePath))
        {
            return (false, $"{api.Name}: could not find its executable.");
        }

        var projectDirectory = ContentRootOf(api.ExePath);
        var profile = LaunchProfile.Read(projectDirectory, api.Name);

        try
        {
            var info = new ProcessStartInfo(api.ExePath)
            {
                WorkingDirectory = projectDirectory,
                UseShellExecute = false,
            };
            info.Environment[HOOK_VAR] = probeDll;
            
            foreach (var (name, value) in profile.EnvironmentVariables)
            {
                info.Environment[name] = value;
            }
            if (profile.ApplicationUrl is not null)
            {
                info.Environment["ASPNETCORE_URLS"] = profile.ApplicationUrl;
            }

            using (var running = Process.GetProcessById(api.Pid))
            {
                running.Kill();
                running.WaitForExit(8000);
            }

            var started = Process.Start(info);
            if (started is null)
            {
                return (false, $"{api.Name}: could not be started again.");
            }

            // Starting is not the same as staying up: a missing setting kills these
            // a second or two in, and silently reporting success is how ports end up
            // free while the app claims everything is fine.
            if (started.WaitForExit(4000))
            {
                return (false, $"{api.Name}: started but exited immediately (code {started.ExitCode}). Start it the way you normally do.");
            }

            return (true, $"{api.Name} restarted.");
        }
        catch (Exception ex)
        {
            return (false, $"{api.Name}: {ex.Message}");
        }
    }

    /// <summary>...\Project\bin\Debug\net8.0\App.exe -> ...\Project</summary>
    private static string ContentRootOf(string exePath)
    {
        var directory = new DirectoryInfo(Path.GetDirectoryName(exePath)!);
        while (directory is not null)
        {
            if (string.Equals(directory.Name, "bin", StringComparison.OrdinalIgnoreCase))
            {
                return directory.Parent?.FullName ?? directory.FullName;
            }
            directory = directory.Parent;
        }
        return Path.GetDirectoryName(exePath)!;
    }
}
