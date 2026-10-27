using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

internal static partial class NativePresenceWorker
{
    private const string GroupSizeKey = "steam_player_group_size";
    private const string GroupIdKey = "steam_player_group";
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly Regex RequestId = new Regex("^[A-Za-z0-9_-]{1,64}$", RegexOptions.CultureInvariant);
    private static readonly Regex DisplayToken = RichPresenceContract.DisplayToken;
    private static readonly HashSet<string> PublicKeys = RichPresenceContract.NativeReadableKeys;
    private static bool GroupSizeValueValid(string value)
    {
        if (value == null) return true;
        int size;
        return Regex.IsMatch(value, "\\A[1-9][0-9]{0,9}\\z", RegexOptions.CultureInvariant)
            && Int32.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out size) && size > 0;
    }
    private static StreamWriter output;
    private static readonly HashSet<string> LifecycleStages = new HashSet<string>(new string[] { "release-user-start", "release-user-returned", "release-pipe-start", "release-pipe-returned", "free-api-library", "free-client-library", "cleanup-complete" }, StringComparer.Ordinal);

    private sealed class CleanupLifecycle
    {
        private Stopwatch clock;
        private bool successful = true;
        private bool completed;
        public void Record(string stage, bool? ok)
        {
            if (ok == false) successful = false;
            if (clock == null) clock = Stopwatch.StartNew();
            try
            {
                if (output == null || !LifecycleStages.Contains(stage)) return;
                output.WriteLine("{\"v\":1,\"requestId\":\"lifecycle\",\"op\":\"lifecycle\",\"stage\":" + Quote(stage)
                    + ",\"ok\":" + (ok.HasValue ? ok.Value ? "true" : "false" : "null")
                    + ",\"elapsedMs\":" + Math.Min((long)Int32.MaxValue, clock.ElapsedMilliseconds).ToString(CultureInfo.InvariantCulture) + "}");
            }
            catch { /* Observation must never prevent remaining resource releases. */ }
        }
        public void Complete()
        {
            if (completed) return;
            completed = true;
            Record("cleanup-complete", successful);
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr LoadLibraryExW(string path, IntPtr reserved, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr GetProcAddress(IntPtr library, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FreeLibrary(IntPtr library);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetStdHandle(int handle, IntPtr value);
    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, int processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder image, ref uint size);

    private static string ProcessImage(int processId)
    {
        // Limited-information queries work across bitness without enumerating target modules.
        IntPtr process = OpenProcess(0x1000u, false, processId);
        if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            StringBuilder image = new StringBuilder(32768);
            uint size = (uint)image.Capacity;
            if (!QueryFullProcessImageNameW(process, 0, image, ref size) || size == 0 || size >= image.Capacity)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return Path.GetFullPath(image.ToString());
        }
        finally { CloseHandle(process); }
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr CreateInterfaceCall(IntPtr version, IntPtr returnCode);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int CreatePipeCall(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int ConnectUserCall(IntPtr self, int pipe);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr GetUserInterfaceCall(IntPtr self, int user, int pipe, IntPtr version);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr GetPipeInterfaceCall(IntPtr self, int pipe, IntPtr version);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void ReleaseUserCall(IntPtr self, int pipe, int user);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    [return: MarshalAs(UnmanagedType.I1)] private delegate bool ReleasePipeCall(IntPtr self, int pipe);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate ulong SteamIdCall(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    [return: MarshalAs(UnmanagedType.I1)] private delegate bool LoggedOnCall(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate uint AppIdCall(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int CountCall(IntPtr friends, ulong user);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr KeyCall(IntPtr friends, ulong user, int index);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr ValueCall(IntPtr friends, ulong user, IntPtr key);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    [return: MarshalAs(UnmanagedType.I1)] private delegate bool SetCall(IntPtr friends, IntPtr key, IntPtr value);

    private sealed class InterfaceSelection
    {
        public readonly string Friends;
        public readonly string User;
        public readonly string Utils;
        public InterfaceSelection(string friends, string user, string utils) { Friends = friends; User = user; Utils = utils; }
    }
    private static InterfaceSelection selectedInterfaces;
    private static string SelectInterfaceFamily(Func<string, bool> hasExport, string family, string[] supported)
    {
        // Probe accessor symbols without invoking their lazy initialization paths.
        string selected = null;
        for (int number = 0; number <= 999; number++)
        {
            string suffix = number.ToString("D3", CultureInfo.InvariantCulture);
            if (!hasExport("SteamAPI_" + family + "_v" + suffix)) continue;
            if (selected != null) throw new Failure("NATIVE_EXPORT_MISSING");
            selected = family + suffix;
        }
        if (selected == null || Array.IndexOf(supported, selected) < 0) throw new Failure("NATIVE_EXPORT_MISSING");
        return selected;
    }
    private static InterfaceSelection SelectInterfaces(Func<string, bool> hasExport)
    {
        return new InterfaceSelection(
            SelectInterfaceFamily(hasExport, "SteamFriends", new string[] { "SteamFriends017", "SteamFriends018" }),
            SelectInterfaceFamily(hasExport, "SteamUser", new string[] { "SteamUser020", "SteamUser021", "SteamUser022", "SteamUser023" }),
            SelectInterfaceFamily(hasExport, "SteamUtils", new string[] { "SteamUtils009", "SteamUtils010" }));
    }
    private static IntPtr RequireSelectedInterface(string version, Func<string, IntPtr> get)
    {
        IntPtr pointer = get(version);
        if (pointer == IntPtr.Zero) throw new Failure("NATIVE_EXPORT_MISSING");
        return pointer;
    }
    private static string InterfaceSelectionJson(InterfaceSelection selection)
    {
        return "{\"friends\":" + Quote(selection.Friends) + ",\"user\":" + Quote(selection.User) + ",\"utils\":" + Quote(selection.Utils) + "}";
    }

    private sealed class Failure : Exception
    {
        public readonly string Code;
        public Failure(string code) { Code = code; }
    }

    private sealed class Binding
    {
        public bool PublicClient;
        public string Dll;
        public string Hash;
        public string ClientDll;
        public string ClientHash;
        public uint App;
        public ulong Self;
        public int GamePid;
        public long GameTicks;
        public int ParentPid;
        public long ParentTicks;
        public string GameImage;
        public int SteamPid;
        public long SteamTicks;
        public string SteamImage;

        public static Binding Parse(string[] args)
        {
            if (args.Length > 0 && args[0] == "--public-client") return ParsePublicBinding(args);
            Binding value = new Binding();
            if (args.Length != 12 || !Path.IsPathRooted(args[0]) || args[0].StartsWith(@"\\", StringComparison.Ordinal)
                || !Regex.IsMatch(args[1], "^[a-f0-9]{64}$", RegexOptions.CultureInvariant)
                || !Path.IsPathRooted(args[2]) || args[2].StartsWith(@"\\", StringComparison.Ordinal)
                || !Regex.IsMatch(args[3], "^[a-f0-9]{64}$", RegexOptions.CultureInvariant)
                || !UInt32.TryParse(args[4], NumberStyles.None, CultureInfo.InvariantCulture, out value.App) || value.App == 0
                || !UInt64.TryParse(args[5], NumberStyles.None, CultureInfo.InvariantCulture, out value.Self) || value.Self == 0
                || !Int32.TryParse(args[6], NumberStyles.None, CultureInfo.InvariantCulture, out value.GamePid) || value.GamePid <= 0
                || !Int64.TryParse(args[7], NumberStyles.None, CultureInfo.InvariantCulture, out value.GameTicks) || value.GameTicks <= 0
                || !Int32.TryParse(args[8], NumberStyles.None, CultureInfo.InvariantCulture, out value.ParentPid) || value.ParentPid <= 0
                || !Int64.TryParse(args[9], NumberStyles.None, CultureInfo.InvariantCulture, out value.ParentTicks) || value.ParentTicks <= 0
                || !Int32.TryParse(args[10], NumberStyles.None, CultureInfo.InvariantCulture, out value.SteamPid) || value.SteamPid <= 0
                || !Int64.TryParse(args[11], NumberStyles.None, CultureInfo.InvariantCulture, out value.SteamTicks) || value.SteamTicks <= 0
                || value.ParentPid == value.GamePid || value.SteamPid == value.GamePid || value.SteamPid == value.ParentPid) throw new Failure("NATIVE_ARGUMENTS_INVALID");
            value.Dll = Path.GetFullPath(args[0]);
            value.Hash = args[1];
            value.ClientDll = Path.GetFullPath(args[2]);
            value.ClientHash = args[3];
            if (String.Equals(value.Dll, value.ClientDll, StringComparison.OrdinalIgnoreCase)) throw new Failure("NATIVE_ARGUMENTS_INVALID");
            if (!String.Equals(Path.GetFileName(value.ClientDll), IntPtr.Size == 4 ? "steamclient.dll" : "steamclient64.dll", StringComparison.OrdinalIgnoreCase)) throw new Failure("NATIVE_ARGUMENTS_INVALID");
            value.SteamImage = Path.Combine(Path.GetDirectoryName(value.ClientDll), "steam.exe");
            value.AssertAlive();
            try
            {
                value.GameImage = ProcessImage(value.GamePid);
            }
            catch { value.AssertAlive(); throw new Failure("NATIVE_CONTEXT_UNAVAILABLE"); }
            value.AssertAlive();
            return value;
        }

        private static int ProcessState(int pid, long ticks, string image)
        {
            Process process;
            try { process = Process.GetProcessById(pid); }
            catch (ArgumentException) { return 70; }
            catch { return 73; }
            using (process)
            try
            {
                if (process.HasExited || process.StartTime.ToUniversalTime().Ticks != ticks) return 70;
                if (image != null && !String.Equals(ProcessImage(pid), image, StringComparison.OrdinalIgnoreCase)) return 70;
                return process.HasExited ? 70 : 0;
            }
            catch { try { return process.HasExited ? 70 : 73; } catch { return 73; } }
        }

        public int LivenessCode()
        {
            int parent = ProcessState(ParentPid, ParentTicks, null);
            if (parent != 0) return parent;
            int steam = ProcessState(SteamPid, SteamTicks, SteamImage);
            return steam != 0 ? steam : ProcessState(GamePid, GameTicks, GameImage);
        }
        public static int RegistryIdentityState(object activePid, object activeUser, int expectedPid, ulong expectedSelf)
        {
            bool hasPid = activePid is int && unchecked((uint)(int)activePid) != 0;
            bool hasUser = activeUser is int && unchecked((uint)(int)activeUser) != 0;
            if (hasPid && unchecked((uint)(int)activePid) != (uint)expectedPid) return 70;
            if (hasUser && unchecked((uint)(int)activeUser) != (uint)(expectedSelf & 0xffffffffUL)) return 70;
            return hasPid && hasUser ? 0 : 73;
        }
        public int ContextCode()
        {
            int alive = LivenessCode();
            if (alive != 0) return alive;
            try
            {
                using (RegistryKey active = Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam\ActiveProcess", false))
                {
                    if (active == null) return 73;
                    int identity = RegistryIdentityState(active.GetValue("pid", null, RegistryValueOptions.DoNotExpandEnvironmentNames),
                        active.GetValue("ActiveUser", null, RegistryValueOptions.DoNotExpandEnvironmentNames), SteamPid, Self);
                    return identity != 0 ? identity : PublicClient ? PublicRunningAppContextCode(App) : 0;
                }
            }
            catch { return 73; }
        }
        public void AssertAlive() { int code = ContextCode(); if (code != 0) throw new Failure(code == 70 ? "NATIVE_CONTEXT_CHANGED" : "NATIVE_CONTEXT_UNAVAILABLE"); }
    }

    private interface IPresence : IDisposable
    {
        bool Guard();
        void Preflight(SortedDictionary<string, string> changes);
        PresenceRead Read();
        bool Set(string key, string value);
    }

    private interface IPublicPresenceReader
    {
        int Count();
        string Key(int index);
        string Value(string key, int maximumBytes);
    }

    private sealed class PresenceRead
    {
        public int KeyCount;
        public readonly SortedDictionary<string, string> Fields = new SortedDictionary<string, string>(StringComparer.Ordinal);
        public string LocalizedString;
        public bool DisplayTokenReadable;
    }

    private static void ReadGuard(Func<bool> valid) { if (!valid()) throw new Failure("NATIVE_CONTEXT_CHANGED"); }
    private static List<string> ApplyOrder(SortedDictionary<string, string> changes)
    {
        List<string> keys = new List<string>();
        foreach (string key in changes.Keys) if (!String.Equals(key, "steam_display", StringComparison.OrdinalIgnoreCase) && changes[key] == null) keys.Add(key);
        foreach (string key in changes.Keys) if (!String.Equals(key, "steam_display", StringComparison.OrdinalIgnoreCase) && changes[key] != null) keys.Add(key);
        string display = new List<string>(changes.Keys).Find(delegate(string key) { return String.Equals(key, "steam_display", StringComparison.OrdinalIgnoreCase); });
        if (display != null) keys.Add(display);
        return keys;
    }
    private static HashSet<string> GroupKeyNames(IPublicPresenceReader reader, Func<bool> valid)
    {
        ReadGuard(valid); int count = reader.Count(); ReadGuard(valid);
        if (count < 0 || count > RichPresenceContract.PresenceMaxKeys) throw new Failure("NATIVE_SET_REJECTED");
        HashSet<string> names = new HashSet<string>(StringComparer.Ordinal);
        HashSet<string> unique = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (int index = 0; index < count; index++)
        {
            ReadGuard(valid); string key = reader.Key(index); ReadGuard(valid);
            if (key == null || Utf8.GetByteCount(key) > RichPresenceContract.PresenceKeyAsciiLength || !unique.Add(key)) throw new Failure("NATIVE_SET_REJECTED");
            names.Add(key);
        }
        return names;
    }
    private static void RequireExistingGroup(IPublicPresenceReader reader, Func<bool> valid)
    {
        if (!GroupKeyNames(reader, valid).Contains(GroupIdKey)) throw new Failure("NATIVE_SET_REJECTED");
    }
    private static void PreflightRealGroupChanges(IPublicPresenceReader reader, Func<bool> valid, SortedDictionary<string, string> changes)
    {
        if (!changes.ContainsKey(GroupSizeKey)) return;
        HashSet<string> names = GroupKeyNames(reader, valid);
        if (!names.Contains(GroupIdKey) || !GroupSizeValueValid(changes[GroupSizeKey])) throw new Failure("NATIVE_SET_REJECTED");
        foreach (string key in ApplyOrder(changes))
        {
            if (changes[key] == null) names.Remove(key); else names.Add(key);
            if (names.Count > RichPresenceContract.PresenceMaxKeys) throw new Failure("NATIVE_SET_REJECTED");
        }
        ReadGuard(valid);
    }
    private static bool PublicText(string value, int maximumBytes)
    {
        return RichPresenceContract.IsText(value, maximumBytes);
    }
    private static PresenceRead ReadPublic(IPublicPresenceReader reader, Func<bool> valid)
    {
        ReadGuard(valid); int count = reader.Count(); ReadGuard(valid);
        if (count < 0 || count > RichPresenceContract.PresenceMaxKeys) throw new Failure("NATIVE_PUBLIC_READ_INVALID");
        PresenceRead result = new PresenceRead { KeyCount = count };
        HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < count; i++)
        {
            ReadGuard(valid); string key = reader.Key(i); ReadGuard(valid);
            if (key == null || Utf8.GetByteCount(key) > RichPresenceContract.PresenceKeyAsciiLength || !seen.Add(key)) throw new Failure("NATIVE_PUBLIC_READ_INVALID");
            bool display = key == "steam_display";
            if (!display && (!PublicKeys.Contains(key) || (key != GroupSizeKey && !RichPresenceContract.IsParameter(key)))) continue;
            ReadGuard(valid); string value = reader.Value(key, display ? RichPresenceContract.PresenceLocalizedReadUtf8Bytes : RichPresenceContract.PresenceValueUtf8Bytes); ReadGuard(valid);
            if (!PublicText(value, display ? RichPresenceContract.PresenceLocalizedReadUtf8Bytes : RichPresenceContract.PresenceValueUtf8Bytes)) throw new Failure("NATIVE_PUBLIC_READ_INVALID");
            if (key == GroupSizeKey && !GroupSizeValueValid(value)) throw new Failure("NATIVE_PUBLIC_READ_INVALID");
            if (!display) result.Fields.Add(key, value);
            else if (DisplayToken.IsMatch(value)) { result.Fields.Add(key, value); result.DisplayTokenReadable = true; }
            else if (value.StartsWith("#", StringComparison.Ordinal)) throw new Failure("NATIVE_PUBLIC_READ_INVALID");
            else if (value.Length > 0) result.LocalizedString = value;
        }
        ReadGuard(valid); return result;
    }

    private sealed class NativeLibrary : IDisposable
    {
        private FileStream file;
        private readonly CleanupLifecycle cleanup;
        private readonly string cleanupStage;
        private readonly Func<IntPtr, bool> unload = FreeLibrary;
        private bool disposed;
        public IntPtr Handle;
        public NativeLibrary(string path, string hash, long maximumBytes, CleanupLifecycle lifecycle, string stage)
        {
            cleanup = lifecycle; cleanupStage = stage;
            try
            {
                if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new Failure("NATIVE_DLL_INVALID");
                file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
                if (file.Length < 256 || file.Length > maximumBytes) throw new Failure("NATIVE_DLL_INVALID");
                byte[] header = new byte[64];
                if (file.Read(header, 0, header.Length) != header.Length || header[0] != 0x4d || header[1] != 0x5a) throw new Failure("NATIVE_DLL_INVALID");
                int pe = BitConverter.ToInt32(header, 0x3c);
                if (pe < 64 || pe > file.Length - 26) throw new Failure("NATIVE_DLL_INVALID");
                file.Position = pe; byte[] signature = new byte[26];
                if (file.Read(signature, 0, signature.Length) != signature.Length || BitConverter.ToUInt32(signature, 0) != 0x4550
                    || BitConverter.ToUInt16(signature, 4) != (IntPtr.Size == 4 ? 0x14c : 0x8664)
                    || BitConverter.ToUInt16(signature, 24) != (IntPtr.Size == 4 ? 0x10b : 0x20b)) throw new Failure("NATIVE_DLL_INVALID");
                file.Position = 0; byte[] digest;
                using (SHA256 sha = SHA256.Create()) digest = sha.ComputeHash(file);
                if (BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant() != hash) throw new Failure("NATIVE_DLL_INVALID");
                Handle = LoadLibraryExW(path, IntPtr.Zero, 0x100u | 0x800u);
                if (Handle == IntPtr.Zero) throw new Failure("NATIVE_LOAD_FAILED");
            }
            catch { Dispose(); throw; }
        }
        public T Require<T>(string name) where T : class
        {
            IntPtr address = GetProcAddress(Handle, name);
            if (address == IntPtr.Zero) throw new Failure("NATIVE_EXPORT_MISSING");
            return (T)(object)Marshal.GetDelegateForFunctionPointer(address, typeof(T));
        }
        public bool HasExport(string name) { return GetProcAddress(Handle, name) != IntPtr.Zero; }
        public void Dispose()
        {
            if (disposed) return; disposed = true;
            bool attempted = false, ok = true;
            if (Handle != IntPtr.Zero)
            {
                attempted = true;
                try { if (!unload(Handle)) ok = false; } catch { ok = false; }
                finally { Handle = IntPtr.Zero; }
            }
            if (file != null)
            {
                attempted = true;
                try { file.Dispose(); } catch { ok = false; }
                finally { file = null; }
            }
            if (attempted) cleanup.Record(cleanupStage, ok);
        }
#if NATIVE_PRESENCE_TEST
        public NativeLibrary(CleanupLifecycle lifecycle, string stage, Func<IntPtr, bool> syntheticUnload, bool failConstruction)
        {
            cleanup = lifecycle; cleanupStage = stage; unload = syntheticUnload; Handle = new IntPtr(1);
            try { if (failConstruction) throw new Failure("SYNTHETIC_CONSTRUCTION_FAILURE"); }
            catch { Dispose(); throw; }
        }
#endif
    }

    private sealed class NativePresence : IPresence, IPublicPresenceReader
    {
        private readonly Binding binding;
        private readonly CleanupLifecycle cleanup = new CleanupLifecycle();
        private NativeLibrary apiLibrary;
        private NativeLibrary clientLibrary;
        private bool disposed;
        private IntPtr client;
        private int pipe;
        private int ownUser;
        private ReleaseUserCall releaseUser;
        private ReleasePipeCall releasePipe;
        private SteamIdCall getSteamId;
        private LoggedOnCall loggedOn;
        private AppIdCall getAppId;
        private CountCall count;
        private KeyCall key;
        private ValueCall readValue;
        private SetCall set;
        private IntPtr user;
        private IntPtr utils;
        private IntPtr friends;

        private IntPtr RequireUserInterface(string export, string version)
        {
            GetUserInterfaceCall get = apiLibrary.Require<GetUserInterfaceCall>(export);
            return RequireSelectedInterface(version, delegate(string selected)
            {
                IntPtr text = CString(selected);
                try { Bound(); IntPtr pointer = get(client, ownUser, pipe, text); Bound(); return pointer; }
                finally { Marshal.FreeHGlobal(text); }
            });
        }
        private IntPtr RequirePipeInterface(string export, string version)
        {
            GetPipeInterfaceCall get = apiLibrary.Require<GetPipeInterfaceCall>(export);
            return RequireSelectedInterface(version, delegate(string selected)
            {
                IntPtr text = CString(selected);
                try { Bound(); IntPtr pointer = get(client, pipe, text); Bound(); return pointer; }
                finally { Marshal.FreeHGlobal(text); }
            });
        }
        private void Bound() { if (disposed) throw new Failure("NATIVE_EXITED"); binding.AssertAlive(); }

        public NativePresence(Binding value)
        {
            binding = value;
            try
            {
                Bound();
                Environment.SetEnvironmentVariable("SteamAppId", binding.App.ToString(CultureInfo.InvariantCulture), EnvironmentVariableTarget.Process);
                Environment.SetEnvironmentVariable("SteamGameId", binding.App.ToString(CultureInfo.InvariantCulture), EnvironmentVariableTarget.Process);
                apiLibrary = new NativeLibrary(binding.Dll, binding.Hash, 16 * 1024 * 1024, cleanup, "free-api-library"); Bound();
                // Flat wrappers must receive the ABI advertised by this exact game API binary.
                selectedInterfaces = SelectInterfaces(apiLibrary.HasExport); Bound();
                clientLibrary = new NativeLibrary(binding.ClientDll, binding.ClientHash, 64 * 1024 * 1024, cleanup, "free-client-library"); Bound();
                CreateInterfaceCall factory = clientLibrary.Require<CreateInterfaceCall>("CreateInterface");
                IntPtr version = CString("SteamClient021");
                try { client = factory(version, IntPtr.Zero); } finally { Marshal.FreeHGlobal(version); }
                Bound(); if (client == IntPtr.Zero) throw new Failure("NATIVE_EXPORT_MISSING");
                releaseUser = apiLibrary.Require<ReleaseUserCall>("SteamAPI_ISteamClient_ReleaseUser");
                releasePipe = apiLibrary.Require<ReleasePipeCall>("SteamAPI_ISteamClient_BReleaseSteamPipe");
                CreatePipeCall createPipe = apiLibrary.Require<CreatePipeCall>("SteamAPI_ISteamClient_CreateSteamPipe");
                pipe = createPipe(client); Bound(); if (pipe <= 0) throw new Failure("NATIVE_INIT_FAILED");
                ConnectUserCall connect = apiLibrary.Require<ConnectUserCall>("SteamAPI_ISteamClient_ConnectToGlobalUser");
                ownUser = connect(client, pipe); Bound(); if (ownUser <= 0) throw new Failure("NATIVE_INIT_FAILED");
                user = RequireUserInterface("SteamAPI_ISteamClient_GetISteamUser", selectedInterfaces.User);
                friends = RequireUserInterface("SteamAPI_ISteamClient_GetISteamFriends", selectedInterfaces.Friends);
                utils = RequirePipeInterface("SteamAPI_ISteamClient_GetISteamUtils", selectedInterfaces.Utils);
                getSteamId = apiLibrary.Require<SteamIdCall>("SteamAPI_ISteamUser_GetSteamID");
                loggedOn = apiLibrary.Require<LoggedOnCall>("SteamAPI_ISteamUser_BLoggedOn");
                getAppId = apiLibrary.Require<AppIdCall>("SteamAPI_ISteamUtils_GetAppID");
                count = apiLibrary.Require<CountCall>("SteamAPI_ISteamFriends_GetFriendRichPresenceKeyCount");
                key = apiLibrary.Require<KeyCall>("SteamAPI_ISteamFriends_GetFriendRichPresenceKeyByIndex");
                readValue = apiLibrary.Require<ValueCall>("SteamAPI_ISteamFriends_GetFriendRichPresence");
                set = apiLibrary.Require<SetCall>("SteamAPI_ISteamFriends_SetRichPresence");
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
            ulong self = getSteamId(user); Bound();
            uint app = getAppId(utils); Bound();
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
        public bool Set(string key, string value)
        {
            IntPtr keyMemory = IntPtr.Zero;
            IntPtr valueMemory = IntPtr.Zero;
            try
            {
                keyMemory = CString(key); if (value != null) valueMemory = CString(value);
                if (key == GroupSizeKey) { if (!GroupSizeValueValid(value)) throw new Failure("NATIVE_PROTOCOL_INVALID"); RequireExistingGroup(this, Guard); }
                if (!Guard()) throw new Failure("NATIVE_CONTEXT_CHANGED");
                bool result = set(friends, keyMemory, valueMemory);
                if (!Guard()) throw new Failure("NATIVE_CONTEXT_CHANGED"); return result;
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
                cleanup.Record("release-user-start", null);
                bool ok = true;
                // A true result records call return, not Steam-side reclamation.
                try { releaseUser(client, pipe, ownUser); } catch { ok = false; }
                finally { ownUser = 0; cleanup.Record("release-user-returned", ok); }
            }
            if (pipe > 0 && client != IntPtr.Zero && releasePipe != null)
            {
                cleanup.Record("release-pipe-start", null);
                bool ok = false;
                try { ok = releasePipe(client, pipe); } catch { }
                finally { pipe = 0; cleanup.Record("release-pipe-returned", ok); }
            }
            if (apiLibrary != null)
            {
                try { apiLibrary.Dispose(); } catch { cleanup.Record("free-api-library", false); }
                finally { apiLibrary = null; }
            }
            if (clientLibrary != null)
            {
                try { clientLibrary.Dispose(); } catch { cleanup.Record("free-client-library", false); }
                finally { clientLibrary = null; }
            }
            cleanup.Complete();
        }
#if NATIVE_PRESENCE_TEST
        public NativePresence(string profile, List<string> calls)
        {
            try
            {
                if (profile == "empty") return;
                apiLibrary = new NativeLibrary(cleanup, "free-api-library", delegate(IntPtr ignored)
                {
                    calls.Add("free-api-library");
                    if (profile == "throw-api" || profile == "all-fail") throw new Exception("SYNTHETIC_PRIVATE_RELEASE_EXCEPTION_NEVER_OUTPUT");
                    return profile != "false-api" && profile != "constructor-failure-free-false";
                }, profile == "constructor-failure" || profile == "constructor-failure-free-false");
                clientLibrary = new NativeLibrary(cleanup, "free-client-library", delegate(IntPtr ignored)
                {
                    calls.Add("free-client-library");
                    if (profile == "throw-client" || profile == "all-fail") throw new Exception("SYNTHETIC_PRIVATE_RELEASE_EXCEPTION_NEVER_OUTPUT");
                    return profile != "false-client" && profile != "client-construction-failure-free-false";
                }, profile == "client-construction-failure" || profile == "client-construction-failure-free-false");
                client = new IntPtr(1); pipe = 1; ownUser = 1;
                releaseUser = delegate(IntPtr self, int ownedPipe, int ownedUser)
                {
                    calls.Add("release-user");
                    if (profile == "throw-user" || profile == "all-fail") throw new Exception("SYNTHETIC_PRIVATE_RELEASE_EXCEPTION_NEVER_OUTPUT");
                };
                releasePipe = delegate(IntPtr self, int ownedPipe)
                {
                    calls.Add("release-pipe");
                    if (profile == "throw-pipe" || profile == "all-fail") throw new Exception("SYNTHETIC_PRIVATE_RELEASE_EXCEPTION_NEVER_OUTPUT");
                    return profile != "false-pipe";
                };
            }
            catch { Dispose(); throw; }
        }
#endif
    }

    private static string ReadString(IntPtr pointer, int maximumBytes)
    {
        if (pointer == IntPtr.Zero) return "";
        List<byte> bytes = new List<byte>();
        for (int i = 0; i <= maximumBytes; i++)
        {
            byte value = Marshal.ReadByte(pointer, i);
            if (value == 0)
            {
                try { return Utf8.GetString(bytes.ToArray()); }
                catch (DecoderFallbackException) { throw new Failure("NATIVE_PUBLIC_READ_INVALID"); }
            }
            bytes.Add(value);
        }
        throw new Failure("NATIVE_PUBLIC_READ_INVALID");
    }

    private static IntPtr CString(string value)
    {
        byte[] bytes = Utf8.GetBytes(value + "\0");
        IntPtr memory = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, memory, bytes.Length);
        return memory;
    }

    // Only this small JSON subset is accepted; duplicate properties and unknown fields fail closed.
    private sealed class Json
    {
        private readonly string input;
        private int offset;
        public Json(string value) { input = value; }
        private void White() { while (offset < input.Length && " \t\r\n".IndexOf(input[offset]) >= 0) offset++; }
        private void Take(char value) { White(); if (offset >= input.Length || input[offset++] != value) throw new Failure("NATIVE_PROTOCOL_INVALID"); }
        private string String()
        {
            Take('"'); StringBuilder value = new StringBuilder();
            while (offset < input.Length)
            {
                char character = input[offset++];
                if (character == '"')
                {
                    try { Utf8.GetByteCount(value.ToString()); }
                    catch { throw new Failure("NATIVE_PROTOCOL_INVALID"); }
                    return value.ToString();
                }
                if (character < 0x20) throw new Failure("NATIVE_PROTOCOL_INVALID");
                if (character == '\\')
                {
                    if (offset >= input.Length) throw new Failure("NATIVE_PROTOCOL_INVALID");
                    char escaped = input[offset++];
                    if (escaped == '"' || escaped == '\\' || escaped == '/') character = escaped;
                    else if (escaped == 'b') character = '\b';
                    else if (escaped == 'f') character = '\f';
                    else if (escaped == 'n') character = '\n';
                    else if (escaped == 'r') character = '\r';
                    else if (escaped == 't') character = '\t';
                    else if (escaped == 'u')
                    {
                        ushort code;
                        if (offset + 4 > input.Length || !UInt16.TryParse(input.Substring(offset, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out code)) throw new Failure("NATIVE_PROTOCOL_INVALID");
                        offset += 4; character = (char)code;
                    }
                    else throw new Failure("NATIVE_PROTOCOL_INVALID");
                }
                value.Append(character);
                if (value.Length > RichPresenceContract.TransportRequestLineBytes) throw new Failure("NATIVE_PROTOCOL_INVALID");
            }
            throw new Failure("NATIVE_PROTOCOL_INVALID");
        }
        private Dictionary<string, object> Object(int depth)
        {
            if (depth > 1) throw new Failure("NATIVE_PROTOCOL_INVALID");
            Take('{'); Dictionary<string, object> result = new Dictionary<string, object>(StringComparer.Ordinal);
            White(); if (offset < input.Length && input[offset] == '}') { offset++; return result; }
            while (true)
            {
                string key = String(); Take(':'); White(); object value;
                if (offset >= input.Length) throw new Failure("NATIVE_PROTOCOL_INVALID");
                if (input[offset] == '"') value = String();
                else if (input[offset] == '{') value = Object(depth + 1);
                else if (input[offset] == '1') { offset++; value = 1; }
                else if (input.Substring(offset).StartsWith("null", StringComparison.Ordinal)) { offset += 4; value = null; }
                else throw new Failure("NATIVE_PROTOCOL_INVALID");
                if (result.ContainsKey(key) || result.Count >= 24) throw new Failure("NATIVE_PROTOCOL_INVALID");
                result.Add(key, value); White();
                if (offset < input.Length && input[offset] == '}') { offset++; return result; }
                Take(',');
            }
        }
        public Dictionary<string, object> Parse()
        {
            if (input.Length > RichPresenceContract.TransportRequestLineBytes || Utf8.GetByteCount(input) > RichPresenceContract.TransportRequestLineBytes) throw new Failure("NATIVE_PROTOCOL_INVALID");
            Dictionary<string, object> result = Object(0); White();
            if (offset != input.Length) throw new Failure("NATIVE_PROTOCOL_INVALID");
            return result;
        }
    }

    private sealed class Request
    {
        public string Id;
        public string Op;
        public SortedDictionary<string, string> Changes;
        public static Request Parse(string line)
        {
            Dictionary<string, object> json = new Json(line).Parse();
            if (!json.ContainsKey("v") || !(json["v"] is int) || (int)json["v"] != 1
                || !json.ContainsKey("requestId") || !(json["requestId"] is string) || !RequestId.IsMatch((string)json["requestId"])
                || (string)json["requestId"] == "startup" || !json.ContainsKey("op") || !(json["op"] is string)) throw new Failure("NATIVE_PROTOCOL_INVALID");
            Request request = new Request { Id = (string)json["requestId"], Op = (string)json["op"], Changes = new SortedDictionary<string, string>(StringComparer.Ordinal) };
            if (request.Op != "read" && request.Op != "apply" && request.Op != "stop") throw new Failure("NATIVE_PROTOCOL_INVALID");
            foreach (string field in json.Keys) if (field != "v" && field != "requestId" && field != "op" && (field != "changes" || request.Op != "apply")) throw new Failure("NATIVE_PROTOCOL_INVALID");
            if (request.Op == "apply")
            {
                if (!json.ContainsKey("changes") || !(json["changes"] is Dictionary<string, object>)) throw new Failure("NATIVE_PROTOCOL_INVALID");
                Dictionary<string, object> changes = (Dictionary<string, object>)json["changes"];
                HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                if (changes.Count < 1 || changes.Count > RichPresenceContract.PresenceMaxKeys) throw new Failure("NATIVE_PROTOCOL_INVALID");
                foreach (KeyValuePair<string, object> change in changes)
                {
                    string key = change.Key;
                    string value = change.Value as string;
                    string lower = key.ToLowerInvariant();
                    if ((value == null && (key != GroupSizeKey || change.Value != null)) || !seen.Add(key)
                        || (key != "steam_display" && key != GroupSizeKey && !RichPresenceContract.IsParameter(key)) || (value != null && !PublicText(value, RichPresenceContract.PresenceValueUtf8Bytes))
                        || (key == GroupSizeKey && !GroupSizeValueValid(value))) throw new Failure("NATIVE_PROTOCOL_INVALID");
                    if (lower == "steam_display" && value != "" && !DisplayToken.IsMatch(value)) throw new Failure("NATIVE_PROTOCOL_INVALID");
                    request.Changes.Add(key, value);
                }
            }
            return request;
        }
    }

    private static string Quote(string value)
    {
        StringBuilder text = new StringBuilder("\"");
        foreach (char character in value)
        {
            if (character == '"' || character == '\\') text.Append('\\').Append(character);
            else if (character < 0x20) text.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
            else text.Append(character);
        }
        return text.Append('"').ToString();
    }
    private static void Reply(string id, string op, bool ok, string code, List<string> accepted, bool mayHaveWritten, PresenceRead read)
    {
        StringBuilder json = new StringBuilder("{\"v\":1,\"requestId\":").Append(Quote(id)).Append(",\"op\":").Append(Quote(op))
            .Append(",\"ok\":").Append(ok ? "true" : "false").Append(",\"acceptedKeys\":[");
        for (int i = 0; i < accepted.Count; i++) { if (i > 0) json.Append(','); json.Append(Quote(accepted[i])); }
        json.Append("],\"mayHaveWritten\":").Append(mayHaveWritten ? "true" : "false");
        if (code != null) json.Append(",\"code\":").Append(Quote(code));
        if (read != null)
        {
            json.Append(",\"keyCount\":").Append(read.KeyCount.ToString(CultureInfo.InvariantCulture)).Append(",\"fields\":{");
            bool first = true;
            foreach (KeyValuePair<string, string> field in read.Fields)
            { if (!first) json.Append(','); first = false; json.Append(Quote(field.Key)).Append(':').Append(Quote(field.Value)); }
            json.Append("},\"localizedString\":").Append(read.LocalizedString == null ? "null" : Quote(read.LocalizedString))
                .Append(",\"displayTokenReadable\":").Append(read.DisplayTokenReadable ? "true" : "false")
                .Append(",\"verificationSource\":\"local-cache\"");
        }
        if (ok && op != "stopped") json.Append(",\"identityMatch\":true,\"appMatch\":true,\"loggedOn\":true,\"gameStillSame\":true");
        if (op == "ready" && selectedInterfaces != null) json.Append(",\"selectedInterfaces\":").Append(InterfaceSelectionJson(selectedInterfaces));
        string frame = json.Append('}').ToString();
        if (Utf8.GetByteCount(frame) > RichPresenceContract.TransportOrdinaryFrameBytes) throw new Failure("NATIVE_PROTOCOL_INVALID");
        output.WriteLine(frame);
    }

    private static bool Handle(string line, IPresence api, HashSet<string> seen)
    {
        string id = "invalid";
        List<string> accepted = new List<string>();
        bool mayHaveWritten = false;
        try
        {
            Request request = Request.Parse(line); id = request.Id;
            if (!seen.Add(id) || seen.Count > 100000) throw new Failure("NATIVE_PROTOCOL_INVALID");
            if (request.Op == "stop") { Reply(id, "stopped", true, null, accepted, false, null); return false; }
            if (!api.Guard()) throw new Failure("NATIVE_CONTEXT_CHANGED");
            if (request.Op == "read") { PresenceRead read = api.Read(); if (!api.Guard()) throw new Failure("NATIVE_CONTEXT_CHANGED"); Reply(id, "read", true, null, accepted, false, read); return true; }
            api.Preflight(request.Changes);
            List<string> keys = ApplyOrder(request.Changes);
            foreach (string key in keys)
            {
                if (!api.Guard()) throw new Failure("NATIVE_CONTEXT_CHANGED");
                mayHaveWritten = true;
                if (!api.Set(key, request.Changes[key])) throw new Failure("NATIVE_SET_REJECTED");
                accepted.Add(key);
            }
            if (!api.Guard()) throw new Failure("NATIVE_CONTEXT_CHANGED");
            Reply(id, "applied", true, null, accepted, mayHaveWritten, null);
            return true;
        }
        catch (Failure failure) { Reply(id, "error", false, failure.Code, accepted, mayHaveWritten, null); return false; }
        catch { Reply(id, "error", false, "NATIVE_INTERNAL_ERROR", accepted, mayHaveWritten, null); return false; }
    }

    private sealed class Input
    {
        public readonly Queue<string> Lines = new Queue<string>();
        public volatile bool Closed;
        public volatile bool Invalid;
        public volatile bool StopQueued;
        private long closedAtTicks;
        public bool OwnerAvailable()
        {
            return !Closed || (StopQueued && DateTime.UtcNow.Ticks - Interlocked.Read(ref closedAtTicks) < TimeSpan.TicksPerMillisecond * 500);
        }
        public void Run()
        {
            try
            {
                using (StreamReader reader = new StreamReader(Console.OpenStandardInput(), Utf8, false, 256))
                {
                    StringBuilder line = new StringBuilder();
                    int lineBytes = 0;
                    while (true)
                    {
                        int next = reader.Read();
                        if (next < 0) { if (line.Length > 0) Invalid = true; break; }
                        if (next == '\n')
                        {
                            if (line.Length > 0 && line[line.Length - 1] == '\r') line.Length--;
                            lock (Lines)
                            {
                                if (Lines.Count >= 32) { Invalid = true; break; }
                                string text = line.ToString(); Lines.Enqueue(text);
                                try { if (Request.Parse(text).Op == "stop") StopQueued = true; } catch { }
                            }
                            line.Length = 0; lineBytes = 0;
                        }
                        else
                        {
                            char character = (char)next;
                            lineBytes += character <= 0x7f ? 1 : character <= 0x7ff ? 2 : Char.IsHighSurrogate(character) ? 4 : Char.IsLowSurrogate(character) ? 0 : 3;
                            if (lineBytes > RichPresenceContract.TransportRequestLineBytes) { Invalid = true; break; }
                            line.Append(character);
                        }
                    }
                }
            }
            catch { Invalid = true; }
            finally { Interlocked.Exchange(ref closedAtTicks, DateTime.UtcNow.Ticks); Closed = true; }
        }
    }

    private sealed class SessionPresence : IPresence
    {
        private readonly IPresence api;
        private readonly Input input;
        public SessionPresence(IPresence value, Input source) { api = value; input = source; }
        public bool Guard()
        {
            if (input.Invalid) throw new Failure("NATIVE_PROTOCOL_INVALID");
            if (input.Closed) throw new Failure("NATIVE_EXITED");
            return api.Guard();
        }
        public PresenceRead Read() { if (!Guard()) throw new Failure("NATIVE_CONTEXT_CHANGED"); return api.Read(); }
        public void Preflight(SortedDictionary<string, string> changes) { if (changes.ContainsKey(GroupSizeKey) && !Guard()) throw new Failure("NATIVE_CONTEXT_CHANGED"); api.Preflight(changes); }
        public bool Set(string key, string value) { if (!Guard()) throw new Failure("NATIVE_CONTEXT_CHANGED"); return api.Set(key, value); }
        public void Dispose() { }
    }

    private sealed class LivenessWatchdog : IDisposable
    {
        private readonly Func<int> alive;
        private readonly ManualResetEvent stopping = new ManualResetEvent(false);
        private readonly Thread thread;
        public LivenessWatchdog(Func<int> check)
        {
            alive = check;
            thread = new Thread(Run); thread.IsBackground = true; thread.Start();
        }
        private void Run()
        {
            while (!stopping.WaitOne(200))
            {
                int code;
                try { code = alive(); }
                catch { code = 73; }
                // This exits only the worker, even if a native call blocks its main thread.
                if (code != 0) Environment.Exit(code);
            }
        }
        public void Dispose()
        {
            stopping.Set();
            if (thread.Join(500)) stopping.Dispose();
        }
    }

    private static Input StartInput()
    {
        Input input = new Input();
        Thread reader = new Thread(input.Run); reader.IsBackground = true; reader.Start();
        return input;
    }

    private static void Loop(IPresence api, Input input)
    {
        IPresence session = new SessionPresence(api, input);
        HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
        Reply("startup", "ready", true, null, new List<string>(), false, null);
        while (true)
        {
            if (input.Invalid) { Reply("invalid", "error", false, "NATIVE_PROTOCOL_INVALID", new List<string>(), false, null); return; }
            string line = null;
            lock (input.Lines)
            {
                if (input.Closed)
                {
                    while (input.Lines.Count > 0)
                    {
                        string candidate = input.Lines.Dequeue();
                        try { if (Request.Parse(candidate).Op == "stop") { line = candidate; break; } } catch { }
                    }
                    input.Lines.Clear();
                }
                else if (input.Lines.Count > 0) line = input.Lines.Dequeue();
            }
            if (line != null && !Handle(line, session, seen)) return;
            if (input.Closed) return;
            // Identity guards belong to each RPC; the independent watchdog covers idle process liveness.
            Thread.Sleep(50);
        }
    }

#if NATIVE_PRESENCE_TEST
    private sealed class FakePresence : IPresence, IPublicPresenceReader
    {
        private readonly int rejectAt;
        private readonly int guardAt;
        private readonly int profile;
        private int calls;
        private int guards;
        public FakePresence(int reject, int guard, int fixture = 0) { rejectAt = reject; guardAt = guard; profile = fixture; }
        public bool Guard() { guards++; return guardAt == 0 || guards < guardAt; }
        public PresenceRead Read() { return ReadPublic(this, Guard); }
        public void Preflight(SortedDictionary<string, string> changes) { PreflightRealGroupChanges(this, Guard, changes); }
        private string[] Keys()
        {
            string[] keys = { "desc", "steam_display", "connect", "session", "unknown_public_candidate", "game:map", "status", "version", "steam_player_group", "matchgrouploc" };
            if (profile == 7) keys[5] = "DESC";
            if (profile == 8) keys[1] = "unpublished_display";
            if (profile == 10) keys[5] = new string('x', 64);
            if (profile == 15) keys[0] = "DESC";
            if (profile == 16) keys[5] = "game:server";
            if (profile == 17) keys[5] = "game:connect";
            if (profile == 18) keys[8] = "unknown_group_absent";
            if (profile >= 19 && profile <= 23) { List<string> values = new List<string>(keys); values.Add(GroupSizeKey); keys = values.ToArray(); }
            if (profile == 24 || profile == 26) { List<string> values = new List<string>(keys); if (profile == 26) values.Add(GroupSizeKey); for (int index = values.Count; index < 20; index++) values.Add("unknown_field_" + index); keys = values.ToArray(); }
            if (profile == 25 && calls > 0) keys[8] = "unknown_group_disappeared";
            return keys;
        }
        public int Count() { return profile == 5 ? 21 : profile == 6 ? -1 : Keys().Length; }
        public string Key(int index) { return Keys()[index]; }
        public string Value(string name, int maximumBytes)
        {
            if (name != "steam_display" && !PublicKeys.Contains(name)) throw new Failure("NATIVE_PRIVATE_VALUE_READ");
            if (name == "steam_display") return profile == 1 ? "#Fixture" : profile == 2 ? "private\ntext" : profile == 3 ? "#bad token" : profile == 9 ? "" : "\u9b42\u5929\u795e\u793e\u5185";
            if (name == "desc") return profile == 4 ? new string('x', 256) : profile == 12 ? "bad\nvalue" : profile == 14 ? null : "\u9b42\u5929\u795e\u793e\u5185";
            if (name == "game:map") return "Fixture map";
            if (name == "status") return "Fixture status";
            if (name == "version") return "1";
            if (name == "matchgrouploc") return "Fixture room";
            if (name == GroupSizeKey) return profile == 20 ? "03" : profile == 21 ? "2147483647" : profile == 22 ? "0" : profile == 23 ? " 3" : "3";
            throw new Failure("NATIVE_PRIVATE_VALUE_READ");
        }
        public bool Set(string key, string value) { if (key == GroupSizeKey) RequireExistingGroup(this, Guard); calls++; return rejectAt == 0 || calls != rejectAt; }
        public void Dispose() { }
    }
#endif

    public static int Main(string[] args)
    {
        output = new StreamWriter(Console.OpenStandardOutput(), Utf8); output.AutoFlush = true;
#if NATIVE_PRESENCE_TEST
        if (args.Length == 2 && args[0] == "--test-cleanup")
        {
            List<string> calls = new List<string>();
            bool constructionFailed = false;
            NativePresence fixture = null;
            try { fixture = new NativePresence(args[1], calls); }
            catch (Failure) { constructionFailed = true; }
            if (fixture != null) fixture.Dispose();
            int first = calls.Count;
            if (fixture != null) fixture.Dispose();
            output.WriteLine("{\"fixtureCalls\":" + first.ToString(CultureInfo.InvariantCulture)
                + ",\"afterSecondDisposeCalls\":" + calls.Count.ToString(CultureInfo.InvariantCulture)
                + ",\"constructionFailed\":" + (constructionFailed ? "true" : "false") + ",\"fixtureOrder\":["
                + String.Join(",", calls.ConvertAll(delegate(string name) { return Quote(name); }).ToArray()) + "]}");
            return 0;
        }
        if (args.Length == 2 && args[0] == "--test-interface-profile")
        {
            HashSet<string> exports = new HashSet<string>(StringComparer.Ordinal);
            string profile = args[1];
            string[] families = profile == "mahjong" ? new string[] { "SteamFriends_v018", "SteamUser_v023", "SteamUtils_v010" }
                : profile == "legacy020" ? new string[] { "SteamFriends_v017", "SteamUser_v020", "SteamUtils_v009" }
                : profile == "legacy022" ? new string[] { "SteamFriends_v018", "SteamUser_v022", "SteamUtils_v010" }
                : new string[] { "SteamFriends_v017", "SteamUser_v021", "SteamUtils_v010" };
            foreach (string family in families) exports.Add("SteamAPI_" + family);
            if (profile == "none") exports.Clear();
            if (profile.StartsWith("missing-", StringComparison.Ordinal) || profile.StartsWith("unknown-", StringComparison.Ordinal))
            {
                string family = profile.EndsWith("friends", StringComparison.Ordinal) ? "SteamFriends" : profile.EndsWith("user", StringComparison.Ordinal) ? "SteamUser" : "SteamUtils";
                exports.RemoveWhere(delegate(string name) { return name.StartsWith("SteamAPI_" + family + "_v", StringComparison.Ordinal); });
                if (profile.StartsWith("unknown-", StringComparison.Ordinal)) exports.Add("SteamAPI_" + family + "_v999");
            }
            if (profile == "multiple-friends") exports.Add("SteamAPI_SteamFriends_v018");
            if (profile == "multiple-user") exports.Add("SteamAPI_SteamUser_v023");
            if (profile == "multiple-utils") exports.Add("SteamAPI_SteamUtils_v009");
            if (profile == "known-unknown-friends") exports.Add("SteamAPI_SteamFriends_v019");
            if (profile == "known-unknown-user") exports.Add("SteamAPI_SteamUser_v024");
            if (profile == "known-unknown-utils") exports.Add("SteamAPI_SteamUtils_v011");
            List<string> requested = new List<string>();
            InterfaceSelection selection = null;
            try
            {
                selection = SelectInterfaces(exports.Contains);
                foreach (string version in new string[] { selection.Friends, selection.User, selection.Utils })
                    RequireSelectedInterface(version, delegate(string name) { requested.Add(name); return profile == "rejected-friends" && name == selection.Friends ? IntPtr.Zero : new IntPtr(1); });
                output.Write("{\"ok\":true,\"selectedInterfaces\":" + InterfaceSelectionJson(selection));
            }
            catch (Failure failure) { output.Write("{\"ok\":false,\"code\":" + Quote(failure.Code)); }
            output.Write(",\"requested\":[");
            for (int i = 0; i < requested.Count; i++) { if (i > 0) output.Write(','); output.Write(Quote(requested[i])); }
            output.WriteLine("]}"); return 0;
        }
        if (args.Length == 5 && args[0] == "--test-registry-identity")
        {
            object activePid = args[3] == "missing" ? null : args[3] == "wrong-type" ? (object)1L : (object)Int32.Parse(args[3], CultureInfo.InvariantCulture);
            object activeUser = args[4] == "missing" ? null : args[4] == "wrong-type" ? (object)1L : (object)Int32.Parse(args[4], CultureInfo.InvariantCulture);
            int result = Binding.RegistryIdentityState(activePid, activeUser, Int32.Parse(args[1], CultureInfo.InvariantCulture), UInt64.Parse(args[2], CultureInfo.InvariantCulture));
            output.WriteLine("{\"identityCode\":" + result.ToString(CultureInfo.InvariantCulture) + "}");
            return 0;
        }
        if (args.Length == 3 && args[0] == "--test-input-once")
        {
            Input fixtureInput = new Input();
            fixtureInput.Closed = args[2] == "closed"; fixtureInput.Invalid = args[2] == "invalid";
            using (FakePresence fake = new FakePresence(0, 0)) Handle(args[1], new SessionPresence(fake, fixtureInput), new HashSet<string>());
            return 0;
        }
        if ((args.Length == 4 || args.Length == 5) && args[0] == "--test-once")
        {
            using (FakePresence fake = new FakePresence(Int32.Parse(args[2], CultureInfo.InvariantCulture), Int32.Parse(args[3], CultureInfo.InvariantCulture), args.Length == 5 ? Int32.Parse(args[4], CultureInfo.InvariantCulture) : 0)) Handle(args[1], fake, new HashSet<string>());
            return 0;
        }
        if (args.Length == 1 && args[0] == "--test-loop") { using (FakePresence fake = new FakePresence(0, 0)) Loop(fake, StartInput()); return 0; }
        if (args.Length == 1 && args[0] == "--test-fixture-child")
        {
            using (Process self = Process.GetCurrentProcess()) output.WriteLine("{\"fixturePid\":" + self.Id.ToString(CultureInfo.InvariantCulture) + ",\"fixtureTicks\":\"" + self.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) + "\"}");
            Thread.Sleep(Timeout.Infinite); return 0;
        }
        if (args.Length == 3 && (args[0] == "--test-watchdog-parent" || args[0] == "--test-watchdog-game" || args[0] == "--test-watchdog-steam" || args[0] == "--test-watchdog-steam-image"))
        {
            Binding fixture = new Binding();
            using (Process self = Process.GetCurrentProcess())
            {
                int other = Int32.Parse(args[1], CultureInfo.InvariantCulture);
                long ticks = Int64.Parse(args[2], CultureInfo.InvariantCulture);
                fixture.ParentPid = args[0] == "--test-watchdog-parent" ? other : self.Id;
                fixture.ParentTicks = args[0] == "--test-watchdog-parent" ? ticks : self.StartTime.ToUniversalTime().Ticks;
                fixture.GamePid = args[0] == "--test-watchdog-game" ? other : self.Id;
                fixture.GameTicks = args[0] == "--test-watchdog-game" ? ticks : self.StartTime.ToUniversalTime().Ticks;
                bool steamFixture = args[0] == "--test-watchdog-steam" || args[0] == "--test-watchdog-steam-image";
                fixture.SteamPid = steamFixture ? other : self.Id;
                fixture.SteamTicks = steamFixture ? ticks : self.StartTime.ToUniversalTime().Ticks;
                fixture.GameImage = ProcessImage(fixture.GamePid);
                fixture.SteamImage = ProcessImage(fixture.SteamPid);
                if (args[0] == "--test-watchdog-steam-image") fixture.SteamImage += ".mismatch";
            }
            using (LivenessWatchdog watchdog = new LivenessWatchdog(fixture.LivenessCode))
            {
                Reply("startup", "ready", true, null, new List<string>(), false, null);
                Thread.Sleep(Timeout.Infinite);
            }
            return 0;
        }
        if (args.Length == 1 && args[0] == "--test-watchdog-eof")
        {
            Input fixtureInput = StartInput();
            using (LivenessWatchdog watchdog = new LivenessWatchdog(delegate { return fixtureInput.Invalid ? 72 : fixtureInput.Closed ? 71 : 0; }))
            {
                Reply("startup", "ready", true, null, new List<string>(), false, null);
                Thread.Sleep(Timeout.Infinite);
            }
            return 0;
        }
        if (args.Length == 1 && args[0] == "--test-watchdog-unavailable")
        {
            using (LivenessWatchdog watchdog = new LivenessWatchdog(delegate { return 73; }))
            {
                Reply("startup", "ready", true, null, new List<string>(), false, null);
                Thread.Sleep(Timeout.Infinite);
            }
            return 0;
        }
#endif
        IntPtr nullOutput = IntPtr.Zero;
        try
        {
            // Native SDK diagnostics must never share the owned JSONL output pipe.
            nullOutput = CreateFileW("NUL", 0x40000000u, 3, IntPtr.Zero, 3, 0x80, IntPtr.Zero);
            if (nullOutput == IntPtr.Zero || nullOutput == new IntPtr(-1) || !SetStdHandle(-11, nullOutput) || !SetStdHandle(-12, nullOutput)) throw new Failure("NATIVE_INTERNAL_ERROR");
            Binding binding = Binding.Parse(args);
            Input input = StartInput();
            using (LivenessWatchdog watchdog = new LivenessWatchdog(delegate { int code = binding.ContextCode(); return code != 0 ? code : input.Invalid ? 72 : !input.OwnerAvailable() ? 71 : 0; }))
            using (IPresence api = binding.PublicClient ? (IPresence)new PublicClientPresence(binding) : new NativePresence(binding)) Loop(api, input);
            return 0;
        }
        catch (Failure failure) { Reply("startup", "error", false, failure.Code, new List<string>(), false, null); return 2; }
        catch { Reply("startup", "error", false, "NATIVE_INTERNAL_ERROR", new List<string>(), false, null); return 2; }
        finally { if (nullOutput != IntPtr.Zero && nullOutput != new IntPtr(-1)) CloseHandle(nullOutput); }
    }
}
