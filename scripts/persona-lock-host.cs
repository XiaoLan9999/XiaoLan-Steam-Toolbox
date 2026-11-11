using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class PersonaLockHost
{
    internal const int MaximumLineBytes = 4096;
    internal const long IdleTimeoutMilliseconds = 30000;
    internal const long StateReadbackTimeoutMilliseconds = 2000;
    internal const int StateReadbackPollMilliseconds = 50;
    // Exact 11.15.70.27 image; no nearest-version fallback. SteamFriends002 setter wrapper SHA-256:
    // 237ff28dee197f0be0edd174f221f801eecdcfeb621002b1ab8284951a0fda60 (RVA 0x723460, 11 bytes).
    private const string SupportedHash = "253e0a11a4415b38c78a42f7bdd6ecc426455f06c1ba6453a48090df3142dbbc";
    private const ulong SteamIdBase = 76561197960265728UL;
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    internal sealed class Failure : Exception { internal readonly string Code; internal Failure(string code) { Code = code; } }
    private static void Require(bool value, string code) { if (!value) throw new Failure(code); }
    private static string ErrorCode(Exception error) { Failure failure = error as Failure; return failure == null ? "PERSONA_INTERNAL_ERROR" : failure.Code; }
    internal interface ISession : IDisposable
    {
        string SteamId { get; }
        int SteamPid { get; }
        string SteamStartTicks { get; }
        bool? Restored { get; set; }
        void CheckOwner();
        int ReadState();
        void SetState(int state);
    }
    internal sealed class Lease
    {
        private readonly ISession session;
        internal int CurrentState;
        internal int? OriginalState;
        internal bool Locked;
        internal bool? Restored;
        internal Lease(ISession session) { this.session = session; Read(); }
        internal int Read()
        {
            session.CheckOwner(); CurrentState = session.ReadState(); session.CheckOwner();
            Require(CurrentState >= 0 && CurrentState <= 7, "PERSONA_STATE_INVALID");
            if (Locked && (CurrentState == 0 || CurrentState == 7))
            {
                Locked = false; OriginalState = null; Restored = false;
            }
            return CurrentState;
        }
        internal void Lock()
        {
            Read();
            if (CurrentState == 0 || CurrentState == 7) { Locked = false; OriginalState = null; Restored = false; return; }
            if (!Locked) { OriginalState = CurrentState; Locked = true; }
            Restored = null;
            if (CurrentState != 4)
            {
                session.SetState(4);
                bool matched = WaitForState(4);
                if (CurrentState == 0 || CurrentState == 7) return;
                Require(matched, "PERSONA_SET_REJECTED");
            }
        }
        private bool WaitForState(int expected)
        {
            Stopwatch clock = Stopwatch.StartNew();
            bool first = true;
            for (;;)
            {
                if (!first && clock.ElapsedMilliseconds >= StateReadbackTimeoutMilliseconds) return false;
                first = false;
                Read();
                if (CurrentState == 0 || CurrentState == 7) { Locked = false; OriginalState = null; Restored = false; return false; }
                if (CurrentState == expected) return true;
                long remaining = StateReadbackTimeoutMilliseconds - clock.ElapsedMilliseconds;
                if (remaining <= 0) return false;
                Thread.Sleep((int)Math.Min(StateReadbackPollMilliseconds, remaining));
            }
        }
        internal void Unlock()
        {
            bool wasLocked = Locked; int? original = OriginalState;
            try
            {
                Read(); if (wasLocked) Restored = false;
                if (wasLocked && original.HasValue && CurrentState == 4 && original.Value != 0 && original.Value != 7)
                {
                    if (original.Value != 4) { session.SetState(original.Value); Restored = WaitForState(original.Value); }
                    else Restored = true;
                    if (CurrentState == 0 || CurrentState == 7) { Restored = false; return; }
                    Require(Restored == true, "PERSONA_RESTORE_REJECTED");
                }
            }
            finally { Locked = false; OriginalState = null; }
        }
        internal bool? Close()
        {
            if (!Locked) return Restored;
            try { Unlock(); return Restored; }
            catch { Locked = false; OriginalState = null; Restored = false; return false; }
        }
        internal Dictionary<string, object> Fields()
        {
            return new Dictionary<string, object> { { "currentState", CurrentState }, { "originalState", OriginalState }, { "locked", Locked }, { "restored", Restored } };
        }
    }
    private sealed class Frame { internal string Line, Error; internal bool End; }
    private static string ReadBoundedLine(TextReader input)
    {
        StringBuilder value = new StringBuilder();
        for (;;)
        {
            int next = input.Read();
            if (next < 0) return value.Length == 0 ? null : value.ToString();
            if (next == '\n') return value.ToString().TrimEnd('\r');
            Require(value.Length < MaximumLineBytes, "PERSONA_FRAME_TOO_LARGE"); value.Append((char)next);
        }
    }
    internal static void Emit(TextWriter output, string op, string requestId, Dictionary<string, object> fields)
    {
        Dictionary<string, object> frame = new Dictionary<string, object> { { "v", 1 }, { "op", op } };
        if (requestId != null) frame.Add("requestId", requestId);
        if (fields != null) foreach (KeyValuePair<string, object> item in fields) frame.Add(item.Key, item.Value);
        output.WriteLine(new JavaScriptSerializer().Serialize(frame)); output.Flush();
    }
    internal static int Run(TextReader input, TextWriter output, ISession session, long idleTimeout, int pollMs)
    {
        Lease lease = null;
        try
        {
            lease = new Lease(session);
            Dictionary<string, object> ready = lease.Fields(); ready.Remove("restored");
            ready.Add("steamId", session.SteamId); ready.Add("steamPid", session.SteamPid); ready.Add("steamStartTicks", session.SteamStartTicks);
            Emit(output, "ready", null, ready);
            BlockingCollection<Frame> frames = new BlockingCollection<Frame>(2);
            Thread reader = new Thread(delegate()
            {
                try { for (;;) { string line = ReadBoundedLine(input); frames.Add(new Frame { Line = line, End = line == null }); if (line == null) return; } }
                catch (Exception error) { try { frames.Add(new Frame { Error = ErrorCode(error) }); } catch { } }
            });
            reader.IsBackground = true; reader.Start(); Stopwatch clock = Stopwatch.StartNew(); long lastCompleted = 0;
            JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = MaximumLineBytes, RecursionLimit = 3 };
            for (;;)
            {
                session.CheckOwner(); Frame frame;
                if (!frames.TryTake(out frame, pollMs)) { if (clock.ElapsedMilliseconds - lastCompleted >= idleTimeout) return 0; continue; }
                if (frame.End) return 0;
                if (frame.Error != null) throw new Failure(frame.Error);
                string requestId = null;
                try
                {
                    Require(Utf8.GetByteCount(frame.Line) <= MaximumLineBytes, "PERSONA_FRAME_TOO_LARGE");
                    Dictionary<string, object> value = json.DeserializeObject(frame.Line) as Dictionary<string, object>;
                    Require(value != null && value.Count == 3 && value.ContainsKey("v") && value["v"] is int && (int)value["v"] == 1
                        && value.ContainsKey("requestId") && value["requestId"] is string && value.ContainsKey("op") && value["op"] is string, "PERSONA_PROTOCOL_INVALID");
                    requestId = (string)value["requestId"]; Guid id;
                    Require(Guid.TryParseExact(requestId, "D", out id) && id.ToString("D") == requestId, "PERSONA_PROTOCOL_INVALID");
                    string op = (string)value["op"];
                    if (op == "lock") lease.Lock();
                    else if (op == "read") lease.Read();
                    else if (op == "unlock" || op == "stop") lease.Unlock();
                    else throw new Failure("PERSONA_PROTOCOL_INVALID");
                    Emit(output, "result", requestId, lease.Fields()); lastCompleted = clock.ElapsedMilliseconds;
                    if (op == "stop") return 0;
                }
                catch (Exception error)
                {
                    Dictionary<string, object> failure = lease.Fields(); failure.Add("code", ErrorCode(error));
                    Emit(output, "error", requestId, failure); return 1;
                }
            }
        }
        catch (Exception error) { Emit(output, "error", null, new Dictionary<string, object> { { "code", ErrorCode(error) } }); return 1; }
        finally
        {
            session.Restored = lease == null ? null : lease.Close();
            session.Dispose();
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr LoadLibraryExW(string path, IntPtr reserved, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, ExactSpelling = true)] private static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr process);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr Factory(IntPtr version, IntPtr code);
    [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate int CreatePipe(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.ThisCall)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool ReleasePipe(IntPtr self, int pipe);
    [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate int ConnectUser(IntPtr self, int pipe);
    [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate void ReleaseUser(IntPtr self, int pipe, int user);
    [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate IntPtr UserInterface(IntPtr self, int user, int pipe, IntPtr version);
    [UnmanagedFunctionPointer(CallingConvention.ThisCall)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool LoggedOn(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate IntPtr SteamId(IntPtr self, IntPtr result);
    [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate int GetState(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate void SetState(IntPtr self, int state);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void ReleaseThreadMemory([MarshalAs(UnmanagedType.I1)] bool threadExit);
    private sealed class CString : IDisposable
    {
        internal readonly IntPtr Value;
        internal CString(string text) { byte[] bytes = Utf8.GetBytes(text + "\0"); Value = Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes, 0, Value, bytes.Length); }
        public void Dispose() { Marshal.FreeHGlobal(Value); }
    }
    private static string RegularPath(string value)
    {
        Require(value != null && Path.IsPathRooted(value) && !value.StartsWith(@"\\", StringComparison.Ordinal) && value.IndexOf('\0') < 0, "PERSONA_UNSAFE_PATH");
        string full = Path.GetFullPath(value);
        Require(File.Exists(full) && (File.GetAttributes(full) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) == 0, "PERSONA_UNSAFE_PATH");
        for (string parent = Path.GetDirectoryName(full); parent != null; parent = Path.GetDirectoryName(parent))
            Require((File.GetAttributes(parent) & FileAttributes.ReparsePoint) == 0, "PERSONA_UNSAFE_PATH");
        return full;
    }
    private static string Hash(Stream input) { using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").ToLowerInvariant(); }
    private static void ProcessMatches(int pid, long ticks, string image)
    {
        try
        {
            using (Process process = Process.GetProcessById(pid)) Require(!process.HasExited && process.StartTime.ToUniversalTime().Ticks == ticks, "PERSONA_CONTEXT_CHANGED");
            if (image == null) return;
            IntPtr handle = OpenProcess(0x1000u, false, pid); Require(handle != IntPtr.Zero, "PERSONA_CONTEXT_UNAVAILABLE");
            try { StringBuilder name = new StringBuilder(32768); int size = name.Capacity; Require(QueryFullProcessImageNameW(handle, 0, name, ref size), "PERSONA_CONTEXT_UNAVAILABLE"); Require(String.Equals(Path.GetFullPath(name.ToString()), image, StringComparison.OrdinalIgnoreCase), "PERSONA_CONTEXT_CHANGED"); }
            finally { CloseHandle(handle); }
        }
        catch (Failure) { throw; }
        catch { throw new Failure("PERSONA_CONTEXT_UNAVAILABLE"); }
    }
    private sealed class Binding
    {
        internal string Dll, SteamExe; internal int SteamPid, OwnerPid; internal long SteamTicks, OwnerTicks; internal ulong Expected;
        internal static Binding Parse(string[] args)
        {
            Require(IntPtr.Size == 8 && args.Length == 8 && args[0] == "--persona-session", "PERSONA_ARGUMENTS_INVALID");
            Binding b = new Binding(); b.Dll = RegularPath(args[1]);
            Require(String.Equals(Path.GetFileName(b.Dll), "steamclient64.dll", StringComparison.OrdinalIgnoreCase) && args[2] == SupportedHash, "PERSONA_DLL_UNSUPPORTED");
            Require(Int32.TryParse(args[3], NumberStyles.None, CultureInfo.InvariantCulture, out b.SteamPid) && b.SteamPid > 0 && Int64.TryParse(args[4], NumberStyles.None, CultureInfo.InvariantCulture, out b.SteamTicks) && b.SteamTicks > 0, "PERSONA_ARGUMENTS_INVALID");
            Require(Int32.TryParse(args[5], NumberStyles.None, CultureInfo.InvariantCulture, out b.OwnerPid) && b.OwnerPid > 0 && Int64.TryParse(args[6], NumberStyles.None, CultureInfo.InvariantCulture, out b.OwnerTicks) && b.OwnerTicks > 0, "PERSONA_ARGUMENTS_INVALID");
            Require(UInt64.TryParse(args[7], NumberStyles.None, CultureInfo.InvariantCulture, out b.Expected) && b.Expected > SteamIdBase && b.Expected - SteamIdBase <= UInt32.MaxValue, "PERSONA_ARGUMENTS_INVALID");
            b.SteamExe = RegularPath(Path.Combine(Path.GetDirectoryName(b.Dll), "steam.exe"));
            using (Process current = Process.GetCurrentProcess()) Require(b.OwnerPid != b.SteamPid && b.OwnerPid != current.Id && b.SteamPid != current.Id, "PERSONA_ARGUMENTS_INVALID");
            b.Check(); return b;
        }
        internal void Check() { ProcessMatches(OwnerPid, OwnerTicks, null); ProcessMatches(SteamPid, SteamTicks, SteamExe); }
    }
    private sealed class NativeSession : ISession
    {
        private readonly Binding binding; private readonly TextWriter output;
        private IntPtr module, client, user, friends; private int pipe, ownUser; private FileStream library;
        private ReleaseUser releaseUser; private ReleasePipe releasePipe; private ReleaseThreadMemory releaseThread;
        internal NativeSession(Binding binding, TextWriter output)
        {
            this.binding = binding; this.output = output;
            try
            {
                binding.Check(); library = new FileStream(binding.Dll, FileMode.Open, FileAccess.Read, FileShare.Read);
                Require(library.Length >= 256 && library.Length <= 64L * 1024 * 1024 && Hash(library) == SupportedHash, "PERSONA_DLL_UNSUPPORTED");
                Environment.SetEnvironmentVariable("SteamAppId", "0", EnvironmentVariableTarget.Process);
                Environment.SetEnvironmentVariable("SteamGameId", "0", EnvironmentVariableTarget.Process);
                binding.Check(); module = LoadLibraryExW(binding.Dll, IntPtr.Zero, 0x1100); Require(module != IntPtr.Zero, "PERSONA_LOAD_FAILED");
                IntPtr factoryPointer = GetProcAddress(module, "CreateInterface"); Require(factoryPointer == Address(0xcfb860), "PERSONA_EXPORT_UNSUPPORTED");
                Factory factory = Marshal.GetDelegateForFunctionPointer(factoryPointer, typeof(Factory)) as Factory;
                using (CString version = new CString("SteamClient021")) client = factory(version.Value, IntPtr.Zero);
                releaseUser = Method<ReleaseUser>(client, 0x130c7d8, 4, 0x720050); releasePipe = Method<ReleasePipe>(client, 0x130c7d8, 1, 0x720360);
                IntPtr cleanup = GetProcAddress(module, "Steam_ReleaseThreadLocalMemory"); Require(cleanup == Address(0x984db0), "PERSONA_EXPORT_UNSUPPORTED");
                releaseThread = Marshal.GetDelegateForFunctionPointer(cleanup, typeof(ReleaseThreadMemory)) as ReleaseThreadMemory;
                binding.Check(); pipe = Method<CreatePipe>(client, 0x130c7d8, 0, 0x5162f0)(client); Require(pipe > 0, "PERSONA_PIPE_FAILED");
                binding.Check(); ownUser = Method<ConnectUser>(client, 0x130c7d8, 2, 0x720000)(client, pipe); Require(ownUser > 0, "PERSONA_CONNECT_FAILED");
                using (CString version = new CString("SteamUser023")) user = Method<UserInterface>(client, 0x130c7d8, 5, 0x720090)(client, ownUser, pipe, version.Value);
                using (CString version = new CString("SteamFriends002")) friends = Method<UserInterface>(client, 0x130c7d8, 8, 0x720130)(client, ownUser, pipe, version.Value);
                CheckIdentity(); Method<GetState>(friends, 0x130d468, 2, 0x71e610); Method<SetState>(friends, 0x130d468, 3, 0x723460);
            }
            catch { Dispose(); throw; }
        }
        private IntPtr Address(int rva) { return new IntPtr(module.ToInt64() + rva); }
        private T Method<T>(IntPtr instance, int table, int slot, int function) where T : class
        {
            Require(module != IntPtr.Zero && instance != IntPtr.Zero && Marshal.ReadIntPtr(instance) == Address(table), "PERSONA_INTERFACE_UNSUPPORTED");
            IntPtr pointer = Marshal.ReadIntPtr(Address(table), slot * IntPtr.Size); Require(pointer == Address(function), "PERSONA_METHOD_UNSUPPORTED");
            return Marshal.GetDelegateForFunctionPointer(pointer, typeof(T)) as T;
        }
        public string SteamId { get { return binding.Expected.ToString(CultureInfo.InvariantCulture); } }
        public int SteamPid { get { return binding.SteamPid; } }
        public string SteamStartTicks { get { return binding.SteamTicks.ToString(CultureInfo.InvariantCulture); } }
        public bool? Restored { get; set; }
        public void CheckOwner() { binding.Check(); }
        private void CheckIdentity()
        {
            binding.Check(); Require(Method<LoggedOn>(user, 0x1319808, 1, 0x71e610)(user), "PERSONA_NOT_LOGGED_ON");
            IntPtr result = Marshal.AllocHGlobal(8);
            try { Marshal.WriteInt64(result, 0); Require(Method<SteamId>(user, 0x1319808, 2, 0x722c80)(user, result) == result && unchecked((ulong)Marshal.ReadInt64(result)) == binding.Expected, "PERSONA_IDENTITY_MISMATCH"); }
            finally { Marshal.FreeHGlobal(result); }
            binding.Check();
        }
        public int ReadState() { CheckIdentity(); int state = Method<GetState>(friends, 0x130d468, 2, 0x71e610)(friends); CheckIdentity(); return state; }
        public void SetState(int state)
        {
            Require(state >= 1 && state <= 6, "PERSONA_STATE_INVALID"); CheckIdentity();
            // ValveSoftware/Proton proton_11.0/lsteamclient/cppISteamFriends_SteamFriends002.cpp preserves this setter.
            // The exact local factory, vtable and forwarding proof is in out/persona-native-rtti-static.json.
            Method<SetState>(friends, 0x130d468, 3, 0x723460)(friends, state); CheckIdentity();
        }
        public void Dispose()
        {
            if (module == IntPtr.Zero) { if (library != null) { library.Dispose(); library = null; } return; }
            bool userOk = true, pipeOk = true, memoryOk = true, libraryOk = true;
            if (client != IntPtr.Zero && pipe > 0 && ownUser > 0 && releaseUser != null) try { releaseUser(client, pipe, ownUser); } catch { userOk = false; }
            ownUser = 0;
            if (client != IntPtr.Zero && pipe > 0 && releasePipe != null) try { pipeOk = releasePipe(client, pipe); } catch { pipeOk = false; }
            pipe = 0;
            if (releaseThread != null) try { releaseThread(false); } catch { memoryOk = false; }
            try { libraryOk = FreeLibrary(module); } catch { libraryOk = false; } module = IntPtr.Zero;
            if (library != null) { library.Dispose(); library = null; }
            Emit(output, "lifecycle", null, new Dictionary<string, object> { { "stage", "cleanup" }, { "userReleased", userOk }, { "pipeReleased", pipeOk }, { "threadMemoryReleased", memoryOk }, { "libraryReleased", libraryOk }, { "restored", Restored } });
        }
    }
    public static int Main(string[] args)
    {
        Console.OutputEncoding = Utf8; Console.InputEncoding = Utf8;
        try { return Run(Console.In, Console.Out, new NativeSession(Binding.Parse(args), Console.Out), IdleTimeoutMilliseconds, 100); }
        catch (Exception error) { Emit(Console.Out, "error", null, new Dictionary<string, object> { { "code", ErrorCode(error) } }); return 1; }
    }
}
