import { startMcpServer, enableLogging, getPermissionMode } from "./mcp-server.js";
import { startTunnel } from "./tunnel.js";
import { startAgentScheduler, stopAgentScheduler } from "./agents.js";
import { sendToWebhook } from "./webhook.js";
import { ensurePokeAuthenticated } from "./poke-auth.js";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import { homedir } from "node:os";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getPlatformPaths } from "./platform-paths.js";

const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
enableLogging(verbose);
const appPaths = getPlatformPaths();
const logFile = process.env.POKE_GATE_LOG_FILE ||
  (process.platform === "win32" ? join(appPaths.logsDir, "gateway.log") : null);

function killExistingPosixInstances() {
  const myPid = process.pid;
  const ppid = process.ppid;
  try {
    const out = execSync("ps -axo pid=,ppid=,command=", { encoding: "utf-8" }).trim();
    const pids = out
      .split("\n")
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!match) return null;
        const [, pid, parentPid, command] = match;
        return { pid: Number(pid), parentPid: Number(parentPid), command };
      })
      .filter((processInfo) => {
        if (!processInfo || processInfo.pid === myPid || processInfo.pid === ppid || processInfo.parentPid === myPid) return false;
        return (
          processInfo.command.includes("node ") &&
          processInfo.command.includes("poke-gate") &&
          (
            processInfo.command.includes("app.js") ||
            processInfo.command.includes(".bin/poke-gate") ||
            processInfo.command.includes("/bin/poke-gate")
          )
        );
      })
      .map(({ pid }) => pid);
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    if (pids.length > 0) log(`Killed ${pids.length} existing poke-gate process(es).`);
  } catch {}
}

async function claimSingleInstance() {
  if (process.platform !== "win32") {
    killExistingPosixInstances();
    return null;
  }

  const userKey = createHash("sha256").update(homedir()).digest("hex").slice(0, 16);
  const pipeName = `\\\\.\\pipe\\poke-gate-${userKey}`;
  const server = net.createServer((socket) => socket.end());

  await new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error("Poke Gate is already running for this Windows user."));
        return;
      }
      reject(error);
    });
    server.listen(pipeName, resolve);
  });
  return server;
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  if (logFile) {
    try {
      mkdirSync(appPaths.logsDir, { recursive: true });
      appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`, "utf8");
    } catch {}
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureAuthenticated() {
  return ensurePokeAuthenticated({
    onLogin: () => log("Signing in to Poke..."),
    onBrowserLogin: (error) => log(`Device login unavailable (${error.message}); opening Chrome for Poke sign-in...`),
  });
}

let currentTunnel = null;
let reconnectWatchdog = null;
let singleInstanceServer = null;

async function connectWithRetry(mcpUrl, token) {
  let attempt = 0;
  const maxDelay = 60_000;

  while (true) {
    attempt++;
    const delay = Math.min(2000 * Math.pow(2, attempt - 1), maxDelay);

    try {
      log(attempt > 1 ? `Reconnecting tunnel (attempt ${attempt})…` : "Connecting tunnel to Poke...");

      const { tunnel } = await startTunnel({
        mcpUrl,
        token,
        onEvent: (type, data) => {
          switch (type) {
            case "connected":
              attempt = 0;
              clearTimeout(reconnectWatchdog);
              reconnectWatchdog = null;
              log(`Tunnel connected (${data.connectionId})`);
              log("Ready — your Poke agent can now access this machine.");
              notifyPoke(data.connectionId);
              startAgentScheduler();
              break;
            case "disconnected":
              log("Tunnel disconnected.");
              scheduleReconnect(mcpUrl, token);
              break;
            case "error":
              log(`Tunnel error: ${data}`);
              break;
            case "tools-synced":
              log(`Tools synced: ${data}`);
              break;
            case "oauth-required":
              log(`OAuth required: ${data}`);
              break;
          }
        },
      });

      currentTunnel = tunnel;
      return;
    } catch (err) {
      log(`Tunnel failed: ${err.message}`);
      log(`Retrying in ${Math.round(delay / 1000)}s…`);
      await sleep(delay);
    }
  }
}

function scheduleReconnect(mcpUrl, token) {
  if (reconnectWatchdog) return;

  log("Waiting 15s for automatic reconnect…");
  reconnectWatchdog = setTimeout(async () => {
    reconnectWatchdog = null;
    log("No reconnect after 15s — creating a fresh tunnel.");

    if (currentTunnel) {
      try { await currentTunnel.stop(); } catch {}
      currentTunnel = null;
    }

    stopAgentScheduler();
    await connectWithRetry(mcpUrl, token);
  }, 15_000);
}

async function main() {
  singleInstanceServer = await claimSingleInstance();
  log("poke-gate starting...");
  log(`Access mode: ${getPermissionMode()}`);

  const token = await ensureAuthenticated();

  const { port } = await startMcpServer();
  log(`MCP server on port ${port}`);

  const mcpUrl = `http://localhost:${port}/mcp`;

  await connectWithRetry(mcpUrl, token);
}

function buildAccessModeMessage(mode) {
  switch (mode) {
    case "limited":
      return (
        "Access mode: Limited. " +
        "You can read files, list directories, and run safe read-only commands (ls, cat, grep, curl, jq…). " +
        "You can also start Codex after an exact chat approval. You cannot write files, take screenshots, or run other commands."
      );
    case "sandbox":
      return (
        "Access mode: Sandbox. " +
        (process.platform === "win32"
          ? "Allowed commands are PowerShell-AST validated and run under a Low-integrity restricted token and Job Object. "
          : "You can read files, list directories, and run commands like brew, node, python, ffmpeg, curl, and more. " +
            "File writes are restricted to Downloads and temporary files by the OS sandbox. ") +
        "Codex can start after an exact chat approval. Screenshots are disabled."
      );
    default:
      return (
        "Access mode: Full. " +
        "You can run shell commands, read files, list directories, take screenshots, and check system info. " +
        "Destructive commands, file writes, and Codex launches require an exact signed approval unless the user explicitly remembers broader approval for the session."
      );
  }
}

async function notifyPoke(connectionId) {
  try {
    const mode = getPermissionMode();
    await sendToWebhook(
      `Hey! I've connected my computer to you via Poke Gate (tunnel: ${connectionId}). ` +
      `${buildAccessModeMessage(mode)} ` +
      `Just use the tools whenever I ask you to do something on my computer. ` +
      `Now reply me with "now I am connected to your computer" but everytime write those replies in most creative fun way.`
    );
    log("Notified Poke agent about connection.");
  } catch (err) {
    log(`Failed to notify Poke: ${err.message}`);
  }
}

process.on("SIGINT", () => {
  log("Shutting down...");
  singleInstanceServer?.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("Shutting down...");
  singleInstanceServer?.close();
  process.exit(0);
});

if (process.platform === "win32") {
  process.on("SIGBREAK", () => {
    log("Shutting down...");
    singleInstanceServer?.close();
    process.exit(0);
  });
}

process.on("uncaughtException", (err) => {
  log(`Uncaught exception: ${err.message}`);
});

process.on("unhandledRejection", (err) => {
  log(`Unhandled rejection: ${err instanceof Error ? err.message : String(err)}`);
});

main();
