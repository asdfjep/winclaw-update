using HsWinClaw.Core.Mail;
using HsWinClaw.Core.Security;

namespace HsWinClaw.Infrastructure.Config;

/// <summary>
/// Root configuration model for WinClaw, bindable from appsettings.json
/// under the "HsWinClaw" section.
/// </summary>
public class WinClawConfig
{
    public const string SectionName = "HsWinClaw";

    public LLMConfig LLM { get; set; } = new();
    public MemoryConfig Memory { get; set; } = new();
    public GatewayConfig Gateway { get; set; } = new();
    public DesktopConfig Desktop { get; set; } = new();
    public McpConfig MCP { get; set; } = new();
    public SandboxConfig Sandbox { get; set; } = new();
    public KnowledgeBaseConfig KnowledgeBase { get; set; } = new();
    public PermissionConfig Permissions { get; set; } = new();
    public SkillsConfig Skills { get; set; } = new();
    public WorkspaceConfig Workspace { get; set; } = new();
    public BotsConfig Bots { get; set; } = new();
    public NewApiConfig NewApi { get; set; } = new();
    public MailOptions Mail { get; set; } = new();
    public UpdateConfig Update { get; set; } = new();
    public string? SkillsDirectory { get; set; }
    public string? DatabasePath { get; set; }
}

/// <summary>
/// In-app auto-update settings. The client polls <see cref="ManifestUrl"/>
/// for a JSON manifest describing the latest release (version / download
/// url / sha256 / notes / mandatory) and offers a one-click silent upgrade.
/// </summary>
public class UpdateConfig
{
    /// <summary>Whether in-app update checks are enabled.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>
    /// URL of the update manifest (winclaw-update.json), served by the
    /// internal update server (hs-rag-cloud Nginx static path).
    /// </summary>
    public string ManifestUrl { get; set; } = "http://10.233.129.67:8080/update/winclaw-update.json";

    /// <summary>How often to re-check for updates while the app is running.</summary>
    public int CheckIntervalHours { get; set; } = 24;

    /// <summary>
    /// Directory where downloaded installers are staged before launch.
    /// Empty = %TEMP%\HsWinClaw-Updates.
    /// </summary>
    public string DownloadDirectory { get; set; } = "";
}

/// <summary>new-api (relay) login and LLM key provisioning.</summary>
public class NewApiConfig
{
    /// <summary>Base URL of the new-api instance, e.g. http://10.233.129.65:3300</summary>
    public string BaseUrl { get; set; } = "http://10.233.129.65:3300";

    /// <summary>Path of the web sign-in page.</summary>
    public string SignInPath { get; set; } = "/sign-in";

    /// <summary>When true, WinClaw requires a valid new-api session before showing the main UI.</summary>
    public bool RequireLogin { get; set; } = true;

    /// <summary>Name of the API token created/reused for WinClaw LLM calls.</summary>
    public string TokenName { get; set; } = "winclaw";

    /// <summary>LLM provider name in credentials.dat that receives the sk- key.</summary>
    public string LlmProviderName { get; set; } = "default";

    public string SignInUrl
    {
        get
        {
            var baseUrl = BaseUrl.TrimEnd('/');
            var path = SignInPath.StartsWith('/') ? SignInPath : "/" + SignInPath;
            return baseUrl + path;
        }
    }
}

/// <summary>LLM provider configuration with multi-provider support.</summary>
public class LLMConfig
{
    /// <summary>Default provider name (e.g. "openai", "ollama").</summary>
    public string DefaultProvider { get; set; } = "openai";

    /// <summary>Default model name.</summary>
    public string DefaultModel { get; set; } = "gpt-4o";

    /// <summary>API key for the default provider (shorthand, backward-compat only).</summary>
    public string ApiKey { get; set; } = string.Empty;

    /// <summary>Custom base URL override (shorthand, backward-compat only).</summary>
    public string? BaseUrl { get; set; }

