using System.Text;
using System.Text.Json;
using ArchiSteamFarm.Steam;
using SteamKit2;

namespace ASFStatusRelay;

internal sealed class RelaySession(Bot bot, RichPresenceTransport transport, RelayConfiguration configuration, Func<IReadOnlyList<SourceCandidate>> candidates, RelayMode initialMode) {
    internal Bot Bot { get; } = bot;
    private readonly IReadOnlySet<uint> Allowed = new HashSet<uint>(configuration.AllowedApps);
    private readonly SemaphoreSlim Gate = new(1, 1);
    private readonly CancellationTokenSource Shutdown = new();
    private readonly object PersonaSync = new();
    private volatile RelayMode Mode = initialMode;
    private Task? Loop;
    private SourceCandidate? Selected;
    private SourceCandidate? LastObservedSource;
    private Dictionary<string, string> Observed = new(StringComparer.Ordinal);
    private DateTimeOffset? ObservedAt;
    private DateTimeOffset? LastUploadAt;
    private uint ActiveAppId;
    private uint PendingClearAppId;
    private bool? WasPaused;
    private Task<(bool Success, string Message)>? PauseTask;
    private Task? ResumeTask;
    private string Detail = "Waiting for a configured source's actual game session.";
    private TaskCompletionSource<bool>? PersonaReceived;
    private string PersonaDiagnostic = "No selected-source persona callback yet.";
    internal bool CleanupDeferred => PendingClearAppId != 0;
    internal void Start() => Loop = Task.Run(LoopAsync);
    internal SourceCandidate? SelectionForDiagnostics() => Selected ?? SourceSelection.Select(candidates(), Allowed, null, Bot.SteamID) ?? LastObservedSource;
    internal (SourceCandidate? Source, uint AppId, Dictionary<string, string> Values, DateTimeOffset? ObservedAt) VerificationTarget() {
        SourceCandidate? source = SelectionForDiagnostics();
        return (source, ActiveAppId != 0 ? ActiveAppId : source?.AppId ?? 0, new(Observed, StringComparer.Ordinal), ObservedAt);
    }
    private bool Current(SourceCandidate selected) => !Shutdown.IsCancellationRequested && Bot.IsConnectedAndLoggedOn && Bot.BotName == configuration.MainBot
        && selected.SteamId != Bot.SteamID && SourceSelection.IsCurrent(selected, candidates().FirstOrDefault(item => item.Name == selected.Name));
    private bool CanPublish(SourceCandidate selected) => Mode == RelayMode.On && Bot.IsPlayingPossible && Current(selected);
    internal void OnPersona(Bot reader, SteamFriends.PersonaStateCallback callback) {
        SourceCandidate? selected = Selected;
        if (!ReferenceEquals(reader, Bot) || selected is null || callback.FriendID.ConvertToUInt64() != selected.SteamId) return;
        lock (PersonaSync) {
            PersonaDiagnostic = $"Friend persona={callback.State}; flags={(uint)callback.StatusFlags} ({callback.StatusFlags}); app field={callback.GameAppID}; GameID={(ulong)callback.GameID}; UTC={DateTimeOffset.UtcNow:O}. Omitted fields may be defaults; source authority is its own ASF session.";
            if (callback.StatusFlags.HasFlag(EClientPersonaStateFlag.Presence | EClientPersonaStateFlag.GameDataBlob)) PersonaReceived?.TrySetResult(true);
        }
    }
    internal string Status() {
        StringBuilder text = new($"ASFStatusRelay {Mode}; main={Bot.BotName}; active app={ActiveAppId}; selected source={Selected?.Name ?? "none"}\n");
        text.AppendLine($"Main available={Bot.IsConnectedAndLoggedOn && Bot.IsPlayingPossible}; farmer paused={Bot.CardsFarmer.Paused}; local persona={Bot.SteamFriends.GetPersonaState()}; configured persona={Bot.BotConfig.OnlineStatus}.");
        text.AppendLine($"Allowed apps={string.Join(',', configuration.AllowedApps)}; poll={configuration.PollIntervalSeconds}s; observed={ObservedAt:O}; upload sent={LastUploadAt:O}.");
        foreach (SourceCandidate source in candidates()) text.AppendLine($"Source {source.Name}: connected={source.Connected}; actual playing={source.Playing}; app={source.AppId}; epoch={source.Epoch}; SteamID={source.SteamId}.");
        text.AppendLine(Detail); lock (PersonaSync) text.AppendLine(PersonaDiagnostic);
        foreach (var pair in Observed.Take(20)) text.AppendLine($"{Plugin.Clean(pair.Key)}={Plugin.Clean(pair.Value)}");
        return text.ToString().TrimEnd();
    }
    internal string StateJson() {
        using MemoryStream stream = new(); using (Utf8JsonWriter writer = new(stream)) {
            writer.WriteStartObject(); writer.WriteString("Mode", Mode.ToString()); writer.WriteString("MainBot", Bot.BotName); writer.WriteString("SelectedSourceBot", Selected?.Name ?? ""); writer.WriteNumber("ActiveAppId", ActiveAppId); writer.WriteBoolean("MainAvailable", Bot.IsConnectedAndLoggedOn && Bot.IsPlayingPossible);
            if (LastUploadAt is not null) writer.WriteString("LastUploadAt", LastUploadAt.Value); else writer.WriteNull("LastUploadAt");
            if (ObservedAt is not null) writer.WriteString("ObservedAt", ObservedAt.Value); else writer.WriteNull("ObservedAt");
            writer.WriteStartObject("RichPresence"); foreach (var pair in Observed) writer.WriteString(pair.Key, pair.Value); writer.WriteEndObject(); writer.WriteString("Detail", Detail); writer.WriteEndObject();
        } return Encoding.UTF8.GetString(stream.ToArray());
    }
    internal async Task<string> SetModeAsync(RelayMode mode) {
        Mode = mode;
        using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(Shutdown.Token); timeout.CancelAfter(TimeSpan.FromSeconds(35));
        await Gate.WaitAsync(timeout.Token).ConfigureAwait(false);
        try {
            if (mode != RelayMode.On) await RestoreAsync(true, timeout.Token).ConfigureAwait(false);
            if (mode != RelayMode.Off) await TickAsync(timeout.Token).ConfigureAwait(false);
            else Detail = WasPaused is null && PendingClearAppId == 0 ? "Relay stopped; previous behavior restored." : "Relay stopped; restoration is pending until the main account is available.";
            return Status();
        } finally { Gate.Release(); }
    }
    private async Task LoopAsync() {
        try {
            while (!Shutdown.IsCancellationRequested) {
                await Gate.WaitAsync(Shutdown.Token).ConfigureAwait(false);
                try { await TickAsync(Shutdown.Token).ConfigureAwait(false); }
                catch (Exception error) when (error is not OperationCanceledException) { Detail = $"Observation failed ({error.GetType().Name}); restoring previous behavior."; await RestoreAsync(true, Shutdown.Token).ConfigureAwait(false); }
                finally { Gate.Release(); }
                await Task.Delay(TimeSpan.FromSeconds(configuration.PollIntervalSeconds), Shutdown.Token).ConfigureAwait(false);
            }
        } catch (OperationCanceledException) when (Shutdown.IsCancellationRequested) { }
    }
    private async Task TickAsync(CancellationToken token) {
        if (!Bot.IsConnectedAndLoggedOn) return;
        if (Mode != RelayMode.On && (WasPaused is not null || ActiveAppId != 0 || PendingClearAppId != 0)) await RestoreAsync(true, token).ConfigureAwait(false);
        if (Mode == RelayMode.Off) return;
        if (Mode == RelayMode.On && !Bot.IsPlayingPossible) { await RestoreAsync(false, token).ConfigureAwait(false); Detail = "Main account is occupied; relay suspended."; return; }
        if (PendingClearAppId != 0 && Bot.IsPlayingPossible) { transport.Upload(PendingClearAppId, new Dictionary<string, string>()); PendingClearAppId = 0; }
        SourceCandidate? selected = SourceSelection.Select(candidates(), Allowed, Selected?.Name, Bot.SteamID); Selected = selected;
        if (selected is null) {
            Observed = new(StringComparer.Ordinal); ObservedAt = DateTimeOffset.UtcNow;
            if (Mode == RelayMode.On) await RestoreAsync(true, token).ConfigureAwait(false);
            Detail = "No configured source is actually playing an allowed game; waiting."; return;
        }
        Dictionary<string, string>? values = await transport.RequestAsync(selected.AppId, selected.SteamId, token).ConfigureAwait(false);
        if (!Current(selected)) values = null;
        Observed = values ?? new(StringComparer.Ordinal); ObservedAt = DateTimeOffset.UtcNow; LastObservedSource = selected;
        if (Mode != RelayMode.On) { Detail = "Observe only; no account state changes."; return; }
        if (values is null) { await RestoreAsync(true, token).ConfigureAwait(false); Detail = "Source unavailable or session changed; stale data cleared."; return; }
        if (!CanPublish(selected)) { await RestoreAsync(false, token).ConfigureAwait(false); return; }
        if (!await EnsurePausedAsync(token).ConfigureAwait(false)) return;
        if (!CanPublish(selected)) { await RestoreAsync(Bot.IsPlayingPossible, token).ConfigureAwait(false); return; }
        if (!Bot.CardsFarmer.Paused || Bot.CardsFarmer.NowFarming) { Detail = "Waiting for farming to stop."; return; }
        if (ActiveAppId != 0 && ActiveAppId != selected.AppId) transport.Upload(ActiveAppId, new Dictionary<string, string>());
        bool entry = RelayPolicy.NeedsGameEntryReset(ActiveAppId, selected.AppId);
        if (entry && RelayPolicy.IsConfiguredPersonaVisible((int)Bot.BotConfig.OnlineStatus)) {
            if (!CanPublish(selected)) { await RestoreAsync(Bot.IsPlayingPossible, token).ConfigureAwait(false); return; }
            Bot.SteamFriends.SetPersonaState(Bot.BotConfig.OnlineStatus);
        }
        bool sent = await transport.PlayAsync(new uint[] { selected.AppId }, cancellationToken: token, canSend: () => CanPublish(selected), resetBefore: entry).ConfigureAwait(false);
        if (!sent) { await RestoreAsync(Bot.IsPlayingPossible, token).ConfigureAwait(false); return; }
        ActiveAppId = selected.AppId;
        if (!CanPublish(selected)) { await RestoreAsync(Bot.IsPlayingPossible, token).ConfigureAwait(false); return; }
        transport.Upload(selected.AppId, values); LastUploadAt = DateTimeOffset.UtcNow;
        Detail = $"Mirroring {selected.Name}, app {selected.AppId}. Check server display with VERIFY.";
    }
    private async Task<bool> EnsurePausedAsync(CancellationToken token) {
        if (ResumeTask is not null) {
            try { await ResumeTask.WaitAsync(TimeSpan.FromSeconds(5), token).ConfigureAwait(false); }
            catch (TimeoutException) { Detail = "Previous farming resume is pending; waiting before acquiring a new pause."; return false; }
            ResumeTask = null; WasPaused = null;
        }
        WasPaused ??= Bot.CardsFarmer.Paused;
        if (Bot.CardsFarmer.Paused && PauseTask is null) return true;
        PauseTask ??= Bot.Actions.Pause(true);
        try { await PauseTask.WaitAsync(TimeSpan.FromSeconds(15), token).ConfigureAwait(false); PauseTask = null; return true; }
        catch (TimeoutException) { Detail = "Farming pause is still finishing; retrying without replacing game state."; return false; }
    }
    private async Task RestoreAsync(bool publish, CancellationToken token) {
        if (ActiveAppId != 0) { PendingClearAppId = ActiveAppId; ActiveAppId = 0; }
        if (PendingClearAppId != 0 && publish && Bot.IsConnectedAndLoggedOn && Bot.IsPlayingPossible) { transport.Upload(PendingClearAppId, new Dictionary<string, string>()); PendingClearAppId = 0; }
        if (PauseTask is not null) {
            try { await PauseTask.WaitAsync(TimeSpan.FromSeconds(15), token).ConfigureAwait(false); PauseTask = null; }
            catch (TimeoutException) { Detail = "Pause cleanup is pending."; return; }
            catch (Exception error) when (error is not OperationCanceledException) { PauseTask = null; }
        }
        if (WasPaused is null || (publish && (!Bot.IsConnectedAndLoggedOn || !Bot.IsPlayingPossible))) return;
        if (publish && !Bot.CardsFarmer.NowFarming) await transport.PlayAsync(Bot.BotConfig.GamesPlayedWhileIdle, Bot.BotConfig.CustomGamePlayedWhileIdle, token, () => Bot.IsConnectedAndLoggedOn && Bot.IsPlayingPossible).ConfigureAwait(false);
        if (WasPaused == false) {
            ResumeTask ??= ResumeOwnedPauseAsync();
            try { await ResumeTask.WaitAsync(TimeSpan.FromSeconds(5), token).ConfigureAwait(false); }
            catch (TimeoutException) { Detail = "Owned farming pause resume is pending; rebind waits for the observed farmer state."; return; }
            ResumeTask = null;
        }
        WasPaused = null;
    }
    private async Task ResumeOwnedPauseAsync() {
        if (Bot.CardsFarmer.Paused) Bot.Actions.Resume();
        // Actions.Resume schedules its work. Do not let a new session inherit our temporary pause
        // as if it belonged to the user, or allow this delayed resume to overtake a new mirror.
        while (Bot.CardsFarmer.Paused) await Task.Delay(50).ConfigureAwait(false);
    }
    internal async Task StopAsync(bool publish) {
        Shutdown.Cancel(); transport.CancelPending(); lock (PersonaSync) PersonaReceived?.TrySetCanceled();
        if (Loop is not null) { try { await Loop.WaitAsync(TimeSpan.FromSeconds(18)).ConfigureAwait(false); } catch (Exception) { } }
        await Gate.WaitAsync().ConfigureAwait(false);
        try {
            if (PauseTask is not null) { try { await PauseTask.ConfigureAwait(false); } catch (Exception) { } finally { PauseTask = null; } }
            await RestoreAsync(publish, CancellationToken.None).ConfigureAwait(false);
            // During a real game, release only our pause. ASF occupation handling restores its idle
            // behavior later; never publish an old route over an occupied real playing session.
            if (WasPaused is not null) await RestoreAsync(false, CancellationToken.None).ConfigureAwait(false);
            if (ResumeTask is not null) {
                await ResumeTask.ConfigureAwait(false);
                await RestoreAsync(false, CancellationToken.None).ConfigureAwait(false);
            }
        } finally { Gate.Release(); }
    }
    internal async Task<string> DiagnoseSourceAsync(SourceCandidate selected) {
        if (!await Gate.WaitAsync(TimeSpan.FromSeconds(8)).ConfigureAwait(false)) return "Main diagnostic busy; retry shortly.";
        try {
            Selected ??= selected;
            TaskCompletionSource<bool> received = new(TaskCreationOptions.RunContinuationsAsynchronously); lock (PersonaSync) PersonaReceived = received;
            try {
                Bot.SteamFriends.RequestFriendInfo(new SteamID(selected.SteamId), EClientPersonaStateFlag.Status | EClientPersonaStateFlag.Presence | EClientPersonaStateFlag.GameDataBlob | EClientPersonaStateFlag.GameExtraInfo);
                try { await received.Task.WaitAsync(TimeSpan.FromSeconds(5), Shutdown.Token).ConfigureAwait(false); } catch (TimeoutException) { }
            } finally { lock (PersonaSync) if (ReferenceEquals(PersonaReceived, received)) PersonaReceived = null; }
            StringBuilder text = new(); lock (PersonaSync) text.AppendLine(PersonaDiagnostic);
            var values = await transport.RequestAsync(selected.AppId, selected.SteamId, Shutdown.Token).ConfigureAwait(false);
            Plugin.AppendFields(text, "Main reading selected source", values, transport.LastResponseSummary); return text.ToString();
        } finally { Gate.Release(); }
    }
}
