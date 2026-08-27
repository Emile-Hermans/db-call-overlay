using System.Diagnostics;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DbCallOverlay;

internal sealed class MainForm : Form
{
    private readonly Settings _settings;
    private readonly Collector _collector;
    private readonly WebView2 _web = new();
    private readonly Label _status = new();
    private readonly NotifyIcon _tray = new();
    private ToolStripMenuItem _pinItem = null!;
    private bool _reallyClosing;

    public MainForm(Settings settings)
    {
        _settings = settings;
        _collector = new Collector(settings);

        Text = "DB Call Overlay";
        MinimumSize = new Size(560, 340);
        BackColor = Color.FromArgb(0x0d, 0x11, 0x17);
        ForeColor = Color.FromArgb(0xe6, 0xed, 0xf3);
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = true;

        try
        {
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }
        catch
        {
        }

        ApplyGeometry();
        BuildStatus();
        BuildTray();

        Controls.Add(_web);
        _web.Dock = DockStyle.Fill;
        _web.Visible = false;
        _web.DefaultBackgroundColor = Color.FromArgb(0x0d, 0x11, 0x17);

        HandleCreated += (_, _) =>
        {
            Native.ApplyDarkTitleBar(Handle);
            Native.ApplyRoundedCorners(Handle);
        };

        // WinForms does not reliably keep a TopMost set before the window exists,
        // so re-apply it once it is actually on screen.
        Shown += (_, _) => SetAlwaysOnTop(_settings.AlwaysOnTop);

        Load += async (_, _) => await StartAsync();
        FormClosing += OnFormClosing;
        Resize += OnResize;
        Move += OnMoved;
    }

    // ---------------------------------------------------------------- chrome

    private void BuildStatus()
    {
        _status.Dock = DockStyle.Fill;
        _status.TextAlign = ContentAlignment.MiddleCenter;
        _status.Font = new Font("Segoe UI", 10f);
        _status.ForeColor = Color.FromArgb(0x8b, 0x94, 0x9e);
        _status.Text = "Starting collector…";
        Controls.Add(_status);
    }

    private void BuildTray()
    {
        var menu = new ContextMenuStrip();

        menu.Items.Add(new ToolStripMenuItem("Show / hide", null, (_, _) => ToggleVisible()));
        menu.Items.Add(new ToolStripSeparator());

        _pinItem = new ToolStripMenuItem("Always on top", null, (_, _) => SetAlwaysOnTop(!TopMost))
        {
            Checked = _settings.AlwaysOnTop,
            CheckOnClick = false,
        };
        menu.Items.Add(_pinItem);

        var opacity = new ToolStripMenuItem("Opacity");
        foreach (var percent in new[] { 100, 90, 80, 70 })
        {
            opacity.DropDownItems.Add(new ToolStripMenuItem($"{percent} %", null, (_, _) => SetOpacity(percent)));
        }
        menu.Items.Add(opacity);

        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Reload", null, (_, _) => _web.CoreWebView2?.Reload()));
        menu.Items.Add(new ToolStripMenuItem("Clear session", null, async (_, _) => await ClearAsync()));
        menu.Items.Add(new ToolStripMenuItem("Open in browser", null, (_, _) => OpenExternally(_collector.Url)));
        menu.Items.Add(new ToolStripMenuItem("Turn recording setup off", null, (_, _) =>
        {
            Setup.Uninstall();
            PostShellState();
            _tray.ShowBalloonTip(3000, "DB Call Overlay",
                "Recording setup removed. Restart your APIs to stop them reporting.", ToolTipIcon.Info);
        }));
        menu.Items.Add(new ToolStripMenuItem("Copy probe command (advanced)", null, (_, _) => CopyProbeCommand()));
        menu.Items.Add(new ToolStripMenuItem("Reset window", null, (_, _) => ResetWindow()));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Quit", null, (_, _) => QuitForReal()));

        _tray.Icon = Icon;
        _tray.Text = "DB Call Overlay";
        _tray.Visible = true;
        _tray.ContextMenuStrip = menu;
        _tray.DoubleClick += (_, _) => ToggleVisible();
    }

