# Audited Windows x64 Steam public-interface profiles

The local AppID host and the client-only real-game backend share
`scripts/steam-public-interface-profiles.cs`. The native broker accepts the same
two exact SHA-256 values. File version labels are descriptive; they do not select
a profile.

| File version | Exact `steamclient64.dll` SHA-256 |
| --- | --- |
| 11.12.30.07 | `e9045710ec7ee47d7b7488d1c5dda2d933dec7e251e965967a5c48f4df68eb4e` |
| 11.15.70.27 | `253e0a11a4415b38c78a42f7bdd6ecc426455f06c1ba6453a48090df3142dbbc` |

Unknown hashes are rejected. Each call also verifies the selected profile's exact
vptr and function address against the helper's own loaded module. Profiles cannot
be mixed, selected by a version prefix, or derived by applying an RVA delta.

## Public interfaces and vtable RVAs

All object vptrs are at offset zero. The entries below are RVAs, not absolute
addresses. They do not describe any private interface or remote-process memory.

| Interface | 11.12.30.07 | 11.15.70.27 |
| --- | --- | --- |
| SteamClient021 | `130c398` | `130c7d8` |
| SteamUser023 | `13193c8` | `1319808` |
| SteamFriends018 | `130e640` | `130ea80` |
| SteamUtils010 | `131aab0` | `131aef0` |
| STEAMAPPS_INTERFACE_VERSION008 | `130b018` | `130b458` |
| STEAMUNIFIEDMESSAGES_INTERFACE_VERSION001 | `130aa78` | `130aeb8` |

## Audited function RVAs

Slots are zero based. Both profiles use the same listed interface versions and
slots, but every function address is recorded explicitly.

| Interface / method | Slot | 11.12.30.07 | 11.15.70.27 |
| --- | ---: | --- | --- |
| Client.CreateSteamPipe | 0 | `516230` | `5162f0` |
| Client.BReleaseSteamPipe | 1 | `7202a0` | `720360` |
| Client.ConnectToGlobalUser | 2 | `71ff40` | `720000` |
| Client.ReleaseUser | 4 | `71ff90` | `720050` |
| Client.GetISteamUser | 5 | `71ffd0` | `720090` |
| Client.GetISteamFriends | 8 | `720070` | `720130` |
| Client.GetISteamUtils | 9 | `720090` | `720150` |
| Client.GetISteamGenericInterface | 12 | `7201a0` | `720260` |
| Client.GetISteamApps | 15 | `7200e0` | `7201a0` |
| User.BLoggedOn | 1 | `71e550` | `71e610` |
| User.GetSteamID | 2 | `722bc0` | `722c80` |
| Utils.GetAppID | 9 | `72e210` | `72e2d0` |
| Apps.BIsSubscribedApp | 6 | `71e810` | `71e8d0` |
| Friends.SetRichPresence | 41 | `7233c0` | `723480` |
| Friends.GetFriendRichPresence | 43 | `722f80` | `723040` |
| Friends.GetFriendRichPresenceKeyCount | 44 | `723000` | `7230c0` |
| Friends.GetFriendRichPresenceKeyByIndex | 45 | `722fc0` | `723080` |
| Unified.SendMethod | 0 | `71e540` | `71e600` |
| Unified.GetMethodResponseInfo | 1 | `71e520` | `71e5e0` |
| Unified.GetMethodResponseData | 2 | `71e500` | `71e5c0` |
| Unified.ReleaseMethod | 3 | `71e530` | `71e5f0` |
| Unified.SendNotification (not exposed by either helper) | 4 | `71e550` | `71e610` |

The Windows x64 C++ `GetSteamID` member uses an explicit eight-byte result buffer
in RDX with `self` in RCX, and returns that buffer pointer in RAX. It is not a
`ulong(self)` delegate. Boolean returns and the Unified response auto-release
argument are marshalled as one byte. Unified handles and contexts are scalar
64-bit values.

## Evidence and limits

Each profile was inspected from disk using PE exports, RTTI/factory registration,
vtable entries and adapter disassembly. Interface order and signatures were
cross-checked against Valve's published [SDK 1.62 headers](https://github.com/ValveSoftware/Proton/tree/proton_11.0/lsteamclient/steamworks_sdk_162)
and [Unified Messages header](https://github.com/ValveSoftware/Proton/blob/proton_11.0/lsteamclient/steamworks_sdk_130/isteamunifiedmessages.h).
This does not require loading a game SDK, installing a game, connecting a CM
account, or reading another process's memory.

Pure tests verify all 22 rows for both hashes and reject unknown hashes and
cross-profile pointer combinations. Build tests verify that both helper builds
include the shared profile source. These checks are not a live Steam acceptance
test or a guarantee of friend-client visibility. Game ownership checks, process
and account guards, and owned-resource cleanup remain in place.

For a future Steam update, first obtain a new static audit and explicit table.
Do not relax the hash or pointer guards to make an unknown build run.