    /// <summary>Default temperature (0.0–2.0).</summary>
    public double? Temperature { get; set; }

    /// <summary>Default max tokens per completion.</summary>
    public int? MaxTokens { get; set; }

    /// <summary>
    /// Thinking/reasoning mode for hybrid models: <c>true</c> force on,
    /// <c>false</c> force off, <c>null</c> let the model decide.
    /// </summary>
    public bool? EnableThinking { get; set; }

    /// <summary>Token budget for the thinking phase (null = model default).</summary>
    public int? ThinkingBudget { get; set; }

    /// <summary>Named provider configurations. Takes precedence over flat ApiKey/BaseUrl.</summary>
    public Dictionary<string, LLMProviderEntry> Providers { get; set; } = new();

    /// <summary>
    /// Friendly display names for model IDs shown in the settings UI
    /// (model ID → label, e.g. "qwen3.8-max" → "深度思考"). Models without
    /// an entry fall back to showing their raw ID.
    /// </summary>
    public Dictionary<string, string> ModelDisplayNames { get; set; } = new();

    /// <summary>Additional provider-specific settings.</summary>
    public Dictionary<string, string> ExtraSettings { get; set; } = new();

    /// <summary>
    /// Resolves the provider entry for a given provider name.
    /// Falls back to flat ApiKey/BaseUrl if no named entry exists.
    /// </summary>
    public LLMProviderEntry ResolveProvider(string? providerName = null)
    {
        var name = providerName ?? DefaultProvider;

        if (Providers.TryGetValue(name, out var entry))
            return entry;

        // Fallback to flat config
        return new LLMProviderEntry
        {
            ApiKey = ApiKey,
            BaseUrl = BaseUrl,
            ModelName = DefaultModel
        };
    }
}

/// <summary>
/// A single LLM provider's connection details.
/// ApiKey and BaseUrl are kept for backward compatibility only;
/// new code reads credentials from ICredentialStore (DPAPI-encrypted).
/// </summary>
public class LLMProviderEntry
{
    /// <summary>Backward-compat only. New code uses ICredentialStore.</summary>
    public string ApiKey { get; set; } = string.Empty;
    /// <summary>Backward-compat only. New code uses ICredentialStore.</summary>
    public string? BaseUrl { get; set; }
    /// <summary>Optional default model. When null the model list is fetched from the provider.</summary>
    public string? ModelName { get; set; }
    public double? Temperature { get; set; }
    public int? MaxTokens { get; set; }
}

/// <summary>Memory subsystem configuration.</summary>
public class MemoryConfig
{
    /// <summary>Whether memory is enabled.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Directory for markdown memory files.</summary>
    public string? StoreDirectory { get; set; }

    /// <summary>Alias for StoreDirectory (JSON compatibility).</summary>
    public string? MemoryDirectory
    {
        get => StoreDirectory;
        set => StoreDirectory = value;
    }

    /// <summary>Path to the SQLite memory search database.</summary>
    public string? SearchDbPath { get; set; }

    /// <summary>Maximum characters for core memory content.</summary>
    public int MaxCoreMemoryChars { get; set; } = 2200;

    /// <summary>Maximum characters for user profile content.</summary>
    public int MaxUserProfileChars { get; set; } = 1375;

    /// <summary>Whether the MemoryCurator background service is enabled.</summary>
    public bool CuratorEnabled { get; set; } = true;

    /// <summary>Alias for CuratorEnabled (JSON compatibility).</summary>
    public bool DreamingEnabled
    {
        get => CuratorEnabled;
        set => CuratorEnabled = value;
    }

    /// <summary>How often the curator runs.</summary>
    public TimeSpan CuratorInterval { get; set; } = TimeSpan.FromHours(1);

    /// <summary>Dreaming interval in hours (JSON compatibility).</summary>
    public double DreamingIntervalHours
    {
        get => CuratorInterval.TotalHours;
        set => CuratorInterval = TimeSpan.FromHours(value);
    }
}