    private void ApplyGeometry()
    {
        Size = new Size(_settings.Width, _settings.Height);

        // First run: sit bottom-right of the primary screen like an overlay should,
        // rather than wherever CenterScreen lands on a multi-monitor desktop.
        Location = _settings.X != -1
            ? new Point(_settings.X, _settings.Y)
            : DefaultCorner();

        if (_settings.Maximized)
        {
            WindowState = FormWindowState.Maximized;
        }

        SetAlwaysOnTop(_settings.AlwaysOnTop);
        SetOpacity(_settings.OpacityPercent);
    }

    // ---------------------------------------------------------------- startup

    private async Task StartAsync()
    {
        try
        {
            await _collector.StartAsync(CancellationToken.None);

            // A hook pointing at a probe that has been moved or deleted would break
            // every dotnet command on this machine. Never leave that lying around.
            if (Setup.RepairIfBroken(_collector.ProbePath()))
            {
                _tray.ShowBalloonTip(4000, "DB Call Overlay",
                    "Recording setup pointed at a probe that no longer exists — it has been repaired.",
                    ToolTipIcon.Info);
            }
        }
        catch (Exception ex)
        {
            _status.Text = "Could not start the collector.";
            MessageBox.Show(this, ex.Message, "DB Call Overlay", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        _status.Text = "Loading…";

        try
        {
            var environment = await CoreWebView2Environment.CreateAsync(
                userDataFolder: Path.Combine(Settings.Folder, "webview"));
            await _web.EnsureCoreWebView2Async(environment);
        }
        catch (Exception ex)
        {
            _status.Text = "WebView2 runtime missing.";
            var answer = MessageBox.Show(
                this,
                "The Microsoft Edge WebView2 runtime is required.\r\n\r\n" +
                "Open the download page?\r\n\r\n" + ex.Message,
                "DB Call Overlay",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning);

            if (answer == DialogResult.Yes)
            {
                OpenExternally("https://developer.microsoft.com/microsoft-edge/webview2/");
            }
            return;
        }

        var core = _web.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false;
        core.Settings.IsZoomControlEnabled = true;

        core.WebMessageReceived += OnWebMessage;
        core.NavigationCompleted += (_, _) =>
        {
            PostShellState();
            // Without this the first click into the window is eaten by focus.
            _web.Focus();
        };
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenExternally(e.Uri);
        };

        _web.Source = new Uri(_collector.Url);
        _web.Visible = true;
        _status.Visible = false;
    }

    // -------------------------------------------------------------- messaging

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string type;
        try
        {
            using var document = JsonDocument.Parse(e.WebMessageAsJson);
            type = document.RootElement.TryGetProperty("type", out var value) ? value.GetString() ?? "" : "";
        }
        catch
        {
            return;
        }

        switch (type)
        {
            case "minimize":
                WindowState = FormWindowState.Minimized;
                break;
            case "close":
                Hide();
                break;
            case "quit":
                QuitForReal();
                break;
            case "toggle-pin":
                SetAlwaysOnTop(!TopMost);
                break;
            case "devtools":
                _web.CoreWebView2?.OpenDevToolsWindow();
                break;
            case "reload":
                _web.CoreWebView2?.Reload();
                break;
            case "setup-install":
                InstallRecording();
                break;
            case "setup-uninstall":
                Setup.Uninstall();
                PostShellState();
                break;
            case "setup-restart":
                RestartApis();
                break;
            case "setup-refresh":
                PostShellState();
                break;
            case "update-check":
                _ = RunUpdateAsync(apply: false);
                break;
            case "update-apply":
                _ = RunUpdateAsync(apply: true);
                break;
        }
    }

