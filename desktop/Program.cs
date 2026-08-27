using System.Threading;

namespace DbCallOverlay;

internal static class Program
{
    private const string INSTANCE_MUTEX = @"Local\DbCallOverlay.Instance";
    private const string SHOW_EVENT = @"Local\DbCallOverlay.Show";

    [STAThread]
    private static void Main()
    {
        using var mutex = new Mutex(true, INSTANCE_MUTEX, out var isFirstInstance);

        if (!isFirstInstance)
        {
            // Already running: ask that instance to come forward, then leave.
            if (EventWaitHandle.TryOpenExisting(SHOW_EVENT, out var existing))
            {
                existing.Set();
                existing.Dispose();
            }
            return;
        }

        ApplicationConfiguration.Initialize();

        var settings = Settings.Load();
        var form = new MainForm(settings);

        using var show = new EventWaitHandle(false, EventResetMode.AutoReset, SHOW_EVENT);
        StartActivationListener(show, form);

        Application.Run(form);
    }

    /// <summary>Brings the window forward when a second launch is attempted.</summary>
    private static void StartActivationListener(EventWaitHandle show, MainForm form)
    {
        var thread = new Thread(() =>
        {
            while (true)
            {
                show.WaitOne();
                try
                {
                    if (form.IsDisposed)
                    {
                        return;
                    }
                    form.BeginInvoke(form.RestoreWindow);
                }
                catch
                {
                    return;
                }
            }
        })
        {
            IsBackground = true,
            Name = "activation-listener",
        };

        thread.Start();
    }
}
