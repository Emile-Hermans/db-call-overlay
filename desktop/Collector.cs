using System.Diagnostics;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;

namespace DbCallOverlay;

/// <summary>
/// Owns the Node collector process: finds it, starts it, waits until it answers,
/// and guarantees it dies with the app (via a Windows job object, so even a hard
/// kill of the shell cannot leave an orphaned node.exe holding the ports).
/// </summary>
internal sealed class Collector : IDisposable
{
    private readonly Settings _settings;
    private readonly StringBuilder _log = new();
    private Process? _process;
    private JobObject? _job;

    public Collector(Settings settings)
    {
        _settings = settings;
    }

    public string Root { get; private set; } = string.Empty;
    public bool Attached { get; private set; }
    public string Url => $"http://127.0.0.1:{_settings.UiPort}";
    public string Log => _log.ToString();

    public async Task StartAsync(CancellationToken cancellation)
    {
        Root = LocateRoot();

        if (await IsHealthyAsync(cancellation))
        {
            // A collector is already running (started by start.ps1 or a previous
            // session) - use it and leave it alone on exit.
            Attached = true;
            return;
        }

        var node = LocateNode()
            ?? throw new InvalidOperationException(
                "Node.js was not found. Install it, or make sure node.exe is on PATH.");

        var script = Path.Combine(Root, "server", "index.mjs");
        if (!File.Exists(script))
        {
            throw new InvalidOperationException($"Collector script not found at {script}");
        }

        var info = new ProcessStartInfo(node, $"\"{script}\"")
        {
            WorkingDirectory = Root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        info.Environment["DBPROBE_UI_PORT"] = _settings.UiPort.ToString();
        info.Environment["DBPROBE_PORT"] = _settings.IngestPort.ToString();

        // Lets the UI show the exact command to attach the probe.
        var probe = ProbePath();
        if (probe is not null)
        {
            info.Environment["DBPROBE_DLL"] = probe;
        }

        // Projects live in the tool folder, never in the build output, so that
        // rebuilding - or deleting bin\ - can never take recorded flows with it.
        var toolRoot = ToolRoot();
        if (toolRoot is not null)
        {
            info.Environment["DBPROBE_DATA"] = Path.Combine(toolRoot, "data");
        }

        _process = Process.Start(info)
            ?? throw new InvalidOperationException("Could not start the collector process.");

        _process.OutputDataReceived += (_, e) => Append(e.Data);
        _process.ErrorDataReceived += (_, e) => Append(e.Data);
        _process.BeginOutputReadLine();
        _process.BeginErrorReadLine();

        _job = JobObject.TryCreate();
        _job?.Assign(_process);

        var deadline = DateTime.UtcNow.AddSeconds(20);
        while (DateTime.UtcNow < deadline)
        {
            if (_process.HasExited)
            {
                throw new InvalidOperationException(
                    $"The collector exited immediately (code {_process.ExitCode}).\r\n\r\n{Log}");
            }
            if (await IsHealthyAsync(cancellation))
            {
                return;
            }
            await Task.Delay(250, cancellation);
        }

        throw new InvalidOperationException($"The collector did not respond on {Url}.\r\n\r\n{Log}");
    }

    private void Append(string? line)
    {
        if (string.IsNullOrEmpty(line))
        {
            return;
        }
        lock (_log)
        {
            if (_log.Length < 8000)
            {
                _log.AppendLine(line);
            }
        }
    }

    private async Task<bool> IsHealthyAsync(CancellationToken cancellation)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            using var response = await client.GetAsync($"{Url}/api/health", cancellation);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Walks up from the exe until it finds the folder holding server\index.mjs.</summary>
    private static string LocateRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 8 && directory is not null; i++)
        {
            if (File.Exists(Path.Combine(directory.FullName, "server", "index.mjs")))
            {
                return directory.FullName;
            }
            directory = directory.Parent;
        }
        return AppContext.BaseDirectory;
    }

    private static string? LocateNode()
    {
        var candidates = new List<string>
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe"),
        };

        foreach (var folder in (Environment.GetEnvironmentVariable("PATH") ?? string.Empty).Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(folder))
            {
                candidates.Add(Path.Combine(folder.Trim(), "node.exe"));
            }
        }

        return candidates.FirstOrDefault(File.Exists);
    }

    /// <summary>
    /// The probe DLL. Prefers the one in the tool folder - that is the path the
    /// run-api / start-vs scripts use, so the command shown in the UI matches them.
    /// Falls back to the copy shipped next to the exe.
    /// </summary>
    public string? ProbePath()
    {
        var root = ToolRoot();
        if (root is not null)
        {
            var source = Path.Combine(root, "probe", "bin", "Release", "net8.0", "DbProbe.dll");
            if (File.Exists(source))
            {
                return source;
            }
        }

        var bundled = Path.Combine(AppContext.BaseDirectory, "probe", "DbProbe.dll");
        return File.Exists(bundled) ? bundled : null;
    }

    /// <summary>The tool folder, which is also the git checkout when there is one.</summary>
    public string? ToolFolder() => ToolRoot();

    /// <summary>The DbCallOverlay folder itself, identified by build.ps1 sitting in it.</summary>
    private static string? ToolRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 8 && directory is not null; i++)
        {
            if (File.Exists(Path.Combine(directory.FullName, "build.ps1")))
            {
                return directory.FullName;
            }
            directory = directory.Parent;
        }
        return null;
    }

    /// <summary>
    /// Closing the app must not leave a collector running. That covers the one we
    /// started, and one we merely attached to - a leftover from a previous window
    /// is exactly the process nobody wants to hunt down in Task Manager.
    /// </summary>
    public void Dispose()
    {
        try
        {
            if (_process is { HasExited: false })
            {
                _process.Kill(entireProcessTree: true);
                _process.WaitForExit(3000);
            }
            else if (Attached)
            {
                StopAttachedCollector();
            }
        }
        catch
        {
        }

        _process?.Dispose();
        _job?.Dispose();
    }

    /// <summary>
    /// Asks the running collector for its own process id and stops it. Only a
    /// node process is ever touched, so a stray pid can never take something else
    /// down with it.
    /// </summary>
    private void StopAttachedCollector()
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            var body = client.GetStringAsync($"{Url}/api/health").GetAwaiter().GetResult();

            var marker = "\"pid\":";
            var at = body.IndexOf(marker, StringComparison.Ordinal);
            if (at < 0)
            {
                return;
            }

            var digits = new string(body[(at + marker.Length)..].TakeWhile(char.IsDigit).ToArray());
            if (!int.TryParse(digits, out var pid))
            {
                return;
            }

            using var collector = Process.GetProcessById(pid);
            if (collector.ProcessName.Equals("node", StringComparison.OrdinalIgnoreCase))
            {
                collector.Kill(entireProcessTree: true);
                collector.WaitForExit(3000);
            }
        }
        catch
        {
            // already gone, unreachable, or not ours to stop
        }
    }
}

/// <summary>Minimal job object wrapper: children die when the handle closes.</summary>
internal sealed class JobObject : IDisposable
{
    private IntPtr _handle;

    private JobObject(IntPtr handle) => _handle = handle;

    public static JobObject? TryCreate()
    {
        try
        {
            var handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero)
            {
                return null;
            }

            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
            {
                BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION
                {
                    LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                },
            };

            var size = Marshal.SizeOf(limits);
            var buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, buffer, false);
                SetInformationJobObject(handle, JobObjectExtendedLimitInformation, buffer, (uint)size);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }

            return new JobObject(handle);
        }
        catch
        {
            return null;
        }
    }

    public void Assign(Process process)
    {
        try
        {
            AssignProcessToJobObject(_handle, process.Handle);
        }
        catch
        {
        }
    }

    public void Dispose()
    {
        if (_handle != IntPtr.Zero)
        {
            CloseHandle(_handle);
            _handle = IntPtr.Zero;
        }
    }

    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string? name);

    [DllImport("kernel32.dll")]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll")]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
}
