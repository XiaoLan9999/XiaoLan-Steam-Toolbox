# ASFStatusRelay 0.3.0 safe-field companion

This source builds the optional ASF plugin required by the toolbox's ASF status-copy mode. It is derived from the generic ASFStatusRelay 0.2 code, with a stricter server-side rich-presence publication policy. No account, server address, password, user configuration or captured presence data is included.

## Privacy boundary

Version 0.2 excludes only connection/group fields and can still publish other join-related values. It is **not compatible** with the toolbox's safe status-copy feature. Version 0.3 advertises `RPRELAY COPYCAPS` and enforces an explicit public-field allowlist both after decoding a source response and immediately before encoding every upload.

Allowed fields are `desc`, `status`, `activity`, `details`, `version`, `state`, `currentmap`, `map`, `mode`, `score`, `matchgrouploc`, `game:state`, `game:mode`, `game:map`, `game:act`, `game:score`, and a valid `steam_display` token. Unknown keys, group identifiers/size, connection/server/room/session/join fields, controls, overlong text, URLs, network addresses and recognizable identifier-bearing join strings are dropped. An omitted game-specific parameter can prevent a game's localized status template from rendering; it is never replaced by invented data. This policy is not a general-purpose content/data-loss-prevention scanner for arbitrary free text.

`COPYCAPS` returns exactly:

```json
{"protocol":1,"safeFields":true,"groupIdentifiers":false,"groupSize":false,"sources":"registered-bots"}
```

Both source and destination must be existing, logged-in ASF bots. It does not turn an arbitrary friend's SteamID into an authenticated source. The original configuration and STATE schema remain compatible, but the toolbox refuses a plugin without these exact capabilities.

## Build without contacting Steam

Requirements: .NET 10 SDK and an extracted ASF-generic distribution matching the intended deployment (reference build: ASF 6.3.10.6). Run:

```powershell
.\Build.ps1 -ASFDirectory 'C:\build\ASF-generic' -Dotnet 'dotnet'
```

The script compiles the plugin, runs deterministic offline sanitizer tests, and places only `ASFStatusRelay.dll` plus this README in `out/package/`. Build dependencies and test executables remain under ignored `out/build/`; do not package that directory. There are no generated example account configurations. No plugin is installed and no bot is started/restarted by the build or tests.

## Manual deployment and operation

Review and back up the existing ASF plugin/configuration before any manual replacement. First send `RPRELAY OFF` through the trusted ASF console/IPC, then read `CONFIG` and `STATE` to verify the relay is stopped and saved `StartupMode` is `Off` (or an intentionally selected non-publishing `Observe`). Only then replace the DLL and perform a controlled ASF restart: a saved old `On` route can otherwise start again automatically. Preserve the existing server-side `ASFStatusRelay.json`; do not copy another user's configuration, an old archive, or automatically rewrite the user's JSON. The toolbox does not perform the installation or restart. Confirm `RPRELAY COPYCAPS` after restart before enabling a route.

The generic commands remain `CONFIG`, `APPLY`, `STATE`, `ON`, `OFF`, `OBSERVE`, and the existing optional diagnostics. `OFF` stops the relay, not the entire ASF bot or its Steam connection. A crashed/disconnected controller cannot guarantee OFF reached the server; version 0.3 still has no expiring lease, atomic configuration update or controller identifier. An existing On route must be manually stopped before the toolbox can replace it. Never run two controllers against the same relay configuration.

The toolbox reports submission times as unverified, not proof of another friend's rendered Steam display. See the repository's `docs/status-copy-asf.md` for ownership, stop, restoration and compatibility limits.
