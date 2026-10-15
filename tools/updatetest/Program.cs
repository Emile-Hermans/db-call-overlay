// Checks the installed-copy updater against a local stand-in for the GitHub
// releases API. Nothing is published and nothing is installed: the "setup" it
// downloads is this program again, which only records how it was started.
//   dotnet run --project tools\updatetest
using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using DbCallOverlay;

// Started as the downloaded "setup": write down the arguments and stop.
if (args.Length > 0 && args[0] == "/update")
{
    File.WriteAllText(Environment.GetEnvironmentVariable("UPDATETEST_RECORD")!, string.Join("\n", args));
    return 0;
}

var failures = 0;
void Check(bool ok, string what, string extra = "")
{
    Console.WriteLine($"{(ok ? "PASS" : "FAIL")}  {what}{(ok ? "" : "  " + extra)}");
    if (!ok) failures++;
}

var work = Path.Combine(Path.GetTempPath(), $"clicktrace-updatetest-{Environment.ProcessId}");
Directory.CreateDirectory(work);
var record = Path.Combine(work, "started.txt");
Environment.SetEnvironmentVariable("UPDATETEST_RECORD", record);

// The "setup" served for download: a copy of this program and everything it needs to run.
var setupBytes = File.ReadAllBytes(Environment.ProcessPath!);
var setupSha = Convert.ToHexString(SHA256.HashData(setupBytes)).ToLowerInvariant();

var port = 19000 + Environment.ProcessId % 1000;
var api = $"http://127.0.0.1:{port}/";
Environment.SetEnvironmentVariable("CLICKTRACE_RELEASES_API", api + "releases/latest");

// What the stand-in answers; each case below sets it.
var latest = (status: 404, json: "");
byte[] served = setupBytes;

var listener = new HttpListener();
listener.Prefixes.Add(api);
listener.Start();
_ = Task.Run(async () =>
{
    while (listener.IsListening)
    {
        HttpListenerContext ctx;
        try { ctx = await listener.GetContextAsync(); } catch { return; }
        var path = ctx.Request.Url!.AbsolutePath;
        byte[] body;
        if (path == "/releases/latest")
        {
            ctx.Response.StatusCode = latest.status;
            body = Encoding.UTF8.GetBytes(latest.json);
        }
        else if (path.EndsWith(".sha256"))
        {
            body = Encoding.ASCII.GetBytes($"{setupSha}  ClicktraceSetup-1.2.0.exe");
        }
        else
        {
            body = served;
        }
        await ctx.Response.OutputStream.WriteAsync(body);
        ctx.Response.Close();
    }
});

string Release(string tag, string? digest, bool sidecar = false) => $$"""
{
  "tag_name": "{{tag}}",
  "body": "## What's new\n\n- Faster waterfall\n- **Fix** first list\n\nThanks!",
  "assets": [
    { "name": "ClicktraceSetup-{{tag.TrimStart('v')}}.exe", "size": {{setupBytes.Length}},
      "browser_download_url": "{{api}}download/ClicktraceSetup-{{tag.TrimStart('v')}}.exe"
      {{(digest is null ? "" : $", \"digest\": \"sha256:{digest}\"")}} }
    {{(sidecar ? $", {{ \"name\": \"ClicktraceSetup-{tag.TrimStart('v')}.exe.sha256\", \"size\": 90, \"browser_download_url\": \"{api}download/x.sha256\" }}" : "")}}
  ]
}
""";

