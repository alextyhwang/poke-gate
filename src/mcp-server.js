import http from "node:http";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, unlinkSync } from "node:fs";
import { hostname, platform, arch, uptime, totalmem, freemem, homedir } from "node:os";
import { join, extname } from "node:path";
import { PermissionService } from "./permission-service.js";
import { CodexRunManager } from "./codex-runner.js";
import { getPlatformPaths, resolveUserPath } from "./platform-paths.js";
import { buildShellInvocation } from "./command-runner.js";
import { captureScreenshot } from "./take-screenshot.js";
import { buildWindowsHostInvocation } from "./windows-host.js";

const SERVER_INFO = { name: "poke-gate", version: "0.0.1" };

const COMMAND_TIMEOUT = 30_000;
const RUN_COMMAND_LOOP_SUPPRESSION_MS = 60_000;
const PERMISSION_MODE = normalizePermissionMode(process.env.POKE_GATE_PERMISSION_MODE);
const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";
const TUNNEL_MCP_PATH_RE = /^\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/mcp$/;

let logEnabled = false;

const permissionSecret = process.env.POKE_GATE_HMAC_SECRET || randomBytes(32).toString("hex");
const permissionService = new PermissionService({ secret: permissionSecret });
const codexRunManager = new CodexRunManager();
const platformPaths = getPlatformPaths();
const sessionAutoApproveAllRisky = new Set();
const runCommandLoopState = new Map();

const SAFE_TOOL_NAMES = new Set(["read_file", "read_image", "list_directory", "system_info", "network_speed", "get_agent_run"]);

const DESTRUCTIVE_COMMAND_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bunlink\b/i,
  /\bmkfs\b/i,
  /\bdiskutil\s+erase/i,
  /\b(?:remove-item|clear-item|clear-content|remove-itemproperty|clear-itemproperty)\b/i,
  /\b(?:format-volume|clear-disk|initialize-disk|remove-partition)\b/i,
  /\breg(?:\.exe)?\s+(?:add|delete|import|restore|load|unload)\b/i,
  /\b(?:diskpart|format\.com|bcdedit|shutdown\.exe)\b/i,
  /\bstart-process\b[^\n]*\b-verb\s+runas\b/i,
  />\s*\//,
  /(^|\s)>(?!>)/,
];

const LIMITED_RUN_COMMANDS = new Set([
  "curl", "yt-dlp", "youtube-dl",
  "ls", "pwd", "cat", "grep", "find", "head", "tail", "wc", "sed", "awk",
  "which", "command", "echo", "stat", "du", "df", "ps", "uname", "sw_vers", "whoami",
  "jq", "diff",
]);

const SANDBOX_RUN_COMMANDS = new Set([
  "yt-dlp", "youtube-dl",
  "ffmpeg", "ffprobe",
  "brew", "node", "python", "python3",
  "curl", "dd", "rm", "mktemp", "mkdir", "cp", "mv", "touch", "jq", "diff",
  "ls", "pwd", "cat", "grep", "find", "head", "tail", "wc", "sed", "awk",
  "which", "command", "echo", "stat", "du", "df", "ps", "uname", "sw_vers", "whoami",
]);

const WINDOWS_LIMITED_RUN_COMMANDS = new Set([
  "get-childitem", "dir", "ls", "get-location", "pwd", "get-content", "cat", "type",
  "select-string", "get-item", "get-itemproperty", "test-path", "resolve-path",
  "get-process", "get-service", "get-computerinfo", "get-ciminstance",
  "where.exe", "whoami", "hostname", "ipconfig", "ping", "tracert", "nslookup",
  "curl.exe", "findstr", "fc", "sort", "more",
]);

const WINDOWS_SANDBOX_RUN_COMMANDS = new Set([
  ...WINDOWS_LIMITED_RUN_COMMANDS,
  "node", "node.exe", "python", "python.exe", "py", "ffmpeg", "ffmpeg.exe", "ffprobe", "ffprobe.exe",
  "new-item", "set-content", "add-content", "copy-item", "move-item", "remove-item",
]);

