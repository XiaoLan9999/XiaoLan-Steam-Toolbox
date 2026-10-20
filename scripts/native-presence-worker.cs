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

internal static class NativePresenceWorker
{
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly Regex RequestId = new Regex("^[A-Za-z0-9_-]{1,64}$", RegexOptions.CultureInvariant);
    private static readonly Regex KeyName = new Regex("^[A-Za-z0-9_:]{1,63}$", RegexOptions.CultureInvariant);
    private static readonly Regex Sensitive = new Regex("connect|join|lobby|token|password|secret|auth|ticket|credential|session|group|party|(?:^|[_:])(?:address|ip|port)(?:$|[_:])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex DisplayToken = new Regex("^#[A-Za-z0-9_]{1,127}$", RegexOptions.CultureInvariant);
    private static StreamWriter output;

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

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int InitFlat(IntPtr error);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    [return: MarshalAs(UnmanagedType.I1)] private delegate bool InitSafe();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void VoidCall();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr InterfaceCall();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate ulong SteamIdCall(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    [return: MarshalAs(UnmanagedType.I1)] private delegate bool LoggedOnCall(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate uint AppIdCall(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int CountCall(IntPtr friends, ulong user);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void RequestCall(IntPtr friends, ulong user);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    [return: MarshalAs(UnmanagedType.I1)] private delegate bool SetCall(IntPtr friends, IntPtr key, IntPtr value);

    private sealed class Failure : Exception
    {
        public readonly string Code;
        public Failure(string code) { Code = code; }
    }

    private sealed class Binding
    {
        public string Dll;
        public string Hash;
        public uint App;
        public ulong Self;
        public int GamePid;
        public long GameTicks;
        public int ParentPid;
        public long ParentTicks;
        public string GameImage;

        public static Binding Parse(string[] args)
        {
            Binding value = new Binding();
            if (args.Length != 8 || !Path.IsPathRooted(args[0]) || args[0].StartsWith(@"\\", StringComparison.Ordinal)
                || !Regex.IsMatch(args[1], "^[a-f0-9]{64}$", RegexOptions.CultureInvariant)
                || !UInt32.TryParse(args[2], NumberStyles.None, CultureInfo.InvariantCulture, out value.App) || value.App == 0
                || !UInt64.TryParse(args[3], NumberStyles.None, CultureInfo.InvariantCulture, out value.Self) || value.Self == 0
                || !Int32.TryParse(args[4], NumberStyles.None, CultureInfo.InvariantCulture, out value.GamePid) || value.GamePid <= 0
                || !Int64.TryParse(args[5], NumberStyles.None, CultureInfo.InvariantCulture, out value.GameTicks) || value.GameTicks <= 0
                || !Int32.TryParse(args[6], NumberStyles.None, CultureInfo.InvariantCulture, out value.ParentPid) || value.ParentPid <= 0
                || !Int64.TryParse(args[7], NumberStyles.None, CultureInfo.InvariantCulture, out value.ParentTicks) || value.ParentTicks <= 0
                || value.ParentPid == value.GamePid) throw new Failure("NATIVE_ARGUMENTS_INVALID");
            value.Dll = Path.GetFullPath(args[0]);
            value.Hash = args[1];
            try
            {
                using (Process game = Process.GetProcessById(value.GamePid)) value.GameImage = Path.GetFullPath(game.MainModule.FileName);
            }
            catch { throw new Failure("NATIVE_CONTEXT_CHANGED"); }
            if (!value.Alive()) throw new Failure("NATIVE_CONTEXT_CHANGED");
            return value;
        }

        private static bool ProcessMatches(int pid, long ticks, string image)
        {
            try
            {
                using (Process process = Process.GetProcessById(pid))
                {
                    return !process.HasExited && process.StartTime.ToUniversalTime().Ticks == ticks
                        && (image == null || String.Equals(Path.GetFullPath(process.MainModule.FileName), image, StringComparison.OrdinalIgnoreCase))
                        && !process.HasExited;
                }
            }
            catch { return false; }
        }

        public bool Alive() { return ProcessMatches(ParentPid, ParentTicks, null) && ProcessMatches(GamePid, GameTicks, GameImage); }
    }

    private interface IPresence : IDisposable
    {
        bool Guard();
        void Callbacks();
        int ReadCount();
        bool Set(string key, string value);
    }

    private sealed class NativePresence : IPresence
    {
        private readonly Binding binding;
        private FileStream dllLock;
        private IntPtr library;
        private bool initialized;
        private VoidCall shutdown;
        private VoidCall callbacks;
        private SteamIdCall getSteamId;
        private LoggedOnCall loggedOn;
        private AppIdCall getAppId;
        private CountCall count;
        private RequestCall request;
        private SetCall set;
        private IntPtr user;
        private IntPtr utils;
        private IntPtr friends;

        private T Find<T>(params string[] names) where T : class
        {
            foreach (string name in names)
            {
                IntPtr address = GetProcAddress(library, name);
                if (address != IntPtr.Zero) return (T)(object)Marshal.GetDelegateForFunctionPointer(address, typeof(T));
            }
            return null;
        }

        private T Require<T>(params string[] names) where T : class
        {
            T value = Find<T>(names);
            if (value == null) throw new Failure("NATIVE_EXPORT_MISSING");
            return value;
        }

        private IntPtr RequireInterface(params string[] names)
        {
            foreach (string name in names)
            {
                InterfaceCall accessor = Find<InterfaceCall>(name);
                if (accessor != null)
                {
                    IntPtr pointer = accessor();
                    if (pointer != IntPtr.Zero) return pointer;
                }
            }
            throw new Failure("NATIVE_EXPORT_MISSING");
        }

        public NativePresence(Binding value)
        {
            binding = value;
            try
            {
                if ((File.GetAttributes(binding.Dll) & FileAttributes.ReparsePoint) != 0) throw new Failure("NATIVE_DLL_INVALID");
                dllLock = new FileStream(binding.Dll, FileMode.Open, FileAccess.Read, FileShare.Read);
                if (dllLock.Length < 256 || dllLock.Length > 16 * 1024 * 1024) throw new Failure("NATIVE_DLL_INVALID");
                byte[] header = new byte[64];
                if (dllLock.Read(header, 0, header.Length) != header.Length || header[0] != 0x4d || header[1] != 0x5a) throw new Failure("NATIVE_DLL_INVALID");
                int pe = BitConverter.ToInt32(header, 0x3c);
                if (pe < 64 || pe > dllLock.Length - 6) throw new Failure("NATIVE_DLL_INVALID");
                dllLock.Position = pe;
                byte[] signature = new byte[6];
                if (dllLock.Read(signature, 0, 6) != 6 || BitConverter.ToUInt32(signature, 0) != 0x4550
                    || BitConverter.ToUInt16(signature, 4) != (IntPtr.Size == 4 ? 0x14c : 0x8664)) throw new Failure("NATIVE_DLL_INVALID");
                dllLock.Position = 0;
                byte[] digest;
                using (SHA256 sha = SHA256.Create()) digest = sha.ComputeHash(dllLock);
                if (BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant() != binding.Hash) throw new Failure("NATIVE_DLL_INVALID");
                if (!binding.Alive()) throw new Failure("NATIVE_CONTEXT_CHANGED");
                Environment.SetEnvironmentVariable("SteamAppId", binding.App.ToString(CultureInfo.InvariantCulture), EnvironmentVariableTarget.Process);
                Environment.SetEnvironmentVariable("SteamGameId", binding.App.ToString(CultureInfo.InvariantCulture), EnvironmentVariableTarget.Process);
                library = LoadLibraryExW(binding.Dll, IntPtr.Zero, 0x100u | 0x800u);
                if (library == IntPtr.Zero) throw new Failure("NATIVE_LOAD_FAILED");
                shutdown = Require<VoidCall>("SteamAPI_Shutdown");
                callbacks = Require<VoidCall>("SteamAPI_RunCallbacks");
                getSteamId = Require<SteamIdCall>("SteamAPI_ISteamUser_GetSteamID");
                loggedOn = Require<LoggedOnCall>("SteamAPI_ISteamUser_BLoggedOn");
                getAppId = Require<AppIdCall>("SteamAPI_ISteamUtils_GetAppID");
                count = Require<CountCall>("SteamAPI_ISteamFriends_GetFriendRichPresenceKeyCount");
                request = Require<RequestCall>("SteamAPI_ISteamFriends_RequestFriendRichPresence");
                set = Require<SetCall>("SteamAPI_ISteamFriends_SetRichPresence");
                InitFlat flat = Find<InitFlat>("SteamAPI_InitFlat");
                if (flat != null)
                {
                    IntPtr error = Marshal.AllocHGlobal(1024);
                    try { Marshal.Copy(new byte[1024], 0, error, 1024); initialized = flat(error) == 0; }
                    finally { Marshal.FreeHGlobal(error); }
                }
                else initialized = Require<InitSafe>("SteamAPI_InitSafe", "SteamAPI_Init")();
                if (!initialized) throw new Failure("NATIVE_INIT_FAILED");
                user = RequireInterface("SteamAPI_SteamUser_v023", "SteamAPI_SteamUser_v022", "SteamAPI_SteamUser_v021", "SteamAPI_SteamUser_v020");
                utils = RequireInterface("SteamAPI_SteamUtils_v010", "SteamAPI_SteamUtils_v009");
                friends = RequireInterface("SteamAPI_SteamFriends_v018", "SteamAPI_SteamFriends_v017");
                if (!Guard()) throw new Failure("NATIVE_CONTEXT_CHANGED");
            }
            catch { Dispose(); throw; }
        }

        public bool Guard()
        {
            return initialized && binding.Alive() && user != IntPtr.Zero && utils != IntPtr.Zero && friends != IntPtr.Zero
                && getSteamId(user) == binding.Self && loggedOn(user) && getAppId(utils) == binding.App;
        }
        public void Callbacks() { callbacks(); }
        public int ReadCount()
        {
            if (!Guard()) throw new Failure("NATIVE_CONTEXT_CHANGED");
            request(friends, binding.Self);
            int result = count(friends, binding.Self);
            if (result < 0 || result > 20) throw new Failure("NATIVE_INTERNAL_ERROR");
            return result;
        }
        public bool Set(string key, string value)
        {
            IntPtr keyMemory = IntPtr.Zero;
            IntPtr valueMemory = IntPtr.Zero;
            try
            {
                keyMemory = CString(key); valueMemory = CString(value);
                if (!Guard()) throw new Failure("NATIVE_CONTEXT_CHANGED");
                return set(friends, keyMemory, valueMemory);
            }
            finally
            {
                if (keyMemory != IntPtr.Zero) Marshal.FreeHGlobal(keyMemory);
                if (valueMemory != IntPtr.Zero) Marshal.FreeHGlobal(valueMemory);
            }
        }
        public void Dispose()
        {
            if (initialized) { initialized = false; try { shutdown(); } catch { } }
            if (library != IntPtr.Zero) { FreeLibrary(library); library = IntPtr.Zero; }
            if (dllLock != null) { dllLock.Dispose(); dllLock = null; }
        }
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
                if (value.Length > 4096) throw new Failure("NATIVE_PROTOCOL_INVALID");
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
                else throw new Failure("NATIVE_PROTOCOL_INVALID");
                if (result.ContainsKey(key) || result.Count >= 24) throw new Failure("NATIVE_PROTOCOL_INVALID");
                result.Add(key, value); White();
                if (offset < input.Length && input[offset] == '}') { offset++; return result; }
                Take(',');
            }
        }
        public Dictionary<string, object> Parse()
        {
            if (input.Length > 16384 || Utf8.GetByteCount(input) > 16384) throw new Failure("NATIVE_PROTOCOL_INVALID");
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
                if (changes.Count < 1 || changes.Count > 20) throw new Failure("NATIVE_PROTOCOL_INVALID");
                foreach (KeyValuePair<string, object> change in changes)
                {
                    string key = change.Key;
                    string value = change.Value as string;
                    string lower = key.ToLowerInvariant();
                    if (value == null || !KeyName.IsMatch(key) || !seen.Add(key) || lower == "__proto__" || lower == "constructor" || lower == "prototype" || lower == "version"
                        || (lower != "steam_display" && lower != "matchgrouploc" && Sensitive.IsMatch(key)) || Utf8.GetByteCount(value) > 255) throw new Failure("NATIVE_PROTOCOL_INVALID");
                    foreach (char character in value) if (Char.IsControl(character) || character == '\u2028' || character == '\u2029') throw new Failure("NATIVE_PROTOCOL_INVALID");
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
    private static void Reply(string id, string op, bool ok, string code, List<string> accepted, bool mayHaveWritten, int? keyCount)
    {
        StringBuilder json = new StringBuilder("{\"v\":1,\"requestId\":").Append(Quote(id)).Append(",\"op\":").Append(Quote(op))
            .Append(",\"ok\":").Append(ok ? "true" : "false").Append(",\"acceptedKeys\":[");
        for (int i = 0; i < accepted.Count; i++) { if (i > 0) json.Append(','); json.Append(Quote(accepted[i])); }
        json.Append("],\"mayHaveWritten\":").Append(mayHaveWritten ? "true" : "false");
        if (code != null) json.Append(",\"code\":").Append(Quote(code));
        if (keyCount.HasValue) json.Append(",\"keyCount\":").Append(keyCount.Value.ToString(CultureInfo.InvariantCulture));
        if (ok && op != "stopped") json.Append(",\"identityMatch\":true,\"appMatch\":true,\"loggedOn\":true,\"gameStillSame\":true");
        output.WriteLine(json.Append('}').ToString());
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
            if (request.Op == "read") { Reply(id, "read", true, null, accepted, false, api.ReadCount()); return true; }
            List<string> keys = new List<string>(request.Changes.Keys);
            string display = keys.Find(delegate(string key) { return String.Equals(key, "steam_display", StringComparison.OrdinalIgnoreCase); });
            if (display != null) { keys.Remove(display); keys.Add(display); }
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
                            lock (Lines) { if (Lines.Count >= 32) { Invalid = true; break; } Lines.Enqueue(line.ToString()); }
                            line.Length = 0; lineBytes = 0;
                        }
                        else
                        {
                            char character = (char)next;
                            lineBytes += character <= 0x7f ? 1 : character <= 0x7ff ? 2 : Char.IsHighSurrogate(character) ? 4 : Char.IsLowSurrogate(character) ? 0 : 3;
                            if (lineBytes > 16384) { Invalid = true; break; }
                            line.Append(character);
                        }
                    }
                }
            }
            catch { Invalid = true; }
            finally { Closed = true; }
        }
    }

