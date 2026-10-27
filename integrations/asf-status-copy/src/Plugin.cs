using System.Collections.Concurrent;
using System.Composition;
using System.Text;
using System.Text.Json;
using ArchiSteamFarm.Plugins.Interfaces;
using ArchiSteamFarm.Steam;
using ArchiSteamFarm.Steam.Interaction;
using ArchiSteamFarm.Storage;
using SteamKit2;
using SteamKit2.Internal;
using SteamKit2.WebUI.Internal;

namespace ASFStatusRelay;

[Export(typeof(IPlugin))]
public sealed class Plugin : IBot, IBotSteamClient, IBotConnection, IBotCommand2 {
    public string Name => "ASFStatusRelay";
    public Version Version => new(0, 3, 0);
    private readonly ConcurrentDictionary<Bot, RichPresenceTransport> Transports = new();
    private readonly ConcurrentDictionary<string, Bot> Bots = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<Bot, List<IDisposable>> Subscriptions = new();
    private readonly SemaphoreSlim Lifecycle = new(1, 1);
    private readonly SemaphoreSlim Verification = new(1, 1);
    private readonly object ActivitySync = new();
    private readonly Dictionary<string, Activity> Activities = new(StringComparer.Ordinal);
    private readonly object PeerSync = new();
    private PeerRequest? PendingPeer;
    private long Epoch;
    private long Revision;
    private RelayConfiguration? Configuration;
    private RelaySession? Session;
    private Task Cleanup = Task.CompletedTask;
    private RelayMode DesiredMode = RelayMode.Observe;
    private string ConfigPath = "";
    private string Warning = "Configuration required: select MainBot and SourceBots.";
    private string CleanupNotice = "";

