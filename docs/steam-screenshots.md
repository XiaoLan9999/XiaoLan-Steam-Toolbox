# Local Steam screenshot import

The toolbox prepares local images for Steam's screenshot manager. It does not
post images to Steam Cloud, impersonate the Steam client, or change a screenshot's
visibility. After preparation, open Steam and the game's screenshot manager,
and use Steam's own upload and privacy controls.

## Reference and implementation boundary

The requested reference is [SteaScree](https://github.com/awthwathje/SteaScree),
an archived GPL-3.0 Qt application. Its [README](https://github.com/awthwathje/SteaScree/blob/master/README.md)
describes making externally captured images available to Steam's uploader.
Its [controller](https://github.com/awthwathje/SteaScree/blob/master/controller.cpp)
and [header](https://github.com/awthwathje/SteaScree/blob/master/controller.h)
document the local file layout, metadata field names, thumbnail width, and image
dimension limits used for interoperability. The toolbox uses its own TypeScript
implementation, parser, transactions, image adapter, and interface. It does not
bundle or copy SteaScree's source, resources, or Qt application. The reference
retains its own license; this is not a relicensing of that project.

## Discovery and readable selectors

- Installation discovery checks Steam's installation registry values and standard
  installation directories, not unrelated user folders. A manually selected Steam
  directory can be remembered by the toolbox controller.
- Only directories immediately under the selected installation's `userdata` are
  treated as candidate local Steam accounts. Screenshot initialization is not a
  prerequisite: an account without `760/screenshots.vdf` remains selectable.
- Account IDs are shown with SteamID64 and available local names. Only the
  `PersonaName`, `AccountName`, and `MostRecent` metadata from `loginusers.vdf` is
  exposed. `localconfig.vdf` can supply a more recently used persona name.
  No password, login cookie, refresh token, or credential store is accessed.
- Game names come from installed `appmanifest_*.acf` files in known libraries,
  local app metadata, and existing screenshot/shortcut metadata. Unsupported or
  missing metadata produces a visible fallback instead of hiding the account or
  game. Binary `shortcuts.vdf` is parsed as bounded data; executables and launch
  options are never executed. Existing 64-bit non-Steam game IDs remain usable.
- Public online name lookups, cache policy, startup refresh, and manual refresh
  are handled by the controller/name provider, independently of Steam login.

## Mode 1: current-account screenshot API (default, 0.16.4)

Mode 1 requires Steam to be running and uses a dedicated, short-lived local
helper with the official `ISteamScreenshots::AddScreenshotToLibrary` API. It does
not mutate an index owned by a running Steam client. Steam creates the local
image, thumbnail and library entry itself. No cloud upload is performed.

The Windows x64 helper connects to the existing Steam user through its own pipe.
It does not use `SteamAPI_Init`, a separate personal CM session, the Friends
interface, rich-presence writes, screenshot hooks, a game injection or a modified
Valve DLL. The selected local user must match the user returned by the API; an
unrelated/stale registry ActiveProcess PID is not treated as account identity.
The actual single Steam process, executable path, start time, image hash, API
identity, app context and license are checked. New DLL versions fail closed and
stop mode 1 rather than guessing vtable compatibility or selecting mode 2.

This route currently requires a supported client, a valid Steam AppID and an
empty caption. An unsupported target, different local account or caption stops
mode 1 without starting a different workflow. The user must explicitly select
mode 2 if appropriate. A helper game context can briefly appear as
the target game; exit real games and stop presence simulation/locks/copying first.
This feature does not promise import while another game is actively running.

Each image is encoded into a private transaction directory. A synced atomic
ledger records `submitting` before any request reaches the helper. The helper
calls Add once, then waits for the matching ScreenshotReady callback (2301,
same user and handle, EResult 1). The parent additionally verifies a newly created
JPEG with the expected hash under the selected user/game. A nonzero handle alone
is never completion. Only confirmed images leave the queue.

After timeout, an unexpected worker exit, failed result persistence, or missing
file proof, the image remains uncertain. Its durable source digest blocks
reimport to the same user/game, including reselecting the source after a toolbox
restart and trying the offline fallback. Other unsubmitted/rejected images remain
processable. Unknown results are never automatically retried or replayed through
the local-index route. Inability to initialize stops mode 1. Even a checked legacy
restart flag cannot make mode 1 close Steam, write a VDF or select mode 2.

Records are kept in `screenshot-live-imports/` under toolbox userData. They contain
only transaction-local JPEG filenames/hashes and target metadata, not original
source paths or login tokens. Finished/rejected/unsubmitted JPEGs are removed
only after the helper actually exits and their path and hash still match; uncertain
JPEGs and records are retained for inspection. A worker whose exit is unconfirmed
blocks presence changes and update installation, while already confirmed imports
remain successful. Do not delete uncertain records merely to force a retry.

The screenshot files and this ledger are not part of a SQLite-only data export;
preserve them separately during a migration.

The initial real-client experiment succeeded with CS2 on the tested client:
Steam returned the matching success callback, the created JPEG matched the input
hash, the original Steam PID/start time remained unchanged, and the user confirmed
the image was visible in Steam's screenshot manager with the friends list normal.
This does not establish compatibility with every game or future client version.

## Mode 2: specified-account local library import

Mode 2 never starts the placeholder game/API screenshot route. With Steam fully
closed, it uses the existing backed-up index transaction directly. With Steam
running, a separate read-only helper obtains the real current SteamID through
the pinned User interface only, using no game, friends, apps or screenshot
interfaces. Its zero-app context does not submit a game status. The actual Steam
PID/start time/path and DLL hash are verified, all resources must be released,
and actual helper exit must be observed. It does not rely on stale registry
ActiveUser/ActiveProcess values or a debugging port.

If the selected target is not current, the main process creates a one-use opaque
permit bound to this service, the complete input and the current Steam identity.
The ordinary `prepare()` guard is not weakened. Only `prepareInactive()` can
consume this private permit, and it rechecks the real identity, PID/start time,
path and DLL hash at all three existing write boundaries. A forged renderer
flag, changed input, account switch, ambiguous instance or unavailable identity
cannot authorize a write. Existing backups, metadata hash comparisons, rollback
and uncertain-image blocking still apply.

A successful inactive-target import returns `activation: after-account-switch`.
It never exits, starts or switches Steam, even if the independent restart option
is checked. The result instructs the user to switch to the target account later
and review/upload in Steam. An experiment switching to another remembered account confirmed this path on
the current client: native account switching restarted Steam, the gallery opened
the test image and the original metadata and image hashes survived unchanged.

If the target is current, mode 2 requires Steam to exit first. Its independent
automatic exit/reopen option defaults off. Enabling it still requires native
confirmation, and the selected account and bound client are rechecked before
and after confirmation. Cancelling leaves Steam and the queue unchanged. No
current-account API attempt automatically selects this option or this mode.

1. The native file picker grants the main process the selected source paths.
   The renderer receives opaque queue IDs, dimensions, and bounded JPEG previews,
   not arbitrary filesystem read access. PNG, JPEG, WebP, and BMP inputs are
   supported. The queue is bounded at 100 images and each input at 32 MiB.
2. The target account must not be active during an index write. If Steam is
   running as a different verified user, the private inactive-account permit
   above is used and Steam is left alone. Otherwise Steam must be fully exited.
   The optional automatic exit presents a destination review and, if the target
   account is actually running, a
   native warning with Cancel as the default. It verifies the single active
   Steam PID/start time, registry executable, selected installation, regular
   executable file identity and absence of running games. Active toolbox local
   simulation, presence connections, locks or status copying must be stopped
   first. Only then does it request normal `steam.exe -shutdown`, wait at most
   60 seconds for exit and observe a stable stopped period. It never force-kills
   a process or restarts a Windows service. No confirmation, unverifiable
   identity, running games, or timeout means no import. Uncheck the automatic
   option to keep the manual-exit workflow. The original process guard remains
   checked before preparation, before publishing image files, and immediately
   before committing the index, even after an automatic exit; the inactive route
   performs its bound-user verification at those same three boundaries instead.
3. Sources are reread and checked against their selection-time SHA-256. Images
   are encoded one at a time to JPEG and aspect-preserving thumbnails. Automatic
   reduction observes the reference's 16,000-pixel side and 26,210,175-pixel area
   limits. Original images are not modified.
4. Files are staged under `userdata/<AccountID>/760`. Existing screenshot files
   are not overwritten. The main JPEG and thumbnail use fresh unique names below
   `remote/<GameID>/screenshots` and `screenshots/thumbnails`.
5. The exact original `screenshots.vdf`, when present, and a transaction manifest
   are saved in `760/.xiaolan-screenshot-backups/<timestamp>-<transaction>/`.
   The manifest records whether an original index existed, its hash, the prepared
   index hash, and the relative imported filenames. It does not contain source
   image paths, login data, or tokens.
6. Existing metadata bytes, comments, unknown fields, and entries are preserved;
   new entries are appended using free indexes. Invalid, ambiguous, non-UTF-8,
   conditional, or excessively large metadata is rejected instead of rewritten.
   An external change to the index aborts the operation.
7. The new index is committed by an atomic rename only after all referenced
   images have been written and synchronized. A handled pre-commit failure removes
   only the new files whose hashes still match this operation. Existing entries
   and files are never rolled back or deleted.
8. If this operation requested Steam to exit, it reopens the originally verified
   executable after import, including a best-effort reopen on an import failure.
   Steam that was already closed is not launched automatically. Restart failure
   after a committed import is a separate warning, not a failed import: the queue
   is cleared and the user is told to open Steam manually, not import again.
   Closing/importing/starting progress is displayed, and conflicting screenshot
   and local-presence IPC operations are fenced for the entire transaction.

This fallback file-index workflow does not use a service-only refresh. The public
[ISteamScreenshots API](https://partner.steamgames.com/doc/api/ISteamScreenshots)
provides game-context screenshot submission, not a documented rescan of an
externally modified VDF. The fallback does not initialize a game's Steamworks
context, restart Steam Client Service, or kill steamwebhelper. Steam Cloud upload
and visibility still require the user's own action
in Steam after import.

An application crash before the index commit can leave unreferenced new JPEGs or
an internal staging directory; the old index remains valid. A crash after the
atomic commit leaves a complete index and image set. A dead-process import lock
can be recovered on the next import. Unknown or live-process locks are preserved.
Backups are intentionally retained for manual recovery and are not automatically
deleted. To restore a backup manually, exit Steam first, preserve the current
index, and replace `760/screenshots.vdf` with that backup's original file. Do not
restore an old index over newer Steam changes without reviewing its contents.

All write tests use disposable fixtures, and lifecycle tests use injected fake
processes. Tests and isolated native-image/renderer smoke
checks do not prove that Steam Cloud accepted a file: final acceptance and upload
remain a Steam-client action.