/// <summary>Gateway / API configuration.</summary>
public class GatewayConfig
{
    /// <summary>Whether to expose the gateway HTTP endpoint.</summary>
    public bool Enabled { get; set; } = false;

    /// <summary>Port to listen on.</summary>
    public int Port { get; set; } = 8647;

    /// <summary>WebSocket port (JSON compatibility alias).</summary>
    public int WebSocketPort
    {
        get => Port;
        set => Port = value;
    }

    /// <summary>
    /// Whether the gateway listens on all interfaces (LAN reachable) instead of
    /// localhost only. Requires a one-time <c>netsh urlacl</c> grant on Windows.
    /// </summary>
    public bool AllowLan { get; set; } = false;

    /// <summary>
    /// Pairing token required by remote (phone) clients to authenticate.
    /// Auto-generated on first enable when empty.
    /// </summary>
    public string? RemoteToken { get; set; }

    /// <summary>API key required to access the gateway (if any).</summary>
    public string? ApiKey { get; set; }

    /// <summary>Maximum number of concurrent sessions.</summary>
    public int MaxSessions { get; set; } = 50;

    /// <summary>Session timeout in minutes.</summary>
    public int SessionTimeoutMinutes { get; set; } = 60;

    /// <summary>Whether to auto-prune stale sessions.</summary>
    public bool AutoPruneSessions { get; set; } = false;

    /// <summary>
    /// Optional safety cap on agent loop turns per session.
    /// 0 (default) = no limit — task length varies wildly (a quick answer is
    /// 1-2 turns, a multi-stage skill pipeline like ppt-master needs 50+), so
    /// the real runaway guards are the payload budget / context compressor /
    /// user stop button, not a fixed turn count. Set a positive value only
    /// when an explicit cap is wanted (e.g. unattended/batch use).
    /// </summary>
    public int MaxAgentTurns { get; set; } = 0;

    /// <summary>
    /// Explicit context-window token budget override. 0 = auto: the budget is
    /// derived from the active model's real window (relay-reported length,
    /// then name heuristics, then a conservative default — see
    /// <c>ModelContextResolver</c>). Compression kicks in at ~85% of the
    /// effective budget; also the denominator of the UI's usage indicator.
    /// </summary>
    public int ContextTokenBudget { get; set; } = 0;

    /// <summary>
    /// Maximum request body size (bytes) accepted by the LLM gateway/proxy.
    /// new-api rejects larger payloads with 400 "Exceeded limit on max bytes
    /// to request body : 6291456". The agent loop keeps every request under
    /// this limit (minus a safety margin) by compressing/truncating the
    /// context before sending.
    /// </summary>
    public int MaxRequestBodyBytes { get; set; } = 6_291_456; // 6 MiB (new-api default)
}

/// <summary>Bot channel configuration (approval notification push).</summary>
public class BotsConfig
{
    /// <summary>Feishu (Lark) group bot configuration.</summary>
    public BotChannelConfig Feishu { get; set; } = new();

    /// <summary>WeCom (企业微信) group bot configuration.</summary>
    public BotChannelConfig WeCom { get; set; } = new();
}

/// <summary>A single bot channel endpoint (group bot webhook).</summary>
public class BotChannelConfig
{
    /// <summary>Whether this bot channel pushes notifications.</summary>
    public bool Enabled { get; set; } = false;

    /// <summary>Incoming webhook URL of the group bot.</summary>
    public string WebhookUrl { get; set; } = string.Empty;
}

/// <summary>Desktop / UI integration configuration.</summary>
public class DesktopConfig
{
    /// <summary>Whether toast notifications are enabled.</summary>
    public bool NotificationsEnabled { get; set; } = true;

    /// <summary>
    /// UI theme: 默认/浅色 (light) or 深色 (dark). Applied at startup and
    /// live on save.
    /// </summary>
    public string Theme { get; set; } = "默认";

