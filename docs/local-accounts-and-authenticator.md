# Local accounts and authenticator codes

## Steam client account selection

The client account switcher is independent of toolbox web-login accounts.
It reads remembered account labels from the registered Steam installation's
`config/loginusers.vdf`, including both modern `AutoLogin` and older selectors.
It does not extract passwords, login tokens, SSFN files or mobile secrets.

An explicit switch opens a native confirmation. If Steam is running, the
toolbox first requires reliable idle-game evidence, requests a normal shutdown,
and waits for exit. Unknown activity, running games, local presence work,
screenshot imports and an unconfirmed exit prevent the switch. There is no
force-kill fallback.

After exit, it re-reads Steam's shutdown saves and changes only startup selectors:
`AutoLogin`, `MostRecent`, the selected user's `AllowAutoLogin`, registry
`AutoLoginUser`, and an existing `WebStorage/Auth/AlwaysShowUserChooser` setting.
It does not change password-remembering or persona preferences. An explicit
online/offline startup choice changes only that account's offline startup flags;
the other accounts' offline flags remain unchanged. The chooser-setting change
is disclosed in the confirmation. Unknown fields and
unrelated configuration are preserved.

Configuration replacement is checked against hashes and staged in the original
Steam configuration directory. The single bounded recovery record contains
encrypted selector values/presence and hashes, not a persistent copy of whole
Steam configuration files. Failed operations restore only owned, unchanged
outputs while Steam remains closed. An incomplete rollback is explicitly
reported and prevents another automatic switch, including after toolbox restart.
Preserve that record for manual review instead of deleting it to bypass the gate.

Starting Steam is not a successful-login confirmation. Expired or absent cached
credentials can still require a password or Steam Guard through Steam itself.
The implementation does not force the global RememberPassword preference on.

The selector mechanism was researched from the upstream Watt Toolkit sources,
then independently implemented; no upstream switcher implementation is embedded:

- https://github.com/BeyondDimension/SteamTools/blob/1eeeae7ec4577af17ff86298317bbe047e68e614/src/BD.WTTS.Client.Plugins.GameAccount/Services.Implementation/SteamPlatformSwitcher.cs
- https://github.com/BeyondDimension/SteamClient/blob/b2f0cd31e390253922c453865128fd283d376332/src/BD.SteamClient/Services.Implementation/SteamServiceImpl.cs

## Existing SDA maFiles

Use the Local authenticators page to select an existing unencrypted `.maFile`.
The native picker passes the selected path only to the main process. The
renderer never receives the file, path, shared secret, identity secret or
session tokens. It receives labels and short-lived five-character codes only.

Version 0.17 retained only identifiers and `shared_secret`. Version 0.18 asks
for explicit native consent before retaining supported confirmation, device
and recovery material in its encrypted v2 vault. Old v1 entries remain code-only;
discarded fields cannot be reconstructed. Re-import the original maFile to add
missing capabilities. Login access/refresh tokens and cookies from imported
Session objects are always discarded.
SteamID64 numeric JSON values are parsed without floating-point rounding.
Duplicate replacement and local deletion require native confirmation. The
original source maFile is never modified or deleted.

The vault is separately encrypted using Windows DPAPI through Electron
safeStorage and atomically saved as `steam-authenticators.vault.json` in the
toolbox data directory. No plaintext fallback is allowed. A different Windows
user or computer may not decrypt this vault: keep the original maFiles privately
and re-import them on the new machine. Normal database exports/imports and
diagnostic reports do not include the vault or secrets.

Codes follow Steam Guard's HMAC-SHA1, 30-second counter and five-character
alphabet. Opening the page, importing or refreshing does not send secrets to
Steam. Only the explicit Sync Steam time action makes an anonymous fixed-endpoint
time request; failure falls back to the local clock with a visible notice.
Hiding the page pauses countdowns and clears renderer codes, and expired codes
are not displayed. Copy requests identify an entry; the main process generates
the current code rather than trusting a renderer-provided code.

Version 0.18 also provides a separate MobileApp-authenticated enrollment wizard,
explicit private export/recovery views and individual trade/market confirmations.
It never automatically removes a phone authenticator or confirms all entries.
Enrollment pending material is encrypted and durable before activation; issued
but unverified or partial material remains isolated instead of being invented or
discarded. See the Chinese setup guide for the complete workflow and recovery
boundaries. Imported/exported maFiles never contain a reusable login session.
SDA itself is not bundled; protocol compatibility was researched from its
upstream project and SteamAuth:

- https://github.com/Jessecar96/SteamDesktopAuthenticator
- https://github.com/geel9/SteamAuth

## Validation boundary

Automated tests use isolated synthetic accounts, files and secrets only. No
real account was switched and no real user maFile was imported during automated
validation. The local preview still needs the owner's explicit usability check.
The unrelated experimental Snooze implementation remains disabled after its
failed live verification; this release does not silently enable it.