const DANGEROUS_COMMAND_PATTERNS = [
  /(^|\s)sudo(\s|$)/i,
  /rm\s+-rf\b/i,
  /rm\s+-fr\b/i,
  /rm\s+-r\s+-f\b/i,
  /diskutil\s+erase/i,
  /mkfs(\.|\s|$)/i,
  /shutdown(\s|$)/i,
  /reboot(\s|$)/i,
  /launchctl\s+bootout/i,
  /chmod\s+777/i,
  /curl\s+[^\n]*\|\s*(sh|bash|zsh)/i,
  /\b(?:format-volume|clear-disk|initialize-disk|remove-partition|diskpart|format\.com|bcdedit)\b/i,
  /\breg(?:\.exe)?\s+(?:add|delete|import|restore|load|unload)\b/i,
  /\bstart-process\b[^\n]*\b-verb\s+runas\b/i,
  /\b(?:invoke-expression|iex)\b/i,
  /-(?:encodedcommand|enc)\b/i,
];

function normalizePermissionMode(value) {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (mode === "limited" || mode === "sandbox") return mode;
  return "full";
}

export function getPermissionMode() {
  return PERMISSION_MODE;
}

export function enableLogging(enabled) {
  logEnabled = enabled;
}

function logTool(name, args, result) {
  if (!logEnabled) return;
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] tool: ${name}`);
  if (name === "run_command") console.log(`[${ts}]   $ ${args.command}${args.cwd ? ` (in ${args.cwd})` : ""}`);
  else if (name === "read_file") console.log(`[${ts}]   read: ${args.path}`);
  else if (name === "write_file") console.log(`[${ts}]   write: ${args.path}`);
  else if (name === "list_directory") console.log(`[${ts}]   ls: ${args.path || "~"}`);
  if (result?.isError) console.log(`[${ts}]   error`);
}

const TOOLS = [
  {
    name: "run_command",
    description:
      "Execute a shell command on the user's machine and return stdout, stderr, and exit code. " +
      "Use this to run any CLI command (ls, cat, git, brew, python, curl, etc.). " +
      "Commands run in a shell with a 30-second timeout.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
        shell: { type: "string", enum: ["powershell", "cmd"], description: "Windows shell (optional; defaults to PowerShell on Windows)" },
        cwd: { type: "string", description: "Working directory (optional, defaults to home)" },
        approval_token: { type: "string", description: "Approval token returned by a previous AWAITING_APPROVAL response" },
        approve: { type: "boolean", description: "Set true after user approves in chat" },
        remember_in_session: { type: "boolean", description: "If true, remember this command for this session" },
        remember_all_risky: { type: "boolean", description: "If true, auto-approve all risky tools for this session" },
      },
      required: ["command"],
    },
  },
  {
    name: "network_speed",
    description:
      "Run a built-in internet speed test and return download/upload Mbps. " +
      "Uses Cloudflare speed endpoints internally without requiring shell pipelines.",
    inputSchema: {
      type: "object",
      properties: {
        tests: {
          type: "string",
          description: "Which direction to test",
          enum: ["download", "upload", "both"],
        },
      },
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file on the user's machine.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file on the user's machine. Creates the file if it doesn't exist, overwrites if it does.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file" },
        content: { type: "string", description: "Content to write" },
        approval_token: { type: "string", description: "Approval token returned by a previous AWAITING_APPROVAL response" },
        approve: { type: "boolean", description: "Set true after user approves in chat" },
        remember_all_risky: { type: "boolean", description: "If true, auto-approve all risky tools for this session" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_directory",
    description: "List files and directories at a given path on the user's machine.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (defaults to home)" },
      },
    },
  },
  {
    name: "system_info",
    description: "Get system information: OS, hostname, architecture, uptime, memory, and home directory.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_image",
    description:
      "Read an image or binary file and return it as base64-encoded data. " +
      "Supports png, jpg, jpeg, gif, webp, pdf, and any other binary file. " +
      "Returns the base64 string and MIME type.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the image/binary file" },
      },
      required: ["path"],
    },
  },
  {
    name: "run_agent",
    description:
      "Start a non-interactive Codex run through the local T3 Code/Codex installation. " +
      "The run uses a workspace-write Codex sandbox and defaults to the user's Documents folder. " +
      "Returns immediately with a run ID; use get_agent_run to inspect progress and results.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Task for Codex to complete" },
        cwd: { type: "string", description: "Working directory (optional, defaults to the user's Documents folder)" },
        approval_token: { type: "string", description: "Approval token returned by a previous AWAITING_APPROVAL response" },
        approve: { type: "boolean", description: "Set true after user approves in chat" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "get_agent_run",
    description: "Get the current status and captured output of a Codex run started by run_agent.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Run ID returned by run_agent" },
      },
      required: ["id"],
    },
  },
  {
    name: "cancel_agent_run",
    description: "Cancel a running Codex run.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Run ID returned by run_agent" },
        approval_token: { type: "string", description: "Approval token returned by a previous AWAITING_APPROVAL response" },
        approve: { type: "boolean", description: "Set true after user approves in chat" },
      },
      required: ["id"],
    },
  },
  {
    name: "take_screenshot",
    description: "Capture all displays as a PNG. Returns the image directly and optionally saves it to a requested path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "PNG file path to persist the screenshot (optional; otherwise a temporary file is used)" },
        approval_token: { type: "string", description: "Approval token returned by a previous AWAITING_APPROVAL response" },
        approve: { type: "boolean", description: "Set true after user approves in chat" },
        remember_all_risky: { type: "boolean", description: "If true, auto-approve all risky tools for this session" },
      },
    },
  },
];

function sanitizeToolArgs(args = {}) {
  const {
    approval_token: _approvalToken,
    approve: _approve,
    remember_in_session: _rememberInSession,
    remember_all_risky: _rememberAllRisky,
    ...cleanArgs
  } = args;
  return cleanArgs;
}

function extractSessionId(req) {
  const sessionId = req.headers["mcp-session-id"];
  if (typeof sessionId === "string" && sessionId.trim().length > 0) {
    return sessionId.trim();
  }
  return "default";
}

export function normalizeMcpPathname(pathname) {
  if (pathname === "/mcp" || TUNNEL_MCP_PATH_RE.test(pathname)) return "/mcp";
  return pathname;
}

function buildApprovalResponse(name, cleanArgs, approval) {
  const summary = name === "run_command"
    ? `Run command: ${cleanArgs.command}`
    : name === "write_file"
      ? `Write file: ${cleanArgs.path}`
      : name === "run_agent"
        ? `Start Codex in ${cleanArgs.cwd || "Documents"}: ${cleanArgs.prompt}`
        : name === "cancel_agent_run"
          ? `Cancel Codex run: ${cleanArgs.id}`
          : "Take screenshot";

  return {
    content: [{
      type: "text",
      text:
        "AWAITING_APPROVAL: Ask the user in chat to approve this action. " +
        "Re-call the same tool with approve=true and approval_token from structuredContent. " +
        "Optional: remember_in_session=true (same command) or remember_all_risky=true (all risky tools for this session).",
    }],
    structuredContent: {
      status: "AWAITING_APPROVAL",
      approvalRequestId: approval.approvalRequestId,
      approvalToken: approval.token,
      expiresAt: new Date(approval.expiresAt).toISOString(),
      toolName: name,
      summary,
    },
    isError: true,
  };
}

function buildPolicyDeniedResponse(message) {
  return {
    content: [{ type: "text", text: `Blocked by access mode policy: ${message}` }],
    isError: true,
  };
}

function splitCommandSegments(commandText) {
  return commandText
    .split(/&&|\|\||[;&|\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function extractExecutable(segment) {
  const withoutParens = segment.replace(/^[()\s]+/, "");
  const withoutSudo = withoutParens.replace(/^sudo\s+/, "");
  const match = withoutSudo.match(/^([A-Za-z0-9_./-]+)/);
  if (!match) return "";
  const raw = match[1];
  const parts = raw.split("/");
  return parts[parts.length - 1].toLowerCase();
}

function hasDangerousPattern(commandText) {
  return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(commandText));
}

function isDestructiveInFullMode(name, cleanArgs) {
  if (name === "write_file") return true;
  if (name === "run_agent" || name === "cancel_agent_run") return true;
  if (name === "run_command") {
    const cmd = typeof cleanArgs.command === "string" ? cleanArgs.command : "";
    return DESTRUCTIVE_COMMAND_PATTERNS.some((p) => p.test(cmd));
  }
  return false;
}

function validateRunCommandAgainstAllowlist(commandText, allowlist, options = {}) {
  if (typeof commandText !== "string" || commandText.trim().length === 0) {
    return "Command is empty.";
  }

  if (hasDangerousPattern(commandText)) {
    return "Command matches a dangerous pattern.";
  }

  if (options.platformName === "win32" && /\$\(|`|--%|(^|\s)&\s*[$(]/.test(commandText)) {
    return "Dynamic PowerShell invocation is not permitted in this mode.";
  }
  if (/[<>]/.test(commandText)) {
    return "Shell redirection is not permitted in this mode.";
  }

  const segments = splitCommandSegments(commandText);
  for (const segment of segments) {
    const executable = extractExecutable(segment);
    if (!executable || !allowlist.has(executable)) {
      return `Command '${executable || "unknown"}' is not permitted in this mode.`;
    }
  }

  return null;
}

