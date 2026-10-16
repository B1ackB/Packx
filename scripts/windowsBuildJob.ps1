# Trusted CI builds only. This Job controls lifetime/resources; it is not a security sandbox.
param([Parameter(Mandatory)][string]$RequestFile, [Parameter(Mandatory)][string]$ResultFile)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Core' -or [IntPtr]::Size -ne 8) { throw 'Requires preinstalled x64 PowerShell Core' }
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PackxBuildJob {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long processTime, jobTime; public uint flags; public UIntPtr minWorking, maxWorking; public uint active; public UIntPtr affinity; public uint priority, scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct Limits { public BasicLimits basic; public Io io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] struct Accounting { public long a,b,c,d; public uint faults, total, active, terminated; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup { public uint cb; public string reserved, desktop, title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags; public ushort show, reservedSize; public IntPtr reservedBytes, input, output, error; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr security, IntPtr name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting data, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string executable, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public sealed class Result {
        public string schemaVersion = "windows-build-job.v1", outcome = "launch_failed", rootCreationTime, failure, cleanupFailure;
        public uint rootProcessId, totalProcesses, activeProcesses;
        public uint? exitCode;
        public int? win32Error;
        public bool cleanupVerified;
        public long elapsedMs;
    }
    static void Check(bool ok, string step) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), step); }
    static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); result.Append(c); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static Accounting Count(IntPtr job) { Accounting data; Check(QueryInformationJobObject(job, 1, out data, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero), "query_job"); return data; }
    public static Result Run(string executable, string[] args, string cwd, uint timeoutMs) {
        if (timeoutMs < 1 || timeoutMs > 120000 || !System.IO.Path.IsPathFullyQualified(executable) || !System.IO.Path.IsPathFullyQualified(cwd)) throw new ArgumentException("Invalid trusted build request");
        var result = new Result(); var clock = Stopwatch.StartNew(); IntPtr job = IntPtr.Zero; ProcessInfo child = new ProcessInfo(); bool joined = false;
        try {
            job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero); Check(job != IntPtr.Zero, "create_job");
            // No breakaway, no inherited Job handle; limits cover every compiler/linker descendant.
            var limits = new Limits(); limits.basic.flags = 0x2000 | 0x8 | 0x200; limits.basic.active = 16; limits.jobMemory = new UIntPtr(2147483648UL);
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<Limits>()), "set_job_limits");
            var command = new StringBuilder(Quote(executable)); foreach (string arg in args) command.Append(' ').Append(Quote(arg));
            var startup = new Startup(); startup.cb = (uint)Marshal.SizeOf<Startup>(); startup.flags = 0x100;
            startup.input = GetStdHandle(-10); startup.output = GetStdHandle(-11); startup.error = GetStdHandle(-12);
            Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x4 | 0x08000000, IntPtr.Zero, cwd, ref startup, out child), "create_suspended");
            result.rootProcessId = child.pid;
            long creation, exit, kernel, user; Check(GetProcessTimes(child.process, out creation, out exit, out kernel, out user), "process_identity"); result.rootCreationTime = DateTime.FromFileTimeUtc(creation).ToString("O");
            Check(AssignProcessToJobObject(job, child.process), "assign_job"); joined = true;
            Check(ResumeThread(child.thread) != uint.MaxValue, "resume");
            uint waited = WaitForSingleObject(child.process, timeoutMs);
            if (waited == 258) result.outcome = "timed_out";
            else { Check(waited == 0, "wait_root"); uint code; Check(GetExitCodeProcess(child.process, out code), "root_exit"); result.exitCode = code; result.outcome = code == 0 ? "succeeded" : "exit_failed"; }
        } catch (Exception error) { result.failure = error.Message; var native = error as Win32Exception; if (native != null) result.win32Error = native.NativeErrorCode; }
        finally {
            try {
                if (joined) {
                    Check(TerminateJobObject(job, 1), "terminate_owned_job");
                    var cleanup = Stopwatch.StartNew(); Accounting count;
                    do { count = Count(job); if (count.active == 0) break; Thread.Sleep(10); } while (cleanup.ElapsedMilliseconds < 5000);
                    result.totalProcesses = count.total; result.activeProcesses = count.active; result.cleanupVerified = count.active == 0;
                    if (!result.cleanupVerified) result.cleanupFailure = "owned_job_still_active";
                } else if (child.process != IntPtr.Zero) { Check(TerminateProcess(child.process, 1), "terminate_unassigned_root"); result.cleanupVerified = WaitForSingleObject(child.process, 5000) == 0; }
                else result.cleanupVerified = true;
            } catch (Exception error) { result.cleanupFailure = error.Message; }
            if (child.thread != IntPtr.Zero) CloseHandle(child.thread); if (child.process != IntPtr.Zero) CloseHandle(child.process); if (job != IntPtr.Zero) CloseHandle(job);
            result.elapsedMs = clock.ElapsedMilliseconds;
        }
        return result;
    }
}
'@
$request = Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json
$result = [PackxBuildJob]::Run($request.executable, [string[]]$request.arguments, $request.cwd, $request.timeoutMs)
$json = $result | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($ResultFile, $json, [System.Text.UTF8Encoding]::new($false))
if ($result.outcome -ne 'succeeded' -or -not $result.cleanupVerified -or $result.cleanupFailure) { exit 1 }
