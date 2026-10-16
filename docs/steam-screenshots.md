# Local Steam screenshot import

The toolbox prepares local images for Steam's screenshot manager. It does not
post images to Steam Cloud, impersonate the Steam client, or change a screenshot's
visibility. After preparation, start Steam, open the game's screenshot manager,
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

## Preparation and recovery

1. The native file picker grants the main process the selected source paths.
   The renderer receives opaque queue IDs, dimensions, and bounded JPEG previews,
   not arbitrary filesystem read access. PNG, JPEG, WebP, and BMP inputs are
   supported. The queue is bounded at 100 images and each input at 32 MiB.
2. Steam must be fully exited. The process guard is checked before preparation,
   before publishing image files, and immediately before committing the index.
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

An application crash before the index commit can leave unreferenced new JPEGs or
an internal staging directory; the old index remains valid. A crash after the
atomic commit leaves a complete index and image set. A dead-process import lock
can be recovered on the next import. Unknown or live-process locks are preserved.
Backups are intentionally retained for manual recovery and are not automatically
deleted. To restore a backup manually, exit Steam first, preserve the current
index, and replace `760/screenshots.vdf` with that backup's original file. Do not
restore an old index over newer Steam changes without reviewing its contents.

All write tests use disposable fixtures. Tests and isolated native-image smoke
checks do not prove that Steam Cloud accepted a file: final acceptance and upload
remain a Steam-client action.
