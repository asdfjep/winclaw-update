using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using HsWinClaw.Infrastructure.Config;
using Microsoft.Extensions.Logging;

namespace HsWinClaw.Desktop.Services;

/// <summary>
/// One entry of the update manifest (winclaw-update.json) published next to
/// each installer. The client compares <see cref="Version"/> against the
/// running build and offers a silent upgrade when it is newer.
/// </summary>
public sealed class UpdateManifest
{
    [JsonPropertyName("version")]
    public string Version { get; set; } = "";

    [JsonPropertyName("url")]
    public string Url { get; set; } = "";

    [JsonPropertyName("sha256")]
    public string Sha256 { get; set; } = "";

    [JsonPropertyName("notes")]
    public string? Notes { get; set; }

    [JsonPropertyName("mandatory")]
    public bool Mandatory { get; set; }

    [JsonPropertyName("publishedAt")]
    public string? PublishedAt { get; set; }
}

/// <summary>
/// In-app auto-update service: polls the update manifest, downloads the new
/// installer with progress, verifies SHA256 and launches a silent Inno Setup
/// upgrade (<c>/VERYSILENT /SUPPRESSMSGBOXES /CLOSEAPPLICATIONS</c>).
///
/// User data lives outside the install dir (chat DB in ~/.hs-winclaw,
/// settings in %APPDATA%\HsWinClaw), and installer.iss only deletes program
/// files on upgrade — so a silent reinstall preserves everything.
/// All failures are logged and swallowed: update checks must never break
/// normal startup.
/// </summary>
public sealed class UpdateService : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    private readonly WinClawConfig _config;
    private readonly ILogger<UpdateService> _logger;
    private readonly HttpClient _http;
    private readonly CancellationTokenSource _cts = new();
    private readonly SemaphoreSlim _downloadLock = new(1, 1);

    private UpdateManifest? _available;
    private bool _started;

    /// <summary>Raised on any state transition. Handlers must marshal to the UI thread.</summary>
    public event Action? StateChanged;

    /// <summary>Raised while downloading with (percent 0..100, receivedBytes, totalBytes).</summary>
    public event Action<double, long, long>? DownloadProgress;

    public UpdateState State { get; private set; } = UpdateState.Idle;

    /// <summary>Manifest of the newer version, when <see cref="State"/> is Available/Downloading/Ready.</summary>
    public UpdateManifest? Available => _available;

    /// <summary>Human-readable error for the last failed operation.</summary>
    public string? LastError { get; private set; }

    public UpdateService(WinClawConfig config, ILogger<UpdateService> logger)
    {
        _config = config;
        _logger = logger;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        _http.DefaultRequestHeaders.CacheControl = new CacheControlHeaderValue { NoCache = true };
    }

    /// <summary>
    /// The running build version, read from AssemblyInformationalVersion
    /// (the git-suffix "+abc1234" is stripped so Version.Parse succeeds).
    /// </summary>
    public static string GetAppVersion()
    {
        var info = Assembly.GetEntryAssembly()
            ?.GetCustomAttribute<AssemblyInformationalVersionAttribute>()
            ?.InformationalVersion ?? "0.0.0";
        var plus = info.IndexOf('+');
        if (plus > 0)
            info = info[..plus];
        return info;
    }

    /// <summary>
    /// Background loop: first check shortly after startup, then every
    /// <c>CheckIntervalHours</c>. Runs until <see cref="Stop"/> is called.
    /// </summary>
    public void Start()
    {
        var update = _config.Update;
        if (!update.Enabled || string.IsNullOrWhiteSpace(update.ManifestUrl))
        {
            _logger.LogInformation("Update checks disabled (Enabled={Enabled}, ManifestUrl set: {HasUrl})",
                update.Enabled, !string.IsNullOrWhiteSpace(update.ManifestUrl));
            return;
        }

        lock (_cts)
        {
            if (_started)
                return;
            _started = true;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                // Give the app a few seconds to settle before the first check.
                await Task.Delay(TimeSpan.FromSeconds(8), _cts.Token).ConfigureAwait(false);
                while (!_cts.Token.IsCancellationRequested)
                {
                    await CheckForUpdateAsync(_cts.Token).ConfigureAwait(false);
                    var hours = Math.Max(1, update.CheckIntervalHours);
                    await Task.Delay(TimeSpan.FromHours(hours), _cts.Token).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException)
            {
                // Normal shutdown.
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Update check loop crashed");
            }
        });
        _logger.LogInformation("Update service started (manifest: {ManifestUrl}, every {Hours}h)",
            update.ManifestUrl, Math.Max(1, update.CheckIntervalHours));
    }

    public void Stop()
    {
        _cts.Cancel();
    }

    /// <summary>
    /// Fetches the manifest and moves to <see cref="UpdateState.Available"/>
    /// when it describes a version newer than the running build.
    /// </summary>
    public async Task CheckForUpdateAsync(CancellationToken ct = default)
    {
        var update = _config.Update;
        if (!update.Enabled || string.IsNullOrWhiteSpace(update.ManifestUrl))
            return;

        // A download/install may already be in flight — don't disturb it.
        if (State is UpdateState.Downloading or UpdateState.Ready)
            return;

        SetState(UpdateState.Checking);
        try
        {
            var json = await _http.GetStringAsync(update.ManifestUrl, ct).ConfigureAwait(false);
            var manifest = JsonSerializer.Deserialize<UpdateManifest>(json, JsonOptions);
            if (manifest is null || string.IsNullOrWhiteSpace(manifest.Version) || string.IsNullOrWhiteSpace(manifest.Url))
            {
                _logger.LogWarning("Update manifest is malformed: {Json}", Truncate(json, 200));
                SetState(UpdateState.Idle);
                return;
            }

            if (!Version.TryParse(manifest.Version, out var remote))
            {
                _logger.LogWarning("Update manifest version '{Version}' is not parseable", manifest.Version);
                SetState(UpdateState.Idle);
                return;
            }

            var currentText = GetAppVersion();
            if (!Version.TryParse(currentText, out var current))
            {
                _logger.LogWarning("Current app version '{Version}' is not parseable; skipping update check", currentText);
                SetState(UpdateState.Idle);
                return;
            }

            if (remote > current)
            {
                _available = manifest;
                _logger.LogInformation("Update available: {Current} -> {Remote} (mandatory={Mandatory})",
                    currentText, manifest.Version, manifest.Mandatory);
                SetState(UpdateState.Available);
            }
            else
            {
                _available = null;
                _logger.LogInformation("No update available (current={Current}, manifest={Remote})",
                    currentText, manifest.Version);
                SetState(UpdateState.Idle);
            }
        }
        catch (OperationCanceledException)
        {
            SetState(UpdateState.Idle);
        }
        catch (Exception ex)
        {
            // Network failures are expected (offline, server not deployed yet).
            _logger.LogWarning("Update check failed: {Message}", ex.Message);
            LastError = "检查更新失败：" + ex.Message;
            SetState(UpdateState.Error);
        }
    }

    /// <summary>
    /// Downloads the installer for the available update, verifies SHA256 and
    /// launches the silent upgrade. The Inno installer closes this app
    /// (CloseApplications=yes + KillProcess in [Code]), overwrites program
    /// files and relaunches the new build.
    /// Returns false when the update could not be started; see <see cref="LastError"/>.
    /// </summary>
    public async Task<bool> StartUpdateAsync(CancellationToken ct = default)
    {
        var manifest = _available;
        if (manifest is null)
        {
            LastError = "没有可用的更新";
            return false;
        }

        await _downloadLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (State is UpdateState.Downloading or UpdateState.Ready)
                return State == UpdateState.Ready;

            SetState(UpdateState.Downloading);
            var target = GetStagedInstallerPath(manifest);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            HardenInstallerDirectory(Path.GetDirectoryName(target)!);

            // Reuse a previously verified download instead of fetching again.
            if (File.Exists(target) && VerifySha256(target, manifest.Sha256))
            {
                _logger.LogInformation("Installer already staged and verified: {Path}", target);
            }
            else
            {
                if (File.Exists(target))
                    File.Delete(target);
                await DownloadInstallerAsync(manifest, target, ct).ConfigureAwait(false);

                if (!VerifySha256(target, manifest.Sha256))
                {
                    File.Delete(target);
                    LastError = "安装包校验失败（SHA256 不一致），已中止。请重试更新。";
                    _logger.LogError("SHA256 mismatch for {Url}; staged file deleted", manifest.Url);
                    SetState(UpdateState.Error);
                    return false;
                }
                _logger.LogInformation("SHA256 verified for {Path}", target);
            }

            // Hold the staged file against writes/deletes from here until the
            // installer process starts — closes the verify→launch replacement
            // window. FileShare.Read keeps the file executable while blocking
            // any re-writer.
            FileStream? hold = null;
            try
            {
                hold = new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.Read);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Could not lock staged installer; continuing");
            }

            SetState(UpdateState.Ready);
            LaunchSilentInstaller(target);
            hold?.Dispose();
            return true;
        }
        catch (OperationCanceledException)
        {
            LastError = "更新已取消";
            SetState(_available is not null ? UpdateState.Available : UpdateState.Idle);
            return false;
        }
        catch (Exception ex)
        {
            LastError = "更新失败：" + ex.Message;
            _logger.LogError(ex, "Update failed");
            SetState(UpdateState.Error);
            return false;
        }
        finally
        {
            _downloadLock.Release();
        }
    }

    private async Task DownloadInstallerAsync(UpdateManifest manifest, string targetPath, CancellationToken ct)
    {
        _logger.LogInformation("Downloading installer from {Url}", manifest.Url);
        using var response = await _http.GetAsync(manifest.Url, HttpCompletionOption.ResponseHeadersRead, ct)
            .ConfigureAwait(false);
        response.EnsureSuccessStatusCode();

        var total = response.Content.Headers.ContentLength ?? -1;
        long received = 0;
        await using var source = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        await using var file = new FileStream(targetPath, FileMode.Create, FileAccess.Write, FileShare.None);

        var buffer = new byte[81920];
        int read;
        while ((read = await source.ReadAsync(buffer, ct).ConfigureAwait(false)) > 0)
        {
            await file.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
            received += read;
            var percent = total > 0 ? Math.Clamp(received * 100.0 / total, 0, 100) : 0;
            DownloadProgress?.Invoke(percent, received, total);
        }

        _logger.LogInformation("Download complete: {Bytes} bytes -> {Path}", received, targetPath);
    }

    private static bool VerifySha256(string path, string expected)
    {
        if (string.IsNullOrWhiteSpace(expected))
            return false;

        using var stream = File.OpenRead(path);
        var actual = Convert.ToHexStringLower(SHA256.HashData(stream));
        return string.Equals(actual, expected.Trim(), StringComparison.OrdinalIgnoreCase);
    }

    private void LaunchSilentInstaller(string installerPath)
    {
        // /VERYSILENT  : no wizard UI
        // /SUPPRESSMSGBOXES : any message boxes auto-dismissed
        // /CLOSEAPPLICATIONS : silently close WinClaw before replacing files
        // /LOG : silent installs leave an uninstall-style log next to the installer
        var args = "/VERYSILENT /SUPPRESSMSGBOXES /CLOSEAPPLICATIONS " +
                   $"/LOG=\"{Path.ChangeExtension(installerPath, ".install.log")}\"";
        _logger.LogInformation("Launching silent installer: {Installer} {Args}", installerPath, args);

        var psi = new ProcessStartInfo
        {
            FileName = installerPath,
            Arguments = args,
            UseShellExecute = true
        };
        Process.Start(psi);

        // The installer's InitializeSetup kills Hs-WinClaw.exe and the new
        // build is launched from [Run] — nothing more to do here.
    }

    /// <summary>
    /// Locks the staging directory down to the current user (removes
    /// inheritance, strips Everyone/Users ACEs, grants FullControl to owner
    /// and Administrators). Prevents other local processes from pre-planting
    /// or swapping a malicious installer between verification and launch.
    /// Best-effort: a failure degrades to the previous behavior with a log.
    /// </summary>
    private void HardenInstallerDirectory(string dir)
    {
        try
        {
            var info = new DirectoryInfo(dir);
            var security = info.GetAccessControl();
            security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
            foreach (var rule in security.GetAccessRules(true, true, typeof(System.Security.Principal.NTAccount)))
                security.RemoveAccessRule((System.Security.AccessControl.FileSystemAccessRule)rule);
            var owner = System.Security.Principal.WindowsIdentity.GetCurrent().Name;
            security.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
                owner, System.Security.AccessControl.FileSystemRights.FullControl,
                System.Security.AccessControl.InheritanceFlags.ContainerInherit | System.Security.AccessControl.InheritanceFlags.ObjectInherit,
                System.Security.AccessControl.PropagationFlags.None,
                System.Security.AccessControl.AccessControlType.Allow));
            security.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
                "BUILTIN\\Administrators", System.Security.AccessControl.FileSystemRights.FullControl,
                System.Security.AccessControl.InheritanceFlags.ContainerInherit | System.Security.AccessControl.InheritanceFlags.ObjectInherit,
                System.Security.AccessControl.PropagationFlags.None,
                System.Security.AccessControl.AccessControlType.Allow));
            info.SetAccessControl(security);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to harden update staging directory ACL: {Dir}", dir);
        }
    }

    /// <summary>Staging location for downloaded installers.</summary>
    private string GetStagedInstallerPath(UpdateManifest manifest)
    {
        var dir = string.IsNullOrWhiteSpace(_config.Update.DownloadDirectory)
            ? Path.Combine(Path.GetTempPath(), "HsWinClaw-Updates")
            : _config.Update.DownloadDirectory;

        var fileName = "";
        if (Uri.TryCreate(manifest.Url, UriKind.Absolute, out var uri))
            fileName = Path.GetFileName(uri.AbsolutePath);
        if (string.IsNullOrWhiteSpace(fileName))
            fileName = $"Hs-WinClaw-Setup-{manifest.Version}.exe";
        // Absolute paths from URIs are URL-encoded.
        fileName = Uri.UnescapeDataString(fileName);
        return Path.Combine(dir, fileName);
    }

    private void SetState(UpdateState state)
    {
        if (State == state)
            return;
        State = state;
        if (state != UpdateState.Error)
            LastError = null;
        StateChanged?.Invoke();
    }

    private static string Truncate(string text, int max)
        => text.Length <= max ? text : text[..max] + "…";

    public void Dispose()
    {
        _cts.Cancel();
        _cts.Dispose();
        _http.Dispose();
        _downloadLock.Dispose();
    }
}

/// <summary>Lifecycle states of the in-app update flow.</summary>
public enum UpdateState
{
    /// <summary>No update known; nothing in flight.</summary>
    Idle,
    /// <summary>Manifest is being fetched.</summary>
    Checking,
    /// <summary>A newer version was found; waiting for the user to start.</summary>
    Available,
    /// <summary>Installer download in progress.</summary>
    Downloading,
    /// <summary>Installer verified; silent install is being launched.</summary>
    Ready,
    /// <summary>Last operation failed; <see cref="UpdateService.LastError"/> explains.</summary>
    Error
}
