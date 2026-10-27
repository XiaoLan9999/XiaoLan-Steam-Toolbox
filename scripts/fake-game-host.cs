using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class FakeGameHost
{
    private const int MaximumLineBytes = 1024;
#if FAKE_GAME_HOST_TEST
    private const int ConnectTimeoutMs = 800;
    private const int HandshakeTimeoutMs = 500;
    private const int HeartbeatTimeoutMs = 650;
    private const int WriteTimeoutMs = 500;
    private const int GuardIntervalMs = 25;
#else
    private const int ConnectTimeoutMs = 15000;
    private const int HandshakeTimeoutMs = 5000;
    private const int HeartbeatTimeoutMs = 15000;
    private const int WriteTimeoutMs = 2000;
    private const int GuardIntervalMs = 250;
#endif
    private static readonly Regex Hex = new Regex("\\A[0-9a-f]{64}\\z", RegexOptions.CultureInvariant);
    private static readonly Regex PipeName = new Regex("\\Axiaolan-steam-fake-[0-9a-f]{64}\\z", RegexOptions.CultureInvariant);
    private static readonly Regex RequestId = new Regex("\\A[A-Za-z0-9_-]{1,64}\\z", RegexOptions.CultureInvariant);
    private static readonly Regex RequestKeys = new Regex("\"(?:v|requestId|op|token)\"\\s*:", RegexOptions.CultureInvariant);
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint clientPid);

    private sealed class HostFailure : Exception
    {
        internal readonly int Code;
        internal HostFailure(int code) { Code = code; }
    }

    private sealed class Binding
    {
        internal string Pipe;
        internal string Token;
        internal int OwnerPid;
        internal long OwnerStart;
        internal int SteamPid;
        internal long SteamStart;

        internal static Binding Parse(string[] args)
        {
            if (args.Length != 12) throw new HostFailure(64);
            Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.Ordinal);
            for (int index = 0; index < args.Length; index += 2)
            {
                if (values.ContainsKey(args[index])) throw new HostFailure(64);
                values.Add(args[index], args[index + 1]);
            }
            string pipe, token, ownerPid, ownerStart, steamPid, steamStart;
            Binding result = new Binding();
            if (!values.TryGetValue("--pipe", out pipe) || !PipeName.IsMatch(pipe)
                || !values.TryGetValue("--token", out token) || !Hex.IsMatch(token)
                || !values.TryGetValue("--owner-pid", out ownerPid) || !Int32.TryParse(ownerPid, NumberStyles.None, CultureInfo.InvariantCulture, out result.OwnerPid) || result.OwnerPid <= 0
                || !values.TryGetValue("--owner-start", out ownerStart) || !Int64.TryParse(ownerStart, NumberStyles.None, CultureInfo.InvariantCulture, out result.OwnerStart) || result.OwnerStart <= 0
                || !values.TryGetValue("--steam-pid", out steamPid) || !Int32.TryParse(steamPid, NumberStyles.None, CultureInfo.InvariantCulture, out result.SteamPid) || result.SteamPid <= 0
                || !values.TryGetValue("--steam-start", out steamStart) || !Int64.TryParse(steamStart, NumberStyles.None, CultureInfo.InvariantCulture, out result.SteamStart) || result.SteamStart <= 0)
                throw new HostFailure(64);
            using (Process self = Process.GetCurrentProcess())
            {
                if (result.OwnerPid == result.SteamPid || result.OwnerPid == self.Id || result.SteamPid == self.Id) throw new HostFailure(64);
            }
            result.Pipe = pipe; result.Token = token;
            return result;
        }

        internal void Check()
        {
            if (!Matches(OwnerPid, OwnerStart) || !Matches(SteamPid, SteamStart)) throw new HostFailure(70);
        }

        private static bool Matches(int pid, long ticks)
        {
            try
            {
                using (Process process = Process.GetProcessById(pid))
                    return !process.HasExited && process.StartTime.ToUniversalTime().Ticks == ticks;
            }
            catch { return false; }
        }
    }

    private sealed class Channel
    {
        private readonly NamedPipeServerStream pipe;
        private readonly Binding binding;
        private readonly Stopwatch clock;
        private readonly byte[] buffer = new byte[MaximumLineBytes + 1];
        private int offset;
        private int available;

        internal Channel(NamedPipeServerStream stream, Binding context, Stopwatch timer) { pipe = stream; binding = context; clock = timer; }

        internal void Wait(IAsyncResult pending, long deadline, int timeoutCode)
        {
            WaitHandle completed = pending.AsyncWaitHandle;
            while (true)
            {
                binding.Check();
                long remaining = deadline - clock.ElapsedMilliseconds;
                if (remaining <= 0) throw new HostFailure(timeoutCode);
                if (completed.WaitOne((int)Math.Min(GuardIntervalMs, remaining))) { binding.Check(); return; }
            }
        }

        internal string ReadLine(long deadline)
        {
            byte[] line = new byte[MaximumLineBytes];
            int count = 0;
            while (true)
            {
                if (offset == available)
                {
                    IAsyncResult pending = pipe.BeginRead(buffer, 0, buffer.Length, null, null);
                    Wait(pending, deadline, 76);
                    try { available = pipe.EndRead(pending); } finally { pending.AsyncWaitHandle.Close(); }
                    offset = 0;
                    if (available == 0) throw new HostFailure(74);
                }
                byte value = buffer[offset++];
                if (value == 10)
                {
                    if (count > 0 && line[count - 1] == 13) count--;
                    try { return Utf8.GetString(line, 0, count); } catch { throw new HostFailure(65); }
                }
                if (count == MaximumLineBytes) throw new HostFailure(65);
                line[count++] = value;
            }
        }

        internal void Reply(string requestId, string op, bool identity)
        {
            binding.Check();
            string extra = "";
            if (identity)
            {
                using (Process self = Process.GetCurrentProcess())
                    extra = ",\"pid\":" + self.Id.ToString(CultureInfo.InvariantCulture) + ",\"startTicks\":\"" + self.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) + "\"";
            }
            byte[] bytes = Utf8.GetBytes("{\"v\":1,\"requestId\":\"" + requestId + "\",\"op\":\"" + op + "\",\"ok\":true" + extra + "}\n");
            IAsyncResult pending = pipe.BeginWrite(bytes, 0, bytes.Length, null, null);
            Wait(pending, clock.ElapsedMilliseconds + WriteTimeoutMs, 74);
            try { pipe.EndWrite(pending); } finally { pending.AsyncWaitHandle.Close(); }
        }
    }

    private sealed class Request
    {
        internal string Id;
        internal string Op;
        internal string Token;
        internal static Request Parse(string line, bool handshake)
        {
            try
            {
                JavaScriptSerializer parser = new JavaScriptSerializer();
                parser.MaxJsonLength = MaximumLineBytes; parser.RecursionLimit = 4;
                Dictionary<string, object> values = parser.DeserializeObject(line) as Dictionary<string, object>;
                int keys = handshake ? 4 : 3;
                if (values == null || values.Count != keys || RequestKeys.Matches(line).Count != keys
                    || !values.ContainsKey("v") || !(values["v"] is int) || (int)values["v"] != 1
                    || !values.ContainsKey("requestId") || !(values["requestId"] is string) || !RequestId.IsMatch((string)values["requestId"])
                    || !values.ContainsKey("op") || !(values["op"] is string)) throw new HostFailure(65);
                Request request = new Request(); request.Id = (string)values["requestId"]; request.Op = (string)values["op"];
                if (handshake)
                {
                    if (request.Op != "hello" || !values.ContainsKey("token") || !(values["token"] is string) || !Hex.IsMatch((string)values["token"])) throw new HostFailure(65);
                    request.Token = (string)values["token"];
                }
                else if (values.ContainsKey("token") || (request.Op != "ping" && request.Op != "stop")) throw new HostFailure(65);
                return request;
            }
            catch (HostFailure) { throw; }
            catch { throw new HostFailure(65); }
        }
    }

    private static bool EqualToken(string expected, string actual)
    {
        int different = expected.Length ^ actual.Length;
        for (int index = 0; index < 64; index++) different |= expected[index] ^ actual[index];
        return different == 0;
    }

    private static int Run(string[] args)
    {
        try
        {
            Binding binding = Binding.Parse(args); binding.Check();
            PipeSecurity security = new PipeSecurity();
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                if (identity.User == null) throw new HostFailure(70);
                security.SetAccessRuleProtection(true, false);
                security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
                security.AddAccessRule(new PipeAccessRule(identity.User, PipeAccessRights.FullControl, AccessControlType.Allow));
            }
            Stopwatch clock = Stopwatch.StartNew();
            using (NamedPipeServerStream pipe = new NamedPipeServerStream(binding.Pipe, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, security))
            {
                Channel channel = new Channel(pipe, binding, clock);
                IAsyncResult connection = pipe.BeginWaitForConnection(null, null);
                channel.Wait(connection, clock.ElapsedMilliseconds + ConnectTimeoutMs, 75);
                try { pipe.EndWaitForConnection(connection); } finally { connection.AsyncWaitHandle.Close(); }
                uint clientPid;
                if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out clientPid) || clientPid != (uint)binding.OwnerPid) throw new HostFailure(65);
                binding.Check();
                Request hello = Request.Parse(channel.ReadLine(clock.ElapsedMilliseconds + HandshakeTimeoutMs), true);
                if (!EqualToken(binding.Token, hello.Token)) throw new HostFailure(65);
                binding.Token = null; hello.Token = null;
                channel.Reply(hello.Id, "hello", true);
                long heartbeat = clock.ElapsedMilliseconds + HeartbeatTimeoutMs;
                while (true)
                {
                    binding.Check();
                    Request request = Request.Parse(channel.ReadLine(heartbeat), false);
                    channel.Reply(request.Id, request.Op, false);
                    if (request.Op == "stop") return 0;
                    heartbeat = clock.ElapsedMilliseconds + HeartbeatTimeoutMs;
                }
            }
        }
        catch (HostFailure failure) { return failure.Code; }
        catch { return 74; }
    }

    private static int Main(string[] args)
    {
#if FAKE_GAME_HOST_TEST
        if (args.Length == 1 && args[0] == "--test-fixture-process")
        {
            using (Process self = Process.GetCurrentProcess())
                Console.WriteLine(self.Id.ToString(CultureInfo.InvariantCulture) + "|" + self.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture));
            Console.ReadLine(); return 0;
        }
        if (args.Length == 2 && args[0] == "--test-scenario") return TestScenario(args[1]);
