using ASFStatusRelay;

int assertions = 0;
void Check(bool condition, string label) {
    assertions++;
    if (!condition) throw new InvalidOperationException("Offline sanitizer test failed: " + label);
}
Dictionary<string, string> Field(string key, string value) => new(StringComparer.Ordinal) { [key] = value };
string[] publicKeys = ["desc", "status", "activity", "details", "version", "state", "currentmap", "map", "mode", "score", "matchgrouploc", "game:state", "game:mode", "game:map", "game:act", "game:score"];
foreach (string key in publicKeys) Check(RichPresenceCodec.Sanitize(Field(key, "Public menu")).ContainsKey(key), "public key " + key);
string[] rejectedKeys = ["connect", "Connect", "steam_player_group", "steam_player_group_size", "group", "party", "game:server", "room", "game:room", "join_token", "session", "session_id", "server", "serverid", "id", "steamid", "ip", "port", "url", "game:url", "password", "token", "unknown", "__proto__"];
foreach (string key in rejectedKeys) {
    Check(RichPresenceCodec.Sanitize(Field(key, "private-marker")).Count == 0, "private key " + key);
    Check(RichPresenceCodec.Decode(RichPresenceCodec.Encode(Field(key, "private-marker"))).Count == 0, "upload private key " + key);
}
string[] rejectedValues = ["https://example.test/join", "steam://joinlobby/fixture", "www.example.test", "192.0.2.1:27015", "[2001:db8::1]", "76561198000000001", "session=fixture", "join_token:fixture", "server=fixture", "id=fixture", "bad\0text", "bad\ntext", "bad\ttext", "bad\u0085text", "bad\u2028text", "bad\u2029text", new string('x', 256), new string('\u754c', 86), "bad\ud800"];
foreach (string value in rejectedValues) Check(RichPresenceCodec.Sanitize(Field("desc", value)).Count == 0, "private/control/oversize value");
Check(RichPresenceCodec.Sanitize(Field("desc", new string('x', 255))).Count == 1, "255-byte public value");
Check(RichPresenceCodec.Sanitize(Field("desc", new string('\u754c', 85))).Count == 1, "255-byte Unicode value");
Check(RichPresenceCodec.Sanitize(Field("score", "2:1")).Count == 1, "public score");
Check(RichPresenceCodec.Sanitize(Field("steam_display", "#Status_1")).Count == 1, "display token");
foreach (string value in new[] { "Menu", "#", "#token%map%", "#token/room", "#bad\n", "##token", "#" + new string('x', 128) }) Check(RichPresenceCodec.Sanitize(Field("steam_display", value)).Count == 0, "invalid display token");
Check(RichPresenceCodec.Sanitize(Field("DESC", "Public")).ContainsKey("desc"), "normalized public key");
Check(RichPresenceCodec.Sanitize(new Dictionary<string, string> { ["desc"] = "One", ["DESC"] = "Two" }).Count == 0, "case alias rejected");
var mixed = new Dictionary<string, string> { ["desc"] = "Public menu", ["steam_display"] = "#Status", ["game:server"] = "private-marker", ["room"] = "private-marker", ["join_token"] = "private-marker", ["connect"] = "private-marker", ["steam_player_group"] = "private-marker" };
var decoded = RichPresenceCodec.Decode(RichPresenceCodec.Encode(mixed));
Check(decoded.Count == 2 && decoded["desc"] == "Public menu" && decoded["steam_display"] == "#Status", "upload policy round trip");
Check(!System.Text.Encoding.UTF8.GetString(RichPresenceCodec.Encode(mixed)).Contains("private-marker"), "no private upload bytes");
Console.WriteLine($"Offline sanitizer assertions passed: {assertions}. No Steam client or network operation was performed.");
