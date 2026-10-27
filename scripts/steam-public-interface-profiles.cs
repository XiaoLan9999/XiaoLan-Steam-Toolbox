using System;
using System.Collections.Generic;

internal enum SteamPublicMethod
{
    CreatePipe, ReleasePipe, ConnectUser, ReleaseUser, GetUser, GetFriends, GetUtils, GetGeneric, GetApps,
    LoggedOn, SteamId, GetAppId, SubscribedApp, SetPresence, GetPresence, CountPresence, IndexPresence,
    SendMethod, ResponseInfo, ResponseData, ReleaseMethod, SendNotification
}

internal sealed class SteamPublicProfile
{
    internal sealed class Call
    {
        internal readonly SteamPublicMethod Method;
        internal readonly int VtableRva, Slot, FunctionRva;
        internal Call(SteamPublicMethod method, int vtableRva, int slot, int functionRva)
        {
            Method = method; VtableRva = vtableRva; Slot = slot; FunctionRva = functionRva;
        }
    }

    internal readonly string Hash, FileVersion;
    private readonly Dictionary<SteamPublicMethod, Call> calls = new Dictionary<SteamPublicMethod, Call>();
    private SteamPublicProfile(string hash, string fileVersion, Call[] entries)
    {
        Hash = hash; FileVersion = fileVersion;
        foreach (Call entry in entries) calls.Add(entry.Method, entry);
    }
    internal Call Get(SteamPublicMethod method) { return calls[method]; }
    internal static bool IsSupported(string hash) { SteamPublicProfile profile; return TrySelect(hash, out profile); }
    internal static bool TrySelect(string hash, out SteamPublicProfile profile)
    {
        if (String.Equals(hash, Previous.Hash, StringComparison.Ordinal)) { profile = Previous; return true; }
        if (String.Equals(hash, Current.Hash, StringComparison.Ordinal)) { profile = Current; return true; }
        profile = null; return false;
    }
    internal static bool Matches(IntPtr module, IntPtr actualVtable, IntPtr actualFunction, Call expected)
    {
        return module != IntPtr.Zero && actualVtable == new IntPtr(module.ToInt64() + expected.VtableRva)
            && actualFunction == new IntPtr(module.ToInt64() + expected.FunctionRva);
    }

    // Each row was checked against its exact disk image; no relocation delta or version fallback is used.
    private static readonly SteamPublicProfile Previous = new SteamPublicProfile(
        "e9045710ec7ee47d7b7488d1c5dda2d933dec7e251e965967a5c48f4df68eb4e", "11.12.30.07", new Call[] {
            new Call(SteamPublicMethod.CreatePipe, 0x130c398, 0, 0x516230),
            new Call(SteamPublicMethod.ReleasePipe, 0x130c398, 1, 0x7202a0),
            new Call(SteamPublicMethod.ConnectUser, 0x130c398, 2, 0x71ff40),
            new Call(SteamPublicMethod.ReleaseUser, 0x130c398, 4, 0x71ff90),
            new Call(SteamPublicMethod.GetUser, 0x130c398, 5, 0x71ffd0),
            new Call(SteamPublicMethod.GetFriends, 0x130c398, 8, 0x720070),
            new Call(SteamPublicMethod.GetUtils, 0x130c398, 9, 0x720090),
            new Call(SteamPublicMethod.GetGeneric, 0x130c398, 12, 0x7201a0),
            new Call(SteamPublicMethod.GetApps, 0x130c398, 15, 0x7200e0),
            new Call(SteamPublicMethod.LoggedOn, 0x13193c8, 1, 0x71e550),
            new Call(SteamPublicMethod.SteamId, 0x13193c8, 2, 0x722bc0),
            new Call(SteamPublicMethod.GetAppId, 0x131aab0, 9, 0x72e210),
            new Call(SteamPublicMethod.SubscribedApp, 0x130b018, 6, 0x71e810),
            new Call(SteamPublicMethod.SetPresence, 0x130e640, 41, 0x7233c0),
            new Call(SteamPublicMethod.GetPresence, 0x130e640, 43, 0x722f80),
            new Call(SteamPublicMethod.CountPresence, 0x130e640, 44, 0x723000),
            new Call(SteamPublicMethod.IndexPresence, 0x130e640, 45, 0x722fc0),
            new Call(SteamPublicMethod.SendMethod, 0x130aa78, 0, 0x71e540),
            new Call(SteamPublicMethod.ResponseInfo, 0x130aa78, 1, 0x71e520),
            new Call(SteamPublicMethod.ResponseData, 0x130aa78, 2, 0x71e500),
            new Call(SteamPublicMethod.ReleaseMethod, 0x130aa78, 3, 0x71e530),
            new Call(SteamPublicMethod.SendNotification, 0x130aa78, 4, 0x71e550)
        });
    private static readonly SteamPublicProfile Current = new SteamPublicProfile(
        "253e0a11a4415b38c78a42f7bdd6ecc426455f06c1ba6453a48090df3142dbbc", "11.15.70.27", new Call[] {
            new Call(SteamPublicMethod.CreatePipe, 0x130c7d8, 0, 0x5162f0),
            new Call(SteamPublicMethod.ReleasePipe, 0x130c7d8, 1, 0x720360),
            new Call(SteamPublicMethod.ConnectUser, 0x130c7d8, 2, 0x720000),
            new Call(SteamPublicMethod.ReleaseUser, 0x130c7d8, 4, 0x720050),
            new Call(SteamPublicMethod.GetUser, 0x130c7d8, 5, 0x720090),
            new Call(SteamPublicMethod.GetFriends, 0x130c7d8, 8, 0x720130),
            new Call(SteamPublicMethod.GetUtils, 0x130c7d8, 9, 0x720150),
            new Call(SteamPublicMethod.GetGeneric, 0x130c7d8, 12, 0x720260),
            new Call(SteamPublicMethod.GetApps, 0x130c7d8, 15, 0x7201a0),
            new Call(SteamPublicMethod.LoggedOn, 0x1319808, 1, 0x71e610),
            new Call(SteamPublicMethod.SteamId, 0x1319808, 2, 0x722c80),
            new Call(SteamPublicMethod.GetAppId, 0x131aef0, 9, 0x72e2d0),
            new Call(SteamPublicMethod.SubscribedApp, 0x130b458, 6, 0x71e8d0),
            new Call(SteamPublicMethod.SetPresence, 0x130ea80, 41, 0x723480),
            new Call(SteamPublicMethod.GetPresence, 0x130ea80, 43, 0x723040),
            new Call(SteamPublicMethod.CountPresence, 0x130ea80, 44, 0x7230c0),
            new Call(SteamPublicMethod.IndexPresence, 0x130ea80, 45, 0x723080),
            new Call(SteamPublicMethod.SendMethod, 0x130aeb8, 0, 0x71e600),
            new Call(SteamPublicMethod.ResponseInfo, 0x130aeb8, 1, 0x71e5e0),
            new Call(SteamPublicMethod.ResponseData, 0x130aeb8, 2, 0x71e5c0),
            new Call(SteamPublicMethod.ReleaseMethod, 0x130aeb8, 3, 0x71e5f0),
            new Call(SteamPublicMethod.SendNotification, 0x130aeb8, 4, 0x71e610)
        });
}