export function evaluateAccessPolicy(toolName, cleanArgs, mode = PERMISSION_MODE, platformName = platform()) {
  if (mode === "full") return null;

  if (mode === "limited") {
    if (SAFE_TOOL_NAMES.has(toolName)) return null;
    if (toolName === "run_agent" || toolName === "cancel_agent_run") return null;
    if (toolName === "run_command") {
      const allowlist = platformName === "win32" ? WINDOWS_LIMITED_RUN_COMMANDS : LIMITED_RUN_COMMANDS;
      return validateRunCommandAgainstAllowlist(cleanArgs.command, allowlist, { platformName });
    }
    if (toolName === "write_file" || toolName === "take_screenshot") {
      return "This tool is disabled in Limited Permissions mode.";
    }
    return "This tool is not permitted in Limited Permissions mode.";
  }

  if (SAFE_TOOL_NAMES.has(toolName)) return null;
  if (toolName === "run_agent" || toolName === "cancel_agent_run") return null;

  if (toolName === "run_command") {
    const allowlist = platformName === "win32" ? WINDOWS_SANDBOX_RUN_COMMANDS : SANDBOX_RUN_COMMANDS;
    return validateRunCommandAgainstAllowlist(cleanArgs.command, allowlist, { platformName });
  }

  if (toolName === "write_file" || toolName === "take_screenshot") {
    return "This tool is disabled in Sandbox mode.";
  }

  return "This tool is not permitted in Sandbox mode.";
}

