# Local online-state lock

This feature is separate from game Rich Presence. It never calls gamesPlayed,
SetRichPresence, logOn or a game executable. It does not change group size,
game titles, display templates or join information.

## Current capability

- Snooze (persona state 4): experimental implementation, disabled in production
  because live verification did not confirm it works
- VR indicator: not implemented; the current friends UI reads persona flag 2048
- Steam Deck indicator: not implemented; the current friends UI reads gaming
  device type 544, not the Big Picture flag 1024

The latter two are not simulated with text, Big Picture, a second same-account
CM login, or an automatic SteamVR launch. A per-app "ForceIdentAsSteamDeck"
setting is not evidence that the remote persona device badge can be changed.

## Native boundary

The x64 helper uses an app-0 pipe in the already running local Steam client.
No game DLL is loaded or edited. The helper pins the exact steamclient64.dll
SHA-256 `253e0a11a4415b38c78a42f7bdd6ecc426455f06c1ba6453a48090df3142dbbc`
and verifies vtable and function addresses before each call.

It deliberately requests the historical SteamFriends002 adapter, whose slot 3
is SetPersonaState. It does not use slot 3 of SteamFriends018 (which has no
setter). The matching Valve Proton wrapper is:

https://github.com/ValveSoftware/Proton/blob/proton_11.0/lsteamclient/cppISteamFriends_SteamFriends002.cpp

The local static proof links the current image's adapter factory, vptr,
getter/setter forwarding thunks and named IPC serializer. Runtime addresses
are not inferred from an old header or accepted for unknown client hashes.

Each read/write verifies Steam PID, process start, image, logged-on state and
the full expected SteamID. The process owner must also remain alive. An
account/client change stops the operation instead of rebinding or logging in.

## Lifecycle

- Opening the page or restarting the toolbox does not create a helper or lock
- The main process checks every 5 seconds; only differing states are reapplied
- Offline (0) and invisible (7) cancel the lease without a write or restoration
- A normal stop restores the original state only if the current state is still
  snooze and identity checks still match; this is best-effort, not an atomic
  Steam compare-and-swap API
- EOF or 30 seconds without a command attempts the same conditional restoration
- If the owner has died, identity/owner guards are not bypassed to restore
- Stop waits for helper cleanup and actual process exit; a kill request is not
  exit confirmation, and unconfirmed helpers remain tracked
- Readback verifies the local cache only, not independent server/friend display

Diagnostics retain only allowlisted stages, state numbers, error codes and a
restoration boolean, with no account ID, credentials or raw helper output.

Managed fake-session tests do not establish live Steam behavior. A short live
test and friend-client observation are still required before claiming that
the current Steam build publishes and retains the indicator correctly.
The legacy setter did not produce a confirmed lock in live validation, even
with a bounded readback wait. `PERSONA_SET_REJECTED` means readback did not
match; it is not a documented Steam rejection response. Do not enable the
production write gate or publish the feature as functional on that evidence.
