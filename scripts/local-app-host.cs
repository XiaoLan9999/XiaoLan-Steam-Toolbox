using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

internal static class LocalAppHost
{
    private const int MaximumLine = RichPresenceContract.TransportRequestLineBytes;
    private const int MaximumCatalogWireBytes = RichPresenceContract.CatalogWireBytes;
    private const int MaximumCatalogJsonBytes = RichPresenceContract.CatalogJsonBytes;
    private const int MaximumCatalogTokens = RichPresenceContract.CatalogTokenCount;
    private const int MaximumCatalogLanguages = RichPresenceContract.CatalogLanguageListCount;
    private const string GroupSizeKey = "steam_player_group_size";
    private const string GroupIdKey = "steam_player_group";
    private const string Interfaces = "{\"client\":\"SteamClient021\",\"user\":\"SteamUser023\",\"friends\":\"SteamFriends018\",\"utils\":\"SteamUtils010\",\"apps\":\"STEAMAPPS_INTERFACE_VERSION008\"}";
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly Regex Hex = new Regex("\\A[0-9a-f]{64}\\z", RegexOptions.CultureInvariant);
    private static readonly Regex Id = new Regex("\\A[A-Za-z0-9_-]{1,64}\\z", RegexOptions.CultureInvariant);
    private static readonly Regex Display = RichPresenceContract.DisplayToken;