    private sealed class SessionPresence : IPresence
    {
        private readonly IPresence api;
        private readonly Input input;
        public SessionPresence(IPresence value, Input source) { api = value; input = source; }
        public bool Guard() { return !input.Closed && !input.Invalid && api.Guard(); }
        public void Callbacks() { if (Guard()) api.Callbacks(); }
        public int ReadCount() { if (!Guard()) throw new Failure("NATIVE_CONTEXT_CHANGED"); return api.ReadCount(); }
        public bool Set(string key, string value) { if (!Guard()) throw new Failure("NATIVE_CONTEXT_CHANGED"); return api.Set(key, value); }
        public void Dispose() { }
    }

    private sealed class LivenessWatchdog : IDisposable
    {
        private readonly Func<bool> alive;
        private readonly ManualResetEvent stopping = new ManualResetEvent(false);
        private readonly Thread thread;
        public LivenessWatchdog(Func<bool> check)
        {
            alive = check;
            thread = new Thread(Run); thread.IsBackground = true; thread.Start();
        }
        private void Run()
        {
            while (!stopping.WaitOne(200))
            {
                bool valid;
                try { valid = alive(); }
                catch { valid = false; }
                // This exits only the worker, even if a native call blocks its main thread.
                if (!valid) Environment.Exit(70);
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
            if (!session.Guard()) return;
            string line = null;
            lock (input.Lines) { if (input.Lines.Count > 0) line = input.Lines.Dequeue(); }
            if (line != null && !Handle(line, session, seen)) return;
            if (!session.Guard()) return;
            session.Callbacks();
            Thread.Sleep(50);
        }
    }

#if NATIVE_PRESENCE_TEST
    private sealed class FakePresence : IPresence
    {
        private readonly int rejectAt;
        private readonly int guardAt;
        private int calls;
        private int guards;
        public FakePresence(int reject, int guard) { rejectAt = reject; guardAt = guard; }
        public bool Guard() { guards++; return guardAt == 0 || guards < guardAt; }
        public void Callbacks() { }
        public int ReadCount() { return 3; }
        public bool Set(string key, string value) { calls++; return rejectAt == 0 || calls != rejectAt; }
        public void Dispose() { }
    }
#endif

