using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Microsoft.Win32;

internal static partial class NativePresenceWorker
{
    private static Binding ParsePublicBindingArguments(string[] args)
    {
        Binding value = new Binding();
        if (args == null || args.Length != 12 || args[0] != "--public-client" || IntPtr.Size != 8
            || !Path.IsPathRooted(args[1]) || args[1].StartsWith(@"\\", StringComparison.Ordinal)
            || !String.Equals(Path.GetFileName(args[1]), "steamclient64.dll", StringComparison.OrdinalIgnoreCase)
            || !Regex.IsMatch(args[2], "^[a-f0-9]{64}$", RegexOptions.CultureInvariant)
            || !UInt32.TryParse(args[3], NumberStyles.None, CultureInfo.InvariantCulture, out value.App) || value.App == 0 || value.App > 0xffffff
            || !UInt64.TryParse(args[4], NumberStyles.None, CultureInfo.InvariantCulture, out value.Self)
            || value.Self <= 76561197960265728UL || value.Self - 76561197960265728UL > UInt32.MaxValue
            || !Int32.TryParse(args[5], NumberStyles.None, CultureInfo.InvariantCulture, out value.GamePid) || value.GamePid <= 0
            || !Int64.TryParse(args[6], NumberStyles.None, CultureInfo.InvariantCulture, out value.GameTicks) || value.GameTicks <= 0
            || !Path.IsPathRooted(args[7]) || args[7].StartsWith(@"\\", StringComparison.Ordinal)
            || !String.Equals(Path.GetExtension(args[7]), ".exe", StringComparison.OrdinalIgnoreCase)
            || !Int32.TryParse(args[8], NumberStyles.None, CultureInfo.InvariantCulture, out value.ParentPid) || value.ParentPid <= 0
            || !Int64.TryParse(args[9], NumberStyles.None, CultureInfo.InvariantCulture, out value.ParentTicks) || value.ParentTicks <= 0
            || !Int32.TryParse(args[10], NumberStyles.None, CultureInfo.InvariantCulture, out value.SteamPid) || value.SteamPid <= 0
            || !Int64.TryParse(args[11], NumberStyles.None, CultureInfo.InvariantCulture, out value.SteamTicks) || value.SteamTicks <= 0
            || value.GamePid == value.ParentPid || value.SteamPid == value.GamePid || value.SteamPid == value.ParentPid)
            throw new Failure("NATIVE_ARGUMENTS_INVALID");
        if (!SteamPublicProfile.IsSupported(args[2])) throw new Failure("NATIVE_EXPORT_MISSING");
        value.PublicClient = true;
        value.Dll = null; value.Hash = null;
        value.ClientDll = Path.GetFullPath(args[1]); value.ClientHash = args[2];
        value.GameImage = Path.GetFullPath(args[7]);
        value.SteamImage = Path.Combine(Path.GetDirectoryName(value.ClientDll), "steam.exe");
        if (String.Equals(value.GameImage, value.SteamImage, StringComparison.OrdinalIgnoreCase)) throw new Failure("NATIVE_ARGUMENTS_INVALID");
        return value;
    }

    private static Binding ParsePublicBinding(string[] args)
    {
        Binding value = ParsePublicBindingArguments(args);
        AssertPublicBinding(value);
        string actual;
        try { actual = ProcessImage(value.GamePid); }
        catch { AssertPublicBinding(value); throw new Failure("NATIVE_CONTEXT_UNAVAILABLE"); }
        if (!String.Equals(actual, value.GameImage, StringComparison.OrdinalIgnoreCase)) throw new Failure("NATIVE_CONTEXT_CHANGED");
        AssertPublicBinding(value);
        return value;
    }

    private static int PublicRunningAppState(object current, uint expected)
    {
        if (!(current is int)) return 73;
        return unchecked((uint)(int)current) == expected ? 0 : 70;
    }

