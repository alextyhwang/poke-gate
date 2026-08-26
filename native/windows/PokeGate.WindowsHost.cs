using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Management.Automation.Language;
using System.Runtime.InteropServices;
using System.Text;

internal static class Program
{
    private const uint TOKEN_ASSIGN_PRIMARY = 0x0001;
    private const uint TOKEN_DUPLICATE = 0x0002;
    private const uint TOKEN_QUERY = 0x0008;
    private const uint TOKEN_ADJUST_DEFAULT = 0x0080;
    private const uint TOKEN_ADJUST_SESSIONID = 0x0100;
    private const uint DISABLE_MAX_PRIVILEGE = 0x0001;
    private const uint SE_GROUP_INTEGRITY = 0x00000020;
    private const int TOKEN_INTEGRITY_LEVEL = 25;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
    private const int JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 258;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;

    private static readonly HashSet<string> LimitedCommands = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "Get-ChildItem", "dir", "ls", "Get-Location", "pwd", "Get-Content", "cat", "type",
        "Select-String", "Get-Item", "Get-ItemProperty", "Test-Path", "Resolve-Path",
        "Get-Process", "Get-Service", "Get-ComputerInfo", "Get-CimInstance",
        "where.exe", "whoami", "hostname", "ipconfig", "ping", "tracert", "nslookup",
        "curl.exe", "findstr", "fc", "sort", "more"
    };

    private static readonly HashSet<string> SandboxCommands = new HashSet<string>(LimitedCommands, StringComparer.OrdinalIgnoreCase)
    {
        "node", "node.exe", "python", "python.exe", "py", "ffmpeg", "ffmpeg.exe",
        "ffprobe", "ffprobe.exe", "New-Item", "Set-Content", "Add-Content", "Copy-Item", "Move-Item"
    };

    private static readonly HashSet<string> DeniedCommands = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "Remove-Item", "Clear-Item", "Clear-Content", "Remove-ItemProperty", "Clear-ItemProperty",
        "Format-Volume", "Clear-Disk", "Initialize-Disk", "Remove-Partition", "diskpart", "format.com",
        "bcdedit", "shutdown.exe", "reg", "reg.exe", "Invoke-Expression", "iex", "Start-Process"
    };

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0 || !String.Equals(args[0], "run", StringComparison.OrdinalIgnoreCase))
            {
                Console.Error.WriteLine("Usage: PokeGate.WindowsHost.exe run --policy limited|sandbox --shell powershell|cmd --cwd PATH --sandbox-dir PATH --timeout-ms N -- COMMAND");
                return 64;
            }

            return Run(args.Skip(1).ToArray());
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Windows sandbox host failed: " + error.Message);
            return 70;
        }
    }

    private static int Run(string[] args)
    {
        string policy = null;
        string shell = null;
        string cwd = null;
        string sandboxDir = null;
        string command = null;
        int timeoutMs = 30000;

        for (int index = 0; index < args.Length; index++)
        {
            if (args[index] == "--" && index + 1 < args.Length)
            {
                command = args[index + 1];
                break;
            }

            if (index + 1 >= args.Length) throw new ArgumentException("Missing value for " + args[index]);
            string value = args[++index];
            switch (args[index - 1])
            {
                case "--policy": policy = value; break;
                case "--shell": shell = value; break;
                case "--cwd": cwd = value; break;
                case "--sandbox-dir": sandboxDir = value; break;
                case "--timeout-ms":
                    if (!Int32.TryParse(value, out timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000)
                        throw new ArgumentException("Invalid timeout.");
                    break;
                default: throw new ArgumentException("Unknown option " + args[index - 1]);
            }
        }

        if (policy != "limited" && policy != "sandbox") throw new ArgumentException("Invalid policy.");
        if (shell != "powershell" && shell != "cmd") throw new ArgumentException("Invalid shell.");
        if (String.IsNullOrWhiteSpace(command)) throw new ArgumentException("Command is required.");
        if (String.IsNullOrWhiteSpace(cwd) || !Directory.Exists(cwd)) throw new DirectoryNotFoundException("Working directory does not exist.");
        if (String.IsNullOrWhiteSpace(sandboxDir) || !Directory.Exists(sandboxDir)) throw new DirectoryNotFoundException("Sandbox directory does not exist.");

        if (shell == "powershell") ValidatePowerShell(command, policy);
        else ValidateCmd(command, policy);

        string systemRoot = Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows";
        string executable = shell == "powershell"
            ? Path.Combine(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
            : Path.Combine(systemRoot, "System32", "cmd.exe");
        string[] childArgs = shell == "powershell"
            ? new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command }
            : new[] { "/d", "/v:off", "/s", "/c", command };

        return RunRestricted(executable, childArgs, cwd, sandboxDir, timeoutMs);
    }

    private static void ValidatePowerShell(string script, string policy)
    {
        Token[] tokens;
        ParseError[] errors;
        ScriptBlockAst ast = Parser.ParseInput(script, out tokens, out errors);
        if (errors.Length > 0) throw new InvalidOperationException("PowerShell parse error: " + errors[0].Message);

        if (ast.FindAll(node =>
                node is RedirectionAst ||
                node is InvokeMemberExpressionAst ||
                node is ScriptBlockExpressionAst ||
                node is SubExpressionAst ||
                node is UsingExpressionAst,
                true).Any())
        {
            throw new InvalidOperationException("Dynamic PowerShell syntax is not allowed in restricted modes.");
        }

        HashSet<string> allowed = policy == "limited" ? LimitedCommands : SandboxCommands;
        foreach (CommandAst commandAst in ast.FindAll(node => node is CommandAst, true).Cast<CommandAst>())
        {
            string name = commandAst.GetCommandName();
            if (String.IsNullOrWhiteSpace(name)) throw new InvalidOperationException("Dynamic command invocation is not allowed.");
            string leafName = Path.GetFileName(name);
            if (DeniedCommands.Contains(name) || DeniedCommands.Contains(leafName))
                throw new InvalidOperationException("Destructive command is blocked: " + name);
            if (!allowed.Contains(name) && !allowed.Contains(leafName))
                throw new InvalidOperationException("Command is not allowlisted for " + policy + " mode: " + name);
        }
    }

    private static void ValidateCmd(string command, string policy)
    {
        if (command.IndexOfAny(new[] { '&', '|', '>', '<', '^', '%', '!' }) >= 0)
            throw new InvalidOperationException("Dynamic CMD syntax is not allowed in restricted modes.");

        string first = command.Trim().Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        if (String.IsNullOrWhiteSpace(first)) throw new InvalidOperationException("Command is required.");
        string leafName = Path.GetFileName(first.Trim('"'));
        HashSet<string> allowed = policy == "limited" ? LimitedCommands : SandboxCommands;
        if (DeniedCommands.Contains(leafName) || !allowed.Contains(leafName))
            throw new InvalidOperationException("Command is not allowlisted for " + policy + " mode: " + leafName);
    }

    private static int RunRestricted(string executable, string[] args, string cwd, string sandboxDir, int timeoutMs)
    {
        IntPtr currentToken;
        if (!OpenProcessToken(Process.GetCurrentProcess().Handle,
            TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID,
            out currentToken)) ThrowLastWin32("OpenProcessToken");

        IntPtr restrictedToken = IntPtr.Zero;
        IntPtr lowIntegritySid = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        PROCESS_INFORMATION processInfo = new PROCESS_INFORMATION();

        try
        {
            if (!CreateRestrictedToken(currentToken, DISABLE_MAX_PRIVILEGE, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out restrictedToken))
                ThrowLastWin32("CreateRestrictedToken");

            if (!ConvertStringSidToSid("S-1-16-4096", out lowIntegritySid)) ThrowLastWin32("ConvertStringSidToSid");
            TOKEN_MANDATORY_LABEL label = new TOKEN_MANDATORY_LABEL();
            label.Label.Sid = lowIntegritySid;
            label.Label.Attributes = SE_GROUP_INTEGRITY;
            if (!SetTokenInformation(restrictedToken, TOKEN_INTEGRITY_LEVEL, ref label,
                Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL)) + GetLengthSid(lowIntegritySid)))
                ThrowLastWin32("SetTokenInformation");

            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) ThrowLastWin32("CreateJobObject");
            ConfigureJob(job);

            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
            startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);

            StringBuilder commandLine = new StringBuilder(QuoteWindowsArgument(executable));
            foreach (string arg in args) commandLine.Append(' ').Append(QuoteWindowsArgument(arg));
            environment = BuildEnvironmentBlock(sandboxDir);

            if (!CreateProcessAsUser(restrictedToken, executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                environment, cwd, ref startup, out processInfo))
                ThrowLastWin32("CreateProcessAsUser");

            if (!AssignProcessToJobObject(job, processInfo.hProcess)) ThrowLastWin32("AssignProcessToJobObject");
            if (ResumeThread(processInfo.hThread) == UInt32.MaxValue) ThrowLastWin32("ResumeThread");

            uint waitResult = WaitForSingleObject(processInfo.hProcess, (uint)timeoutMs);
            if (waitResult == WAIT_TIMEOUT)
            {
                TerminateJobObject(job, 124);
                Console.Error.WriteLine("Command timed out after " + timeoutMs + "ms.");
                return 124;
            }
            if (waitResult != WAIT_OBJECT_0) ThrowLastWin32("WaitForSingleObject");

            uint exitCode;
            if (!GetExitCodeProcess(processInfo.hProcess, out exitCode)) ThrowLastWin32("GetExitCodeProcess");
            return unchecked((int)exitCode);
        }
        finally
        {
            if (processInfo.hThread != IntPtr.Zero) CloseHandle(processInfo.hThread);
            if (processInfo.hProcess != IntPtr.Zero) CloseHandle(processInfo.hProcess);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (lowIntegritySid != IntPtr.Zero) LocalFree(lowIntegritySid);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if (restrictedToken != IntPtr.Zero) CloseHandle(restrictedToken);
            CloseHandle(currentToken);
        }
    }

    private static IntPtr BuildEnvironmentBlock(string sandboxDir)
    {
        SortedDictionary<string, string> variables = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
            variables[Convert.ToString(entry.Key)] = Convert.ToString(entry.Value);
        variables["TEMP"] = sandboxDir;
        variables["TMP"] = sandboxDir;
        variables["POKE_GATE_SANDBOX_DIR"] = sandboxDir;

        StringBuilder block = new StringBuilder();
        foreach (KeyValuePair<string, string> variable in variables)
            block.Append(variable.Key).Append('=').Append(variable.Value).Append('\0');
        block.Append('\0');
        return Marshal.StringToHGlobalUni(block.ToString());
    }

    private static void ConfigureJob(IntPtr job)
    {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        info.BasicLimitInformation.ActiveProcessLimit = 32;
        int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(info, buffer, false);
            if (!SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, buffer, (uint)length))
                ThrowLastWin32("SetInformationJobObject");
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static string QuoteWindowsArgument(string value)
    {
        if (value.Length > 0 && value.All(character => !Char.IsWhiteSpace(character) && character != '"')) return value;
        StringBuilder result = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { backslashes++; continue; }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1).Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes).Append(character);
            backslashes = 0;
        }
        result.Append('\\', backslashes * 2).Append('"');
        return result.ToString();
    }

    private static void ThrowLastWin32(string operation)
    {
        throw new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }

    [StructLayout(LayoutKind.Sequential)] private struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }
    [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb; public string lpReserved, lpDesktop, lpTitle; public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] private struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }

    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool CreateRestrictedToken(IntPtr existingTokenHandle, uint flags, uint disableSidCount, IntPtr sidsToDisable, uint deletePrivilegeCount, IntPtr privilegesToDelete, uint restrictedSidCount, IntPtr sidsToRestrict, out IntPtr newTokenHandle);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool SetTokenInformation(IntPtr tokenHandle, int tokenInformationClass, ref TOKEN_MANDATORY_LABEL tokenInformation, int tokenInformationLength);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessAsUser(IntPtr token, string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSidToSid(string stringSid, out IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern int GetLengthSid(IntPtr sid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int standardHandle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
}