    public static int Main(string[] args)
    {
        output = new StreamWriter(Console.OpenStandardOutput(), Utf8); output.AutoFlush = true;
#if NATIVE_PRESENCE_TEST
        if (args.Length == 4 && args[0] == "--test-once")
        {
            using (FakePresence fake = new FakePresence(Int32.Parse(args[2], CultureInfo.InvariantCulture), Int32.Parse(args[3], CultureInfo.InvariantCulture))) Handle(args[1], fake, new HashSet<string>());
            return 0;
        }
        if (args.Length == 1 && args[0] == "--test-loop") { using (FakePresence fake = new FakePresence(0, 0)) Loop(fake, StartInput()); return 0; }
        if (args.Length == 1 && args[0] == "--test-fixture-child")
        {
            using (Process self = Process.GetCurrentProcess()) output.WriteLine("{\"fixturePid\":" + self.Id.ToString(CultureInfo.InvariantCulture) + ",\"fixtureTicks\":\"" + self.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) + "\"}");
            Thread.Sleep(Timeout.Infinite); return 0;
        }
        if (args.Length == 3 && (args[0] == "--test-watchdog-parent" || args[0] == "--test-watchdog-game"))
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
                using (Process game = Process.GetProcessById(fixture.GamePid)) fixture.GameImage = Path.GetFullPath(game.MainModule.FileName);
            }
            using (LivenessWatchdog watchdog = new LivenessWatchdog(fixture.Alive))
            {
                Reply("startup", "ready", true, null, new List<string>(), false, null);
                Thread.Sleep(Timeout.Infinite);
            }
            return 0;
        }
        if (args.Length == 1 && args[0] == "--test-watchdog-eof")
        {
            Input fixtureInput = StartInput();
            using (LivenessWatchdog watchdog = new LivenessWatchdog(delegate { return !fixtureInput.Closed && !fixtureInput.Invalid; }))
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
            using (LivenessWatchdog watchdog = new LivenessWatchdog(delegate { return !input.Closed && !input.Invalid && binding.Alive(); }))
            using (NativePresence api = new NativePresence(binding)) Loop(api, input);
            return 0;
        }
        catch (Failure failure) { Reply("startup", "error", false, failure.Code, new List<string>(), false, null); return 2; }
        catch { Reply("startup", "error", false, "NATIVE_INTERNAL_ERROR", new List<string>(), false, null); return 2; }
        finally { if (nullOutput != IntPtr.Zero && nullOutput != new IntPtr(-1)) CloseHandle(nullOutput); }
    }
}
