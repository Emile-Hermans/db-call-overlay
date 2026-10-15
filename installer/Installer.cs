using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;

namespace ClicktraceSetup
{
    /// <summary>
    /// Installs the payload for the current user: files, shortcuts, an entry in
    /// Installed apps, and an uninstall script that undoes all of it - including
    /// switching recording off, because a startup hook pointing at a deleted file
    /// stops every dotnet command on the machine.
    /// </summary>
    internal sealed class Installer
    {
        public const string AppName = "Clicktrace";
        public const string AppExe = "DbCallOverlay.exe";
        private const string AppProcess = "DbCallOverlay";
        private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Clicktrace";
        private const string Manifest = "install-files.txt";
        private const string ProbeFile = @"probe\DbProbe.dll";

        public string Dir { get; }
        public bool Shortcuts { get; set; } = true;
        public bool DesktopShortcut { get; set; } = true;
        public bool Register { get; set; } = true;

        /// <summary>Anything worth telling the user that did not stop the install.</summary>
        public List<string> Notes { get; } = new List<string>();

        public Installer(string dir) => Dir = Path.GetFullPath(dir.TrimEnd('\\', '/'));

        public static string DefaultDir => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", AppName);

        public static string Version =>
            Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion?.Split('+')[0]
            ?? Assembly.GetExecutingAssembly().GetName().Version.ToString(3);

        /// <summary>The version already installed for this user, if any.</summary>
        public static string InstalledVersion()
        {
            using (var key = Registry.CurrentUser.OpenSubKey(UninstallKey))
            {
                return key?.GetValue("DisplayVersion") as string;
            }
        }

        public static string InstalledDir()
        {
            using (var key = Registry.CurrentUser.OpenSubKey(UninstallKey))
            {
                return key?.GetValue("InstallLocation") as string;
            }
        }

        public void Run(Action<int, string> progress)
        {
            Log.Write($"install {Version} to {Dir}");
            progress(2, "Closing Clicktrace if it is running…");
            StopRunningApp();

            Directory.CreateDirectory(Dir);
            var previous = ReadManifest();
            var written = new List<string>();

            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            {
                if (stream == null) throw new InvalidOperationException("This setup has no payload. It was built incorrectly.");
                using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
                {
                    var files = zip.Entries.Where((e) => !string.IsNullOrEmpty(e.Name)).ToList();
                    for (var i = 0; i < files.Count; i++)
                    {
                        var entry = files[i];
                        if (i % 20 == 0) progress(5 + (int)(85.0 * i / files.Count), $"Copying files… {i} of {files.Count}");
                        var relative = entry.FullName.Replace('/', '\\');
                        Extract(entry, relative);
                        written.Add(relative);
                    }
                }
            }

            progress(92, "Tidying up…");
            // Files a previous version installed that this one no longer has.
            foreach (var stale in previous.Except(written, StringComparer.OrdinalIgnoreCase))
            {
                TryDelete(Path.Combine(Dir, stale));
            }
            File.WriteAllLines(Path.Combine(Dir, Manifest), written);

            File.WriteAllText(Path.Combine(Dir, "uninstall.ps1"), UninstallScript(), new UTF8Encoding(true));

            if (Shortcuts)
            {
                progress(95, "Creating shortcuts…");
                CreateShortcut(StartMenuShortcut);
                if (DesktopShortcut) CreateShortcut(DesktopShortcutPath);
                else TryDelete(DesktopShortcutPath);
            }

            if (Register)
            {
                progress(98, "Registering with Windows…");
                RegisterUninstall(written);
            }

            progress(100, "Done.");
            Log.Write("install finished");
        }

