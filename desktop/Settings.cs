using System.Text.Json;

namespace DbCallOverlay;

/// <summary>Window geometry and preferences, kept in LOCALAPPDATA.</summary>
internal sealed class Settings
{
    public int X { get; set; } = -1;
    public int Y { get; set; } = -1;
    public int Width { get; set; } = 1180;
    public int Height { get; set; } = 640;
    public bool Maximized { get; set; }
    public bool AlwaysOnTop { get; set; } = true;
    public int OpacityPercent { get; set; } = 100;
    public int UiPort { get; set; } = 8478;
    public int IngestPort { get; set; } = 8477;

    /// <summary>
    /// When recording was switched on. A Visual Studio that started before this
    /// cannot pass the recorder to the projects it debugs.
    /// </summary>
    public DateTime? SetupInstalledAt { get; set; }

    private static readonly JsonSerializerOptions _json = new() { WriteIndented = true };

    public static string Folder { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "DbCallOverlay");

    private static string File => Path.Combine(Folder, "settings.json");

    public static Settings Load()
    {
        try
        {
            if (System.IO.File.Exists(File))
            {
                var loaded = JsonSerializer.Deserialize<Settings>(System.IO.File.ReadAllText(File));
                if (loaded is not null)
                {
                    return loaded.Sanitised();
                }
            }
        }
        catch
        {
            // a corrupt settings file must never stop the app from opening
        }

        return new Settings();
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Folder);
            System.IO.File.WriteAllText(File, JsonSerializer.Serialize(this, _json));
        }
        catch
        {
        }
    }

    /// <summary>Keeps the window on a screen that actually exists.</summary>
    private Settings Sanitised()
    {
        Width = Math.Clamp(Width, 520, 6000);
        Height = Math.Clamp(Height, 320, 4000);
        OpacityPercent = Math.Clamp(OpacityPercent, 40, 100);

        if (X != -1 || Y != -1)
        {
            var visible = new Rectangle(X, Y, Width, Height);
            if (!Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(visible)))
            {
                X = -1;
                Y = -1;
            }
        }

        return this;
    }
}
