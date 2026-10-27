using System.Text.Json;

namespace ASFStatusRelay;

public static class RelaySettings {
    private const int MaxConfigBytes = 32768;
    public static void SaveConfiguration(string path, RelayConfiguration configuration) {
        string json = configuration.ToJson();
        RelayConfiguration.Parse(json);
        string temporary = path + ".tmp." + Guid.NewGuid().ToString("N");
        try {
            using (FileStream stream = new(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                byte[] bytes = System.Text.Encoding.UTF8.GetBytes(json);
                stream.Write(bytes); stream.Flush(true);
            }
            File.Move(temporary, path, true);
        } finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    public static string ReadStartupMode(string path) {
        if (!File.Exists(path)) return "Observe";
        using JsonDocument document = ReadDocument(path);
        foreach (JsonProperty property in document.RootElement.EnumerateObject()) {
            if (property.Name.Equals("StartupMode", StringComparison.OrdinalIgnoreCase)) {
                if (property.Value.ValueKind != JsonValueKind.String) throw new InvalidDataException("StartupMode must be a mode name.");
                return NormalizeMode(property.Value.GetString()!);
            }
        }
        return "Observe";
    }

    public static void SaveStartupMode(string path, string mode, IReadOnlyCollection<uint> defaultAllowedApps) {
        mode = NormalizeMode(mode);
        string temporary = path + ".tmp." + Guid.NewGuid().ToString("N");
        JsonDocument? existing = null;
        try {
            if (File.Exists(path)) existing = ReadDocument(path);
            bool hasApps = false;
            using (FileStream stream = new(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                using (Utf8JsonWriter writer = new(stream, new JsonWriterOptions { Indented = true })) {
                    writer.WriteStartObject();
                    if (existing is not null) foreach (JsonProperty property in existing.RootElement.EnumerateObject()) {
                        if (property.Name.Equals("StartupMode", StringComparison.OrdinalIgnoreCase)) continue;
                        if (property.Name.Equals("AllowedApps", StringComparison.OrdinalIgnoreCase)) {
                            if (property.Value.ValueKind != JsonValueKind.Array || property.Value.GetArrayLength() is < 1 or > 32) throw new InvalidDataException("Invalid existing AllowedApps.");
                            foreach (JsonElement app in property.Value.EnumerateArray()) {
                                if (!app.TryGetUInt32(out uint appId) || appId == 0 || appId > 0xffffff) throw new InvalidDataException("Invalid existing app ID.");
                            }
                            hasApps = true;
                        }
                        property.WriteTo(writer);
                    }
                    if (!hasApps) {
                        writer.WritePropertyName("AllowedApps");
                        writer.WriteStartArray();
                        foreach (uint appId in defaultAllowedApps) writer.WriteNumberValue(appId);
                        writer.WriteEndArray();
                    }
                    writer.WriteString("StartupMode", mode);
                    writer.WriteEndObject();
                }
                stream.Flush(true);
                if (stream.Length > MaxConfigBytes) throw new InvalidDataException("Updated configuration exceeds limit.");
            }
            File.Move(temporary, path, true);
        } finally {
            existing?.Dispose();
            try { if (File.Exists(temporary)) File.Delete(temporary); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    private static JsonDocument ReadDocument(string path) {
        if (new FileInfo(path).Length > MaxConfigBytes) throw new InvalidDataException("Configuration exceeds limit.");
        JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
        if (document.RootElement.ValueKind == JsonValueKind.Object) return document;
        document.Dispose();
        throw new InvalidDataException("Configuration must be a JSON object.");
    }

    private static string NormalizeMode(string mode) => mode.Trim().ToUpperInvariant() switch {
        "ON" => "On",
        "OFF" => "Off",
        "OBSERVE" => "Observe",
        _ => throw new ArgumentException("Unknown relay startup mode.", nameof(mode))
    };
}