    /// <summary>JSON compatibility alias for NotificationsEnabled.</summary>
    public bool ShowNotifications
    {
        get => NotificationsEnabled;
        set => NotificationsEnabled = value;
    }

    /// <summary>Whether system tray integration is enabled.</summary>
    public bool SystemTrayEnabled { get; set; } = true;

    /// <summary>JSON compatibility alias for SystemTrayEnabled.</summary>
    public bool CloseToTray
    {
        get => SystemTrayEnabled;
        set => SystemTrayEnabled = value;
    }

    /// <summary>Whether global hotkeys are enabled.</summary>
    public bool HotkeysEnabled { get; set; } = false;

    /// <summary>UI language.</summary>
    public string Language { get; set; } = "zh-CN";

    /// <summary>Whether to start minimized to tray.</summary>
    public bool StartMinimized { get; set; } = false;
}

/// <summary>MCP (Model Context Protocol) configuration.</summary>
public class McpConfig
{
    /// <summary>Whether the MCP server is enabled.</summary>
    public bool ServerEnabled { get; set; } = false;

    /// <summary>Port for the MCP server to listen on.</summary>
    public int ServerPort { get; set; } = 5200;

    /// <summary>
    /// Bearer token required on every MCP request. Generated on first start
    /// when empty and persisted back to settings. Clients must send
    /// <c>Authorization: Bearer &lt;token&gt;</c> (or <c>?token=</c>).
    /// </summary>
    public string? ServerToken { get; set; }

    /// <summary>External MCP servers to connect to as a client.</summary>
    public List<McpServerEntry> Servers { get; set; } = new();
}

/// <summary>An external MCP server connection entry.</summary>
public class McpServerEntry
{
    public string Name { get; set; } = string.Empty;
    public string Url { get; set; } = string.Empty;
    public string? ApiKey { get; set; }
}

/// <summary>Sandbox (process isolation) configuration.</summary>
public class SandboxConfig
{
    /// <summary>
    /// Committed-memory limit (MB) enforced per sandboxed process tree.
    /// Sized for heavy render pipelines (headless-browser PPT/image export);
    /// set 0 to disable.
    /// </summary>
    public int DefaultMemoryLimitMb { get; set; } = 4096;

    /// <summary>
    /// CPU-time limit (seconds) accumulated across the WHOLE process tree.
    /// Off by default: tree-wide accounting penalizes legitimately parallel
    /// work (an 8-core render burns CPU 8x faster than wall time), and the
    /// wall-clock timeout already caps runaways. Set a value to opt in.
    /// </summary>
    public int CpuLimitSeconds { get; set; } = 0;

    /// <summary>Wall-clock timeout (ms) for a single sandboxed execution.</summary>
    public int DefaultTimeoutMs { get; set; } = 3_600_000;

    /// <summary>
    /// Reserved: network isolation inside the job (requires a WFP/AppContainer
    /// filter; not yet enforced). Documented so the config is honest.
    /// </summary>
    public bool AllowNetworkAccess { get; set; } = true;

    /// <summary>Whether sandbox is enabled globally.</summary>
    public bool Enabled { get; set; } = true;
}

/// <summary>Cloud knowledge base (hs-rag) integration. Local embedded RAG removed.</summary>
public class KnowledgeBaseConfig
{
    /// <summary>
    /// Legacy field for user-settings.json compatibility. Always forced to "cloud" at startup.
    /// </summary>
    public string RagSource { get; set; } = "cloud";

    /// <summary>Cloud hs-rag base URL.</summary>
    public string CloudBaseUrl { get; set; } = "http://10.233.129.67:8080";

    /// <summary>
    /// Cloud API key (in-memory / legacy plaintext). Prefer DPAPI credentials.dat
    /// under <see cref="CredentialProviderName"/>.
    /// </summary>
    public string? CloudApiKey { get; set; }

    /// <summary>
    /// Legacy local URL (unused). Kept so old user-settings.json still binds.
    /// </summary>
    public string BaseUrl { get; set; } = "http://10.233.129.67:8080";

