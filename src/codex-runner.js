import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { getPlatformPaths, resolveUserPath } from "./platform-paths.js";
import { terminateChildProcessTree } from "./process-control.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_CHARS = 100_000;

function appendCapped(current, chunk) {
  const next = current + String(chunk);
  return next.length <= MAX_OUTPUT_CHARS ? next : next.slice(-MAX_OUTPUT_CHARS);
}

export function resolveCodexWorkingDirectory(cwd, options = {}) {
  const paths = options.paths ?? getPlatformPaths(options);
  const resolved = resolveUserPath(cwd, {
    paths,
    fallback: paths.documentsDir,
  });

  if (!existsSync(resolved)) {
    throw new Error(`Codex working directory does not exist: ${resolved}`);
  }
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`Codex working directory is not a directory: ${resolved}`);
  }
  return resolved;
}

export function findCodexExecutable(options = {}) {
  const env = options.env ?? process.env;
  const paths = options.paths ?? getPlatformPaths(options);
  if (env.POKE_GATE_CODEX_PATH?.trim()) return env.POKE_GATE_CODEX_PATH.trim();
  if (paths.platform !== "win32") return "codex";

  const candidates = [join(paths.homeDir, ".codex", "plugins", ".plugin-appserver", "codex.exe")];
  const localAppData = env.LOCALAPPDATA || join(paths.homeDir, "AppData", "Local");
  const codexBinRoot = join(localAppData, "OpenAI", "Codex", "bin");
  try {
    candidates.push(...readdirSync(codexBinRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(codexBinRoot, entry.name, "codex.exe"))
      .filter(existsSync)
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs));
  } catch {}

  return candidates.find(existsSync) ?? "codex.exe";
}

export function buildCodexExecInvocation({ prompt, cwd, env = process.env, paths } = {}) {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("Codex prompt is required.");
  }

  const workingDirectory = resolveCodexWorkingDirectory(cwd, { paths });
  const executable = findCodexExecutable({ env, paths });
  const args = [
    "exec",
    "--cd",
    workingDirectory,
    "--skip-git-repo-check",
    "--approve-for-me",
    "--json",
    "--color",
    "never",
    prompt.trim(),
  ];

  return { executable, args, cwd: workingDirectory };
}

export class CodexRunManager {
  constructor(options = {}) {
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.now = options.now ?? (() => new Date());
    this.paths = options.paths ?? getPlatformPaths(options);
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.runs = new Map();
  }

  start({ prompt, cwd } = {}) {
    const invocation = buildCodexExecInvocation({ prompt, cwd, env: this.env, paths: this.paths });
    const id = randomUUID();
    const startedAt = this.now();
    const child = this.spawnImpl(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: this.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const run = {
      id,
      status: "running",
      prompt: prompt.trim(),
      cwd: invocation.cwd,
      pid: child.pid ?? null,
      startedAt: startedAt.toISOString(),
      finishedAt: null,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      child,
      timer: null,
    };
    this.runs.set(id, run);

    child.stdout?.on("data", (chunk) => {
      run.stdout = appendCapped(run.stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      run.stderr = appendCapped(run.stderr, chunk);
    });
    child.once("error", (error) => {
      if (run.status !== "running") return;
      run.status = "failed";
      run.stderr = appendCapped(run.stderr, error.message);
      run.finishedAt = this.now().toISOString();
      clearTimeout(run.timer);
    });
    child.once("close", (exitCode, signal) => {
      if (run.status === "timed_out" || run.status === "cancelled") return;
      run.exitCode = exitCode;
      run.signal = signal;
      run.status = exitCode === 0 ? "completed" : "failed";
      run.finishedAt = this.now().toISOString();
      clearTimeout(run.timer);
    });

    run.timer = setTimeout(() => {
      if (run.status !== "running") return;
      run.status = "timed_out";
      run.finishedAt = this.now().toISOString();
      terminateChildProcessTree(child);
    }, this.timeoutMs);
    run.timer.unref?.();

    return this.get(id);
  }

  get(id) {
    const run = this.runs.get(id);
    if (!run) return null;
    const { child: _child, timer: _timer, ...publicRun } = run;
    return publicRun;
  }

  cancel(id) {
    const run = this.runs.get(id);
    if (!run) return null;
    if (run.status === "running") {
      run.status = "cancelled";
      run.finishedAt = this.now().toISOString();
      clearTimeout(run.timer);
      terminateChildProcessTree(run.child);
    }
    return this.get(id);
  }

  async wait(id, options = {}) {
    const pollIntervalMs = options.pollIntervalMs ?? 100;
    while (true) {
      const run = this.get(id);
      if (!run) return null;
      if (run.status !== "running") return run;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

export function extractCodexFinalMessage(stdout) {
  if (typeof stdout !== "string") return "";
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const event = JSON.parse(lines[index]);
      if (event?.item?.type === "agent_message" && typeof event.item.text === "string") {
        return event.item.text;
      }
      if (typeof event?.message === "string") return event.message;
    } catch {}
  }
  return "";
}

export { DEFAULT_TIMEOUT_MS };