try
{
    Check(ReleaseUpdater.CurrentVersion == "1.1.0", "the current version comes from the build", ReleaseUpdater.CurrentVersion);

    // --- nothing published --------------------------------------------------
    latest = (404, "");
    var s = Updater.Check(null);
    Check(!s.Available && s.Problem is null, "no release yet is not an error", s.Problem ?? "");

    // --- an older or equal release ------------------------------------------
    latest = (200, Release("v1.1.0", setupSha));
    s = Updater.Check(null);
    Check(!s.Available, "the same version is not offered as an update");
    latest = (200, Release("v1.0.9", setupSha));
    Check(!Updater.Check(null).Available, "an older version is not offered");
    Check(ReleaseUpdater.IsNewer("1.10.0", "1.9.0"), "versions compare as numbers, not text");

    // --- a newer release ------------------------------------------------------
    latest = (200, Release("v1.2.0", setupSha));
    s = Updater.Check(null);
    Check(s.Available && s.Latest == "1.2.0", "a newer release is offered", $"{s.Available} {s.Latest}");
    Check(s.Current == "v1.1.0", "the current version is shown", s.Current ?? "");
    Check(s.Changes.SequenceEqual(new[] { "Faster waterfall", "Fix first list" }), "the release notes become the change list", string.Join(" | ", s.Changes));

    // --- no checksum: offered, never installed --------------------------------
    latest = (200, Release("v1.2.0", null));
    s = Updater.Check(null);
    Check(s.Problem?.Contains("SHA-256") == true, "a release without a checksum says it will not auto-install", s.Problem ?? "");
    var (ok, message) = Updater.Apply(null, "");
    Check(!ok && !File.Exists(record), "and Update now refuses it", message);

    // --- a corrupted download ---------------------------------------------------
    latest = (200, Release("v1.2.0", setupSha));
    served = setupBytes.Take(setupBytes.Length - 1).Append((byte)0x42).ToArray();
    (ok, message) = Updater.Apply(null, "");
    Check(!ok && message.Contains("does not match"), "a download that fails the checksum is refused", message);
    Check(!File.Exists(record), "and is never started");
    Check(!File.Exists(Path.Combine(Path.GetTempPath(), "Clicktrace-update", "ClicktraceSetup-1.2.0.exe")), "and is deleted");

    // --- the sidecar file instead of GitHub's digest ------------------------------
    served = setupBytes;
    latest = (200, Release("v1.2.0", null, sidecar: true));
    s = Updater.Check(null);
    Check(s.Available && s.Problem is null, "a .sha256 file attached to the release is accepted", s.Problem ?? "");

    // --- a good download ------------------------------------------------------
    // The served "setup" is this program's launcher, which needs its .dll beside
    // it to start. A real setup is one self-contained file and needs nothing.
    var downloads = Path.Combine(Path.GetTempPath(), "Clicktrace-update");
    Directory.CreateDirectory(downloads);
    foreach (var support in Directory.GetFiles(AppContext.BaseDirectory, "updatetest.*").Where(f => !f.EndsWith(".exe")))
    {
        File.Copy(support, Path.Combine(downloads, Path.GetFileName(support)), true);
    }
    latest = (200, Release("v1.2.0", setupSha));
    (ok, message) = Updater.Apply(null, "");
    Check(ok, "a verified download is started", message);
    for (var i = 0; i < 40 && !File.Exists(record); i++) Thread.Sleep(100);
    var started = File.Exists(record) ? File.ReadAllText(record).Split('\n') : [];
    Check(started.FirstOrDefault() == "/update", "as an update", string.Join(" ", started));
    Check(started.Any(a => a == "/dir=" + AppContext.BaseDirectory.TrimEnd('\\', '/')), "over this install folder", string.Join(" ", started));

    // --- GitHub unreachable -------------------------------------------------------
    Environment.SetEnvironmentVariable("CLICKTRACE_RELEASES_API", "http://127.0.0.1:1/releases/latest");
    s = Updater.Check(null);
    Check(s.Problem?.StartsWith("Could not reach GitHub") == true, "an unreachable GitHub is reported, not thrown", s.Problem ?? "");
}
finally
{
    listener.Stop();
    try { Directory.Delete(work, true); } catch { }
    try { Directory.Delete(Path.Combine(Path.GetTempPath(), "Clicktrace-update"), true); } catch { }
}

Console.WriteLine(failures == 0 ? "\nALL PASS" : $"\n{failures} FAILED");
return failures == 0 ? 0 : 1;
