using System.Text;
using System.Text.RegularExpressions;
using ProtoBuf;
using SteamKit2;

namespace ASFStatusRelay;

// SteamKit's generated type omits the legacy binary field (tag 2).
// Retain both formats; Steam currently sends either depending on the backend.
[ProtoContract]
public sealed class RichPresenceInfo : Extensible {
    [ProtoMember(1)] public List<RichPresenceEntry> Entries { get; } = [];
}

[ProtoContract]
public sealed class RichPresenceEntry : Extensible {
    [ProtoMember(1, DataFormat = DataFormat.FixedSize)] public ulong SteamID { get; set; }
    [ProtoMember(2)] public byte[] BinaryKeyValues { get; set; } = [];
    [ProtoMember(3)] public List<RichPresenceKeyValue> KeyValues { get; } = [];
}

[ProtoContract]
public sealed class RichPresenceKeyValue : Extensible {
    [ProtoMember(1)] public string Key { get; set; } = "";
    [ProtoMember(2)] public string Value { get; set; } = "";
}

public static class RichPresenceCodec {
    public const int MaxBinaryBytes = 65536;
    private static readonly HashSet<string> PublicKeys = new(StringComparer.Ordinal) {
        "desc", "status", "activity", "details", "version", "state", "currentmap", "map", "mode", "score", "matchgrouploc",
        "game:state", "game:mode", "game:map", "game:act", "game:score"
    };
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private static readonly Regex DisplayToken = new(@"\A#[A-Za-z0-9_]{1,127}\z", RegexOptions.CultureInvariant);
    private static readonly Regex PrivateValue = new(@"(?:[a-z][a-z0-9+.-]*\s*://|\bwww\.|\b(?:steam|https?|wss?):|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-f0-9]{0,4}:){2,}[a-f0-9]{0,4}|(?<!\d)\d{16,20}(?!\d)|\b(?:connect|join(?:_token)?|lobby|room|session|auth|token|ticket|password|secret|server|ip|address|port|id)\s*[=:]\s*\S)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50));

    private static bool SafeValue(string value) {
        try {
            if (StrictUtf8.GetByteCount(value) > 255 || value.Any(c => char.IsControl(c) || c is '\u2028' or '\u2029')) return false;
            return !PrivateValue.IsMatch(value);
        } catch (Exception error) when (error is EncoderFallbackException or RegexMatchTimeoutException) { return false; }
    }

    public static Dictionary<string, string> Decode(byte[] bytes) {
        ArgumentNullException.ThrowIfNull(bytes);
        if (bytes.Length == 0) return new(StringComparer.Ordinal);
        if (bytes.Length > MaxBinaryBytes) throw new InvalidDataException("Presence payload exceeds limit.");
        using MemoryStream stream = new(bytes, false);
        KeyValue root = new();
        if (!root.TryReadAsBinary(stream)) throw new InvalidDataException("Invalid binary presence payload.");
        KeyValue values = root.Name == "RP" ? root : root["RP"];
        Dictionary<string, string> result = new(StringComparer.Ordinal);
        foreach (KeyValue field in values.Children) {
            if (field.Name is not null && field.Value is not null) result[field.Name] = field.Value;
        }
        return result;
    }

    public static byte[] Encode(IReadOnlyDictionary<string, string> values) {
        ArgumentNullException.ThrowIfNull(values);
        KeyValue root = new("RP");
        // Enforce the same policy at the upload boundary, including any future caller.
        foreach ((string key, string value) in Sanitize(values)) root.Children.Add(new KeyValue(key, value));
        using MemoryStream stream = new();
        root.SaveToStream(stream, true);
        if (stream.Length > MaxBinaryBytes) throw new InvalidDataException("Presence payload exceeds limit.");
        return stream.ToArray();
    }

    public static Dictionary<string, string> Sanitize(IReadOnlyDictionary<string, string> values) {
        ArgumentNullException.ThrowIfNull(values);
        Dictionary<string, string> result = new(StringComparer.Ordinal);
        HashSet<string> seen = new(StringComparer.Ordinal);
        foreach ((string key, string value) in values) {
            if (result.Count >= 20) break;
            if (string.IsNullOrEmpty(key) || value is null || key.Length > 63) continue;
            string normalized = key.ToLowerInvariant();
            if (normalized != "steam_display" && !PublicKeys.Contains(normalized)) continue;
            if (!SafeValue(value) || (normalized == "steam_display" && !DisplayToken.IsMatch(value))) continue;
            // Case aliases must not change which field gets published.
            if (!seen.Add(normalized)) { result.Remove(normalized); continue; }
            result[normalized] = value;
        }
        return result;
    }
}

public static class RelayPolicy {
    public static bool IsValidSteamId(ulong value) {
        SteamID steamId = new(value);
        return steamId.IsValid && steamId.IsIndividualAccount;
    }
    public static bool ShouldMirror(bool destinationAvailable, bool sourceVisible, uint sourceAppId, IReadOnlySet<uint> allowedApps) =>
        destinationAvailable && sourceVisible && sourceAppId != 0 && allowedApps.Contains(sourceAppId);
    public static bool SourceIsEligible(bool sourceSessionKnown, bool externalPlaying, uint externalAppId, uint visibleAppId) =>
        !sourceSessionKnown || (externalPlaying && externalAppId == visibleAppId && visibleAppId != 0);
    public static uint EffectiveSourceApp(bool sourceSessionKnown, bool externalPlaying, uint externalAppId, uint friendAppId) =>
        sourceSessionKnown ? (externalPlaying ? externalAppId : 0) : friendAppId;
    public static bool IsOwnedSourceStillEligible(bool sourceSessionKnown, bool externalPlaying, uint externalAppId, long currentActivityGeneration, uint expectedAppId, long expectedActivityGeneration) =>
        sourceSessionKnown && externalPlaying && expectedAppId != 0 && externalAppId == expectedAppId && currentActivityGeneration == expectedActivityGeneration;
    public static bool IsConfiguredPersonaVisible(int configuredState) => configuredState is >= 1 and <= 6;
    public static bool NeedsGameEntryReset(uint activeAppId, uint nextAppId) => nextAppId != 0 && activeAppId != nextAppId;
}
