using System.Text.Json;

namespace DbCallOverlay;

/// <summary>
/// The bits of Properties\launchSettings.json that decide whether a restarted API
/// comes back correctly: ASPNETCORE_ENVIRONMENT and the URLs it binds.
/// </summary>
internal sealed class LaunchProfile
{
    public Dictionary<string, string> EnvironmentVariables { get; } = new();
    public string? ApplicationUrl { get; private set; }

    public static LaunchProfile Read(string projectDirectory, string assemblyName)
    {
        var profile = new LaunchProfile();
        var file = Path.Combine(projectDirectory, "Properties", "launchSettings.json");

        if (!File.Exists(file))
        {
            return profile;
        }

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(file));
            if (!document.RootElement.TryGetProperty("profiles", out var profiles))
            {
                return profile;
            }

            var chosen = Choose(profiles, assemblyName);
            if (chosen is null)
            {
                return profile;
            }

            if (chosen.Value.TryGetProperty("environmentVariables", out var variables) &&
                variables.ValueKind == JsonValueKind.Object)
            {
                foreach (var variable in variables.EnumerateObject())
                {
                    if (variable.Value.ValueKind == JsonValueKind.String)
                    {
                        profile.EnvironmentVariables[variable.Name] = variable.Value.GetString()!;
                    }
                }
            }

            if (chosen.Value.TryGetProperty("applicationUrl", out var url) && url.ValueKind == JsonValueKind.String)
            {
                profile.ApplicationUrl = url.GetString();
            }
        }
        catch
        {
            // an unreadable launchSettings just means we restart with defaults
        }

        return profile;
    }

    /// <summary>
    /// Prefer the profile named after the project - that is the one Visual Studio
    /// selects by default - and otherwise the first "Project" profile.
    /// </summary>
    private static JsonElement? Choose(JsonElement profiles, string assemblyName)
    {
        if (profiles.TryGetProperty(assemblyName, out var exact))
        {
            return exact;
        }

        foreach (var candidate in profiles.EnumerateObject())
        {
            if (candidate.Value.TryGetProperty("commandName", out var command) &&
                command.ValueKind == JsonValueKind.String &&
                string.Equals(command.GetString(), "Project", StringComparison.OrdinalIgnoreCase))
            {
                return candidate.Value;
            }
        }

        return null;
    }
}