#endif
        return Run(args);
    }

#if FAKE_GAME_HOST_TEST
    private static Process TestProcess(string arguments)
    {
        ProcessStartInfo start = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, arguments);
        start.UseShellExecute = false; start.CreateNoWindow = true;
        start.RedirectStandardInput = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
        return Process.Start(start);
    }

    private static string RandomHex()
    {
        byte[] bytes = new byte[32]; using (RandomNumberGenerator random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
        return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
    }

    private static string Command(string id, string op, string token)
    {
        return "{\"v\":1,\"requestId\":\"" + id + "\",\"op\":\"" + op + "\"" + (token == null ? "" : ",\"token\":\"" + token + "\"") + "}";
    }

    private static int TestScenario(string scenario)
    {
        Process steam = null, owner = null, host = null;
        try
        {
            steam = TestProcess("--test-fixture-process"); string[] steamMetadata = steam.StandardOutput.ReadLine().Split('|');
            string ownerPid, ownerStart;
            using (Process self = Process.GetCurrentProcess()) { ownerPid = self.Id.ToString(CultureInfo.InvariantCulture); ownerStart = self.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture); }
            if (scenario == "owner-exit" || scenario == "wrong-client")
            {
                owner = TestProcess("--test-fixture-process"); string[] metadata = owner.StandardOutput.ReadLine().Split('|'); ownerPid = metadata[0]; ownerStart = metadata[1];
            }
            if (scenario == "owner-reused") ownerStart = (Int64.Parse(ownerStart, CultureInfo.InvariantCulture) + 1).ToString(CultureInfo.InvariantCulture);
            if (scenario == "steam-reused") steamMetadata[1] = (Int64.Parse(steamMetadata[1], CultureInfo.InvariantCulture) + 1).ToString(CultureInfo.InvariantCulture);
            string pipeName = "xiaolan-steam-fake-" + RandomHex(), token = RandomHex();
            host = TestProcess("--pipe " + pipeName + " --token " + token + " --owner-pid " + ownerPid + " --owner-start " + ownerStart + " --steam-pid " + steamMetadata[0] + " --steam-start " + steamMetadata[1]);
            if (scenario == "owner-exit") { owner.StandardInput.Close(); owner.WaitForExit(1000); }
            else if (scenario != "connect-timeout" && scenario != "owner-reused" && scenario != "steam-reused")
            {
                using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous))
                {
                    pipe.Connect(1500);
                    using (StreamReader input = new StreamReader(pipe, Utf8, false, 1024, true))
                    using (StreamWriter output = new StreamWriter(pipe, Utf8, 1024, true))
                    {
                        output.AutoFlush = true;
                        if (scenario == "wrong-client") { }
                        else if (scenario == "hello-timeout") Thread.Sleep(700);
                        else if (scenario == "malformed") output.WriteLine("{broken}");
                        else if (scenario == "oversized") output.WriteLine(new string('x', MaximumLineBytes + 1));
                        else if (scenario == "before-hello") output.WriteLine(Command("1", "ping", null));
                        else
                        {
                            output.WriteLine(Command("1", "hello", scenario == "wrong-token" ? new string('0', 64) : token));
                            if (scenario != "wrong-token")
                            {
                                if (input.ReadLine().IndexOf("\"op\":\"hello\"", StringComparison.Ordinal) < 0) throw new Exception();
                                if (scenario == "steam-exit") { steam.StandardInput.Close(); steam.WaitForExit(1000); }
                                else if (scenario == "disconnect") { }
                                else if (scenario == "heartbeat-timeout") Thread.Sleep(900);
                                else if (scenario == "replay-hello") output.WriteLine(Command("2", "hello", token));
                                else if (scenario == "extra-key") output.WriteLine("{\"v\":1,\"requestId\":\"2\",\"op\":\"ping\",\"extra\":true}");
                                else if (scenario == "duplicate-key") output.WriteLine("{\"v\":1,\"requestId\":\"2\",\"op\":\"ping\",\"op\":\"ping\"}");
                                else if (scenario == "unknown-op") output.WriteLine(Command("2", "launch", null));
                                else
                                {
                                    int pings = scenario == "long-lived" ? 4 : 1;
                                    for (int index = 0; index < pings; index++)
                                    {
                                        if (pings > 1) Thread.Sleep(250);
                                        output.WriteLine(Command("ping" + index, "ping", null));
                                        if (input.ReadLine().IndexOf("\"op\":\"ping\"", StringComparison.Ordinal) < 0) throw new Exception();
                                    }
                                    output.WriteLine(Command("stop", "stop", null));
                                    if (input.ReadLine().IndexOf("\"op\":\"stop\"", StringComparison.Ordinal) < 0) throw new Exception();
                                }
                            }
                        }
                        if (scenario != "disconnect") host.WaitForExit(2200);
                    }
                }
            }
            if (!host.WaitForExit(2500)) throw new Exception();
            Console.WriteLine("{\"exitCode\":" + host.ExitCode.ToString(CultureInfo.InvariantCulture) + "}");
            return 0;
        }
        catch { Console.WriteLine("{\"fixtureFailed\":true}"); return 1; }
        finally
        {
            foreach (Process process in new Process[] { host, owner, steam })
            {
                if (process == null) continue;
                try { process.StandardInput.Close(); if (!process.WaitForExit(1200)) { process.Kill(); process.WaitForExit(1200); } } catch { }
                process.Dispose();
            }
        }
    }
#endif
}