function getRunCommandFingerprint(cleanArgs) {
  return JSON.stringify({
    command: typeof cleanArgs.command === "string" ? cleanArgs.command : "",
    cwd: typeof cleanArgs.cwd === "string" && cleanArgs.cwd.trim().length > 0 ? cleanArgs.cwd.trim() : "__HOME__",
  });
}

function getRunCommandState(sessionId) {
  if (!runCommandLoopState.has(sessionId)) {
    runCommandLoopState.set(sessionId, {
      inFlight: new Set(),
      recentFailures: new Map(),
    });
  }

  return runCommandLoopState.get(sessionId);
}

export function resetRunCommandLoopGuard() {
  runCommandLoopState.clear();
}

export function prepareRunCommandAttempt(sessionId, cleanArgs, now = Date.now()) {
  const state = getRunCommandState(sessionId);
  const fingerprint = getRunCommandFingerprint(cleanArgs);
  const recentFailure = state.recentFailures.get(fingerprint);

  if (state.inFlight.has(fingerprint)) {
    return {
      suppressed: true,
      reason: "already_running",
      fingerprint,
    };
  }

  if (recentFailure && now < recentFailure.suppressedUntil) {
    return {
      suppressed: true,
      reason: "recent_failure",
      fingerprint,
    };
  }

  state.inFlight.add(fingerprint);
  return {
    suppressed: false,
    fingerprint,
  };
}

export function recordRunCommandOutcome(sessionId, cleanArgs, result, now = Date.now()) {
  const state = getRunCommandState(sessionId);
  const fingerprint = getRunCommandFingerprint(cleanArgs);

  state.inFlight.delete(fingerprint);

  if (result.exitCode === 0) {
    state.recentFailures.delete(fingerprint);
    return;
  }

  state.recentFailures.set(fingerprint, {
    exitCode: result.exitCode,
    suppressedUntil: now + RUN_COMMAND_LOOP_SUPPRESSION_MS,
  });
}

function buildRunCommandSuppressionResponse(cleanArgs, reason) {
  const detail = reason === "already_running"
    ? "The same command is already running."
    : "The same command just failed, so repeated retries are being suppressed for a short period.";

  return {
    content: [{
      type: "text",
      text: `${detail} Change the command or wait before retrying: ${cleanArgs.command}`,
    }],
    isError: true,
  };
}