    private sealed class Failure : Exception
    {
        internal readonly string Code;
        internal Failure(string code) { Code = code; }
    }
    private static Failure Error(string suffix) { return new Failure("LOCAL_APP_" + suffix); }
    private static string Quote(string value)
    {
        StringBuilder result = new StringBuilder("\"");
        foreach (char item in value)
        {
            if (item == '"' || item == '\\') result.Append('\\').Append(item);
            else if (item == '\b') result.Append("\\b");
            else if (item == '\f') result.Append("\\f");
            else if (item == '\n') result.Append("\\n");
            else if (item == '\r') result.Append("\\r");
            else if (item == '\t') result.Append("\\t");
            else if (item < 0x20) result.Append("\\u").Append(((int)item).ToString("x4", CultureInfo.InvariantCulture));
            else result.Append(item);
        }
        return result.Append('"').ToString();
    }
    private static bool PublicKey(string key)
    {
        return key == "steam_display" || key == GroupSizeKey || RichPresenceContract.IsParameter(key);
    }
    private static bool PublicValue(string value)
    {
        return RichPresenceContract.IsText(value, RichPresenceContract.PresenceValueUtf8Bytes);
    }
    private static bool GroupSizeValueValid(string value)
    {
        if (value == null) return true;
        int size;
        return Regex.IsMatch(value, "\\A[1-9][0-9]{0,9}\\z", RegexOptions.CultureInvariant)
            && Int32.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out size) && size > 0;
    }
    private static List<string> ApplyOrder(SortedDictionary<string, string> changes)
    {
        List<string> keys = new List<string>();
        foreach (string key in changes.Keys) if (key != "steam_display" && changes[key] == null) keys.Add(key);
        foreach (string key in changes.Keys) if (key != "steam_display" && changes[key] != null) keys.Add(key);
        if (changes.ContainsKey("steam_display")) keys.Add("steam_display");
        return keys;
    }
    private sealed class OwnedGroup
    {
        private readonly Action check;
        private readonly Func<List<string>> keys;
        private readonly Func<string> currentGroup;
        private readonly Func<string, string, bool> write;
        private string owned;
        internal OwnedGroup(Action guard, Func<List<string>> names, Func<string> group, Func<string, string, bool> set) { check = guard; keys = names; currentGroup = group; write = set; }
        private List<string> Keys()
        {
            check(); List<string> found = keys(); check();
            if (found.Count > RichPresenceContract.PresenceMaxKeys) throw Error("SET_REJECTED");
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string key in found) if (key == null || !seen.Add(key) || (key.Equals(GroupIdKey, StringComparison.OrdinalIgnoreCase) && key != GroupIdKey)) throw Error("SET_REJECTED");
            return found;
        }
        private bool IsOwned()
        {
            if (owned == null) return false;
            check(); string actual = currentGroup(); check(); return String.Equals(actual, owned, StringComparison.Ordinal);
        }
        internal void Preflight(SortedDictionary<string, string> changes)
        {
            if (!changes.ContainsKey(GroupSizeKey)) return;
            List<string> found = Keys(); bool grouped = found.Contains(GroupIdKey);
            if (grouped && !IsOwned()) throw Error("SET_REJECTED");
            HashSet<string> projected = new HashSet<string>(found, StringComparer.Ordinal);
            foreach (string key in ApplyOrder(changes))
            {
                if (key == GroupSizeKey)
                {
                    if (!GroupSizeValueValid(changes[key])) throw Error("SET_REJECTED");
                    if (changes[key] != null) projected.Add(GroupIdKey); else projected.Remove(GroupIdKey);
                }
                if (changes[key] == null) projected.Remove(key); else projected.Add(key);
                if (projected.Count > RichPresenceContract.PresenceMaxKeys) throw Error("SET_REJECTED");
            }
            check();
        }
        internal bool Set(string value)
        {
            SortedDictionary<string, string> change = new SortedDictionary<string, string>(StringComparer.Ordinal); change.Add(GroupSizeKey, value); Preflight(change);
            bool grouped = Keys().Contains(GroupIdKey);
            if (grouped && !IsOwned()) return false;
            if (value != null && !grouped)
            {
                byte[] random = new byte[16]; using (RandomNumberGenerator source = RandomNumberGenerator.Create()) source.GetBytes(random);
                owned = BitConverter.ToString(random).Replace("-", "").ToLowerInvariant();
                if (Keys().Contains(GroupIdKey)) { owned = null; return false; }
                check(); if (!write(GroupIdKey, owned)) return false;
                check(); if (!IsOwned()) return false;
            }
            bool currentGroupExists = Keys().Contains(GroupIdKey);
            if (currentGroupExists && !IsOwned()) return false;
            if (value != null && !currentGroupExists) return false;
            check(); if (!write(GroupSizeKey, value)) return false;
            check();
            if (value == null)
            {
                if (Keys().Contains(GroupIdKey)) { if (!IsOwned()) return false; check(); if (!write(GroupIdKey, null)) return false; }
                owned = null;
            }
            else if (!Keys().Contains(GroupIdKey) || !IsOwned()) return false;
            check(); return true;
        }
        internal bool Cleanup()
        {
            if (owned == null) return true;
            try
            {
                if (!Keys().Contains(GroupIdKey) || !IsOwned()) { owned = null; return true; }
                check(); if (!write(GroupSizeKey, null)) return false;
                check(); if (!Keys().Contains(GroupIdKey) || !IsOwned()) { owned = null; return true; }
                check(); if (!write(GroupIdKey, null)) return false;
                owned = null; return true;
            }
            catch (Failure failure) { return failure.Code == "LOCAL_APP_CONTEXT_CHANGED" || failure.Code == "LOCAL_APP_CONTEXT_UNAVAILABLE" || failure.Code == "LOCAL_APP_IDENTITY_MISMATCH" || failure.Code == "LOCAL_APP_APP_MISMATCH" || failure.Code == "LOCAL_APP_NOT_LICENSED"; }
            catch { return false; }
        }
    }

    private static class Os
    {
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref int size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr LoadLibraryExW(string path, IntPtr file, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)] internal static extern IntPtr GetProcAddress(IntPtr module, string name);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool FreeLibrary(IntPtr module);
    }

    private sealed class Binding
    {
        internal string Dll;
        internal string Hash;
        internal string SteamExe;
        internal uint AppId;
        internal ulong SteamId;
        internal uint AccountId;
        internal int OwnerPid, SteamPid;
        internal long OwnerStart, SteamStart;

        internal static Binding Parse(string[] args)
        {
            if (args.Length != 16 || IntPtr.Size != 8) throw Error("ARGUMENTS_INVALID");
            Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.Ordinal);
            for (int index = 0; index < args.Length; index += 2) { if (values.ContainsKey(args[index])) throw Error("ARGUMENTS_INVALID"); values.Add(args[index], args[index + 1]); }
            string dll, hash, app, steamId, ownerPid, ownerStart, steamPid, steamStart;
            Binding result = new Binding();
            if (!values.TryGetValue("--client-dll", out dll) || !Path.IsPathRooted(dll) || dll.StartsWith(@"\\", StringComparison.Ordinal)
                || !String.Equals(Path.GetFileName(dll), "steamclient64.dll", StringComparison.OrdinalIgnoreCase)
                || !values.TryGetValue("--client-sha256", out hash) || !Hex.IsMatch(hash)
                || !values.TryGetValue("--app-id", out app) || !UInt32.TryParse(app, NumberStyles.None, CultureInfo.InvariantCulture, out result.AppId) || result.AppId == 0 || result.AppId > 0xffffff || result.AppId == 480
                || !values.TryGetValue("--steam-id", out steamId) || steamId.Length != 17 || !UInt64.TryParse(steamId, NumberStyles.None, CultureInfo.InvariantCulture, out result.SteamId)
                || result.SteamId <= 76561197960265728UL || result.SteamId - 76561197960265728UL > UInt32.MaxValue
                || !values.TryGetValue("--owner-pid", out ownerPid) || !Int32.TryParse(ownerPid, NumberStyles.None, CultureInfo.InvariantCulture, out result.OwnerPid) || result.OwnerPid <= 0
                || !values.TryGetValue("--owner-start", out ownerStart) || !Int64.TryParse(ownerStart, NumberStyles.None, CultureInfo.InvariantCulture, out result.OwnerStart) || result.OwnerStart <= 0
                || !values.TryGetValue("--steam-pid", out steamPid) || !Int32.TryParse(steamPid, NumberStyles.None, CultureInfo.InvariantCulture, out result.SteamPid) || result.SteamPid <= 0
                || !values.TryGetValue("--steam-start", out steamStart) || !Int64.TryParse(steamStart, NumberStyles.None, CultureInfo.InvariantCulture, out result.SteamStart) || result.SteamStart <= 0) throw Error("ARGUMENTS_INVALID");
            using (Process self = Process.GetCurrentProcess()) if (result.OwnerPid == result.SteamPid || result.OwnerPid == self.Id || result.SteamPid == self.Id) throw Error("ARGUMENTS_INVALID");
            result.Dll = Path.GetFullPath(dll); result.Hash = hash; result.AccountId = (uint)(result.SteamId - 76561197960265728UL);
            result.SteamExe = Path.Combine(Path.GetDirectoryName(result.Dll), "steam.exe");
            return result;
        }
        private static void ProcessMatches(int pid, long ticks, string expectedImage)
        {
            try
            {
                using (Process process = Process.GetProcessById(pid)) if (process.HasExited || process.StartTime.ToUniversalTime().Ticks != ticks) throw Error("CONTEXT_CHANGED");
                if (expectedImage != null)
                {
                    IntPtr handle = Os.OpenProcess(0x1000u, false, pid);
                    if (handle == IntPtr.Zero) throw Error("CONTEXT_UNAVAILABLE");
                    try
                    {
                        StringBuilder path = new StringBuilder(32768); int size = path.Capacity;
                        if (!Os.QueryFullProcessImageNameW(handle, 0, path, ref size)) throw Error("CONTEXT_UNAVAILABLE");
                        if (!String.Equals(Path.GetFullPath(path.ToString()), expectedImage, StringComparison.OrdinalIgnoreCase)) throw Error("CONTEXT_CHANGED");
                    }
                    finally { Os.CloseHandle(handle); }
                }
            }
            catch (Failure) { throw; }
            catch (ArgumentException) { throw Error("CONTEXT_CHANGED"); }
            catch { throw Error("CONTEXT_UNAVAILABLE"); }
        }
        private static uint RegistryNumber(object value)
        {
            if (value is int) return unchecked((uint)(int)value);
            if (value is uint) return (uint)value;
            throw Error("CONTEXT_UNAVAILABLE");
        }
        internal void Check()
        {
            ProcessMatches(OwnerPid, OwnerStart, null); ProcessMatches(SteamPid, SteamStart, SteamExe);
            try
            {
                using (RegistryKey active = Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam\ActiveProcess", false))
                {
                    if (active == null) throw Error("CONTEXT_UNAVAILABLE");
                    if (RegistryNumber(active.GetValue("pid", null, RegistryValueOptions.DoNotExpandEnvironmentNames)) != (uint)SteamPid
                        || RegistryNumber(active.GetValue("ActiveUser", null, RegistryValueOptions.DoNotExpandEnvironmentNames)) != AccountId) throw Error("CONTEXT_CHANGED");
                }
            }
            catch (Failure) { throw; }
            catch { throw Error("CONTEXT_UNAVAILABLE"); }
        }
        internal void ValidateDll()
        {
            if (!SteamPublicProfile.IsSupported(Hash)) throw Error("PROFILE_UNSUPPORTED");
            try
            {
                if ((File.GetAttributes(Dll) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) throw Error("DLL_INVALID");
                using (FileStream stream = File.Open(Dll, FileMode.Open, FileAccess.Read, FileShare.Read))
                using (SHA256 sha = SHA256.Create())
                    if (BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant() != Hash) throw Error("DLL_INVALID");
            }
            catch (Failure) { throw; }
            catch { throw Error("DLL_INVALID"); }
        }
    }

    private sealed class Output
    {
        private sealed class Item { internal string Line; internal bool Ok; internal readonly ManualResetEvent Done = new ManualResetEvent(false); }
        private readonly Queue<Item> queue = new Queue<Item>();
        private readonly AutoResetEvent ready = new AutoResetEvent(false);
        private bool failed;
        internal Output()
        {
            Thread writer = new Thread(delegate()
            {
                Stream stream = Console.OpenStandardOutput();
                while (true)
                {
                    ready.WaitOne();
                    while (true)
                    {
                        Item item; lock (queue) { if (queue.Count == 0) break; item = queue.Dequeue(); }
                        try { byte[] bytes = Utf8.GetBytes(item.Line + "\n"); stream.Write(bytes, 0, bytes.Length); stream.Flush(); item.Ok = true; } catch { item.Ok = false; }
                        item.Done.Set();
                    }
                }
            });
            writer.IsBackground = true; writer.Start();
        }
        internal void Write(string line)
        {
            if (failed) throw Error("INTERNAL_ERROR");
            Item item = new Item(); item.Line = line;
            lock (queue) { if (queue.Count >= 8) { failed = true; throw Error("INTERNAL_ERROR"); } queue.Enqueue(item); }
            ready.Set();
            if (!item.Done.WaitOne(2000)) { failed = true; throw Error("INTERNAL_ERROR"); }
            item.Done.Dispose();
            if (!item.Ok) { failed = true; throw Error("INTERNAL_ERROR"); }
        }
        internal void Safe(string line) { try { Write(line); } catch { } }
    }
    private static Output output;

    private sealed class Lifecycle
    {
        private readonly Stopwatch clock = new Stopwatch();
        internal bool Ok = true;
        internal void Emit(string stage, bool? ok)
        {
            if (!clock.IsRunning) clock.Start();
            if (ok == false) Ok = false;
            output.Safe("{\"v\":1,\"requestId\":\"lifecycle\",\"op\":\"lifecycle\",\"stage\":" + Quote(stage) + ",\"ok\":" + (ok.HasValue ? ok.Value ? "true" : "false" : "null") + ",\"elapsedMs\":" + Math.Min(Int32.MaxValue, clock.ElapsedMilliseconds).ToString(CultureInfo.InvariantCulture) + "}");
        }
    }

    private interface IPresence : IDisposable
    {
        void Check();
        void Preflight(SortedDictionary<string, string> changes);
        bool Set(string key, string value);
        SortedDictionary<string, string> Read(out int keyCount, out string localizedString);
        CatalogResult Catalog(string language, Func<bool> cancelled);
        bool CleanupOk { get; }
    }
    private sealed class CString : IDisposable
    {
        internal IntPtr Value;
        internal CString(string value)
        {
            if (value == null) return;
            byte[] bytes = Utf8.GetBytes(value + "\0"); Value = Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes, 0, Value, bytes.Length);
        }
        public void Dispose() { if (Value != IntPtr.Zero) { Marshal.FreeHGlobal(Value); Value = IntPtr.Zero; } }
    }

    private sealed class NativePresence : IPresence
    {
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr Factory(IntPtr version, IntPtr code);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate int CreatePipe(IntPtr self);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool ReleasePipe(IntPtr self, int pipe);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate int ConnectUser(IntPtr self, int pipe);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate void ReleaseUser(IntPtr self, int pipe, int user);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate IntPtr UserInterface(IntPtr self, int user, int pipe, IntPtr version);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate IntPtr PipeInterface(IntPtr self, int pipe, IntPtr version);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool LoggedOn(IntPtr self);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate IntPtr SteamId(IntPtr self, IntPtr result);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate uint AppId(IntPtr self);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool Licensed(IntPtr self, uint appId);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool SetPresence(IntPtr self, IntPtr key, IntPtr value);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate IntPtr GetPresence(IntPtr self, ulong steamId, IntPtr key);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate int CountPresence(IntPtr self, ulong steamId);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate IntPtr IndexPresence(IntPtr self, ulong steamId, int index);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate ulong SendMethod(IntPtr self, IntPtr method, IntPtr request, uint size, ulong context);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool ResponseInfo(IntPtr self, ulong handle, out uint size, out int result);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool ResponseData(IntPtr self, ulong handle, IntPtr buffer, uint size, [MarshalAs(UnmanagedType.I1)] bool autoRelease);
        [UnmanagedFunctionPointer(CallingConvention.ThisCall)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool ReleaseMethod(IntPtr self, ulong handle);

        private readonly Binding binding;
        private SteamPublicProfile profile;
        private readonly Lifecycle lifecycle = new Lifecycle();
        private IntPtr module, client, user, friends, utils, apps;
        private int pipe, userHandle;
        private bool disposed;
        private Func<IntPtr, bool> unload = Os.FreeLibrary;
        private ReleaseUser releaseUser;
        private ReleasePipe releasePipe;
        private LoggedOn loggedOn;
        private SteamId steamId;
        private AppId appId;
        private Licensed licensed;
        private SetPresence setPresence;
        private GetPresence getPresence;
        private CountPresence countPresence;
        private IndexPresence indexPresence;
        private OwnedGroup group;
        public bool CleanupOk { get { return lifecycle.Ok; } }

        private IntPtr Address(int rva) { return new IntPtr(module.ToInt64() + rva); }
        private T Method<T>(IntPtr instance, SteamPublicMethod method) where T : class
        {
            SteamPublicProfile.Call expected = profile.Get(method);
            if (instance == IntPtr.Zero || Marshal.ReadIntPtr(instance) != Address(expected.VtableRva)) throw Error("PROFILE_UNSUPPORTED");
            IntPtr function = Marshal.ReadIntPtr(Address(expected.VtableRva), expected.Slot * IntPtr.Size);
            if (!SteamPublicProfile.Matches(module, Marshal.ReadIntPtr(instance), function, expected)) throw Error("PROFILE_UNSUPPORTED");
            return Marshal.GetDelegateForFunctionPointer(function, typeof(T)) as T;
        }
        private IntPtr GetUserInterface(SteamPublicMethod method, string version)
        {
            using (CString name = new CString(version)) return Method<UserInterface>(client, method)(client, userHandle, pipe, name.Value);
        }
        internal NativePresence(Binding context)
        {
            binding = context;
            try
            {
                binding.Check(); binding.ValidateDll();
                if (!SteamPublicProfile.TrySelect(binding.Hash, out profile)) throw Error("PROFILE_UNSUPPORTED");
                string target = binding.AppId.ToString(CultureInfo.InvariantCulture);
                Environment.SetEnvironmentVariable("SteamAppId", target, EnvironmentVariableTarget.Process);
                Environment.SetEnvironmentVariable("SteamGameId", target, EnvironmentVariableTarget.Process);
                module = Os.LoadLibraryExW(binding.Dll, IntPtr.Zero, 8u);
                if (module == IntPtr.Zero) throw Error("INIT_FAILED");
                binding.Check(); binding.ValidateDll();
                IntPtr exported = Os.GetProcAddress(module, "CreateInterface"); if (exported == IntPtr.Zero) throw Error("INIT_FAILED");
                Factory factory = Marshal.GetDelegateForFunctionPointer(exported, typeof(Factory)) as Factory;
                using (CString version = new CString("SteamClient021")) client = factory(version.Value, IntPtr.Zero);
                releasePipe = Method<ReleasePipe>(client, SteamPublicMethod.ReleasePipe);
                releaseUser = Method<ReleaseUser>(client, SteamPublicMethod.ReleaseUser);
                binding.Check(); pipe = Method<CreatePipe>(client, SteamPublicMethod.CreatePipe)(client); if (pipe <= 0) throw Error("INIT_FAILED");
                binding.Check(); userHandle = Method<ConnectUser>(client, SteamPublicMethod.ConnectUser)(client, pipe); if (userHandle <= 0) throw Error("INIT_FAILED");
                binding.Check(); user = GetUserInterface(SteamPublicMethod.GetUser, "SteamUser023");
                loggedOn = Method<LoggedOn>(user, SteamPublicMethod.LoggedOn);
                steamId = Method<SteamId>(user, SteamPublicMethod.SteamId);
                using (CString version = new CString("SteamUtils010")) utils = Method<PipeInterface>(client, SteamPublicMethod.GetUtils)(client, pipe, version.Value);
                appId = Method<AppId>(utils, SteamPublicMethod.GetAppId);
                binding.Check(); apps = GetUserInterface(SteamPublicMethod.GetApps, "STEAMAPPS_INTERFACE_VERSION008");
                licensed = Method<Licensed>(apps, SteamPublicMethod.SubscribedApp);
                Check(); friends = GetUserInterface(SteamPublicMethod.GetFriends, "SteamFriends018");
                setPresence = Method<SetPresence>(friends, SteamPublicMethod.SetPresence);
                getPresence = Method<GetPresence>(friends, SteamPublicMethod.GetPresence);
                countPresence = Method<CountPresence>(friends, SteamPublicMethod.CountPresence);
                indexPresence = Method<IndexPresence>(friends, SteamPublicMethod.IndexPresence);
                group = new OwnedGroup(Check, GroupKeys, PrivateGroupValue, SetRaw);
                Check();
            }
            catch { Dispose(); throw; }
        }
        public void Check()
        {
            binding.Check();
            if (!loggedOn(user)) throw Error("CONTEXT_CHANGED");
            IntPtr result = Marshal.AllocHGlobal(8);
            try
            {
                Marshal.WriteInt64(result, 0);
                if (steamId(user, result) != result || unchecked((ulong)Marshal.ReadInt64(result)) != binding.SteamId) throw Error("IDENTITY_MISMATCH");
            }
            finally { Marshal.FreeHGlobal(result); }
            binding.Check(); if (appId(utils) != binding.AppId) throw Error("APP_MISMATCH");
            binding.Check(); if (!licensed(apps, binding.AppId)) throw Error("NOT_LICENSED");
            binding.Check();
        }
        public bool Set(string key, string value)
        {
            if (key == GroupSizeKey) return group.Set(value);
            return SetRaw(key, value);
        }
        public void Preflight(SortedDictionary<string, string> changes) { group.Preflight(changes); }
        private List<string> GroupKeys()
        {
            Check(); int count = countPresence(friends, binding.SteamId); if (count < 0 || count > RichPresenceContract.PresenceMaxKeys) throw Error("SET_REJECTED");
            List<string> names = new List<string>(); for (int index = 0; index < count; index++) { Check(); names.Add(Text(indexPresence(friends, binding.SteamId, index), RichPresenceContract.PresenceKeyAsciiLength)); }
            Check(); return names;
        }
        private string PrivateGroupValue()
        {
            using (CString name = new CString(GroupIdKey)) return Text(getPresence(friends, binding.SteamId, name.Value), RichPresenceContract.PresenceValueUtf8Bytes);
        }
        private bool SetRaw(string key, string value)
        {
            using (CString name = new CString(key)) using (CString data = new CString(value)) return setPresence(friends, name.Value, data.Value);
        }
        private static string Text(IntPtr pointer, int maximum)
        {
            if (pointer == IntPtr.Zero) return null;
            byte[] bytes = new byte[maximum];
            for (int index = 0; index <= maximum; index++)
            {
                byte value = Marshal.ReadByte(pointer, index);
                if (value == 0) return Utf8.GetString(bytes, 0, index);
                if (index == maximum) throw Error("READ_FAILED");
                bytes[index] = value;
            }
            throw Error("READ_FAILED");
        }
        public SortedDictionary<string, string> Read(out int keyCount, out string localizedString)
        {
            Check(); localizedString = null; keyCount = countPresence(friends, binding.SteamId);
            if (keyCount < 0 || keyCount > RichPresenceContract.PresenceMaxKeys) throw Error("READ_FAILED");
            SortedDictionary<string, string> result = new SortedDictionary<string, string>(StringComparer.Ordinal);
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (int index = 0; index < keyCount; index++)
            {
                Check(); string key = Text(indexPresence(friends, binding.SteamId, index), RichPresenceContract.PresenceKeyAsciiLength);
                if (key == null || !PublicKey(key)) continue;
                if (!seen.Add(key)) throw Error("READ_FAILED");
                using (CString name = new CString(key))
                {
                    if (key == "steam_display") { localizedString = Text(getPresence(friends, binding.SteamId, name.Value), RichPresenceContract.PresenceLocalizedReadUtf8Bytes); if (localizedString != null && !RichPresenceContract.IsWellFormedText(localizedString)) throw Error("READ_FAILED"); continue; }
                    string value = Text(getPresence(friends, binding.SteamId, name.Value), RichPresenceContract.PresenceValueUtf8Bytes);
                    if (key == GroupSizeKey && (value == null || !GroupSizeValueValid(value))) throw Error("READ_FAILED");
                    if (value != null && PublicValue(value)) result.Add(key, value);
                }
            }
            Check(); return result;
        }
        public CatalogResult Catalog(string language, Func<bool> cancelled)
        {
            Check(); IntPtr unified = GetUserInterface(SteamPublicMethod.GetGeneric, "STEAMUNIFIEDMESSAGES_INTERFACE_VERSION001");
            if (unified == IntPtr.Zero) return CatalogResult.Unavailable("UNAVAILABLE");
            SendMethod send = Method<SendMethod>(unified, SteamPublicMethod.SendMethod);
            ResponseInfo info = Method<ResponseInfo>(unified, SteamPublicMethod.ResponseInfo);
            ResponseData data = Method<ResponseData>(unified, SteamPublicMethod.ResponseData);
            ReleaseMethod release = Method<ReleaseMethod>(unified, SteamPublicMethod.ReleaseMethod);
            byte[] request = Proto.Request(binding.AppId, language); IntPtr native = Marshal.AllocHGlobal(request.Length); ulong handle = 0;
            try
            {
                Marshal.Copy(request, 0, native, request.Length);
                using (CString method = new CString("Community.GetAppRichPresenceLocalization#1")) handle = send(unified, method.Value, native, (uint)request.Length, 0UL);
                if (handle == 0) return CatalogResult.Unavailable("UNAVAILABLE");
                Stopwatch wait = Stopwatch.StartNew();
                while (wait.ElapsedMilliseconds < 8000)
                {
                    if (cancelled()) return CatalogResult.Unavailable("CANCELLED");
                    Check(); uint size; int result;
                    if (info(unified, handle, out size, out result))
                    {
                        if (result != 1) return CatalogResult.Unavailable("UNAVAILABLE", result >= RichPresenceContract.LookupSteamResultMin && result <= RichPresenceContract.LookupSteamResultMax ? (int?)result : null);
                        if (size == 0 || size > MaximumCatalogWireBytes) return CatalogResult.Unavailable("RESPONSE_INVALID");
                        IntPtr response = Marshal.AllocHGlobal((int)size);
                        try
                        {
                            if (!data(unified, handle, response, size, false)) return CatalogResult.Unavailable("UNAVAILABLE");
                            byte[] bytes = new byte[size]; Marshal.Copy(response, bytes, 0, bytes.Length); Check();
                            try { return Proto.Response(bytes, binding.AppId, language); }
                            catch { return CatalogResult.Unavailable("RESPONSE_INVALID"); }
                        }
                        finally { Marshal.FreeHGlobal(response); }
                    }
                    Thread.Sleep(50);
                }
                return CatalogResult.Unavailable("TIMEOUT");
            }
            finally
            {
                Marshal.FreeHGlobal(native);
                if (handle != 0 && !release(unified, handle)) throw Error("INTERNAL_ERROR");
            }
        }
        public void Dispose()
        {
            if (disposed) return; disposed = true;
            if (group != null && !group.Cleanup()) lifecycle.Ok = false;
            if (userHandle > 0 && releaseUser != null)
            {
                lifecycle.Emit("release-user-start", null); bool ok = true;
                try { releaseUser(client, pipe, userHandle); } catch { ok = false; }
                userHandle = 0; lifecycle.Emit("release-user-returned", ok);
            }
            if (pipe > 0 && releasePipe != null)
            {
                lifecycle.Emit("release-pipe-start", null); bool ok = false;
                try { ok = releasePipe(client, pipe); } catch { }
                pipe = 0; lifecycle.Emit("release-pipe-returned", ok);
            }
            if (module != IntPtr.Zero)
            {
                bool ok = false; try { ok = unload(module); } catch { }
                module = IntPtr.Zero; lifecycle.Emit("free-client-library", ok);
            }
            lifecycle.Emit("cleanup-complete", lifecycle.Ok);
        }
#if LOCAL_APP_HOST_TEST
        private NativePresence() { }
        internal void MarkCleanupFailed() { lifecycle.Ok = false; }
        internal static NativePresence CleanupFixture(string mode)
        {
            NativePresence value = new NativePresence(); value.client = new IntPtr(1); value.pipe = 1; value.userHandle = 1; value.module = new IntPtr(2);
            value.releaseUser = delegate { if (mode == "release-user-exception" || mode == "release-user-failed") throw new InvalidOperationException("private fixture error"); };
            value.releasePipe = delegate { if (mode == "release-pipe-exception") throw new InvalidOperationException("private fixture error"); return mode != "release-pipe-failed"; };
            value.unload = delegate { if (mode == "unload-exception") throw new InvalidOperationException("private fixture error"); return mode != "unload-failed"; };
            return value;
        }
#endif
    }

    private sealed class CatalogResult
    {
        internal bool Available;
        internal string Code;
        internal int? SteamResult;
        internal readonly SortedDictionary<string, string> Tokens = new SortedDictionary<string, string>(StringComparer.Ordinal);
        internal static CatalogResult Unavailable(string reason, int? steamResult = null) { return new CatalogResult { Code = "LOCAL_APP_CATALOG_" + reason, SteamResult = steamResult }; }
    }
    private sealed class Proto
    {
        private readonly byte[] bytes; private int position;
        private Proto(byte[] data) { bytes = data; }
        private ulong Varint()
        {
            ulong value = 0;
            for (int index = 0; index < 10; index++)
            {
                if (position >= bytes.Length) throw Error("CATALOG_RESPONSE_INVALID"); byte part = bytes[position++];
                if (index == 9 && part > 1) throw Error("CATALOG_RESPONSE_INVALID"); value |= (ulong)(part & 127) << (7 * index);
                if ((part & 128) == 0) return value;
            }
            throw Error("CATALOG_RESPONSE_INVALID");
        }
        private byte[] Data()
        {
            ulong length = Varint(); if (length > MaximumCatalogWireBytes || length > (ulong)(bytes.Length - position)) throw Error("CATALOG_RESPONSE_INVALID");
            byte[] value = new byte[(int)length]; Buffer.BlockCopy(bytes, position, value, 0, value.Length); position += value.Length; return value;
        }
        private bool Field(out int field, out int wire)
        {
            field = wire = 0; if (position == bytes.Length) return false;
            ulong tag = Varint(); if ((tag >> 3) == 0 || tag > UInt32.MaxValue) throw Error("CATALOG_RESPONSE_INVALID"); field = (int)(tag >> 3); wire = (int)(tag & 7); return true;
        }
        private void Skip(int wire)
        {
            if (wire == 0) { Varint(); return; }
            if (wire == 2) { ulong length = Varint(); if (length > MaximumCatalogWireBytes || length > (ulong)(bytes.Length - position)) throw Error("CATALOG_RESPONSE_INVALID"); position += (int)length; return; }
            int size = wire == 1 ? 8 : wire == 5 ? 4 : 0; if (size == 0 || size > bytes.Length - position) throw Error("CATALOG_RESPONSE_INVALID"); position += size;
        }
        private static void WriteVarint(Stream stream, uint value) { do { byte part = (byte)(value & 127); value >>= 7; stream.WriteByte(value == 0 ? part : (byte)(part | 128)); } while (value != 0); }
        internal static byte[] Request(uint appId, string language)
        {
            using (MemoryStream stream = new MemoryStream()) { stream.WriteByte(8); WriteVarint(stream, appId); byte[] text = Utf8.GetBytes(language); stream.WriteByte(18); WriteVarint(stream, (uint)text.Length); stream.Write(text, 0, text.Length); return stream.ToArray(); }
        }
        private static KeyValuePair<string, string> Token(byte[] bytes)
        {
            Proto token = new Proto(bytes); string name = null, value = null; int field, wire;
            while (token.Field(out field, out wire))
            {
                if (field == 1 && wire == 2) { if (name != null) throw Error("CATALOG_RESPONSE_INVALID"); name = Utf8.GetString(token.Data()); }
                else if (field == 2 && wire == 2) { if (value != null) throw Error("CATALOG_RESPONSE_INVALID"); value = Utf8.GetString(token.Data()); }
                else token.Skip(wire);
            }
            if (String.IsNullOrEmpty(name) || !RichPresenceContract.IsText(name, RichPresenceContract.CatalogTokenNameUtf8Bytes)
                || value == null || Utf8.GetByteCount(value) > RichPresenceContract.CatalogTokenValueUtf8Bytes) throw Error("CATALOG_RESPONSE_INVALID");
            return new KeyValuePair<string, string>(name, value);
        }
        private static void Language(byte[] bytes, string expected, CatalogResult output, ref bool found)
        {
            Proto list = new Proto(bytes); string language = null; int field, wire;
            while (list.Field(out field, out wire))
            {
                if (field == 1 && wire == 2) { if (language != null) throw Error("CATALOG_RESPONSE_INVALID"); byte[] name = list.Data(); if (name.Length > RichPresenceContract.CatalogLanguageNameUtf8Bytes) throw Error("CATALOG_RESPONSE_INVALID"); language = Utf8.GetString(name); if (!RichPresenceContract.IsWellFormedText(language)) throw Error("CATALOG_RESPONSE_INVALID"); }
                else list.Skip(wire);
            }
            if (language != expected) return;
            if (found) throw Error("CATALOG_RESPONSE_INVALID"); found = true; int size = 2, count = 0;
            // Token content and count in unrelated languages do not constrain the requested catalog.
            list = new Proto(bytes);
            while (list.Field(out field, out wire))
            {
                if (field != 2 || wire != 2) { list.Skip(wire); continue; }
                if (++count > MaximumCatalogTokens) throw Error("CATALOG_RESPONSE_INVALID");
                KeyValuePair<string, string> token = Token(list.Data()); if (output.Tokens.ContainsKey(token.Key)) throw Error("CATALOG_RESPONSE_INVALID");
                size += Utf8.GetByteCount(Quote(token.Key)) + Utf8.GetByteCount(Quote(token.Value)) + (count == 1 ? 1 : 2); if (size > MaximumCatalogJsonBytes) throw Error("CATALOG_RESPONSE_INVALID"); output.Tokens.Add(token.Key, token.Value);
            }
        }
        internal static CatalogResult Response(byte[] bytes, uint expectedAppId, string language)
        {
            if (bytes.Length > MaximumCatalogWireBytes) throw Error("CATALOG_RESPONSE_INVALID"); Proto response = new Proto(bytes); uint appId = 0; bool appSeen = false, found = false; int field, wire, lists = 0;
            CatalogResult result = new CatalogResult();
            while (response.Field(out field, out wire))
            {
                if (field == 1 && wire == 0) { if (appSeen) throw Error("CATALOG_RESPONSE_INVALID"); ulong id = response.Varint(); if (id > UInt32.MaxValue) throw Error("CATALOG_RESPONSE_INVALID"); appId = (uint)id; appSeen = true; }
                else if (field == 2 && wire == 2) { if (++lists > MaximumCatalogLanguages) throw Error("CATALOG_RESPONSE_INVALID"); Language(response.Data(), language, result, ref found); }
                else response.Skip(wire);
            }
            if (!appSeen) return CatalogResult.Unavailable("RESPONSE_INVALID");
            if (appId != expectedAppId) return CatalogResult.Unavailable("APP_MISMATCH");
            if (!found) return CatalogResult.Unavailable("LANGUAGE_MISSING");
            result.Available = true; return result;
        }
    }

    private sealed class Json
    {
        private readonly string input; private int offset;
        internal Json(string value) { input = value; }
        private void White() { while (offset < input.Length && (input[offset] == ' ' || input[offset] == '\t' || input[offset] == '\r' || input[offset] == '\n')) offset++; }
        private void Take(char value) { White(); if (offset >= input.Length || input[offset++] != value) throw Error("PROTOCOL_INVALID"); }
        private string String()
        {
            Take('"'); StringBuilder value = new StringBuilder();
            while (offset < input.Length)
            {
                char character = input[offset++];
                if (character == '"') { Utf8.GetByteCount(value.ToString()); return value.ToString(); }
                if (character < 0x20) throw Error("PROTOCOL_INVALID");
                if (character == '\\')
                {
                    if (offset >= input.Length) throw Error("PROTOCOL_INVALID"); char escaped = input[offset++];
                    if (escaped == '"' || escaped == '\\' || escaped == '/') character = escaped;
                    else if (escaped == 'b') character = '\b'; else if (escaped == 'f') character = '\f'; else if (escaped == 'n') character = '\n'; else if (escaped == 'r') character = '\r'; else if (escaped == 't') character = '\t';
                    else if (escaped == 'u') { ushort code; if (offset + 4 > input.Length || !UInt16.TryParse(input.Substring(offset, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out code)) throw Error("PROTOCOL_INVALID"); offset += 4; character = (char)code; }
                    else throw Error("PROTOCOL_INVALID");
                }
                value.Append(character); if (value.Length > RichPresenceContract.TransportRequestLineBytes) throw Error("PROTOCOL_INVALID");
            }
            throw Error("PROTOCOL_INVALID");
        }
        private Dictionary<string, object> Object(int depth)
        {
            if (depth > 1) throw Error("PROTOCOL_INVALID"); Take('{'); Dictionary<string, object> values = new Dictionary<string, object>(StringComparer.Ordinal);
            White(); if (offset < input.Length && input[offset] == '}') { offset++; return values; }
            while (true)
            {
                string key = String(); Take(':'); White(); object value;
                if (offset >= input.Length) throw Error("PROTOCOL_INVALID");
                if (input[offset] == '"') value = String(); else if (input[offset] == '{') value = Object(depth + 1);
                else if (input[offset] == '1') { offset++; value = 1; }
                else if (input.Substring(offset).StartsWith("null", StringComparison.Ordinal)) { offset += 4; value = null; }
                else throw Error("PROTOCOL_INVALID");
                if (values.ContainsKey(key) || values.Count >= 24) throw Error("PROTOCOL_INVALID"); values.Add(key, value); White();
                if (offset < input.Length && input[offset] == '}') { offset++; return values; } Take(',');
            }
        }
        internal Dictionary<string, object> Parse()
        {
            if (input.Length > MaximumLine || Utf8.GetByteCount(input) > MaximumLine) throw Error("PROTOCOL_INVALID");
            Dictionary<string, object> value = Object(0); White(); if (offset != input.Length) throw Error("PROTOCOL_INVALID"); return value;
        }
    }
    private sealed class Request
    {
        internal string RequestId, Op, Language;
        internal SortedDictionary<string, string> Changes = new SortedDictionary<string, string>(StringComparer.Ordinal);
        internal static Request Parse(string line)
        {
            Dictionary<string, object> json = new Json(line).Parse();
            if (!json.ContainsKey("v") || !(json["v"] is int) || (int)json["v"] != 1
                || !json.ContainsKey("requestId") || !(json["requestId"] is string) || !Id.IsMatch((string)json["requestId"]) || (string)json["requestId"] == "startup" || (string)json["requestId"] == "lifecycle"
                || !json.ContainsKey("op") || !(json["op"] is string)) throw Error("PROTOCOL_INVALID");
            Request request = new Request(); request.RequestId = (string)json["requestId"]; request.Op = (string)json["op"];
            if (request.Op != "ping" && request.Op != "read" && request.Op != "apply" && request.Op != "stop" && request.Op != "catalog") throw Error("PROTOCOL_INVALID");
            if (json.Count != (request.Op == "apply" || request.Op == "catalog" ? 4 : 3)) throw Error("PROTOCOL_INVALID");
            if (request.Op == "catalog") { if (!json.ContainsKey("language") || !(json["language"] is string) || Array.IndexOf(RichPresenceContract.Languages, (string)json["language"]) < 0) throw Error("PROTOCOL_INVALID"); request.Language = (string)json["language"]; }
            if (request.Op == "apply")
            {
                if (!json.ContainsKey("changes") || !(json["changes"] is Dictionary<string, object>)) throw Error("PROTOCOL_INVALID");
                Dictionary<string, object> changes = (Dictionary<string, object>)json["changes"];
                if (changes.Count < 1 || changes.Count > RichPresenceContract.PresenceMaxKeys) throw Error("PROTOCOL_INVALID");
                HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (KeyValuePair<string, object> change in changes)
                {
                    string value = change.Value as string;
                    if (!PublicKey(change.Key) || !seen.Add(change.Key) || change.Key.Equals("version", StringComparison.OrdinalIgnoreCase)
                        || (change.Value != null && (value == null || !PublicValue(value)))
                        || (change.Key == GroupSizeKey && !GroupSizeValueValid(value))
                        || (change.Key == "steam_display" && value != null && value != "" && !Display.IsMatch(value))) throw Error("PROTOCOL_INVALID");
                    request.Changes.Add(change.Key, value);
                }
            }
            return request;
        }
    }

    private static void Reply(string requestId, string op, bool ok, string code, IList<string> accepted, bool mayHaveWritten, SortedDictionary<string, string> fields, int keyCount, string localizedString = null)
    {
        StringBuilder line = new StringBuilder("{\"v\":1,\"requestId\":").Append(Quote(requestId)).Append(",\"op\":").Append(Quote(op)).Append(",\"ok\":").Append(ok ? "true" : "false").Append(",\"acceptedKeys\":[");
        for (int index = 0; index < accepted.Count; index++) { if (index > 0) line.Append(','); line.Append(Quote(accepted[index])); }
        line.Append("],\"mayHaveWritten\":").Append(mayHaveWritten ? "true" : "false");
        if (code != null) line.Append(",\"code\":").Append(Quote(code));
        if (ok && op == "ready") line.Append(",\"identityMatch\":true,\"appMatch\":true,\"licensed\":true,\"selectedInterfaces\":").Append(Interfaces);
        if (fields != null)
        {
            line.Append(",\"keyCount\":").Append(keyCount.ToString(CultureInfo.InvariantCulture)).Append(",\"fields\":{"); bool first = true;
            foreach (KeyValuePair<string, string> field in fields) { if (!first) line.Append(','); first = false; line.Append(Quote(field.Key)).Append(':').Append(Quote(field.Value)); }
            line.Append("},\"localizedString\":").Append(localizedString == null ? "null" : Quote(localizedString)).Append(",\"verificationSource\":\"local-cache\",\"displayTokenReadable\":false");
        }
        string frame = line.Append('}').ToString();
        if (Utf8.GetByteCount(frame) > RichPresenceContract.TransportOrdinaryFrameBytes) throw Error("PROTOCOL_INVALID");
        output.Write(frame);
    }
    private static void CatalogReply(string requestId, CatalogResult catalog)
    {
        StringBuilder line = new StringBuilder("{\"v\":1,\"requestId\":").Append(Quote(requestId)).Append(",\"op\":\"catalog\",\"ok\":true,\"acceptedKeys\":[],\"mayHaveWritten\":false,\"available\":").Append(catalog.Available ? "true" : "false").Append(",\"tokens\":{"); bool first = true;
        foreach (KeyValuePair<string, string> token in catalog.Tokens) { if (!first) line.Append(','); first = false; line.Append(Quote(token.Key)).Append(':').Append(Quote(token.Value)); }
        line.Append('}'); if (catalog.Code != null) line.Append(",\"code\":").Append(Quote(catalog.Code));
        if (catalog.SteamResult.HasValue) line.Append(",\"steamResult\":").Append(catalog.SteamResult.Value.ToString(CultureInfo.InvariantCulture));
        string frame = line.Append('}').ToString();
        if (Utf8.GetByteCount(frame) > RichPresenceContract.TransportCatalogFrameBytes) throw Error("PROTOCOL_INVALID");
        output.Write(frame);
    }

    private sealed class Input
    {
        internal readonly Queue<string> Lines = new Queue<string>(); internal volatile bool Closed, Invalid, StopQueued;
        internal void Run()
        {
            try
            {
                using (StreamReader reader = new StreamReader(Console.OpenStandardInput(), Utf8, false, 1024))
                {
                    StringBuilder line = new StringBuilder();
                    while (true)
                    {
                        int next = reader.Read(); if (next < 0) { if (line.Length > 0) Invalid = true; break; }
                        if (next == '\n')
                        {
                            if (line.Length > 0 && line[line.Length - 1] == '\r') line.Length--;
                            string value = line.ToString(); if (Utf8.GetByteCount(value) > MaximumLine) { Invalid = true; break; }
                            lock (Lines) { if (Lines.Count >= 32) { Invalid = true; break; } Lines.Enqueue(value); }
                            try { if (Request.Parse(value).Op == "stop") StopQueued = true; } catch { }
                            line.Length = 0;
                        }
                        else { line.Append((char)next); if (line.Length > MaximumLine) { Invalid = true; break; } }
                    }
                }
            }
            catch { Invalid = true; }
            finally { Closed = true; }
        }
    }

    private static int Serve(IPresence api, int heartbeatMs)
    {
        Reply("startup", "ready", true, null, new string[0], false, null, 0);
        Input input = new Input(); Thread reader = new Thread(input.Run); reader.IsBackground = true; reader.Start();
        Stopwatch clock = Stopwatch.StartNew(); long lastActivity = 0, nextGuard = 0;
        HashSet<string> recent = new HashSet<string>(StringComparer.Ordinal); Queue<string> recentOrder = new Queue<string>();
        while (true)
        {
            string requestId = "invalid"; List<string> accepted = new List<string>(); bool mayHaveWritten = false;
            try
            {
                if (input.Invalid) throw Error("PROTOCOL_INVALID");
                if (clock.ElapsedMilliseconds >= nextGuard) { api.Check(); nextGuard = clock.ElapsedMilliseconds + 250; }
                string line = null; lock (input.Lines) if (input.Lines.Count > 0) line = input.Lines.Dequeue();
                if (line == null) { if (input.Closed) return 0; if (clock.ElapsedMilliseconds - lastActivity >= heartbeatMs) throw Error("TIMEOUT"); Thread.Sleep(25); continue; }
                Request request = Request.Parse(line); requestId = request.RequestId;
                if (!recent.Add(requestId)) throw Error("PROTOCOL_INVALID"); recentOrder.Enqueue(requestId); if (recentOrder.Count > 256) recent.Remove(recentOrder.Dequeue());
                if (request.Op == "stop") { Reply(requestId, "stopped", true, null, accepted, false, null, 0); return 0; }
                api.Check();
                if (request.Op == "ping") Reply(requestId, "pong", true, null, accepted, false, null, 0);
                else if (request.Op == "read") { int count; string localized; SortedDictionary<string, string> values = api.Read(out count, out localized); api.Check(); Reply(requestId, "read", true, null, accepted, false, values, count, localized); }
                else if (request.Op == "catalog") { CatalogResult catalog = api.Catalog(request.Language, delegate { return input.Closed || input.StopQueued || input.Invalid; }); api.Check(); CatalogReply(requestId, catalog); }
                else
                {
                    api.Preflight(request.Changes);
                    List<string> keys = ApplyOrder(request.Changes);
                    foreach (string key in keys) { api.Check(); mayHaveWritten = true; if (!api.Set(key, request.Changes[key])) throw Error("SET_REJECTED"); accepted.Add(key); }
                    api.Check(); Reply(requestId, "applied", true, null, accepted, mayHaveWritten, null, 0);
                }
                lastActivity = clock.ElapsedMilliseconds;
            }
            catch (Failure failure) { Reply(requestId, "error", false, failure.Code, accepted, mayHaveWritten, null, 0); return 70; }
            catch { Reply(requestId, "error", false, "LOCAL_APP_INTERNAL_ERROR", accepted, mayHaveWritten, null, 0); return 74; }
        }
    }

    private static int Main(string[] args)
    {
        output = new Output(); IPresence api = null; int code = 74; bool serving = false;
        try
        {
#if LOCAL_APP_HOST_TEST
            if (args.Length == 2 && args[0] == "--test-group-cleanup")
            {
                FakePresence fixture = new FakePresence(args[1] == "external" ? "group-external" : args[1] == "reject-size" ? "group-reject-size" : args[1] == "appearance" ? "group-appears-before-create" : args[1] == "replacement" ? "group-replaced-before-size" : "success");
                bool applied = args[1] == "external" ? false : fixture.Set(GroupSizeKey, "3");
                if (args[1] == "remove") fixture.Set(GroupSizeKey, null);
                if (args[1] == "conflict") fixture.ReplaceGroup();
                if (args[1] == "context") fixture.EndContext();
                fixture.Dispose(); fixture.Dispose(); fixture.ReportGroupFixture(applied); return 0;
            }
            if ((args.Length == 3 || args.Length == 4) && args[0] == "--test-proto") { CatalogReply("fixture", Proto.Response(Convert.FromBase64String(args.Length == 4 ? args[3] : Console.In.ReadToEnd()), UInt32.Parse(args[1], CultureInfo.InvariantCulture), args[2])); return 0; }
            if (args.Length == 2 && args[0] == "--test-fake") api = new FakePresence(args[1]);
            else
#endif
            { Binding binding = Binding.Parse(args); api = new NativePresence(binding); }
            api.Check();
            serving = true;
#if LOCAL_APP_HOST_TEST
            code = Serve(api, 700);
#else
            code = Serve(api, 15000);
#endif
        }
        catch (Failure failure) { if (!serving) output.Safe("{\"v\":1,\"requestId\":\"startup\",\"op\":\"ready\",\"ok\":false,\"acceptedKeys\":[],\"mayHaveWritten\":false,\"code\":" + Quote(failure.Code) + "}"); code = 70; }
        catch { if (!serving) output.Safe("{\"v\":1,\"requestId\":\"startup\",\"op\":\"ready\",\"ok\":false,\"acceptedKeys\":[],\"mayHaveWritten\":false,\"code\":\"LOCAL_APP_INTERNAL_ERROR\"}"); code = 74; }
        finally { if (api != null) { api.Dispose(); if (!api.CleanupOk) code = 74; } }
        return code;
    }

#if LOCAL_APP_HOST_TEST
    private sealed class FakePresence : IPresence
    {
        private readonly string mode; private readonly NativePresence cleanup; private int writes; private bool disposed;
        private readonly OwnedGroup group;
        private bool contextEnded;
        private int groupWrites, sizeWrites;
        private int groupKeyReads;
        private readonly SortedDictionary<string, string> values = new SortedDictionary<string, string>(StringComparer.Ordinal) { { "desc", "Fixture baseline" }, { "steam_display", "#Fixture" } };
        internal FakePresence(string value)
        {
            mode = value; cleanup = NativePresence.CleanupFixture(mode);
            if (mode == "group-external" || mode == "size-read") { values[GroupIdKey] = "FAKE_EXTERNAL_GROUP_NEVER_OUTPUT"; values[GroupSizeKey] = "3"; }
            if (mode == "size-invalid") { values[GroupIdKey] = "FAKE_EXTERNAL_GROUP_NEVER_OUTPUT"; values[GroupSizeKey] = "03"; }
            if (mode == "group-full") for (int index = 0; index < 17; index++) values["field" + index] = "Keep";
            if (mode == "read-frame-boundary") { values.Clear(); values["steam_display"] = "#Fixture"; for (int index = 0; index < RichPresenceContract.PresenceMaxKeys - 1; index++) values["field" + index] = new string('"', RichPresenceContract.PresenceValueUtf8Bytes); }
            group = new OwnedGroup(Check, GroupKeys, delegate { return values.ContainsKey(GroupIdKey) ? values[GroupIdKey] : null; }, SetRaw);
            if (mode == "init-failed") { Dispose(); throw Error("INIT_FAILED"); }
        }
        public bool CleanupOk { get { return cleanup.CleanupOk; } }
        private List<string> GroupKeys()
        {
            groupKeyReads++;
            if ((mode == "group-appears-before-create" && groupKeyReads >= 3 && groupWrites == 0) || (mode == "group-replaced-before-size" && groupWrites > 0 && sizeWrites == 0)) ReplaceGroup();
            List<string> keys = new List<string>(values.Keys); keys.Add("connect"); return keys;
        }
        public void Check()
        {
            if (contextEnded) throw Error("CONTEXT_CHANGED");
            if (mode == "identity") throw Error("IDENTITY_MISMATCH"); if (mode == "app") throw Error("APP_MISMATCH"); if (mode == "license") throw Error("NOT_LICENSED");
            if (mode == "context-after-write" && writes > 0) throw Error("CONTEXT_CHANGED");
        }
        public bool Set(string key, string value)
        {
            if (key == GroupSizeKey) return group.Set(value);
            return SetRaw(key, value);
        }
        public void Preflight(SortedDictionary<string, string> changes) { group.Preflight(changes); }
        private bool SetRaw(string key, string value)
        {
            if (key == GroupIdKey) groupWrites++;
            if (key == GroupSizeKey) sizeWrites++;
            writes++; if (mode == "reject-second" && writes == 2) return false;
            if (mode == "group-reject-size" && key == GroupSizeKey && value != null) return false;
            if (value == null) values.Remove(key); else values[key] = value; return true;
        }
        public SortedDictionary<string, string> Read(out int count, out string localizedString)
        {
            if (mode == "read-failed") throw Error("READ_FAILED"); count = values.Count + 1;
            if (mode == "read-frame-boundary") count = values.Count;
            if (mode == "group-conflict-after-read" && values.ContainsKey(GroupSizeKey)) values[GroupIdKey] = "FAKE_EXTERNAL_GROUP_NEVER_OUTPUT";
            localizedString = mode == "read-frame-boundary" ? new string('"', RichPresenceContract.PresenceLocalizedReadUtf8Bytes) : "Fixture localized state"; SortedDictionary<string, string> result = new SortedDictionary<string, string>(StringComparer.Ordinal);
            foreach (KeyValuePair<string, string> entry in values)
            {
                if (!PublicKey(entry.Key) || entry.Key == "steam_display") continue;
                if (entry.Key == GroupSizeKey && !GroupSizeValueValid(entry.Value)) throw Error("READ_FAILED");
                result.Add(entry.Key, entry.Value);
            }
            return result;
        }
        public CatalogResult Catalog(string language, Func<bool> cancelled)
        {
            if (mode == "catalog-timeout") return CatalogResult.Unavailable("TIMEOUT");
            if (mode == "catalog-unavailable") return CatalogResult.Unavailable("UNAVAILABLE");
            if (mode == "catalog-denied") return CatalogResult.Unavailable("UNAVAILABLE", 15);
            if (cancelled()) return CatalogResult.Unavailable("CANCELLED");
            CatalogResult result = new CatalogResult(); result.Available = true; result.Tokens.Add("#Fixture", language == "english" ? "%desc%" : "状态：%desc%"); return result;
        }
        internal void ReplaceGroup() { values[GroupIdKey] = "FAKE_EXTERNAL_GROUP_NEVER_OUTPUT"; }
        internal void EndContext() { contextEnded = true; }
        internal void ReportGroupFixture(bool applied)
        {
            output.Write("{\"fixtureGroup\":true,\"applied\":" + (applied ? "true" : "false")
                + ",\"groupPresent\":" + (values.ContainsKey(GroupIdKey) ? "true" : "false")
                + ",\"sizePresent\":" + (values.ContainsKey(GroupSizeKey) ? "true" : "false")
                + ",\"externalPreserved\":" + (values.ContainsKey(GroupIdKey) && values[GroupIdKey] == "FAKE_EXTERNAL_GROUP_NEVER_OUTPUT" ? "true" : "false")
                + ",\"unrelatedPreserved\":" + (values.ContainsKey("desc") && values["desc"] == "Fixture baseline" && values.ContainsKey("steam_display") && values["steam_display"] == "#Fixture" ? "true" : "false")
                + ",\"groupWrites\":" + groupWrites.ToString(CultureInfo.InvariantCulture) + ",\"sizeWrites\":" + sizeWrites.ToString(CultureInfo.InvariantCulture) + "}");
        }
        public void Dispose()
        {
            if (disposed) return; disposed = true;
            if (!group.Cleanup()) cleanup.MarkCleanupFailed();
            cleanup.Dispose(); cleanup.Dispose();
        }
    }
#endif
}
