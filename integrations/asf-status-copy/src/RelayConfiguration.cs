using System.Text;
using System.Text.Json;

namespace ASFStatusRelay;

public sealed record RelayConfiguration {
    public string MainBot { get; init; } = "";
    public string[] SourceBots { get; init; } = [];
    public uint[] AllowedApps { get; init; } = [730];
    public string StartupMode { get; init; } = "Observe";
    public int PollIntervalSeconds { get; init; } = 15;

    public static RelayConfiguration Parse(string json, IReadOnlyCollection<string>? knownBotNames = null) {
        if (Encoding.UTF8.GetByteCount(json) > 32768) throw new InvalidDataException("Configuration exceeds 32 KiB.");
        using JsonDocument document = JsonDocument.Parse(json);
        if (document.RootElement.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Configuration must be an object.");
        Dictionary<string, JsonElement> fields = new(StringComparer.OrdinalIgnoreCase);
        foreach (JsonProperty property in document.RootElement.EnumerateObject()) {
            if (!fields.TryAdd(property.Name, property.Value)) throw new InvalidDataException("Duplicate configuration property.");
        }
        string main = RequiredString(fields, "MainBot");
        if (!fields.TryGetValue("SourceBots", out JsonElement sources) || sources.ValueKind != JsonValueKind.Array || sources.GetArrayLength() is < 1 or > 32) throw new InvalidDataException("SourceBots requires 1 to 32 names.");
        List<string> sourceNames = [];
        HashSet<string> seen = new(StringComparer.Ordinal) { main };
        foreach (JsonElement source in sources.EnumerateArray()) {
            string name = source.ValueKind == JsonValueKind.String ? source.GetString()!.Trim() : "";
            if (string.IsNullOrEmpty(name) || !seen.Add(name)) throw new InvalidDataException("Empty, duplicate, or main-account source name.");
            sourceNames.Add(name);
        }
        uint[] apps = [730];
        if (fields.TryGetValue("AllowedApps", out JsonElement appArray)) {
            if (appArray.ValueKind != JsonValueKind.Array || appArray.GetArrayLength() is < 1 or > 32) throw new InvalidDataException("AllowedApps requires 1 to 32 IDs.");
            HashSet<uint> appSet = [];
            foreach (JsonElement app in appArray.EnumerateArray()) {
                if (!app.TryGetUInt32(out uint id) || id == 0 || id > 0xffffff || !appSet.Add(id)) throw new InvalidDataException("Invalid or duplicate app ID.");
            }
            apps = appSet.ToArray();
        }
        string mode = "Observe";
        if (fields.ContainsKey("StartupMode")) mode = NormalizeMode(RequiredString(fields, "StartupMode"));
        int interval = 15;
        if (fields.TryGetValue("PollIntervalSeconds", out JsonElement intervalElement) && (!intervalElement.TryGetInt32(out interval) || interval is < 15 or > 120)) throw new InvalidDataException("PollIntervalSeconds must be 15 to 120.");
        if (knownBotNames is not null) {
            Dictionary<string, string> roster = new(StringComparer.Ordinal);
            foreach (string name in knownBotNames) roster[name] = name;
            if (!roster.TryGetValue(main, out string? canonicalMain)) throw new InvalidDataException("MainBot is not a registered ASF bot.");
            main = canonicalMain;
            for (int i = 0; i < sourceNames.Count; i++) {
                if (!roster.TryGetValue(sourceNames[i], out string? canonicalSource)) throw new InvalidDataException("A SourceBot is not a registered ASF bot.");
                sourceNames[i] = canonicalSource;
            }
        }
        return new() { MainBot = main, SourceBots = sourceNames.ToArray(), AllowedApps = apps, StartupMode = mode, PollIntervalSeconds = interval };
    }

    public string ToJson() {
        using MemoryStream stream = new();
        using (Utf8JsonWriter writer = new(stream, new JsonWriterOptions { Indented = true })) {
            writer.WriteStartObject(); writer.WriteString("MainBot", MainBot);
            writer.WritePropertyName("SourceBots"); writer.WriteStartArray(); foreach (string name in SourceBots) writer.WriteStringValue(name); writer.WriteEndArray();
            writer.WritePropertyName("AllowedApps"); writer.WriteStartArray(); foreach (uint app in AllowedApps) writer.WriteNumberValue(app); writer.WriteEndArray();
            writer.WriteString("StartupMode", StartupMode); writer.WriteNumber("PollIntervalSeconds", PollIntervalSeconds); writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    public static string NormalizeMode(string mode) => mode.Trim().ToUpperInvariant() switch { "ON" => "On", "OFF" => "Off", "OBSERVE" => "Observe", _ => throw new InvalidDataException("Invalid StartupMode.") };
    private static string RequiredString(Dictionary<string, JsonElement> fields, string name) => fields.TryGetValue(name, out JsonElement value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString()) ? value.GetString()!.Trim() : throw new InvalidDataException($"{name} is required.");
}

public sealed record SourceCandidate(string Name, ulong SteamId, uint AppId, long Epoch, bool Connected, bool Playing);

public static class SourceSelection {
    public static SourceCandidate? Select(IReadOnlyList<SourceCandidate> ordered, IReadOnlySet<uint> allowed, string? currentName, ulong excludedSteamId = 0) {
        bool Eligible(SourceCandidate candidate) => candidate.Connected && candidate.Playing && RelayPolicy.IsValidSteamId(candidate.SteamId) && candidate.SteamId != excludedSteamId && allowed.Contains(candidate.AppId);
        SourceCandidate? sticky = ordered.FirstOrDefault(candidate => string.Equals(candidate.Name, currentName, StringComparison.Ordinal) && Eligible(candidate));
        return sticky ?? ordered.FirstOrDefault(Eligible);
    }
    public static bool IsCurrent(SourceCandidate selected, SourceCandidate? current) => current is not null && current.Connected && current.Playing && selected.Name == current.Name && selected.SteamId == current.SteamId && selected.AppId == current.AppId && selected.Epoch == current.Epoch;
}