function quoteForSingleShellArg(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function buildSandboxProfile() {
  const userHome = homedir();
  return [
    "(version 1)",
    "(deny default)",
    "(import \"system.sb\")",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow file-read*)",
    "(allow network-outbound)",
    "(allow sysctl-read)",
    "(allow file-write*",
    `  (subpath "${userHome}/Downloads")`,
    "  (subpath \"/private/tmp\")",
    "  (subpath \"/tmp\")",
    ")",
  ].join("\n");
}

export function buildSandboxWrappedCommand(command) {
  const profile = buildSandboxProfile();
  return `${SANDBOX_EXEC_PATH} -p ${quoteForSingleShellArg(profile)} /bin/zsh -lc ${quoteForSingleShellArg(command)}`;
}

function runCommand(command, cwd, options = {}) {
  return new Promise((res) => {
    const dir = resolveUserPath(cwd, { paths: platformPaths, fallback: platformPaths.homeDir });
    const sandboxRequested = options.permissionMode === "sandbox";
    const windowsRestrictedRequested = platform() === "win32" &&
      (options.permissionMode === "limited" || options.permissionMode === "sandbox");
    const macSandboxApplied = sandboxRequested && platform() !== "win32" && existsSync(SANDBOX_EXEC_PATH);
    const sandboxApplied = windowsRestrictedRequested || macSandboxApplied;
    if (sandboxRequested && !sandboxApplied) {
      res({
        stdout: "",
        stderr: "OS sandbox is unavailable; command was not run.",
        exitCode: 1,
        durationMs: 0,
        timedOut: false,
        sandboxApplied: false,
      });
      return;
    }

    let invocation;
    try {
      invocation = windowsRestrictedRequested
        ? buildWindowsHostInvocation(command, {
          policy: options.permissionMode,
          shellName: options.shellName,
          cwd: dir,
          paths: platformPaths,
          timeoutMs: COMMAND_TIMEOUT,
        })
        : macSandboxApplied
        ? { executable: SANDBOX_EXEC_PATH, args: ["-p", buildSandboxProfile(), "/bin/zsh", "-lc", command] }
        : buildShellInvocation(command, { shellName: options.shellName });
    } catch (error) {
      res({ stdout: "", stderr: error.message, exitCode: 1, durationMs: 0, timedOut: false, sandboxApplied: false });
      return;
    }

    const start = Date.now();
    execFile(invocation.executable, invocation.args, {
      cwd: dir,
      timeout: windowsRestrictedRequested ? COMMAND_TIMEOUT + 2_000 : COMMAND_TIMEOUT,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const durationMs = Date.now() - start;

      res({
        stdout: stdout.slice(0, 50_000),
        stderr: stderr.slice(0, 10_000),
        exitCode: error ? (error.code ?? 1) : 0,
        durationMs,
        timedOut: Boolean(
          (windowsRestrictedRequested && Number(error?.code) === 124) ||
          (error?.killed && error?.signal === "SIGTERM"),
        ),
        sandboxApplied,
      });
    });
  });
}

function previewText(text, limit = 220) {
  if (typeof text !== "string") return "";
  return text.trim().replace(/\s+/g, " ").slice(0, limit);
}

function logCommandPreview(args, result) {
  if (!logEnabled) return;
  const ts = new Date().toISOString().slice(11, 19);
  const timeoutSuffix = result.timedOut ? " timeout" : "";
  const sandboxSuffix = result.sandboxApplied ? " sandbox=os" : " sandbox=none";
  const cwdText = args.cwd ? ` (in ${args.cwd})` : "";

  console.log(`[${ts}]   terminal preview:`);
  console.log(`[${ts}]     $ ${args.command}${cwdText}`);
  console.log(`[${ts}]     process: exit=${result.exitCode} duration=${result.durationMs}ms${timeoutSuffix}${sandboxSuffix}`);

  const stdoutPreview = previewText(result.stdout);
  const stderrPreview = previewText(result.stderr);
  if (stdoutPreview) console.log(`[${ts}]     stdout: ${stdoutPreview}`);
  if (stderrPreview) console.log(`[${ts}]     stderr: ${stderrPreview}`);
}

function toMbps(bytes, seconds) {
  if (!Number.isFinite(bytes) || !Number.isFinite(seconds) || seconds <= 0) return null;
  return (bytes * 8) / seconds / 1_000_000;
}

