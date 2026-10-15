using System.Diagnostics;
using System.Net.Http.Headers;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace DbCallOverlay;

/// <summary>
/// Updates a copy that was installed with ClicktraceSetup.exe rather than cloned.
///
/// It asks GitHub for the latest release, and if that is newer, downloads the
/// setup attached to it, checks it against the SHA-256 published with the
/// release, and runs it over this install. The setup closes this app, replaces
/// the files and opens it again; recordings and settings live elsewhere and are
/// not touched.
///
/// A download whose checksum cannot be established is never run.
/// </summary>
internal static class ReleaseUpdater
{
    /// <summary>Where releases are published. Overridable for a fork.</summary>
    private static string Repository =>
        Environment.GetEnvironmentVariable("CLICKTRACE_RELEASES") is { Length: > 0 } custom
            ? custom
            : "Emile-Hermans/db-call-overlay";

    private static readonly Regex SetupAsset = new(@"^ClicktraceSetup-[\w.\-]+\.exe$", RegexOptions.IgnoreCase);
    private static readonly Regex Sha256 = new(@"\b[0-9a-fA-F]{64}\b");

    /// <summary>The version this copy was built as, without any build metadata.</summary>
    public static string CurrentVersion =>
        (Assembly.GetEntryAssembly()?.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
         ?? Assembly.GetEntryAssembly()?.GetName().Version?.ToString(3)
         ?? "0.0.0").Split('+')[0];

    private sealed record Release(string Version, string Tag, string[] Notes, string SetupUrl, string SetupName, long Size, string? Sha256);

    public static UpdateStatus Check()
    {
        var current = CurrentVersion;
        try
        {
            var release = Latest();
            if (release is null)
            {
                return new UpdateStatus(false, false, $"v{current}", null, 0, [], false, null,
                    Message: "You have the latest version — no newer release has been published.");
            }

            var newer = IsNewer(release.Version, current);
            return new UpdateStatus(false, newer, $"v{current}", null, 0, newer ? release.Notes : [], false,
                release.Sha256 is null && newer
                    ? $"Version {release.Version} is out, but its release has no SHA-256 to check the download against, so it will not be installed automatically. Download it from GitHub instead."
                    : null,
                Latest: release.Version);
        }
        catch (Exception ex)
        {
            return new UpdateStatus(false, false, $"v{current}", null, 0, [], false,
                $"Could not reach GitHub to check for updates: {ex.Message}");
        }
    }

    public static (bool Ok, string Message) Apply()
    {
        Release? release;
        try
        {
            release = Latest();
        }
        catch (Exception ex)
        {
            return (false, $"Could not reach GitHub: {ex.Message}");
        }

        if (release is null || !IsNewer(release.Version, CurrentVersion)) return (false, "Already up to date.");
        if (release.Sha256 is null) return (false, "This release has no SHA-256 to check the download against, so it is not installed automatically.");

        var folder = Path.Combine(Path.GetTempPath(), "Clicktrace-update");
        Directory.CreateDirectory(folder);
        var file = Path.Combine(folder, release.SetupName);

        try
        {
            using (var client = Client(TimeSpan.FromMinutes(10)))
            using (var response = client.GetAsync(release.SetupUrl, HttpCompletionOption.ResponseHeadersRead).GetAwaiter().GetResult())
            {
                response.EnsureSuccessStatusCode();
                using var output = File.Create(file);
                response.Content.CopyToAsync(output).GetAwaiter().GetResult();
            }

            string actual;
            using (var stream = File.OpenRead(file))
            {
                actual = Convert.ToHexString(SHA256.HashData(stream));
            }

            if (!actual.Equals(release.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                File.Delete(file);
                return (false, $"The download does not match the release's SHA-256, so it was deleted and nothing was changed.");
            }

            // The setup waits for this app to close, replaces the files and opens it again.
            var installDir = AppContext.BaseDirectory.TrimEnd('\\', '/');
            Process.Start(new ProcessStartInfo(file)
            {
                ArgumentList = { "/update", $"/dir={installDir}" },
                UseShellExecute = false,
            });
        }
        catch (Exception ex)
        {
            return (false, $"Update stopped, nothing was changed: {ex.Message}");
        }

        return (true, $"Installing version {release.Version}… Clicktrace restarts by itself in a few seconds.");
    }

    // ------------------------------------------------------------------ GitHub

    private static HttpClient Client(TimeSpan timeout)
    {
        var client = new HttpClient { Timeout = timeout };
        client.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("Clicktrace", CurrentVersion));
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        return client;
    }

    /// <summary>The latest published release with a setup attached, or null if there is none.</summary>
    private static Release? Latest()
    {
        using var client = Client(TimeSpan.FromSeconds(20));
        // CLICKTRACE_RELEASES_API replaces the whole URL; tools/updatetest uses it to
        // point the check at a local server instead of GitHub.
        var url = Environment.GetEnvironmentVariable("CLICKTRACE_RELEASES_API") is { Length: > 0 } api
            ? api
            : $"https://api.github.com/repos/{Repository}/releases/latest";
        using var response = client.GetAsync(url).GetAwaiter().GetResult();
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();

        using var doc = JsonDocument.Parse(response.Content.ReadAsStringAsync().GetAwaiter().GetResult());
        var root = doc.RootElement;
        var tag = root.GetProperty("tag_name").GetString() ?? "";
        var assets = root.GetProperty("assets").EnumerateArray().ToList();

        var setup = assets.FirstOrDefault(a => SetupAsset.IsMatch(a.GetProperty("name").GetString() ?? ""));
        if (setup.ValueKind != JsonValueKind.Object) return null;
        var setupName = setup.GetProperty("name").GetString()!;

        // GitHub records a digest for every uploaded asset; a "<setup>.sha256" file
        // attached to the release is accepted as well.
        string? sha = null;
        if (setup.TryGetProperty("digest", out var digest) && digest.GetString() is { } d && d.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase))
        {
            sha = d["sha256:".Length..];
        }
        if (sha is null)
        {
            var sidecar = assets.FirstOrDefault(a =>
                string.Equals(a.GetProperty("name").GetString(), setupName + ".sha256", StringComparison.OrdinalIgnoreCase));
            if (sidecar.ValueKind == JsonValueKind.Object)
            {
                var text = client.GetStringAsync(sidecar.GetProperty("browser_download_url").GetString()).GetAwaiter().GetResult();
                sha = Sha256.Match(text) is { Success: true } m ? m.Value : null;
            }
        }

        var notes = (root.TryGetProperty("body", out var body) ? body.GetString() ?? "" : "")
            .Split('\n')
            .Select(l => l.Trim())
            .Where(l => l.StartsWith("- ") || l.StartsWith("* "))
            .Select(l => l[2..].Replace("**", "").Trim())
            .Take(10)
            .ToArray();

        return new Release(
            tag.TrimStart('v', 'V'),
            tag,
            notes,
            setup.GetProperty("browser_download_url").GetString()!,
            setupName,
            setup.GetProperty("size").GetInt64(),
            sha);
    }

    internal static bool IsNewer(string candidate, string current) =>
        System.Version.TryParse(candidate, out var a) && System.Version.TryParse(current, out var b) && a > b;
}
