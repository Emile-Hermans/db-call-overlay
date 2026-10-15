using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ClicktraceSetup
{
    internal static class Program
    {
        // ClicktraceSetup.exe                     the window
        // ClicktraceSetup.exe /silent             install with defaults, no window
        //   /dir=<folder>   install somewhere else
        //   /noshortcuts    no Start menu or Desktop shortcut
        //   /noregister     no entry in Installed apps
        //   /run            open Clicktrace afterwards
        // ClicktraceSetup.exe /update /dir=<folder>
        //   what the app's Update button runs: no window, waits for the app to
        //   close, opens it again afterwards, and says so if anything fails
        [STAThread]
        private static int Main(string[] args)
        {
            string Arg(string name) =>
                args.FirstOrDefault((a) => a.StartsWith("/" + name + "=", StringComparison.OrdinalIgnoreCase))?.Substring(name.Length + 2);
            bool Flag(string name) => args.Any((a) => a.Equals("/" + name, StringComparison.OrdinalIgnoreCase));

            var dir = Arg("dir") ?? Installer.InstalledDir() ?? Installer.DefaultDir;

            if (Flag("update"))
            {
                var installer = new Installer(dir);
                try
                {
                    installer.WaitForAppToClose(TimeSpan.FromSeconds(20));
                    installer.Run((_, status) => Log.Write(status));
                    foreach (var note in installer.Notes) Log.Write("note: " + note);
                    Launch(installer.Dir);
                    return 0;
                }
                catch (Exception e)
                {
                    Log.Write("FAILED: " + e);
                    MessageBox.Show(
                        "The update could not be installed: " + e.Message + "\r\n\r\nClicktrace was left as it was. " +
                        "Details are in " + Log.File,
                        "Clicktrace", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    try { Launch(installer.Dir); } catch { /* nothing more to do */ }
                    return 1;
                }
            }

            if (Flag("silent"))
            {
                try
                {
                    var installer = new Installer(dir) { Shortcuts = !Flag("noshortcuts"), Register = !Flag("noregister") };
                    installer.Run((_, status) => Log.Write(status));
                    foreach (var note in installer.Notes) Log.Write("note: " + note);
                    if (Flag("run")) Launch(installer.Dir);
                    return 0;
                }
                catch (Exception e)
                {
                    Log.Write("FAILED: " + e);
                    return 1;
                }
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm(dir));
            return 0;
        }

        public static void Launch(string dir)
        {
            Process.Start(new ProcessStartInfo(Path.Combine(dir, Installer.AppExe)) { WorkingDirectory = dir, UseShellExecute = true });
        }
    }

    internal sealed class SetupForm : Form
    {
        private static readonly Color Accent = Color.FromArgb(0x5b, 0x46, 0xf0);
        private static readonly Color Ink2 = Color.FromArgb(0x4a, 0x51, 0x63);

        private string _dir;
        private readonly Label _status = new Label();
        private readonly Label _folder = new Label();
        private readonly ProgressBar _progress = new ProgressBar();
        private readonly CheckBox _desktop = new CheckBox();
        private readonly Button _primary = new Button();
        private readonly Button _secondary = new Button();
        private readonly LinkLabel _change = new LinkLabel();
        private bool _done;

        public SetupForm(string dir)
        {
            _dir = dir;
            var existing = Installer.InstalledVersion();

            Text = $"Clicktrace {Installer.Version} Setup";
            Font = new Font("Segoe UI", 9.75f);
            BackColor = Color.White;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoScaleDimensions = new SizeF(96f, 96f);
            ClientSize = new Size(540, 330);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { /* cosmetic */ }

            var logo = new PictureBox { Location = new Point(28, 26), Size = new Size(48, 48), SizeMode = PictureBoxSizeMode.Zoom };
            try { logo.Image = new Icon(Icon, 48, 48).ToBitmap(); } catch { /* cosmetic */ }

            var title = new Label
            {
                Text = "Clicktrace",
                Font = new Font("Segoe UI Semibold", 17f),
                Location = new Point(88, 22),
                AutoSize = true,
            };
            var tagline = new Label
            {
                Text = "Know exactly what a click does — and why it is slow.",
                ForeColor = Ink2,
                Location = new Point(90, 56),
                AutoSize = true,
            };

            var body = new Label
            {
                Text = (existing != null
                           ? $"Clicktrace {existing} is installed. This updates it to {Installer.Version} — your recordings and settings are kept.\r\n\r\n"
                           : $"Installs Clicktrace {Installer.Version} for {Environment.UserName} only — no administrator rights needed.\r\n\r\n") +
                       "Everything it needs is included: its own .NET runtime, Node.js and the recorder. Nothing else on this machine is changed until you press \"Switch recording on\" in the app.",
                Location = new Point(30, 100),
                Size = new Size(480, 96),
            };

            _folder.Location = new Point(30, 200);
            _folder.Size = new Size(400, 20);
            _folder.ForeColor = Ink2;
            _folder.AutoEllipsis = true;
            _change.Text = "Change…";
            _change.LinkColor = Accent;
            _change.Location = new Point(440, 200);
            _change.AutoSize = true;
            _change.LinkClicked += (_, __) => ChooseFolder();
            PaintFolder();

            _desktop.Text = "Put a shortcut on the Desktop";
            _desktop.Checked = true;
            _desktop.Location = new Point(30, 226);
            _desktop.AutoSize = true;

            _progress.Location = new Point(30, 228);
            _progress.Size = new Size(480, 8);
            _progress.Visible = false;

            _status.Location = new Point(30, 244);
            _status.Size = new Size(480, 40);
            _status.ForeColor = Ink2;

            var footer = new Panel { Dock = DockStyle.Bottom, Height = 56, BackColor = Color.FromArgb(0xf3, 0xf4, 0xf8) };
            _primary.Text = existing != null ? "Update" : "Install";
            _primary.Size = new Size(120, 32);
            _primary.Location = new Point(ClientSize.Width - 30 - 120, 12);
            _primary.FlatStyle = FlatStyle.Flat;
            _primary.FlatAppearance.BorderSize = 0;
            _primary.BackColor = Accent;
            _primary.ForeColor = Color.White;
            _primary.Font = new Font("Segoe UI Semibold", 9.75f);
            _primary.Click += async (_, __) => await Primary();

            _secondary.Text = "Cancel";
            _secondary.Size = new Size(100, 32);
            _secondary.Location = new Point(_primary.Left - 10 - 100, 12);
            _secondary.FlatStyle = FlatStyle.System;
            _secondary.Click += (_, __) => Close();
            footer.Controls.Add(_primary);
            footer.Controls.Add(_secondary);

            Controls.AddRange(new Control[] { logo, title, tagline, body, _folder, _change, _desktop, _progress, _status, footer });
            AcceptButton = _primary;
            CancelButton = _secondary;
        }

        private void PaintFolder() => _folder.Text = "Folder: " + _dir;

        private void ChooseFolder()
        {
            using (var dialog = new FolderBrowserDialog { Description = "Install Clicktrace in", SelectedPath = _dir })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                // Installing into a chosen folder: keep it in its own subfolder, so the
                // uninstaller can remove the whole folder without touching anything else.
                _dir = Path.GetFileName(dialog.SelectedPath).Equals("Clicktrace", StringComparison.OrdinalIgnoreCase)
                    ? dialog.SelectedPath
                    : Path.Combine(dialog.SelectedPath, "Clicktrace");
                PaintFolder();
            }
        }

        private async Task Primary()
        {
            if (_done)
            {
                Program.Launch(_dir);
                Close();
                return;
            }

            _primary.Enabled = false;
            _secondary.Enabled = false;
            _change.Visible = false;
            _desktop.Visible = false;
            _progress.Visible = true;

            var installer = new Installer(_dir) { DesktopShortcut = _desktop.Checked };
            try
            {
                await Task.Run(() => installer.Run((pct, status) => BeginInvoke((Action)(() =>
                {
                    _progress.Value = Math.Max(0, Math.Min(100, pct));
                    _status.Text = status;
                }))));
            }
            catch (Exception e)
            {
                Log.Write("FAILED: " + e);
                _status.ForeColor = Color.FromArgb(0xd4, 0x2f, 0x36);
                _status.Text = "Setup did not finish: " + e.Message;
                _secondary.Text = "Close";
                _secondary.Enabled = true;
                _primary.Text = "Try again";
                _primary.Enabled = true;
                return;
            }

            _done = true;
            _status.ForeColor = Color.FromArgb(0x12, 0x80, 0x4d);
            _status.Text = "Clicktrace is installed. Find it in the Start menu." +
                           (installer.Notes.Count > 0 ? "\r\n" + string.Join("\r\n", installer.Notes) : "");
            if (installer.Notes.Count > 0) _status.ForeColor = Color.FromArgb(0xb2, 0x6f, 0x00);
            _primary.Text = "Open Clicktrace";
            _primary.Width = 140;
            _primary.Left = ClientSize.Width - 30 - 140;
            _primary.Enabled = true;
            _secondary.Text = "Close";
            _secondary.Left = _primary.Left - 10 - 100;
            _secondary.Enabled = true;
            _primary.Focus();
        }
    }
}