    /// <summary>Selected knowledge base IDs (empty = use first available).</summary>
    public List<string> SelectedKnowledgeBaseIds { get; set; } = new();

    /// <summary>Whether knowledge base integration is enabled.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Maximum number of sources to include in responses.</summary>
    public int MaxSources { get; set; } = 5;

    /// <summary>After NewApi login, auto-register/login cloud hs-rag and create default KB.</summary>
    public bool AutoProvisionOnLogin { get; set; } = true;

    /// <summary>Default knowledge base name created on first provision.</summary>
    public string DefaultKnowledgeBaseName { get; set; } = "first";

    /// <summary>DPAPI credential provider name for the cloud API key.</summary>
    public string CredentialProviderName { get; set; } = "hs-rag-cloud";
}

/// <summary>Skills configuration.</summary>
public class SkillsConfig
{
    /// <summary>Enabled skill names (empty = all enabled).</summary>
    public List<string> EnabledSkills { get; set; } = new();

    /// <summary>Disabled skill names.</summary>
    public List<string> DisabledSkills { get; set; } = new();

    /// <summary>Whether community skills are allowed.</summary>
    public bool AllowCommunitySkills { get; set; } = true;

    /// <summary>Whether custom skills are allowed.</summary>
    public bool AllowCustomSkills { get; set; } = true;
}

/// <summary>Workspace configuration for file uploads and archival.</summary>
public class WorkspaceConfig
{
    /// <summary>
    /// Root directory for the workspace. Defaults to D:\WinClawWorkspace.
    /// Users can customize this path in appsettings.json.
    /// </summary>
    public string Path { get; set; } = @"D:\WinClawWorkspace";

    /// <summary>
    /// Directory where generated artifacts (PPT, spreadsheets, projects, etc.) are saved.
    /// Empty = default under the user's Documents folder.
    /// </summary>
    public string OutputDirectory { get; set; } = string.Empty;

    /// <summary>Whether to automatically archive uploaded files.</summary>
    public bool AutoArchive { get; set; } = true;

    /// <summary>Whether to use LLM to generate wiki-style metadata for uploaded files.</summary>
    public bool AutoIndex { get; set; } = true;

    /// <summary>
    /// Minimum free disk space in GB. Warn user if below this threshold.
    /// </summary>
    public int MinFreeSpaceGb { get; set; } = 10;

    /// <summary>Legacy default output directory: Documents\WinClaw\Output.</summary>
    public static string GetDefaultOutputDirectory() =>
        System.IO.Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
            "WinClaw",
            "Output");

    /// <summary>
    /// Resolves <see cref="OutputDirectory"/> (or the default), expands env vars,
    /// and ensures the directory exists.
    ///
    /// Default resolution order (when <see cref="OutputDirectory"/> is empty):
    ///   1. <c>&lt;Workspace.Path&gt;\Output</c> — artifacts stay inside the
    ///      configured workspace, matching Permissions.WorkspacePaths so
    ///      writes are never blocked by PathGuard.
    ///   2. Documents\WinClaw\Output — fallback only if Path is unset.
    /// </summary>
    public string ResolveOutputDirectory()
    {
        string raw;
        if (!string.IsNullOrWhiteSpace(OutputDirectory))
        {
            raw = OutputDirectory.Trim();
        }
        else if (!string.IsNullOrWhiteSpace(Path))
        {
            // Keep generated artifacts under the workspace root by default.
            raw = System.IO.Path.Combine(Path.Trim(), "Output");
        }
        else
        {
            raw = GetDefaultOutputDirectory();
        }

        if (raw.StartsWith('~'))
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            raw = System.IO.Path.Combine(home, raw.TrimStart('~').TrimStart('\\', '/'));
        }

        raw = Environment.ExpandEnvironmentVariables(raw);
        System.IO.Directory.CreateDirectory(raw);
        return System.IO.Path.GetFullPath(raw);
    }
}