    /// <summary>
    /// Talking to a remote takes seconds, so it happens off the UI thread and the
    /// result is posted back to the page when it arrives.
    /// </summary>
    private async Task RunUpdateAsync(bool apply)
    {
        var root = _collector.ToolFolder();
        var exe = Application.ExecutablePath;

        Post(new { type = "update", state = "busy", message = apply ? "Updating…" : "Checking…" });

        var result = await Task.Run(() =>
        {
            if (!apply)
            {
                var status = Updater.Check(root);
                return new
                {
                    type = "update",
                    state = status.Problem is not null ? "problem" : status.Available ? "available" : "current",
                    message = status.Problem
                        ?? (status.Available
                            ? $"{status.Behind} update{(status.Behind == 1 ? "" : "s")} available."
                            : "You have the latest version."),
                    current = status.Current,
                    currentDate = status.CurrentDate,
                    changes = status.Changes,
                    dirty = status.HasLocalChanges,
                    canApply = status.Available && !status.HasLocalChanges && status.Problem is null,
                };
            }

            var (ok, message) = Updater.Apply(root, exe);
            return new
            {
                type = "update",
                state = ok ? "applied" : "problem",
                message,
                current = (string?)null,
                currentDate = (string?)null,
                changes = Array.Empty<string>(),
                dirty = false,
                canApply = false,
            };
        });

        Post(result);

        if (apply && result.state == "applied")
        {
            // The rebuild script is waiting for this process to go away.
            await Task.Delay(1200);
            _reallyClosing = true;
            Close();
        }
    }