async function fetchWithTimeout(url, options, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function runNetworkSpeedTests(testSelection = "both", options = {}) {
  const tests = typeof testSelection === "string" ? testSelection : "both";
  const runDownload = tests === "download" || tests === "both";
  const runUpload = tests === "upload" || tests === "both";

  if (!runDownload && !runUpload) {
    return {
      content: [{ type: "text", text: "Invalid test selection. Use download, upload, or both." }],
      isError: true,
    };
  }

  const downloadBytes = options.downloadBytes ?? 25 * 1024 * 1024;
  const uploadBytes = options.uploadBytes ?? 10 * 1024 * 1024;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => performance.now());
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT;
  let dlSeconds = null;
  let ulSeconds = null;
  let dlMbps = null;
  let ulMbps = null;
  const errors = [];

  if (runDownload) {
    try {
      const startedAt = now();
      const response = await fetchWithTimeout(
        `https://speed.cloudflare.com/__down?bytes=${downloadBytes}`,
        {},
        timeoutMs,
        fetchImpl,
      );
      if (!response.ok) throw new Error(`download endpoint returned HTTP ${response.status}`);
      const body = await response.arrayBuffer();
      dlSeconds = (now() - startedAt) / 1000;
      dlMbps = toMbps(body.byteLength, dlSeconds);
    } catch (error) {
      errors.push(`download: ${error.message}`);
    }
  }

  if (runUpload) {
    try {
      const uploadBody = Buffer.alloc(uploadBytes);
      const startedAt = now();
      const response = await fetchWithTimeout(
        "https://speed.cloudflare.com/__up",
        { method: "POST", body: uploadBody },
        timeoutMs,
        fetchImpl,
      );
      if (!response.ok) throw new Error(`upload endpoint returned HTTP ${response.status}`);
      await response.arrayBuffer();
      ulSeconds = (now() - startedAt) / 1000;
      ulMbps = toMbps(uploadBytes, ulSeconds);
    } catch (error) {
      errors.push(`upload: ${error.message}`);
    }
  }

    const lines = ["Network Speed Test"]; 
    if (runDownload) {
      lines.push(dlMbps === null
        ? "- Download: unavailable"
        : `- Download: ${dlMbps.toFixed(2)} Mbps (${dlSeconds.toFixed(2)}s for 25 MiB)`);
    }
    if (runUpload) {
      lines.push(ulMbps === null
        ? "- Upload: unavailable"
        : `- Upload: ${ulMbps.toFixed(2)} Mbps (${ulSeconds.toFixed(2)}s for 10 MiB)`);
    }

    const response = {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: {
        downloadMbps: dlMbps,
        uploadMbps: ulMbps,
        downloadSeconds: Number.isFinite(dlSeconds) ? dlSeconds : null,
        uploadSeconds: Number.isFinite(ulSeconds) ? ulSeconds : null,
      },
    };

    if (errors.length > 0 || (runDownload && dlMbps === null) || (runUpload && ulMbps === null)) {
      response.isError = true;
      response.content[0].text += `\n\nDetails: ${errors.join("; ") || "speed test failed"}`;
    }

    return response;
}

