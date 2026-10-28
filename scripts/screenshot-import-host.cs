using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

internal static class ScreenshotImportHost
{
    internal const int MaximumLineBytes = 8192;
    internal const int MaximumBatch = 100;
    internal const long IdleTimeoutMilliseconds = 60000;
    private const string SupportedHash = "253e0a11a4415b38c78a42f7bdd6ecc426455f06c1ba6453a48090df3142dbbc";
    private const ulong SteamIdBase = 76561197960265728UL;
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly Regex RequestId = new Regex("\\A[A-Za-z0-9_-]{1,64}\\z", RegexOptions.CultureInvariant);
    private static readonly Regex HashPattern = new Regex("\\A[0-9a-f]{64}\\z", RegexOptions.CultureInvariant);

    internal sealed class Failure : Exception { internal readonly string Code; internal Failure(string code) { Code = code; } }
    private static void Require(bool value, string code) { if (!value) throw new Failure(code); }
    private static string Code(Exception error) { Failure failure = error as Failure; return failure == null ? "INTERNAL_ERROR" : failure.Code; }
    internal static bool ActivityAllows(uint target, uint runningAppId, IEnumerable<uint> activeAppIds)
    {
        if (target == 0 || target > 0xffffff || target == 480 || (runningAppId != 0 && runningAppId != target) || activeAppIds == null) return false;
        int count = 0;
        foreach (uint app in activeAppIds) { if (++count > 4096 || (app != 0 && app != target)) return false; }
        return true;
    }
    internal sealed class Request { internal string Id, Path, Sha256; internal int Width, Height; }
    internal sealed class Result
    {
        internal string Status, Code;
        internal bool MayHaveSubmitted;
        internal uint? Handle;
        internal int? SteamResult;
        internal Result(string status, bool submitted, uint? handle, int? result, string code) { Status = status; MayHaveSubmitted = submitted; Handle = handle; SteamResult = result; Code = code; }
    }
    internal interface IImportSession : IDisposable
    {
        void CheckOwner();
        Result Add(Request request, Action submitting, Action<uint> submitted);
    }
    internal sealed class Protocol
    {
        private readonly TextWriter writer;
        private readonly Func<long> now;
        private readonly long idleTimeoutMs;
        private readonly int pollMs;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = MaximumLineBytes, RecursionLimit = 8 };
        internal Protocol(TextWriter writer) : this(writer, null, IdleTimeoutMilliseconds, 100) { }
        internal Protocol(TextWriter writer, Func<long> clock, long idleTimeoutMs, int pollMs)
        {
            this.writer = writer; this.idleTimeoutMs = idleTimeoutMs; this.pollMs = pollMs;
            Stopwatch elapsed = Stopwatch.StartNew(); now = clock ?? delegate() { return elapsed.ElapsedMilliseconds; };
        }
        internal void Emit(string op, string id, Dictionary<string, object> fields)
        {
            Dictionary<string, object> value = new Dictionary<string, object>(StringComparer.Ordinal);
            value.Add("v", 1); value.Add("op", op); if (id != null) value.Add("requestId", id);
            if (fields != null) foreach (KeyValuePair<string, object> item in fields) value.Add(item.Key, item.Value);
            writer.WriteLine(json.Serialize(value)); writer.Flush();
        }
        private void EmitResult(string id, Result result)
        {
            Dictionary<string, object> fields = new Dictionary<string, object>();
            fields.Add("status", result.Status); fields.Add("mayHaveSubmitted", result.MayHaveSubmitted);
            if (result.Handle.HasValue) fields.Add("handle", result.Handle.Value);
            if (result.SteamResult.HasValue) fields.Add("result", result.SteamResult.Value);
            if (result.Code != null) fields.Add("code", result.Code);
            Emit("result", id, fields);
        }
        private sealed class Frame { internal string Line, Error; internal bool End; }
        private static string ReadBoundedLine(TextReader input)
        {
            StringBuilder line = new StringBuilder(512);
            for (;;)
            {
                int next = input.Read();
                if (next < 0) return line.Length == 0 ? null : line.ToString();
                if (next == '\n') return line.ToString().TrimEnd('\r');
                Require(line.Length < MaximumLineBytes, "FRAME_TOO_LARGE"); line.Append((char)next);
            }
        }
        private Dictionary<string, object> Parse(string line)
        {
            Require(Utf8.GetByteCount(line) <= MaximumLineBytes, "FRAME_TOO_LARGE");
            Dictionary<string, object> value;
            try { value = json.DeserializeObject(line) as Dictionary<string, object>; }
            catch { throw new Failure("PROTOCOL_INVALID"); }
            Require(value != null && value.ContainsKey("v") && value["v"] is int && (int)value["v"] == 1, "PROTOCOL_INVALID");
            return value;
        }
        private static string Text(Dictionary<string, object> value, string key)
        {
            object item; Require(value.TryGetValue(key, out item) && item is string, "REQUEST_INVALID"); return (string)item;
        }
        private static int Number(Dictionary<string, object> value, string key)
        {
            object item; Require(value.TryGetValue(key, out item) && item is int, "REQUEST_INVALID"); return (int)item;
        }
        private static void Keys(Dictionary<string, object> value, string[] expected)
        {
            Require(value.Count == expected.Length, "REQUEST_INVALID"); foreach (string key in expected) Require(value.ContainsKey(key), "REQUEST_INVALID");
        }
        internal int Run(TextReader input, IImportSession session)
        {
            BlockingCollection<Frame> frames = new BlockingCollection<Frame>(2);
            Thread reader = new Thread(delegate()
            {
                try
                {
                    for (;;)
                    {
                        string line = ReadBoundedLine(input);
                        if (line == null) { frames.Add(new Frame { End = true }); return; }
                        frames.Add(new Frame { Line = line });
                    }
                }
                catch (Exception error) { try { frames.Add(new Frame { Error = Code(error) }); } catch { } }
            });
            reader.IsBackground = true; reader.Start(); int added = 0; long lastCompleted = now();
            try
            {
                while (added < MaximumBatch)
                {
                    session.CheckOwner(); Frame frame;
                    if (!frames.TryTake(out frame, pollMs))
                    {
                        if (now() - lastCompleted >= idleTimeoutMs) { Emit("stopped", null, new Dictionary<string, object> { { "reason", "IDLE_TIMEOUT" } }); return 0; }
                        continue;
                    }
                    if (frame.Error != null) throw new Failure(frame.Error);
                    if (frame.End) { Emit("stopped", null, new Dictionary<string, object> { { "reason", "EOF" } }); return 0; }
                    Dictionary<string, object> value = Parse(frame.Line);
                    string id = Text(value, "requestId"); Require(RequestId.IsMatch(id), "REQUEST_INVALID");
                    string op = Text(value, "op");
                    if (op == "stop") { Keys(value, new string[] { "v", "requestId", "op" }); Emit("stopped", id, null); return 0; }
                    Require(op == "add", "REQUEST_INVALID"); added++; bool attempted = false; uint? handle = null;
                    try
                    {
                        Keys(value, new string[] { "v", "requestId", "op", "path", "width", "height", "sha256" });
                        Request request = new Request { Id = id, Path = Text(value, "path"), Width = Number(value, "width"), Height = Number(value, "height"), Sha256 = Text(value, "sha256") };
                        Require(request.Path.Length > 0 && request.Path.Length < 4096 && request.Path.IndexOf('\0') < 0 && HashPattern.IsMatch(request.Sha256), "REQUEST_INVALID");
                        Require(request.Width > 0 && request.Height > 0 && request.Width <= 16000 && request.Height <= 16000 && (long)request.Width * request.Height <= 26210175, "IMAGE_INVALID");
                        Result result = session.Add(request, delegate() { Emit("submitting", id, null); attempted = true; }, delegate(uint current) { handle = current; Emit("submitted", id, new Dictionary<string, object> { { "handle", current } }); });
                        Require(result != null, "RESULT_INVALID"); EmitResult(id, result);
                    }
                    catch (Exception error) { EmitResult(id, new Result(attempted ? "uncertain" : "rejected", attempted, handle, null, Code(error))); }
                    lastCompleted = now();
                }
                Emit("stopped", null, new Dictionary<string, object> { { "reason", "BATCH_LIMIT" } }); return 0;
            }
            catch (Exception error) { Emit("error", null, new Dictionary<string, object> { { "code", Code(error) } }); return 1; }
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr LoadLibraryExW(string path, IntPtr reserved, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, ExactSpelling = true, SetLastError = true)] private static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
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
    [UnmanagedFunctionPointer(CallingConvention.ThisCall)] private delegate uint AddScreenshot(IntPtr self, IntPtr filename, IntPtr thumbnail, int width, int height);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool NextCallback(int pipe, IntPtr callback);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void FreeCallback(int pipe);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void ReleaseThreadMemory([MarshalAs(UnmanagedType.I1)] bool threadExit);
    private sealed class CString : IDisposable
    {
        internal IntPtr Value;
        internal CString(string value) { byte[] bytes = Utf8.GetBytes(value + "\0"); Value = Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes, 0, Value, bytes.Length); }
        public void Dispose() { if (Value != IntPtr.Zero) { Marshal.FreeHGlobal(Value); Value = IntPtr.Zero; } }
    }
    private static string Hash(Stream file) { using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "").ToLowerInvariant(); }
    private static string Hash(string path) { using (FileStream file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) return Hash(file); }
    private static string SafeDirectory(string value)
    {
        Require(value != null && Path.IsPathRooted(value) && !value.StartsWith(@"\\", StringComparison.Ordinal) && value.IndexOf('\0') < 0, "UNSAFE_PATH");
        string path = Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar); Require(path.Length > 3 && Directory.Exists(path), "UNSAFE_PATH");
        for (string current = path; !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current)) Require((File.GetAttributes(current) & FileAttributes.ReparsePoint) == 0, "UNSAFE_PATH");
        return path;
    }
    private static string RegularPath(string value)
    {
        Require(value != null && Path.IsPathRooted(value) && !value.StartsWith(@"\\", StringComparison.Ordinal) && value.IndexOf('\0') < 0, "UNSAFE_FILE");
        string path = Path.GetFullPath(value); Require(File.Exists(path) && (File.GetAttributes(path) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0, "UNSAFE_FILE");
        SafeDirectory(Path.GetDirectoryName(path)); return path;
    }
    private static void ProcessMatches(int pid, long start, string expectedExe)
    {
        using (Process process = Process.GetProcessById(pid)) Require(!process.HasExited && process.StartTime.ToUniversalTime().Ticks == start, "CONTEXT_CHANGED");
        if (expectedExe == null) return;
        IntPtr handle = OpenProcess(0x1000u, false, pid); Require(handle != IntPtr.Zero, "CONTEXT_UNAVAILABLE");
        try { StringBuilder image = new StringBuilder(32768); int length = image.Capacity; Require(QueryFullProcessImageNameW(handle, 0, image, ref length), "CONTEXT_UNAVAILABLE"); Require(String.Equals(Path.GetFullPath(image.ToString()), expectedExe, StringComparison.OrdinalIgnoreCase), "CONTEXT_CHANGED"); }
        finally { CloseHandle(handle); }
    }
    private sealed class Binding
    {
        internal string Dll, SteamExe, StagingRoot;
        internal int SteamPid, OwnerPid;
        internal long SteamStart, OwnerStart;
        internal uint Target;
        internal ulong Expected;
        internal static Binding Parse(string[] args)
        {
            Require(IntPtr.Size == 8 && args.Length == 9, "ARGUMENTS_INVALID"); Binding b = new Binding();
            b.Dll = RegularPath(args[0]); Require(String.Equals(Path.GetFileName(b.Dll), "steamclient64.dll", StringComparison.OrdinalIgnoreCase) && args[1] == SupportedHash && Hash(b.Dll) == SupportedHash, "DLL_UNSUPPORTED");
            b.SteamExe = RegularPath(Path.Combine(Path.GetDirectoryName(b.Dll), "steam.exe"));
            Require(Int32.TryParse(args[2], NumberStyles.None, CultureInfo.InvariantCulture, out b.SteamPid) && b.SteamPid > 0 && Int64.TryParse(args[3], NumberStyles.None, CultureInfo.InvariantCulture, out b.SteamStart) && b.SteamStart > 0, "ARGUMENTS_INVALID");
            Require(UInt32.TryParse(args[4], NumberStyles.None, CultureInfo.InvariantCulture, out b.Target) && b.Target > 0 && b.Target <= 0xffffff && b.Target != 480, "ARGUMENTS_INVALID");
            Require(UInt64.TryParse(args[5], NumberStyles.None, CultureInfo.InvariantCulture, out b.Expected) && b.Expected > SteamIdBase && b.Expected - SteamIdBase <= UInt32.MaxValue, "ARGUMENTS_INVALID");
            Require(Int32.TryParse(args[6], NumberStyles.None, CultureInfo.InvariantCulture, out b.OwnerPid) && b.OwnerPid > 0 && Int64.TryParse(args[7], NumberStyles.None, CultureInfo.InvariantCulture, out b.OwnerStart) && b.OwnerStart > 0, "ARGUMENTS_INVALID");
            using (Process self = Process.GetCurrentProcess()) Require(b.OwnerPid != b.SteamPid && b.OwnerPid != self.Id && b.SteamPid != self.Id, "ARGUMENTS_INVALID");
            b.StagingRoot = SafeDirectory(args[8]); b.Check(); return b;
        }
        internal static Binding ParseIdentity(string[] args)
        {
            Require(IntPtr.Size == 8 && args.Length == 7 && args[0] == "--read-current-user", "ARGUMENTS_INVALID");
            Binding b = new Binding(); b.Dll = RegularPath(args[1]);
            Require(String.Equals(Path.GetFileName(b.Dll), "steamclient64.dll", StringComparison.OrdinalIgnoreCase) && args[2] == SupportedHash && Hash(b.Dll) == SupportedHash, "DLL_UNSUPPORTED");
            b.SteamExe = RegularPath(Path.Combine(Path.GetDirectoryName(b.Dll), "steam.exe"));
            Require(Int32.TryParse(args[3], NumberStyles.None, CultureInfo.InvariantCulture, out b.SteamPid) && b.SteamPid > 0 && Int64.TryParse(args[4], NumberStyles.None, CultureInfo.InvariantCulture, out b.SteamStart) && b.SteamStart > 0, "ARGUMENTS_INVALID");
            Require(Int32.TryParse(args[5], NumberStyles.None, CultureInfo.InvariantCulture, out b.OwnerPid) && b.OwnerPid > 0 && Int64.TryParse(args[6], NumberStyles.None, CultureInfo.InvariantCulture, out b.OwnerStart) && b.OwnerStart > 0, "ARGUMENTS_INVALID");
            using (Process self = Process.GetCurrentProcess()) Require(b.OwnerPid != b.SteamPid && b.OwnerPid != self.Id && b.SteamPid != self.Id, "ARGUMENTS_INVALID");
            b.Check(); return b;
        }
        internal void Check() { ProcessMatches(OwnerPid, OwnerStart, null); ProcessMatches(SteamPid, SteamStart, SteamExe); }
        private static uint ActivityNumber(object value)
        {
            if (value == null) return 0;
            if (value is int) return unchecked((uint)(int)value);
            if (value is uint) return (uint)value;
            if (value is long && (long)value >= 0 && (long)value <= UInt32.MaxValue) return (uint)(long)value;
            throw new Failure("ACTIVITY_UNAVAILABLE");
        }
        internal void CheckActivity()
        {
            try
            {
                uint running; List<uint> active = new List<uint>();
                using (RegistryKey steam = Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam", false))
                {
                    Require(steam != null, "ACTIVITY_UNAVAILABLE"); running = ActivityNumber(steam.GetValue("RunningAppID", null, RegistryValueOptions.DoNotExpandEnvironmentNames));
                }
                using (RegistryKey apps = Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam\Apps", false))
                {
                    if (apps != null)
                    {
                        string[] names = apps.GetSubKeyNames(); Require(names.Length <= 4096, "ACTIVITY_UNAVAILABLE");
                        foreach (string name in names)
                        using (RegistryKey app = apps.OpenSubKey(name, false))
                        {
                            Require(app != null, "ACTIVITY_UNAVAILABLE");
                            if (ActivityNumber(app.GetValue("Running", null, RegistryValueOptions.DoNotExpandEnvironmentNames)) == 0) continue;
                            uint id; Require(UInt32.TryParse(name, NumberStyles.None, CultureInfo.InvariantCulture, out id), "ACTIVITY_UNAVAILABLE"); active.Add(id);
                        }
                    }
                }
                Require(ActivityAllows(Target, running, active), "GAME_ACTIVE");
            }
            catch (Failure) { throw; }
            catch { throw new Failure("ACTIVITY_UNAVAILABLE"); }
        }
        internal void ValidateDll() { Require(RegularPath(Dll) == Dll && Hash(Dll) == SupportedHash, "DLL_CHANGED"); }
    }
    internal interface IIdentitySession : IDisposable
    {
        ulong Read();
        int SteamPid { get; }
        string SteamStartTicks { get; }
    }
    internal static int RunIdentity(IIdentitySession session, Protocol output)
    {
        using (session)
        {
            ulong first = session.Read(); ulong second = session.Read();
            Require(first == second && first > SteamIdBase && first - SteamIdBase <= UInt32.MaxValue, "IDENTITY_MISMATCH");
            output.Emit("identity", null, new Dictionary<string, object> { { "protocol", 1 }, { "readOnly", true }, { "steamId", first.ToString(CultureInfo.InvariantCulture) }, { "steamPid", session.SteamPid }, { "steamStartTicks", session.SteamStartTicks } });
        }
        return 0;
    }
    private sealed class NativeIdentity : IIdentitySession
    {
        private readonly Binding binding;
        private readonly Protocol output;
        private IntPtr module, client, user;
        private int pipe, userHandle;
        private ReleaseUser releaseUser;
        private ReleasePipe releasePipe;
        private ReleaseThreadMemory releaseThread;
        private LoggedOn loggedOn;
        private SteamId steamId;
        internal NativeIdentity(Binding b, Protocol output)
        {
            binding = b; this.output = output;
            try
            {
                b.Check(); b.ValidateDll();
                Environment.SetEnvironmentVariable("SteamAppId", "0", EnvironmentVariableTarget.Process);
                Environment.SetEnvironmentVariable("SteamGameId", "0", EnvironmentVariableTarget.Process);
                module = LoadLibraryExW(b.Dll, IntPtr.Zero, 8u); Require(module != IntPtr.Zero, "LOAD_FAILED"); b.Check(); b.ValidateDll();
                IntPtr factoryAddress = GetProcAddress(module, "CreateInterface"); Require(factoryAddress != IntPtr.Zero, "EXPORT_UNSUPPORTED");
                Factory factory = Marshal.GetDelegateForFunctionPointer(factoryAddress, typeof(Factory)) as Factory;
                using (CString version = new CString("SteamClient021")) client = factory(version.Value, IntPtr.Zero);
                releaseUser = Method<ReleaseUser>(client, 0x130c7d8, 4, 0x720050); releasePipe = Method<ReleasePipe>(client, 0x130c7d8, 1, 0x720360);
                IntPtr cleanup = GetProcAddress(module, "Steam_ReleaseThreadLocalMemory"); Require(cleanup == Address(0x984db0), "EXPORT_UNSUPPORTED");
                releaseThread = Marshal.GetDelegateForFunctionPointer(cleanup, typeof(ReleaseThreadMemory)) as ReleaseThreadMemory;
                b.Check(); pipe = Method<CreatePipe>(client, 0x130c7d8, 0, 0x5162f0)(client); Require(pipe > 0, "PIPE_FAILED");
                b.Check(); userHandle = Method<ConnectUser>(client, 0x130c7d8, 2, 0x720000)(client, pipe); Require(userHandle > 0, "CONNECT_FAILED");
                using (CString version = new CString("SteamUser023")) user = Method<UserInterface>(client, 0x130c7d8, 5, 0x720090)(client, userHandle, pipe, version.Value);
                loggedOn = Method<LoggedOn>(user, 0x1319808, 1, 0x71e610); steamId = Method<SteamId>(user, 0x1319808, 2, 0x722c80);
            }
            catch { Dispose(); throw; }
        }
        private IntPtr Address(int rva) { return new IntPtr(module.ToInt64() + rva); }
        private T Method<T>(IntPtr instance, int vtableRva, int slot, int functionRva) where T : class
        {
            Require(instance != IntPtr.Zero && Marshal.ReadIntPtr(instance) == Address(vtableRva), "INTERFACE_UNSUPPORTED");
            IntPtr pointer = Marshal.ReadIntPtr(Address(vtableRva), slot * IntPtr.Size); Require(pointer == Address(functionRva), "METHOD_UNSUPPORTED");
            return Marshal.GetDelegateForFunctionPointer(pointer, typeof(T)) as T;
        }
        public int SteamPid { get { return binding.SteamPid; } }
        public string SteamStartTicks { get { return binding.SteamStart.ToString(CultureInfo.InvariantCulture); } }
        public ulong Read()
        {
            binding.Check(); Require(loggedOn(user), "NOT_LOGGED_ON"); IntPtr result = Marshal.AllocHGlobal(8);
            try
            {
                Marshal.WriteInt64(result, 0); Require(steamId(user, result) == result, "IDENTITY_MISMATCH");
                ulong id = unchecked((ulong)Marshal.ReadInt64(result)); Require(id > SteamIdBase && id - SteamIdBase <= UInt32.MaxValue, "IDENTITY_MISMATCH");
                binding.Check(); return id;
            }
            finally { Marshal.FreeHGlobal(result); }
        }
        public void Dispose()
        {
            if (module == IntPtr.Zero) return;
            bool userOk = true, pipeOk = true, memoryOk = true, libraryOk = true;
            if (client != IntPtr.Zero && pipe > 0 && userHandle > 0 && releaseUser != null) try { releaseUser(client, pipe, userHandle); } catch { userOk = false; }
            userHandle = 0; if (client != IntPtr.Zero && pipe > 0 && releasePipe != null) try { pipeOk = releasePipe(client, pipe); } catch { pipeOk = false; }
            pipe = 0; if (releaseThread != null) try { releaseThread(false); } catch { memoryOk = false; }
            try { libraryOk = FreeLibrary(module); } catch { libraryOk = false; } module = IntPtr.Zero;
            try { output.Emit("lifecycle", null, new Dictionary<string, object> { { "stage", "cleanup" }, { "userReleased", userOk }, { "pipeReleased", pipeOk }, { "threadMemoryReleased", memoryOk }, { "libraryReleased", libraryOk } }); } catch { }
        }
    }
    private sealed class NativeSession : IImportSession
    {
        private readonly Binding binding;
        private readonly Protocol output;
        private IntPtr module, client, user, utils, apps, screenshots;
        private int pipe, userHandle;
        private ReleaseUser releaseUser;
        private ReleasePipe releasePipe;
        private NextCallback nextCallback;
        private FreeCallback freeCallback;
        private ReleaseThreadMemory releaseThread;
        private LoggedOn loggedOn;
        private SteamId steamId;
        private AppId appId;
        private Licensed licensed;
        private AddScreenshot add;
        internal NativeSession(Binding b, Protocol output)
        {
            binding = b; this.output = output;
            try
            {
                b.Check(); b.ValidateDll(); b.CheckActivity();
                Environment.SetEnvironmentVariable("SteamAppId", b.Target.ToString(CultureInfo.InvariantCulture), EnvironmentVariableTarget.Process);
                Environment.SetEnvironmentVariable("SteamGameId", b.Target.ToString(CultureInfo.InvariantCulture), EnvironmentVariableTarget.Process);
                module = LoadLibraryExW(b.Dll, IntPtr.Zero, 8u); Require(module != IntPtr.Zero, "LOAD_FAILED"); b.Check(); b.ValidateDll();
                Factory factory = Export<Factory>("CreateInterface", null); using (CString version = new CString("SteamClient021")) client = factory(version.Value, IntPtr.Zero);
                releaseUser = Method<ReleaseUser>(client, 0x130c7d8, 4, 0x720050); releasePipe = Method<ReleasePipe>(client, 0x130c7d8, 1, 0x720360);
                nextCallback = Export<NextCallback>("Steam_BGetCallback", 0x984d00); freeCallback = Export<FreeCallback>("Steam_FreeLastCallback", 0x984d30); releaseThread = Export<ReleaseThreadMemory>("Steam_ReleaseThreadLocalMemory", 0x984db0);
                b.Check(); pipe = Method<CreatePipe>(client, 0x130c7d8, 0, 0x5162f0)(client); Require(pipe > 0, "PIPE_FAILED");
                b.Check(); b.CheckActivity(); userHandle = Method<ConnectUser>(client, 0x130c7d8, 2, 0x720000)(client, pipe); Require(userHandle > 0, "CONNECT_FAILED");
                using (CString version = new CString("SteamUser023")) user = Method<UserInterface>(client, 0x130c7d8, 5, 0x720090)(client, userHandle, pipe, version.Value);
                loggedOn = Method<LoggedOn>(user, 0x1319808, 1, 0x71e610); steamId = Method<SteamId>(user, 0x1319808, 2, 0x722c80);
                using (CString version = new CString("SteamUtils010")) utils = Method<PipeInterface>(client, 0x130c7d8, 9, 0x720150)(client, pipe, version.Value);
                appId = Method<AppId>(utils, 0x131aef0, 9, 0x72e2d0);
                using (CString version = new CString("STEAMAPPS_INTERFACE_VERSION008")) apps = Method<UserInterface>(client, 0x130c7d8, 15, 0x7201a0)(client, userHandle, pipe, version.Value);
                licensed = Method<Licensed>(apps, 0x130b458, 6, 0x71e8d0); Check();
                string getter = "generic12";
                using (CString version = new CString("STEAMSCREENSHOTS_INTERFACE_VERSION003"))
                {
                    screenshots = Method<UserInterface>(client, 0x130c7d8, 12, 0x720260)(client, userHandle, pipe, version.Value); Check();
                    if (screenshots == IntPtr.Zero) { getter = "screenshots18"; screenshots = Method<UserInterface>(client, 0x130c7d8, 18, 0x7203d0)(client, userHandle, pipe, version.Value); }
                }
                add = Method<AddScreenshot>(screenshots, 0x1315640, 1, 0x729900); Check();
                output.Emit("ready", null, new Dictionary<string, object> { { "steamId", b.Expected.ToString(CultureInfo.InvariantCulture) }, { "appId", b.Target }, { "protocol", 1 }, { "screenshotsVersion", "STEAMSCREENSHOTS_INTERFACE_VERSION003" }, { "getter", getter } });
            }
            catch { Dispose(); throw; }
        }
        private IntPtr Address(int rva) { return new IntPtr(module.ToInt64() + rva); }
        private T Export<T>(string name, int? expectedRva) where T : class
        {
            IntPtr pointer = GetProcAddress(module, name); Require(pointer != IntPtr.Zero && (!expectedRva.HasValue || pointer == Address(expectedRva.Value)), "EXPORT_UNSUPPORTED");
            return Marshal.GetDelegateForFunctionPointer(pointer, typeof(T)) as T;
        }
        private T Method<T>(IntPtr instance, int vtableRva, int slot, int functionRva) where T : class
        {
            Require(instance != IntPtr.Zero && Marshal.ReadIntPtr(instance) == Address(vtableRva), "INTERFACE_UNSUPPORTED");
            IntPtr pointer = Marshal.ReadIntPtr(Address(vtableRva), slot * IntPtr.Size); Require(pointer == Address(functionRva), "METHOD_UNSUPPORTED"); return Marshal.GetDelegateForFunctionPointer(pointer, typeof(T)) as T;
        }
        public void CheckOwner() { binding.Check(); }
        private void Check()
        {
            binding.Check(); Require(loggedOn(user), "NOT_LOGGED_ON"); IntPtr result = Marshal.AllocHGlobal(8);
            try { Marshal.WriteInt64(result, 0); Require(steamId(user, result) == result && unchecked((ulong)Marshal.ReadInt64(result)) == binding.Expected, "IDENTITY_MISMATCH"); }
            finally { Marshal.FreeHGlobal(result); }
            binding.Check(); Require(appId(utils) == binding.Target, "APP_MISMATCH"); binding.Check(); Require(licensed(apps, binding.Target), "NOT_LICENSED"); binding.Check();
        }
        private FileStream ImageSource(Request request)
        {
            string root = SafeDirectory(binding.StagingRoot);
            Require(Path.IsPathRooted(request.Path) && !request.Path.StartsWith(@"\\", StringComparison.Ordinal), "IMAGE_OUTSIDE_STAGING");
            string path = Path.GetFullPath(request.Path);
            Require(path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) && String.Equals(Path.GetExtension(path), ".jpg", StringComparison.OrdinalIgnoreCase), "IMAGE_OUTSIDE_STAGING");
            RegularPath(path);
            FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            try
            {
                Require(stream.Length > 4 && stream.Length <= 32L * 1024 * 1024 && Hash(stream) == request.Sha256, "IMAGE_CHANGED"); stream.Position = 0;
                using (System.Drawing.Image image = System.Drawing.Image.FromStream(stream, false, true)) Require(image.RawFormat.Guid == ImageFormat.Jpeg.Guid && image.Width == request.Width && image.Height == request.Height, "IMAGE_INVALID");
                stream.Position = 0; return stream;
            }
            catch { stream.Dispose(); throw; }
        }
        public Result Add(Request request, Action submitting, Action<uint> submitted)
        {
            bool attempted = false; uint? current = null;
            try
            {
                Check(); using (FileStream source = ImageSource(request)) using (CString filename = new CString(Path.GetFullPath(request.Path)))
                {
                    binding.CheckActivity(); Check(); submitting(); attempted = true;
                    uint handle = add(screenshots, filename.Value, IntPtr.Zero, request.Width, request.Height); current = handle;
                    if (handle == 0) return new Result("rejected", true, 0, null, "INVALID_SCREENSHOT_HANDLE");
                    submitted(handle); IntPtr callback = Marshal.AllocHGlobal(24);
                    try
                    {
                        Stopwatch clock = Stopwatch.StartNew(); int callbacks = 0;
                        while (clock.ElapsedMilliseconds < 15000)
                        {
                            Check();
                            for (int batch = 0; batch < 128; batch++)
                            {
                                for (int offset = 0; offset < 24; offset++) Marshal.WriteByte(callback, offset, 0);
                                if (!nextCallback(pipe, callback)) break;
                                try
                                {
                                    callbacks++; Require(callbacks <= 4096, "CALLBACK_LIMIT");
                                    int target = Marshal.ReadInt32(callback, 0), kind = Marshal.ReadInt32(callback, 4), bytes = Marshal.ReadInt32(callback, 16);
                                    Require(bytes >= 0 && bytes <= 1048576, "CALLBACK_INVALID"); if (kind != 2301) continue;
                                    Require(bytes == 8, "CALLBACK_INVALID"); IntPtr payload = Marshal.ReadIntPtr(callback, 8); Require(payload != IntPtr.Zero, "CALLBACK_INVALID");
                                    uint received = unchecked((uint)Marshal.ReadInt32(payload, 0)); int result = Marshal.ReadInt32(payload, 4);
                                    if (received != handle) continue; Require(target == userHandle, "CALLBACK_USER_MISMATCH"); Check();
                                    return new Result(result == 1 ? "confirmed" : "rejected", true, handle, result, result == 1 ? null : "STEAM_REJECTED");
                                }
                                finally { freeCallback(pipe); }
                            }
                            Thread.Sleep(50);
                        }
                        return new Result("uncertain", true, handle, null, "CALLBACK_TIMEOUT");
                    }
                    finally { Marshal.FreeHGlobal(callback); }
                }
            }
            catch (Exception error) { return new Result(attempted ? "uncertain" : "rejected", attempted, current, null, Code(error)); }
            finally { if (releaseThread != null) try { releaseThread(false); } catch { } }
        }
        public void Dispose()
        {
            if (module == IntPtr.Zero) return;
            bool userOk = true, pipeOk = true, memoryOk = true, libraryOk = true;
            if (client != IntPtr.Zero && pipe > 0 && userHandle > 0 && releaseUser != null) try { releaseUser(client, pipe, userHandle); } catch { userOk = false; }
            userHandle = 0; if (client != IntPtr.Zero && pipe > 0 && releasePipe != null) try { pipeOk = releasePipe(client, pipe); } catch { pipeOk = false; }
            pipe = 0; if (releaseThread != null) try { releaseThread(false); } catch { memoryOk = false; }
            try { libraryOk = FreeLibrary(module); } catch { libraryOk = false; } module = IntPtr.Zero;
            try { output.Emit("lifecycle", null, new Dictionary<string, object> { { "stage", "cleanup" }, { "userReleased", userOk }, { "pipeReleased", pipeOk }, { "threadMemoryReleased", memoryOk }, { "libraryReleased", libraryOk } }); } catch { }
        }
    }
    public static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false); Protocol output = new Protocol(Console.Out);
        try
        {
            if (args.Length > 0 && args[0] == "--read-current-user") return RunIdentity(new NativeIdentity(Binding.ParseIdentity(args), output), output);
            Binding binding = Binding.Parse(args);
            using (NativeSession session = new NativeSession(binding, output))
            using (StreamReader input = new StreamReader(Console.OpenStandardInput(), Utf8, false, 4096)) return output.Run(input, session);
        }
        catch (Exception error) { try { output.Emit("error", null, new Dictionary<string, object> { { "code", Code(error) } }); } catch { } return 1; }
    }
}