    private void Post(object payload)
    {
        try
        {
            if (InvokeRequired)
            {
                BeginInvoke(() => Post(payload));
                return;
            }
            _web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(payload));
        }
        catch
        {
        }
    }

    /// <summary>
    /// True when Visual Studio is open but started before recording was switched
    /// on, so anything it debugs still runs without the recorder.
    /// </summary>
    private bool NeedsVisualStudioRestart()
    {
        var started = Setup.VisualStudioStartedAt();
        if (started is null || !Setup.IsInstalled(_collector.ProbePath()))
        {
            return false;
        }

        // Switched on outside this app (install-hook.ps1) - we have no timestamp to
        // compare, so say nothing rather than nag about a restart that may be done.
        return _settings.SetupInstalledAt is not null && started < _settings.SetupInstalledAt;
    }

    private void InstallRecording()
    {
        var probe = _collector.ProbePath();
        if (probe is null)
        {
            MessageBox.Show(this, "The probe is missing. Run build.ps1 once and reopen the app.",
                "DB Call Overlay", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        try
        {
            Setup.Install(probe);
            _settings.SetupInstalledAt = DateTime.Now;
            _settings.Save();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, "DB Call Overlay", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        PostShellState();
    }

    private void RestartApis()
    {
        var probe = _collector.ProbePath();
        if (probe is null)
        {
            return;
        }

        // Anything Visual Studio is debugging is off limits: stopping it ends the
        // debug session and loses the settings VS passes in, which leaves the API
        // running on the wrong ports with the wrong configuration.
        var apis = Setup.FindApis().Where(a => !a.FromVisualStudio).ToList();
        if (apis.Count == 0)
        {
            MessageBox.Show(this,
                "The APIs that are running were started by Visual Studio.\r\n\r\n" +
                "Stop and start them from Visual Studio instead (Shift+F5, then F5) — this app " +
                "will not touch them.",
                "DB Call Overlay", MessageBoxButtons.OK, MessageBoxIcon.Information);
            PostShellState();
            return;
        }

        var answer = MessageBox.Show(
            this,
            $"Restart {apis.Count} running API{(apis.Count == 1 ? "" : "s")} so they can be recorded?",
            "DB Call Overlay",
            MessageBoxButtons.OKCancel,
            MessageBoxIcon.Question);

        if (answer != DialogResult.OK)
        {
            return;
        }

        var problems = apis
            .Select(api => Setup.Restart(api, probe))
            .Where(result => !result.Ok)
            .Select(result => result.Message)
            .ToList();

        if (problems.Count > 0)
        {
            MessageBox.Show(this,
                "Some APIs could not be restarted from here - start them the way you normally do:\r\n\r\n" +
                string.Join("\r\n", problems),
                "DB Call Overlay", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        PostShellState();
    }

    private void PostShellState()
    {
        try
        {
            var probe = _collector.ProbePath();
            var payload = JsonSerializer.Serialize(new
            {
                type = "shell",
                pinned = TopMost,
                opacity = _settings.OpacityPercent,
                attached = _collector.Attached,
                setup = new
                {
                    installed = Setup.IsInstalled(probe),
                    probeMissing = probe is null,
                    visualStudioOpen = Setup.VisualStudioStartedAt() is not null,
                    // The single most common reason nothing is recorded: VS was
                    // already open when recording was switched on.
                    visualStudioNeedsRestart = NeedsVisualStudioRestart(),
                    apis = Setup.FindApis().Select(a => new
                    {
                        pid = a.Pid,
                        name = a.Name,
                        fromVisualStudio = a.FromVisualStudio,
                    }),
                },
            });
            _web.CoreWebView2?.PostWebMessageAsJson(payload);
        }
        catch
        {
        }
    }

    // ---------------------------------------------------------------- actions

    private void SetAlwaysOnTop(bool value)
    {
        TopMost = value;
        _settings.AlwaysOnTop = value;
        if (_pinItem is not null)
        {
            _pinItem.Checked = value;
        }
        PostShellState();
    }

    private void SetOpacity(int percent)
    {
        _settings.OpacityPercent = Math.Clamp(percent, 40, 100);
        Opacity = _settings.OpacityPercent / 100d;
        PostShellState();
    }

    private async Task ClearAsync()
    {
        try
        {
            using var client = new System.Net.Http.HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            await client.PostAsync($"{_collector.Url}/api/clear", new StringContent("{}"));
        }
        catch
        {
        }
    }

    private void CopyProbeCommand()
    {
        var probe = _collector.ProbePath();
        if (probe is null)
        {
            MessageBox.Show(this, "Probe not built yet — run build.ps1 first.", "DB Call Overlay");
            return;
        }

        Clipboard.SetText($"$env:DOTNET_STARTUP_HOOKS='{probe}'; $env:DBPROBE_APPS='WebApi.'");
        _tray.ShowBalloonTip(2500, "DB Call Overlay",
            "Probe command copied — paste it before starting an API.", ToolTipIcon.Info);
    }

    private Point DefaultCorner()
    {
        var work = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1920, 1080);
        return new Point(
            Math.Max(work.Right - Width - 24, work.Left),
            Math.Max(work.Bottom - Height - 24, work.Top));
    }

    private void ResetWindow()
    {
        WindowState = FormWindowState.Normal;
        Size = new Size(1180, 640);
        Location = DefaultCorner();
        SetOpacity(100);
        Show();
        Activate();
    }

    private void ToggleVisible()
    {
        if (Visible && WindowState != FormWindowState.Minimized)
        {
            Hide();
            return;
        }
        RestoreWindow();
    }

    public void RestoreWindow()
    {
        Show();
        if (WindowState == FormWindowState.Minimized)
        {
            WindowState = _settings.Maximized ? FormWindowState.Maximized : FormWindowState.Normal;
        }
        Activate();
        BringToFront();
        SetAlwaysOnTop(_settings.AlwaysOnTop);
    }

    private static void OpenExternally(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch
        {
        }
    }

    private void QuitForReal()
    {
        _reallyClosing = true;
        Close();
    }

    // ----------------------------------------------------------------- state

    private void OnResize(object? sender, EventArgs e)
    {
        if (WindowState == FormWindowState.Normal)
        {
            _settings.Width = Width;
            _settings.Height = Height;
        }
        _settings.Maximized = WindowState == FormWindowState.Maximized;
    }

    private void OnMoved(object? sender, EventArgs e)
    {
        if (WindowState == FormWindowState.Normal)
        {
            _settings.X = Left;
            _settings.Y = Top;
        }
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        // Closing the window (X, Alt+F4) parks the app in the tray so a recording
        // is not lost by accident. Shutdown and Task Manager really do end it.
        var mustExit = _reallyClosing
            || e.CloseReason is CloseReason.WindowsShutDown
                or CloseReason.ApplicationExitCall
                or CloseReason.TaskManagerClosing;

        if (!mustExit)
        {
            e.Cancel = true;
            Hide();

            if (!_settings.TrayHintShown)
            {
                _settings.TrayHintShown = true;
                _settings.Save();
                _tray.ShowBalloonTip(4000, "Still recording",
                    "DB Call Overlay is in the tray — double-click the icon to bring it back, or right-click to quit.",
                    ToolTipIcon.Info);
            }
            return;
        }

        _settings.Save();
        _tray.Visible = false;
        _tray.Dispose();
        _collector.Dispose();
    }
}