    public Task OnLoaded() {
        ConfigPath = Path.Combine(Path.GetDirectoryName(typeof(Plugin).Assembly.Location)!, "ASFStatusRelay.json");
        if (File.Exists(ConfigPath)) {
            try { Configuration = RelayConfiguration.Parse(File.ReadAllText(ConfigPath)); DesiredMode = ParseMode(Configuration.StartupMode); Warning = ""; }
            catch (Exception error) { Warning = $"Configuration not activated ({error.GetType().Name}): {error.Message}"; }
        }
        return Task.CompletedTask;
    }
    public Task OnBotInit(Bot bot) { Bots[bot.BotName] = bot; return Task.CompletedTask; }
    public Task<IReadOnlyCollection<ClientMsgHandler>?> OnBotSteamHandlersInit(Bot bot) {
        Bots[bot.BotName] = bot;
        RichPresenceTransport transport = new(message => bot.ArchiLogger.LogGenericWarning($"{Name}: {message}"));
        Transports[bot] = transport;
        return Task.FromResult<IReadOnlyCollection<ClientMsgHandler>?>(new ClientMsgHandler[] { transport });
    }
    public Task OnBotSteamCallbacksInit(Bot bot, CallbackManager callbacks) {
        List<IDisposable> subscriptions = [
            callbacks.Subscribe<SteamUser.PlayingSessionStateCallback>(callback => SetActivity(bot, bot.IsConnectedAndLoggedOn, callback.PlayingBlocked, callback.PlayingAppID)),
            callbacks.Subscribe<SteamFriends.PersonaStateCallback>(callback => {
                Session?.OnPersona(bot, callback);
                lock (PeerSync) {
                    PeerRequest? request = PendingPeer;
                    if (request is not null && ReferenceEquals(request.Reader, bot) && callback.FriendID.ConvertToUInt64() == request.Target && callback.StatusFlags.HasFlag(EClientPersonaStateFlag.Presence | EClientPersonaStateFlag.GameDataBlob))
                        request.Completion.TrySetResult($"Fresh peer MAIN: persona={callback.State}; raw GameID={(ulong)callback.GameID}; type={callback.GameID.AppType}; AppID={callback.GameID.AppID}; app field={callback.GameAppID}; flags={(uint)callback.StatusFlags}; name={Clean(callback.GameName ?? "")}; UTC={DateTimeOffset.UtcNow:O}.");
                }
            })
        ];
        if (Subscriptions.TryRemove(bot, out List<IDisposable>? old)) foreach (IDisposable item in old) item.Dispose();
        Subscriptions[bot] = subscriptions;
        return Task.CompletedTask;
    }
    private void SetActivity(Bot bot, bool connected, bool playing, uint appId) {
        lock (ActivitySync) {
            Activities.TryGetValue(bot.BotName, out Activity? old);
            long epoch = old is not null && ReferenceEquals(old.Bot, bot) && old.Connected == connected && old.Playing == playing && old.AppId == appId ? old.Epoch : ++Epoch;
            Activities[bot.BotName] = new(bot, connected, playing, appId, epoch);
        }
    }
    public async Task OnBotLoggedOn(Bot bot) {
        Bots[bot.BotName] = bot;
        lock (ActivitySync) {
            Activities.TryGetValue(bot.BotName, out Activity? old);
            SetActivity(bot, true, old is not null && ReferenceEquals(old.Bot, bot) && old.Playing, old is not null && ReferenceEquals(old.Bot, bot) ? old.AppId : 0);
        }
        await Lifecycle.WaitAsync().ConfigureAwait(false);
        try { if (Session is null) StartCurrent(); } finally { Lifecycle.Release(); }
    }
    public async Task OnBotDisconnected(Bot bot, EResult reason) {
        SetActivity(bot, false, false, 0);
        await Lifecycle.WaitAsync().ConfigureAwait(false);
        try { if (ReferenceEquals(Session?.Bot, bot)) QueueCleanup(false); } finally { Lifecycle.Release(); }
    }
    public async Task OnBotDestroy(Bot bot) {
        await OnBotDisconnected(bot, EResult.OK).ConfigureAwait(false);
        if (Bots.TryGetValue(bot.BotName, out Bot? registered) && ReferenceEquals(registered, bot)) Bots.TryRemove(bot.BotName, out _);
        if (Subscriptions.TryRemove(bot, out List<IDisposable>? subscriptions)) foreach (IDisposable item in subscriptions) item.Dispose();
        if (Transports.TryRemove(bot, out RichPresenceTransport? transport)) transport.CancelPending();
    }
    private RelayConfiguration Validate(RelayConfiguration candidate) {
        RelayConfiguration validated = RelayConfiguration.Parse(candidate.ToJson(), Bots.Keys.ToArray());
        Bot main = Bots[validated.MainBot]; HashSet<ulong> seen = [];
        foreach (string name in validated.SourceBots) {
            ulong id = Bots[name].SteamID;
            if (id != 0 && (id == main.SteamID || !seen.Add(id))) throw new InvalidDataException("Main/source aliases resolve to the same Steam account.");
        }
        return validated;
    }
    private IReadOnlyList<SourceCandidate> Candidates(RelayConfiguration configuration, Bot main) {
        List<SourceCandidate> result = []; HashSet<ulong> seen = [];
        lock (ActivitySync) foreach (string name in configuration.SourceBots) {
            if (!Bots.TryGetValue(name, out Bot? source)) { result.Add(new(name, 0, 0, 0, false, false)); continue; }
            Activities.TryGetValue(name, out Activity? activity);
            bool same = activity is not null && ReferenceEquals(activity.Bot, source);
            ulong id = source.SteamID; bool valid = id != 0 && id != main.SteamID && seen.Add(id);
            result.Add(new(name, id, same ? activity!.AppId : 0, same ? activity!.Epoch : 0, valid && same && activity!.Connected && source.IsConnectedAndLoggedOn, valid && same && activity!.Playing));
        }
        return result;
    }
    private void StartCurrent() {
        if (Session is not null || Configuration is null) return;
        if (!Cleanup.IsCompletedSuccessfully) { _ = StartAfterCleanupAsync(Cleanup, Revision); return; }
        try {
            RelayConfiguration config = Validate(Configuration); Bot main = Bots[config.MainBot];
            if (!main.IsConnectedAndLoggedOn || !Transports.TryGetValue(main, out RichPresenceTransport? transport)) { Warning = "Configured main is offline; waiting."; return; }
            Session = new(main, transport, config, () => Candidates(config, main), DesiredMode);
            Session.Start(); Warning = "";
            main.ArchiLogger.LogGenericInfo($"{Name} 0.3.0: {DesiredMode}; main={config.MainBot}; sources={string.Join(",", config.SourceBots)}.");
        } catch (Exception error) { Warning = $"Configuration waiting: {error.Message}"; }
    }
    private async Task StartAfterCleanupAsync(Task cleanup, long revision) {
        try {
            await cleanup.ConfigureAwait(false); await Lifecycle.WaitAsync().ConfigureAwait(false);
            try { if (revision == Revision) StartCurrent(); } finally { Lifecycle.Release(); }
        } catch (Exception error) { Warning = $"Cleanup failed ({error.GetType().Name}); relay stopped."; }
    }
    private void QueueCleanup(bool publish) {
        RelaySession? old = Session; Session = null;
        if (old is not null) Cleanup = FinishCleanupAsync(Cleanup, old, publish);
    }
    private async Task FinishCleanupAsync(Task previous, RelaySession old, bool publish) {
        try { await previous.ConfigureAwait(false); } finally {
            await old.StopAsync(publish).ConfigureAwait(false);
            CleanupNotice = old.CleanupDeferred ? $"Previous main {old.Bot.BotName}: owned farming pause released; game/RP cleanup deferred to ASF occupation handling while the account is unavailable." : "";
        }
    }
    private bool Authorized(EAccess access, ulong steamId) {
        if (access == EAccess.Owner) return true;
        Bot? target = Session?.Bot;
        if (target is null && Configuration is not null) Bots.TryGetValue(Configuration.MainBot, out target);
        return target is not null && Commands.GetProxyAccess(target, access, steamId) >= EAccess.Master;
    }
    public async Task<string?> OnBotCommand(Bot bot, EAccess access, string message, string[] args, ulong steamID = 0) {
        if (args.Length == 0 || !args[0].Equals("RPRELAY", StringComparison.OrdinalIgnoreCase)) return null;
        string verb = args.Length > 1 ? args[1].ToUpperInvariant() : "HELP";
        try {
            if (verb == "COPYCAPS") return "{\"protocol\":1,\"safeFields\":true,\"groupIdentifiers\":false,\"groupSize\":false,\"sources\":\"registered-bots\"}";
            if (verb is "CONFIG" or "APPLY" or "RELOAD") {
                if (access != EAccess.Owner) return "ASFStatusRelay: CONFIG/APPLY/RELOAD require ASF Owner permission.";
                if (verb == "CONFIG") return (Configuration ?? new RelayConfiguration()).ToJson();
                string json;
                if (verb == "RELOAD") json = File.ReadAllText(ConfigPath);
                else {
                    if (args.Length != 3 || args[2].Length > 65536) return "ASFStatusRelay: APPLY requires base64 UTF-8 JSON, maximum 32 KiB decoded.";
                    byte[] bytes = Convert.FromBase64String(args[2]);
                    if (bytes.Length > 32768) return "ASFStatusRelay: configuration exceeds 32 KiB.";
                    json = new UTF8Encoding(false, true).GetString(bytes);
                }
                return await ApplyAsync(RelayConfiguration.Parse(json, Bots.Keys.ToArray())).ConfigureAwait(false);
            }
            if (!Authorized(access, steamID)) return "ASFStatusRelay: configured-main Master/Owner permission required.";
            if (verb is "ON" or "OFF" or "OBSERVE") return await SetModeAsync(ParseMode(verb), access, steamID).ConfigureAwait(false);
            RelaySession? session;
            await Lifecycle.WaitAsync().ConfigureAwait(false);
            try { if (!Authorized(access, steamID)) return "ASFStatusRelay: main binding changed; permission required."; session = Session; }
            finally { Lifecycle.Release(); }
            if (verb == "STATE") return session?.StateJson() ?? EmptyStateJson();
            if (verb == "STATUS") return (session?.Status() ?? $"ASFStatusRelay: not bound. {Warning}") + $"\nSaved startup mode={Configuration?.StartupMode ?? "Observe"}. {Warning} {CleanupNotice}";
            if (session is null) return $"ASFStatusRelay: no active main binding. {Warning}";
            if (verb == "SOURCE") return await SourceAsync(session).ConfigureAwait(false);
            if (verb == "VERIFY") return await VerifyAsync(session).ConfigureAwait(false);
            return "ASFStatusRelay: COPYCAPS | STATUS | STATE | ON | OFF | OBSERVE | VERIFY | SOURCE | CONFIG | APPLY <base64-json> | RELOAD";
        } catch (Exception error) { return $"ASFStatusRelay: operation failed ({error.GetType().Name}): {error.Message}"; }
    }
    private async Task<string> ApplyAsync(RelayConfiguration candidate) {
        using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(40));
        await Lifecycle.WaitAsync(timeout.Token).ConfigureAwait(false);
        try {
            candidate = Validate(candidate);
            QueueCleanup(true);
            try { await Cleanup.WaitAsync(TimeSpan.FromSeconds(30), timeout.Token).ConfigureAwait(false); }
            catch { _ = StartAfterCleanupAsync(Cleanup, Revision); throw; }
            try { RelaySettings.SaveConfiguration(ConfigPath, candidate); } catch { StartCurrent(); throw; }
            Configuration = candidate; DesiredMode = ParseMode(candidate.StartupMode); Revision++; Warning = ""; StartCurrent();
            return $"ASFStatusRelay: configuration saved and applied. Main={candidate.MainBot}; sources={string.Join(",", candidate.SourceBots)}; mode={candidate.StartupMode}. {Warning} {CleanupNotice}";
        } finally { Lifecycle.Release(); }
    }
    private async Task<string> SetModeAsync(RelayMode mode, EAccess access, ulong steamId) {
        await Lifecycle.WaitAsync().ConfigureAwait(false);
        Task<string>? application; string persistence = "";
        try {
            if (!Authorized(access, steamId)) return "ASFStatusRelay: main binding changed; permission required.";
            if (Configuration is null) return "ASFStatusRelay: configure MainBot and SourceBots first.";
            DesiredMode = mode;
            try { RelaySettings.SaveStartupMode(ConfigPath, mode.ToString(), Configuration.AllowedApps); Configuration = Configuration with { StartupMode = mode.ToString() }; }
            catch (Exception error) { persistence = $" WARNING: startup-mode save failed ({error.GetType().Name}); restart persistence unverified."; }
            StartCurrent(); application = Session?.SetModeAsync(mode);
        } finally { Lifecycle.Release(); }
        return (application is null ? $"ASFStatusRelay: requested {mode}; waiting for main binding. {Warning}" : await application.ConfigureAwait(false)) + persistence;
    }
    private string EmptyStateJson() {
        using MemoryStream stream = new(); using (Utf8JsonWriter writer = new(stream)) {
            writer.WriteStartObject(); writer.WriteString("Mode", DesiredMode.ToString()); writer.WriteString("MainBot", Configuration?.MainBot ?? ""); writer.WriteString("SelectedSourceBot", ""); writer.WriteNumber("ActiveAppId", 0); writer.WriteBoolean("MainAvailable", false); writer.WriteNull("LastUploadAt"); writer.WriteNull("ObservedAt"); writer.WriteStartObject("RichPresence"); writer.WriteEndObject(); writer.WriteString("Detail", Warning); writer.WriteEndObject();
        } return Encoding.UTF8.GetString(stream.ToArray());
    }
    private Bot? ResolveSource(SourceCandidate selected) => Bots.TryGetValue(selected.Name, out Bot? source) && source.SteamID == selected.SteamId && source.IsConnectedAndLoggedOn ? source : null;
    private async Task<string> SourceAsync(RelaySession session) {
        if (!await Verification.WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false)) return "ASFStatusRelay: diagnostic busy.";
        try {
            SourceCandidate? selected = session.SelectionForDiagnostics();
            if (selected is null) return "ASFStatusRelay: no actual source session.\n" + session.Status();
            StringBuilder text = new($"SOURCE read-only: source={selected.Name}; SteamID={selected.SteamId}; app={selected.AppId}; epoch={selected.Epoch}\n");
            Bot? source = ResolveSource(selected);
            if (source is not null && Transports.TryGetValue(source, out RichPresenceTransport? transport)) {
                var own = await transport.RequestAsync(selected.AppId, selected.SteamId, CancellationToken.None).ConfigureAwait(false);
                AppendFields(text, "Source own session", own, transport.LastResponseSummary);
            }
            text.Append(await session.DiagnoseSourceAsync(selected).ConfigureAwait(false)); return text.ToString();
        } finally { Verification.Release(); }
    }
    private async Task<string> VerifyAsync(RelaySession session) {
        if (!await Verification.WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false)) return "ASFStatusRelay: diagnostic busy.";
        try {
            var target = session.VerificationTarget();
            if (target.Source is null || target.AppId == 0) return "ASFStatusRelay: no current or observed game to verify.";
            Bot? source = ResolveSource(target.Source);
            if (source is null || !Transports.TryGetValue(source, out RichPresenceTransport? transport)) return "ASFStatusRelay: selected source must be logged on.";
            string persona = $"MAIN local persona before reads={session.Bot.SteamFriends.GetPersonaState()}; configured={session.Bot.BotConfig.OnlineStatus}.";
            Task<string> peer = ReadPeerAsync(source, session.Bot.SteamID); Task<string> privacy = ReadPrivacyAsync(session.Bot, target.AppId);
            var actual = await transport.RequestAsync(target.AppId, session.Bot.SteamID, CancellationToken.None).ConfigureAwait(false);
            string[] diagnostics = await Task.WhenAll(peer, privacy).ConfigureAwait(false);
            StringBuilder text = new($"VERIFY source={source.BotName}; main={session.Bot.BotName}; app={target.AppId}\n{persona}\n{string.Join("\n", diagnostics)}\n");
            bool match = actual is not null && target.Values.Count == actual.Count && target.Values.All(pair => actual.TryGetValue(pair.Key, out string? value) && pair.Value == value);
            text.AppendLine(actual is null ? "Rich presence unavailable." : $"Server RP comparison={(match ? "MATCH" : "DIFFERENT")}; source observed={target.ObservedAt:O}. Confirm native badge using peer GameID.");
            AppendFields(text, "Main server fields", actual, transport.LastResponseSummary); return text.ToString();
        } finally { Verification.Release(); }
    }
    private async Task<string> ReadPeerAsync(Bot reader, ulong target) {
        PeerRequest request = new(reader, target); lock (PeerSync) PendingPeer = request;
        try {
            reader.SteamFriends.RequestFriendInfo(new SteamID(target), EClientPersonaStateFlag.Status | EClientPersonaStateFlag.Presence | EClientPersonaStateFlag.GameDataBlob | EClientPersonaStateFlag.GameExtraInfo);
            return await request.Completion.Task.WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
        } catch (Exception error) { return $"Peer game unverified ({error.GetType().Name})."; }
        finally { lock (PeerSync) if (ReferenceEquals(PendingPeer, request)) PendingPeer = null; }
    }
    private static async Task<string> ReadPrivacyAsync(Bot main, uint appId) {
        try {
            SteamUnifiedMessages? unified = main.GetHandler<SteamUnifiedMessages>();
            if (unified is null || !main.IsConnectedAndLoggedOn) return "Privacy read unavailable.";
            var appsTask = unified.CreateService<AccountPrivateApps>().GetPrivateAppList(new CAccountPrivateApps_GetPrivateAppList_Request()).ToTask().WaitAsync(TimeSpan.FromSeconds(7));
            var privacyTask = unified.CreateService<Player>().GetPrivacySettings(new CPlayer_GetPrivacySettings_Request()).ToTask().WaitAsync(TimeSpan.FromSeconds(7));
            await Task.WhenAll(appsTask, privacyTask).ConfigureAwait(false);
            var apps = await appsTask.ConfigureAwait(false); var privacy = await privacyTask.ConfigureAwait(false);
            string privateFlag = apps.Result == EResult.OK && apps.Body.private_apps is not null ? apps.Body.private_apps.appids.Any(id => id == appId).ToString() : "unverified";
            CPrivacySettings? settings = privacy.Body.privacy_settings;
            return $"Main app {appId} private={privateFlag}; privacy result={privacy.Result}; profile={settings?.privacy_state}; game details={settings?.privacy_state_ownedgames}; playtime={settings?.privacy_state_playtime}. No changes.";
        } catch (Exception error) { return $"Privacy read unverified ({error.GetType().Name})."; }
    }
    internal static void AppendFields(StringBuilder text, string label, Dictionary<string, string>? values, string summary) {
        text.AppendLine($"{label}: {(values is null ? "unavailable" : values.Count + " sanitized fields")}. {summary}");
        if (values is not null) foreach (var pair in values.Take(20)) text.AppendLine($"{Clean(pair.Key)}={Clean(pair.Value)}");
    }
    internal static string Clean(string value) => value.Replace("\r", " ").Replace("\n", " ").Replace("\t", " ");
    private static RelayMode ParseMode(string mode) => RelayConfiguration.NormalizeMode(mode) switch { "On" => RelayMode.On, "Off" => RelayMode.Off, _ => RelayMode.Observe };
    private sealed record Activity(Bot Bot, bool Connected, bool Playing, uint AppId, long Epoch);
    private sealed record PeerRequest(Bot Reader, ulong Target) { internal TaskCompletionSource<string> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously); }
}
internal enum RelayMode { Off, Observe, On }