    private static int PublicRunningAppContextCode(uint expected)
    {
        try
        {
            using (RegistryKey steam = Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam", false))
                return steam == null ? 73 : PublicRunningAppState(steam.GetValue("RunningAppID", null, RegistryValueOptions.DoNotExpandEnvironmentNames), expected);
        }
        catch { return 73; }
    }

    private static void AssertPublicBinding(Binding value)
    {
        value.AssertAlive();
    }

    private static void VerifyPublicMethodAddresses(IntPtr module, IntPtr actualVtable, IntPtr actualFunction, int vtableRva, int functionRva)
    {
        if (module == IntPtr.Zero || actualVtable != new IntPtr(module.ToInt64() + vtableRva)
            || actualFunction != new IntPtr(module.ToInt64() + functionRva)) throw new Failure("NATIVE_EXPORT_MISSING");
    }

    private sealed class PublicClientPresence : IPresence, IPublicPresenceReader
    {
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate int PublicCreatePipe(IntPtr self);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool PublicReleasePipe(IntPtr self, int pipe);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate int PublicConnectUser(IntPtr self, int pipe);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate void PublicReleaseUser(IntPtr self, int pipe, int user);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate IntPtr PublicUserInterface(IntPtr self, int user, int pipe, IntPtr version);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate IntPtr PublicPipeInterface(IntPtr self, int pipe, IntPtr version);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool PublicLoggedOn(IntPtr self);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate IntPtr PublicSteamId(IntPtr self, IntPtr result);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate uint PublicAppId(IntPtr self);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool PublicSet(IntPtr self, IntPtr key, IntPtr value);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate IntPtr PublicValue(IntPtr self, ulong steamId, IntPtr key);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate int PublicCount(IntPtr self, ulong steamId);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate IntPtr PublicIndex(IntPtr self, ulong steamId, int index);

        private readonly Binding binding;
        private SteamPublicProfile profile;
        private readonly CleanupLifecycle cleanup = new CleanupLifecycle();
        private NativeLibrary clientLibrary;
        private IntPtr client, user, friends, utils;
        private int pipe, ownUser;
        private bool disposed;
        private PublicReleaseUser releaseUser;
        private PublicReleasePipe releasePipe;
        private PublicLoggedOn loggedOn;
        private PublicSteamId getSteamId;
        private PublicAppId getAppId;
        private PublicCount count;
        private PublicIndex key;
        private PublicValue readValue;
        private PublicSet set;

        private T Method<T>(IntPtr instance, SteamPublicMethod method) where T : class
        {
            if (instance == IntPtr.Zero || clientLibrary == null) throw new Failure("NATIVE_EXPORT_MISSING");
            SteamPublicProfile.Call expected = profile.Get(method);
            IntPtr expectedVtable = new IntPtr(clientLibrary.Handle.ToInt64() + expected.VtableRva);
            IntPtr actualVtable = Marshal.ReadIntPtr(instance);
            if (actualVtable != expectedVtable) throw new Failure("NATIVE_EXPORT_MISSING");
            IntPtr function = Marshal.ReadIntPtr(expectedVtable, expected.Slot * IntPtr.Size);
            VerifyPublicMethodAddresses(clientLibrary.Handle, actualVtable, function, expected.VtableRva, expected.FunctionRva);
            return (T)(object)Marshal.GetDelegateForFunctionPointer(function, typeof(T));
        }

        private void Bound()
        {
            if (disposed) throw new Failure("NATIVE_EXITED");
            AssertPublicBinding(binding);
        }

        private IntPtr UserInterface(SteamPublicMethod method, string version)
        {
            IntPtr text = CString(version);
            try { Bound(); IntPtr result = Method<PublicUserInterface>(client, method)(client, ownUser, pipe, text); Bound(); return result; }
            finally { Marshal.FreeHGlobal(text); }
        }

        public PublicClientPresence(Binding value)
        {
            binding = value;
            try
            {
                if (IntPtr.Size != 8 || !binding.PublicClient || !SteamPublicProfile.TrySelect(binding.ClientHash, out profile)) throw new Failure("NATIVE_EXPORT_MISSING");
                Bound();
                Environment.SetEnvironmentVariable("SteamAppId", binding.App.ToString(CultureInfo.InvariantCulture), EnvironmentVariableTarget.Process);
                Environment.SetEnvironmentVariable("SteamGameId", binding.App.ToString(CultureInfo.InvariantCulture), EnvironmentVariableTarget.Process);
                clientLibrary = new NativeLibrary(binding.ClientDll, profile.Hash, 64 * 1024 * 1024, cleanup, "free-client-library"); Bound();
                CreateInterfaceCall factory = clientLibrary.Require<CreateInterfaceCall>("CreateInterface");
                IntPtr version = CString("SteamClient021");
                try { client = factory(version, IntPtr.Zero); } finally { Marshal.FreeHGlobal(version); }
                Bound();
                releaseUser = Method<PublicReleaseUser>(client, SteamPublicMethod.ReleaseUser);
                releasePipe = Method<PublicReleasePipe>(client, SteamPublicMethod.ReleasePipe);
                pipe = Method<PublicCreatePipe>(client, SteamPublicMethod.CreatePipe)(client); Bound();
                if (pipe <= 0) throw new Failure("NATIVE_INIT_FAILED");
                ownUser = Method<PublicConnectUser>(client, SteamPublicMethod.ConnectUser)(client, pipe); Bound();
                if (ownUser <= 0) throw new Failure("NATIVE_INIT_FAILED");
                user = UserInterface(SteamPublicMethod.GetUser, "SteamUser023");
                loggedOn = Method<PublicLoggedOn>(user, SteamPublicMethod.LoggedOn);
                getSteamId = Method<PublicSteamId>(user, SteamPublicMethod.SteamId);
                version = CString("SteamUtils010");
                try { Bound(); utils = Method<PublicPipeInterface>(client, SteamPublicMethod.GetUtils)(client, pipe, version); Bound(); }
                finally { Marshal.FreeHGlobal(version); }
                getAppId = Method<PublicAppId>(utils, SteamPublicMethod.GetAppId);
                friends = UserInterface(SteamPublicMethod.GetFriends, "SteamFriends018");
                set = Method<PublicSet>(friends, SteamPublicMethod.SetPresence);
                readValue = Method<PublicValue>(friends, SteamPublicMethod.GetPresence);
                count = Method<PublicCount>(friends, SteamPublicMethod.CountPresence);
                key = Method<PublicIndex>(friends, SteamPublicMethod.IndexPresence);
                if (!Guard()) throw new Failure("NATIVE_CONTEXT_CHANGED");
            }
            catch { Dispose(); throw; }
        }

        public bool Guard()
        {
            Bound();
            if (pipe <= 0 || ownUser <= 0 || user == IntPtr.Zero || utils == IntPtr.Zero || friends == IntPtr.Zero) throw new Failure("NATIVE_INIT_FAILED");
            bool online = loggedOn(user); Bound();
            if (!online) throw new Failure("NATIVE_CONTEXT_UNAVAILABLE");
            IntPtr result = Marshal.AllocHGlobal(8);
            ulong self;
            try
            {
                Marshal.WriteInt64(result, 0);
                // This public C++ member returns CSteamID through an explicit x64 sret buffer.
                if (getSteamId(user, result) != result) throw new Failure("NATIVE_CONTEXT_UNAVAILABLE");
                self = unchecked((ulong)Marshal.ReadInt64(result));
            }
            finally { Marshal.FreeHGlobal(result); }
            Bound(); uint app = getAppId(utils); Bound();
            if (self == 0 || app == 0) throw new Failure("NATIVE_CONTEXT_UNAVAILABLE");
            return self == binding.Self && app == binding.App;
        }

        public PresenceRead Read() { return ReadPublic(this, Guard); }
        public void Preflight(SortedDictionary<string, string> changes) { PreflightRealGroupChanges(this, Guard, changes); }
        public int Count() { return count(friends, binding.Self); }
        public string Key(int index) { return ReadString(key(friends, binding.Self, index), RichPresenceContract.PresenceKeyAsciiLength); }
        public string Value(string name, int maximumBytes)
        {
            IntPtr text = CString(name);
            try { return ReadString(readValue(friends, binding.Self, text), maximumBytes); }
            finally { Marshal.FreeHGlobal(text); }
        }
        public bool Set(string name, string value)
        {
            if (!Guard()) throw new Failure("NATIVE_CONTEXT_CHANGED");
            if (name == GroupSizeKey)
            {
                if (!GroupSizeValueValid(value)) throw new Failure("NATIVE_PROTOCOL_INVALID");
                RequireExistingGroup(this, Guard);
            }
            IntPtr keyMemory = IntPtr.Zero, valueMemory = IntPtr.Zero;
            try
            {
                keyMemory = CString(name); valueMemory = value == null ? IntPtr.Zero : CString(value);
                if (!Guard()) throw new Failure("NATIVE_CONTEXT_CHANGED");
                bool result = set(friends, keyMemory, valueMemory);
                if (!Guard()) throw new Failure("NATIVE_CONTEXT_CHANGED");
                return result;
            }
            finally
            {
                if (keyMemory != IntPtr.Zero) Marshal.FreeHGlobal(keyMemory);
                if (valueMemory != IntPtr.Zero) Marshal.FreeHGlobal(valueMemory);
            }
        }
        public void Dispose()
        {
            if (disposed) return; disposed = true;
            if (ownUser > 0 && client != IntPtr.Zero && releaseUser != null)
            {
                cleanup.Record("release-user-start", null); bool ok = true;
                try { releaseUser(client, pipe, ownUser); } catch { ok = false; }
                finally { ownUser = 0; cleanup.Record("release-user-returned", ok); }
            }
            if (pipe > 0 && client != IntPtr.Zero && releasePipe != null)
            {
                cleanup.Record("release-pipe-start", null); bool ok = false;
                try { ok = releasePipe(client, pipe); } catch { }
                finally { pipe = 0; cleanup.Record("release-pipe-returned", ok); }
            }
            if (clientLibrary != null)
            {
                try { clientLibrary.Dispose(); } catch { cleanup.Record("free-client-library", false); }
                finally { clientLibrary = null; }
            }
            cleanup.Complete();
        }
    }
}