function handleToolCall(name, args, context = {}) {
  const sessionId = context.sessionId || "default";
  const cleanArgs = sanitizeToolArgs(args);

  const policyRejection = evaluateAccessPolicy(name, cleanArgs);
  if (policyRejection) {
    const blocked = buildPolicyDeniedResponse(policyRejection);
    logTool(name, cleanArgs, blocked);
    return blocked;
  }

  const needsApproval = PERMISSION_MODE === "full"
    ? isDestructiveInFullMode(name, cleanArgs)
    : permissionService.isRisky(name);

  if (needsApproval) {
    const commandText = typeof cleanArgs.command === "string" ? cleanArgs.command : "";
    const alreadyAllowed = sessionAutoApproveAllRisky.has(sessionId) ||
      (commandText && permissionService.isAllowedBySessionPattern(sessionId, commandText));

    if (!alreadyAllowed) {
      const hasApprovalToken = Boolean(args.approval_token);
      const isApproved = args.approve === true && hasApprovalToken
        ? permissionService.validateApprovalToken(sessionId, args.approval_token, name, cleanArgs)
        : false;

      if (!isApproved) {
        const approval = permissionService.requestApproval(sessionId, name, cleanArgs);
        return buildApprovalResponse(name, cleanArgs, approval);
      }

      if (name === "run_command" && args.remember_in_session === true && commandText) {
        permissionService.allowPatternForSession(sessionId, commandText);
      }
      if (args.remember_all_risky === true) {
        sessionAutoApproveAllRisky.add(sessionId);
      }
    }
  }

  switch (name) {
    case "network_speed": {
      logTool(name, cleanArgs);
      return runNetworkSpeedTests(cleanArgs.tests).then((response) => {
        logTool(name, cleanArgs, response);
        return response;
      });
    }

    case "run_command": {
      const attempt = prepareRunCommandAttempt(sessionId, cleanArgs);
      if (attempt.suppressed) {
        const r = buildRunCommandSuppressionResponse(cleanArgs, attempt.reason);
        logTool(name, cleanArgs, r);
        return r;
      }

      logTool(name, cleanArgs);
      return runCommand(cleanArgs.command, cleanArgs.cwd, {
        permissionMode: PERMISSION_MODE,
        shellName: cleanArgs.shell,
      }).then((result) => {
        recordRunCommandOutcome(sessionId, cleanArgs, result);
        logCommandPreview(cleanArgs, result);
        const r = { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        if (result.exitCode !== 0) r.isError = true;
        logTool(name, cleanArgs, r);
        return r;
      });
    }

    case "read_file": {
      try {
        const p = resolveUserPath(cleanArgs.path, { paths: platformPaths });
        const text = readFileSync(p, "utf-8");
        const r = { content: [{ type: "text", text: text.slice(0, 100_000) }] };
        logTool(name, cleanArgs, r);
        return r;
      } catch (err) {
        const r = { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        logTool(name, cleanArgs, r);
        return r;
      }
    }

    case "write_file": {
      try {
        const p = resolveUserPath(cleanArgs.path, { paths: platformPaths });
        writeFileSync(p, cleanArgs.content);
        const r = { content: [{ type: "text", text: `Written to ${p}` }] };
        logTool(name, cleanArgs, r);
        return r;
      } catch (err) {
        const r = { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        logTool(name, cleanArgs, r);
        return r;
      }
    }

    case "list_directory": {
      try {
        const dir = resolveUserPath(cleanArgs.path, { paths: platformPaths });
        const entries = readdirSync(dir).map((entry) => {
          try {
            const s = statSync(join(dir, entry));
            return `${s.isDirectory() ? "d" : "-"} ${entry}`;
          } catch {
            return `? ${entry}`;
          }
        });
        const r = { content: [{ type: "text", text: entries.join("\n") }] };
        logTool(name, cleanArgs, r);
        return r;
      } catch (err) {
        const r = { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        logTool(name, cleanArgs, r);
        return r;
      }
    }

    case "system_info": {
      const info = {
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        uptime: `${Math.floor(uptime() / 3600)}h ${Math.floor((uptime() % 3600) / 60)}m`,
        totalMemory: `${Math.round(totalmem() / 1024 / 1024 / 1024)}GB`,
        freeMemory: `${Math.round(freemem() / 1024 / 1024 / 1024)}GB`,
        homeDir: homedir(),
        nodeVersion: process.version,
      };
      logTool(name, cleanArgs);
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }

    case "read_image": {
      try {
        const p = resolveUserPath(cleanArgs.path, { paths: platformPaths });
        const ext = extname(p).toLowerCase().slice(1);
        const mimeMap = {
          png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
          gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
          pdf: "application/pdf", ico: "image/x-icon", bmp: "image/bmp",
        };
        const mimeType = mimeMap[ext] || "application/octet-stream";
        const buf = readFileSync(p);
        const base64 = buf.toString("base64");
        logTool(name, cleanArgs);

        if (mimeType.startsWith("image/")) {
          return {
            content: [
              { type: "image", data: base64, mimeType },
              { type: "text", text: `Image: ${p} (${mimeType}, ${buf.length} bytes)` },
            ],
          };
        }
        return {
          content: [
            { type: "text", text: `File: ${p} (${mimeType}, ${buf.length} bytes)\nBase64: ${base64.slice(0, 200)}${base64.length > 200 ? "..." : ""}` },
          ],
        };
      } catch (err) {
        const r = { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        logTool(name, cleanArgs, r);
        return r;
      }
    }

    case "run_agent": {
      try {
        const run = codexRunManager.start({ prompt: cleanArgs.prompt, cwd: cleanArgs.cwd });
        logTool(name, { prompt: cleanArgs.prompt, cwd: run.cwd });
        return {
          content: [{
            type: "text",
            text: `Codex run started. Run ID: ${run.id}\nWorking directory: ${run.cwd}\nUse get_agent_run with this ID to check progress.`,
          }],
          structuredContent: run,
        };
      } catch (err) {
        const r = { content: [{ type: "text", text: `Could not start Codex: ${err.message}` }], isError: true };
        logTool(name, cleanArgs, r);
        return r;
      }
    }

    case "get_agent_run": {
      const run = codexRunManager.get(cleanArgs.id);
      if (!run) {
        return { content: [{ type: "text", text: `Codex run not found: ${cleanArgs.id}` }], isError: true };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(run, null, 2) }],
        structuredContent: run,
      };
    }

    case "cancel_agent_run": {
      const run = codexRunManager.cancel(cleanArgs.id);
      if (!run) {
        return { content: [{ type: "text", text: `Codex run not found: ${cleanArgs.id}` }], isError: true };
      }
      return {
        content: [{ type: "text", text: `Codex run ${run.id} is ${run.status}.` }],
        structuredContent: run,
      };
    }

    case "take_screenshot": {
      logTool(name, cleanArgs);
      let screenshot;
      try {
        screenshot = captureScreenshot({ path: cleanArgs.path });
        return {
          content: [
            { type: "image", data: screenshot.png.toString("base64"), mimeType: "image/png" },
            { type: "text", text: cleanArgs.path ? `Screenshot saved to ${screenshot.path}` : "Screenshot captured." },
          ],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Screenshot failed: ${error.message}` }], isError: true };
      } finally {
        if (screenshot?.temporary) {
          try { unlinkSync(screenshot.path); } catch {}
        }
      }
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}

function handleJsonRpc(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "This server gives you access to the user's machine. " +
            "You can run shell commands, read/write files, list directories, and get system info. " +
            "Use these tools to help the user with OS-level tasks.",
        },
      };

    case "notifications/initialized":
      return null;

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

    case "tools/call": {
      const result = handleToolCall(params.name, params.arguments || {}, msg.__context || {});
      if (result instanceof Promise) {
        return result.then((r) => ({ jsonrpc: "2.0", id, result: r }));
      }
      return { jsonrpc: "2.0", id, result };
    }

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    default:
      if (!id) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function writeMcpEventStream(req, res) {
  const sessionId = extractSessionId(req);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Mcp-Session-Id": sessionId,
  });
  res.write(": connected\n\n");

  const keepAlive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 25_000);

  req.on("close", () => clearInterval(keepAlive));
}

export function startMcpServer(port = 0) {
  return new Promise((resolve, reject) => {
    const httpServer = http.createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Accept, X-Poke-User-Id");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url, "http://localhost");
      const pathname = normalizeMcpPathname(url.pathname);

      if (pathname === "/mcp" && req.method === "GET") {
        const accept = req.headers.accept || "";
        if (accept.includes("text/event-stream")) {
          writeMcpEventStream(req, res);
        } else {
          res.writeHead(405, { "Content-Type": "text/plain", Allow: "POST, OPTIONS" });
          res.end("MCP endpoint expects POST, or GET with Accept: text/event-stream");
        }
        return;
      }

      if (pathname === "/mcp" && req.method === "POST") {
        try {
          const body = await readBody(req);
          const parsed = JSON.parse(body);

          const sessionId = extractSessionId(req);
          const responseHeaders = {
            "Content-Type": "application/json",
            "Mcp-Session-Id": sessionId,
          };

          if (Array.isArray(parsed)) {
            const results = [];
            for (const msg of parsed) {
              const m = { ...msg, __context: { sessionId } };
              const r = handleJsonRpc(m);
              const resolved = r instanceof Promise ? await r : r;
              if (resolved) results.push(resolved);
            }
            res.writeHead(200, responseHeaders);
            res.end(JSON.stringify(results));
          } else {
            const m = { ...parsed, __context: { sessionId } };
            let result = handleJsonRpc(m);
            if (result instanceof Promise) result = await result;
            if (result) {
              res.writeHead(200, responseHeaders);
              res.end(JSON.stringify(result));
            } else {
              res.writeHead(204, { "Mcp-Session-Id": sessionId });
              res.end();
            }
          }
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
        }
        return;
      }

      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    httpServer.on("error", reject);
    httpServer.listen(port, "127.0.0.1", () => {
      resolve({ httpServer, port: httpServer.address().port });
    });
  });
}
