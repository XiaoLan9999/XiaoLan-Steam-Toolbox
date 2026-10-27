using SteamKit2;
using SteamKit2.Internal;

namespace ASFStatusRelay;

internal sealed class RichPresenceTransport(Action<string> warning) : ClientMsgHandler {
    // ASF derives its cached OSType from this same SteamKit default at logon.
    private static readonly uint ClientOsType = unchecked((uint)new SteamUser.LogOnDetails().ClientOSType);
    private readonly object Sync = new();
    private PendingRequest? Pending;
    internal string LastResponseSummary { get; private set; } = "No request yet.";

    public override void HandleMsg(IPacketMsg packetMsg) {
        if (packetMsg.MsgType != EMsg.ClientRichPresenceInfo) return;
        PendingRequest? pending;
        lock (Sync) pending = Pending;
        if (pending is null) return;
        try {
            ClientMsgProtobuf<RichPresenceInfo> message = new(packetMsg);
            if (message.TargetJobID != JobID.Invalid && message.TargetJobID != pending.JobId) return;
            if (message.ProtoHeader.routing_appid != 0 && message.ProtoHeader.routing_appid != pending.AppId) return;
            RichPresenceEntry? entry = message.Body.Entries.FirstOrDefault(item => item.SteamID == pending.SteamId);
            if (entry is null) { LastResponseSummary = $"Reply received; route={message.ProtoHeader.routing_appid}; entries={message.Body.Entries.Count}; requested entry absent."; return; }
            Dictionary<string, string> values = entry.BinaryKeyValues.Length > 0
                ? RichPresenceCodec.Decode(entry.BinaryKeyValues) : new(StringComparer.Ordinal);
            foreach (RichPresenceKeyValue field in entry.KeyValues) values[field.Key] = field.Value;
            Dictionary<string, string> sanitized = RichPresenceCodec.Sanitize(values);
            LastResponseSummary = $"Reply received; route={message.ProtoHeader.routing_appid}; binary bytes={entry.BinaryKeyValues.Length}; protobuf pairs={entry.KeyValues.Count}; sanitized fields={sanitized.Count}.";
            pending.Completion.TrySetResult(sanitized);
        } catch (Exception error) {
            // Do not log raw packets: they may contain connection/join information.
            warning($"Unreadable presence response ({error.GetType().Name}); old relay data will be cleared.");
            LastResponseSummary = $"Unreadable reply ({error.GetType().Name}).";
            pending.Completion.TrySetResult(null);
        }
    }

    internal async Task<Dictionary<string, string>?> RequestAsync(uint appId, ulong steamId, CancellationToken cancellationToken) {
        if (Client?.IsConnected != true) return null;
        PendingRequest pending = new(appId, steamId, Client.GetNextJobID());
        lock (Sync) {
            if (Pending is not null) throw new InvalidOperationException("A presence request is already pending.");
            Pending = pending;
            LastResponseSummary = "Request in progress.";
        }
        try {
            ClientMsgProtobuf<CMsgClientRichPresenceRequest> request = new(EMsg.ClientRichPresenceRequest);
            request.SourceJobID = pending.JobId;
            request.ProtoHeader.routing_appid = appId;
            request.Body.steamid_request.Add(steamId);
            Client.Send(request);
            return await pending.Completion.Task.WaitAsync(TimeSpan.FromSeconds(7), cancellationToken).ConfigureAwait(false);
        } catch (TimeoutException) {
            LastResponseSummary = "No matching response within 7 seconds. " + LastResponseSummary;
            return null;
        } finally {
            lock (Sync) if (ReferenceEquals(Pending, pending)) Pending = null;
        }
    }

    internal void CancelPending() {
        lock (Sync) {
            Pending?.Completion.TrySetResult(null);
            Pending = null;
        }
    }

    internal void Upload(uint appId, IReadOnlyDictionary<string, string> values) {
        if (Client?.IsConnected != true) return;
        ClientMsgProtobuf<CMsgClientRichPresenceUpload> request = new(EMsg.ClientRichPresenceUpload);
        request.ProtoHeader.routing_appid = appId;
        request.Body.rich_presence_kv = RichPresenceCodec.Encode(values);
        Client.Send(request);
    }

    internal async Task<bool> PlayAsync(IReadOnlyCollection<uint> appIds, string? customName = null, CancellationToken cancellationToken = default, Func<bool>? canSend = null, bool resetBefore = false) {
        cancellationToken.ThrowIfCancellationRequested();
        if (Client?.IsConnected != true || canSend?.Invoke() == false) return false;
        ClientMsgProtobuf<CMsgClientGamesPlayed> request = new(EMsg.ClientGamesPlayedWithDataBlob);
        request.Body.client_os_type = ClientOsType;
        if (resetBefore || !string.IsNullOrEmpty(customName)) {
            Client.Send(request);
            await Task.Delay(500, cancellationToken).ConfigureAwait(false);
            if (!Client.IsConnected || canSend?.Invoke() == false) return false;
        }
        if (!string.IsNullOrEmpty(customName)) {
            request.Body.games_played.Add(new CMsgClientGamesPlayed.GamePlayed {
                game_extra_info = customName,
                game_id = new GameID { AppType = GameID.GameType.Shortcut, ModID = uint.MaxValue }
            });
        }
        foreach (uint appId in appIds.Where(id => id != 0).Distinct().Take(32 - request.Body.games_played.Count)) {
            request.Body.games_played.Add(new CMsgClientGamesPlayed.GamePlayed { game_id = new GameID(appId) });
        }
        cancellationToken.ThrowIfCancellationRequested();
        if (!Client.IsConnected || canSend?.Invoke() == false) return false;
        Client.Send(request);
        return true;
    }

    private sealed record PendingRequest(uint AppId, ulong SteamId, JobID JobId) {
        internal TaskCompletionSource<Dictionary<string, string>?> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
}