        private void Extract(ZipArchiveEntry entry, string relative)
        {
            var target = Path.GetFullPath(Path.Combine(Dir, relative));
            // A crafted archive must not write outside the install folder.
            if (!target.StartsWith(Dir + "\\", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"Refusing to write outside the install folder: {relative}");

            Directory.CreateDirectory(Path.GetDirectoryName(target));
            try
            {
                entry.ExtractToFile(target, overwrite: true);
            }
            catch (IOException) when (File.Exists(target))
            {
                // Locked. Fine if it is already this exact file.
                if (SameContent(entry, target)) return;

                // The recorder is loaded into every .NET app started while recording is
                // on, and Windows does not let a loaded file be replaced. The old one
                // keeps working; it updates the next time setup runs with those closed.
                if (relative.Equals(ProbeFile, StringComparison.OrdinalIgnoreCase))
                {
                    Notes.Add("The recorder is in use by .NET apps that are being recorded, so it was left at its previous " +
                              "version. Close those apps and run setup again to update it.");
                    Log.Write("probe locked, kept previous version");
                    return;
                }
                throw new IOException($"{relative} is in use by another program. Close it and run setup again.");
            }
        }

        private static bool SameContent(ZipArchiveEntry entry, string file)
        {
            try
            {
                if (new FileInfo(file).Length != entry.Length) return false;
                using (var sha = SHA256.Create())
                using (var a = entry.Open())
                using (var b = File.Open(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    return sha.ComputeHash(a).SequenceEqual(SHA256.Create().ComputeHash(b));
                }
            }
            catch
            {
                return false;
            }
        }

        private List<string> ReadManifest()
        {
            var file = Path.Combine(Dir, Manifest);
            return File.Exists(file) ? File.ReadAllLines(file).Where((l) => l.Length > 0).ToList() : new List<string>();
        }

        /// <summary>
        /// The app starts an update and then closes itself; give it the time to do
        /// that cleanly before anything is forced.
        /// </summary>
        public void WaitForAppToClose(TimeSpan timeout)
        {
            var deadline = DateTime.UtcNow + timeout;
            while (DateTime.UtcNow < deadline && OwnProcesses(AppProcess).Any())
            {
                System.Threading.Thread.Sleep(250);
            }
        }

        /// <summary>Processes of this name running from this install folder.</summary>
        private IEnumerable<Process> OwnProcesses(string name)
        {
            foreach (var process in Process.GetProcessesByName(name))
            {
                string path;
                try { path = process.MainModule?.FileName ?? ""; }
                catch { continue; }
                if (path.StartsWith(Dir + "\\", StringComparison.OrdinalIgnoreCase)) yield return process;
            }
        }

        private void StopRunningApp()
        {
            foreach (var process in OwnProcesses(AppProcess))
            {
                try
                {
                    Log.Write($"closing running app, pid {process.Id}");
                    process.CloseMainWindow();
                    if (!process.WaitForExit(5000)) process.Kill();
                    process.WaitForExit(5000);
                }
                catch (Exception e)
                {
                    Log.Write($"could not close pid {process.Id}: {e.Message}");
                }
            }

            // The app's collector runs on the bundled node.exe. Closing the app stops
            // it, but a straggler would hold node.exe open while it is replaced.
            foreach (var node in OwnProcesses("node"))
            {
                try
                {
                    Log.Write($"stopping collector, pid {node.Id}");
                    node.Kill();
                    node.WaitForExit(5000);
                }
                catch (Exception e)
                {
                    Log.Write($"could not stop pid {node.Id}: {e.Message}");
                }
            }
        }

        private static void TryDelete(string file)
        {
            try
            {
                if (File.Exists(file)) File.Delete(file);
            }
            catch (Exception e)
            {
                Log.Write($"could not delete {file}: {e.Message}");
            }
        }

        // ------------------------------------------------------------ shortcuts

        public static string StartMenuShortcut => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", AppName + ".lnk");

        public static string DesktopShortcutPath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk");

        private void CreateShortcut(string path)
        {
            var exe = Path.Combine(Dir, AppExe);
            dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
            dynamic link = shell.CreateShortcut(path);
            link.TargetPath = exe;
            link.WorkingDirectory = Dir;
            link.IconLocation = exe + ",0";
            link.Description = "Clicktrace - what every click in your app costs the database, and why it is slow";
            link.Save();
            Log.Write($"shortcut {path}");
        }

        // ------------------------------------------------------------ registry

        private void RegisterUninstall(List<string> files)
        {
            long bytes = 0;
            foreach (var f in files)
            {
                try { bytes += new FileInfo(Path.Combine(Dir, f)).Length; } catch { /* sizing is cosmetic */ }
            }

            using (var key = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                key.SetValue("DisplayName", AppName);
                key.SetValue("DisplayVersion", Version);
                key.SetValue("Publisher", AppName);
                key.SetValue("DisplayIcon", Path.Combine(Dir, AppExe) + ",0");
                key.SetValue("InstallLocation", Dir);
                key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
                key.SetValue("UninstallString",
                    $"powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{Path.Combine(Dir, "uninstall.ps1")}\"");
                key.SetValue("QuietUninstallString",
                    $"powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{Path.Combine(Dir, "uninstall.ps1")}\" -Quiet");
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                key.SetValue("EstimatedSize", (int)(bytes / 1024), RegistryValueKind.DWord);
            }
        }

        // ------------------------------------------------------------ uninstall

        /// <summary>
        /// Written into the install folder rather than kept in this exe, so removing
        /// the app never needs the (large) setup file to still be around.
        /// </summary>
        private string UninstallScript()
        {
            string Quote(string s) => "'" + s.Replace("'", "''") + "'";
            return $@"# Removes Clicktrace for this user. Written by ClicktraceSetup {Version}.
# Recordings and settings in %LOCALAPPDATA%\DbCallOverlay are kept.
param([switch]$Quiet)
$ErrorActionPreference = 'Continue'
$dir = {Quote(Dir)}
Add-Type -AssemblyName System.Windows.Forms

function Say($text, $icon = 'Information') {{
    if (-not $Quiet) {{ [System.Windows.Forms.MessageBox]::Show($text, 'Clicktrace', 'OK', $icon) | Out-Null }}
}}

if (-not $Quiet) {{
    $answer = [System.Windows.Forms.MessageBox]::Show(""Remove Clicktrace?`n`nYour recordings and settings are kept."", 'Clicktrace', 'OKCancel', 'Question')
    if ($answer -ne 'OK') {{ return }}
}}

# Close the app (it stops its own collector).
Get-Process DbCallOverlay -ErrorAction SilentlyContinue |
    Where-Object {{ $_.Path -and $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) }} |
    ForEach-Object {{ $_.CloseMainWindow() | Out-Null; if (-not $_.WaitForExit(5000)) {{ $_.Kill() }} }}

# Switch recording off first: a startup hook pointing at a deleted file stops
# every dotnet command on this machine.
$hook = [Environment]::GetEnvironmentVariable('DOTNET_STARTUP_HOOKS', 'User')
if ($hook -and $hook.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase)) {{
    [Environment]::SetEnvironmentVariable('DOTNET_STARTUP_HOOKS', $null, 'User')
    [Environment]::SetEnvironmentVariable('DBPROBE_APPS', $null, 'User')
}}

$shell = New-Object -ComObject WScript.Shell
foreach ($link in @({Quote(StartMenuShortcut)}, {Quote(DesktopShortcutPath)})) {{
    if ((Test-Path $link) -and $shell.CreateShortcut($link).TargetPath.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase)) {{
        Remove-Item $link -Force
    }}
}}

Remove-Item 'HKCU:\{UninstallKey}' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue

if (Test-Path $dir) {{
    Say ""Clicktrace was removed, but some files are still in use and stay behind in:`n$dir`n`nThe recorder is loaded in .NET apps that were started while recording was on. Close those apps (or sign out), then delete the folder."" 'Warning'
}} else {{
    Say 'Clicktrace was removed. Your recordings and settings are kept in %LOCALAPPDATA%\DbCallOverlay.'
}}
";
        }
    }

    internal static class Log
    {
        public static readonly string File = Path.Combine(Path.GetTempPath(), "ClicktraceSetup.log");

        public static void Write(string line)
        {
            try { System.IO.File.AppendAllText(File, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss}  {line}\r\n"); }
            catch { /* logging must never stop an install */ }
        }
    }
}
