using System.Diagnostics;
using System.Text;

namespace DbCallOverlay;

internal sealed record UpdateStatus(
    bool IsRepository,
    bool Available,
    string? Current,
    string? CurrentDate,
    int Behind,
    string[] Changes,
    bool HasLocalChanges,
    string? Problem);

/// <summary>
/// Updates the app from the git repository it was cloned from.
///
/// Deliberately conservative: fast-forward only, and it refuses outright when
/// there is local work in the tree. Losing someone's uncommitted change to make
/// an update button convenient is not a trade worth making.
/// </summary>
internal static class Updater
{
    public static UpdateStatus Check(string? repoRoot)
    {
        if (repoRoot is null || !Directory.Exists(Path.Combine(repoRoot, ".git")))
        {
            return new UpdateStatus(false, false, null, null, 0, [], false,
                "This copy was not cloned with git, so it cannot update itself. Download the latest version manually.");
        }

        var git = GitPath();
        if (git is null)
        {
            return new UpdateStatus(true, false, null, null, 0, [], false,
                "Git is not installed, so the app cannot fetch updates.");
        }

        var current = Run(git, "rev-parse --short HEAD", repoRoot).Output.Trim();
        var currentDate = Run(git, "log -1 --format=%cd --date=short", repoRoot).Output.Trim();
        var dirty = Run(git, "status --porcelain", repoRoot).Output.Trim().Length > 0;

        var fetch = Run(git, "fetch --quiet origin", repoRoot, timeoutMs: 30000);
        if (!fetch.Ok)
        {
            return new UpdateStatus(true, false, current, currentDate, 0, [], dirty,
                $"Could not reach the repository: {First(fetch.Error)}");
        }

        var branch = Run(git, "rev-parse --abbrev-ref HEAD", repoRoot).Output.Trim();
        var upstream = $"origin/{(string.IsNullOrWhiteSpace(branch) || branch == "HEAD" ? "main" : branch)}";

        var behindText = Run(git, $"rev-list --count HEAD..{upstream}", repoRoot).Output.Trim();
        if (!int.TryParse(behindText, out var behind))
        {
            return new UpdateStatus(true, false, current, currentDate, 0, [], dirty,
                $"No branch named {upstream} on the remote.");
        }

        var changes = behind == 0
            ? []
            : Run(git, $"log --format=%s HEAD..{upstream}", repoRoot).Output
                .Split('\n', StringSplitOptions.RemoveEmptyEntries)
                .Select(line => line.Trim())
                .Take(10)
                .ToArray();

        return new UpdateStatus(true, behind > 0, current, currentDate, behind, changes, dirty, null);
    }

    /// <summary>
    /// Pulls, then hands the rebuild to a detached script: the app cannot rebuild
    /// its own executable while it is running, so the script waits for it to exit
    /// first and starts it again afterwards.
    /// </summary>
    public static (bool Ok, string Message) Apply(string? repoRoot, string exePath)
    {
        var status = Check(repoRoot);

        if (status.Problem is not null) return (false, status.Problem);
        if (!status.Available) return (false, "Already up to date.");
        if (status.HasLocalChanges)
        {
            return (false,
                "There are local changes in this folder. Commit or discard them first — " +
                "updating would overwrite them.");
        }

        var git = GitPath()!;
        var pull = Run(git, "merge --ff-only FETCH_HEAD", repoRoot!, timeoutMs: 30000);
        if (!pull.Ok)
        {
            return (false, $"Update stopped, nothing was changed: {First(pull.Error)}");
        }

        try
        {
            var script = WriteRestartScript(repoRoot!, exePath);
            Process.Start(new ProcessStartInfo("powershell",
                $"-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{script}\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            });
        }
        catch (Exception ex)
        {
            return (false, $"Updated the files, but could not start the rebuild: {ex.Message}");
        }

        return (true, "Updated. Rebuilding and restarting…");
    }

    private static string WriteRestartScript(string repoRoot, string exePath)
    {
        // $pid is reserved in PowerShell, hence $appPid.
        var script = new StringBuilder()
            .AppendLine($"$appPid = {Environment.ProcessId}")
            .AppendLine("while (Get-Process -Id $appPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 300 }")
            .AppendLine($"Set-Location '{repoRoot}'")
            .AppendLine("# The recorder cannot be replaced while an application has it loaded; that is")
            .AppendLine("# not fatal, the rest of the update still applies.")
            .AppendLine("dotnet build probe\\DbProbe.csproj -c Release --nologo -v quiet")
            .AppendLine("dotnet build desktop\\DbCallOverlay.csproj -c Release --nologo -v quiet")
            .AppendLine("if ($LASTEXITCODE -ne 0) {")
            .AppendLine("  Add-Type -AssemblyName System.Windows.Forms")
            .AppendLine("  [System.Windows.Forms.MessageBox]::Show('The update was downloaded but the rebuild failed. Run Install.cmd in the tool folder.','DB Call Overlay') | Out-Null")
            .AppendLine("  exit 1")
            .AppendLine("}")
            .AppendLine($"Start-Process '{exePath}'")
            .ToString();

        var path = Path.Combine(Settings.Folder, "update.ps1");
        Directory.CreateDirectory(Settings.Folder);
        File.WriteAllText(path, script);
        return path;
    }

    private static string? GitPath()
    {
        var candidates = new List<string>
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Git", "cmd", "git.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Git", "cmd", "git.exe"),
        };

        foreach (var folder in (Environment.GetEnvironmentVariable("PATH") ?? string.Empty).Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(folder))
            {
                candidates.Add(Path.Combine(folder.Trim(), "git.exe"));
            }
        }

        return candidates.FirstOrDefault(File.Exists);
    }

    private static (bool Ok, string Output, string Error) Run(string exe, string arguments, string workingDirectory, int timeoutMs = 15000)
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo(exe, arguments)
            {
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            })!;

            var output = process.StandardOutput.ReadToEnd();
            var error = process.StandardError.ReadToEnd();

            if (!process.WaitForExit(timeoutMs))
            {
                try { process.Kill(true); } catch { }
                return (false, output, "timed out");
            }

            return (process.ExitCode == 0, output, error);
        }
        catch (Exception ex)
        {
            return (false, string.Empty, ex.Message);
        }
    }

    private static string First(string text)
    {
        var line = text.Split('\n', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim();
        return string.IsNullOrEmpty(line) ? "unknown error" : line;
    }
}
