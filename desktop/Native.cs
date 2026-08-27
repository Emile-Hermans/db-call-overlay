using System.Runtime.InteropServices;

namespace DbCallOverlay;

/// <summary>Windows 11 window dressing: dark title bar and rounded corners.</summary>
internal static class Native
{
    private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    private const int DWMWA_USE_IMMERSIVE_DARK_MODE_BEFORE_20H1 = 19;
    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMWCP_ROUND = 2;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

    public static void ApplyDarkTitleBar(IntPtr window)
    {
        if (window == IntPtr.Zero)
        {
            return;
        }

        var enabled = 1;
        try
        {
            if (DwmSetWindowAttribute(window, DWMWA_USE_IMMERSIVE_DARK_MODE, ref enabled, sizeof(int)) != 0)
            {
                DwmSetWindowAttribute(window, DWMWA_USE_IMMERSIVE_DARK_MODE_BEFORE_20H1, ref enabled, sizeof(int));
            }
        }
        catch
        {
            // older Windows - the light title bar is cosmetic, not fatal
        }
    }

    public static void ApplyRoundedCorners(IntPtr window)
    {
        if (window == IntPtr.Zero)
        {
            return;
        }

        var preference = DWMWCP_ROUND;
        try
        {
            DwmSetWindowAttribute(window, DWMWA_WINDOW_CORNER_PREFERENCE, ref preference, sizeof(int));
        }
        catch
        {
        }
    }
}
