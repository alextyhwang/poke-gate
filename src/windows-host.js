import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getPlatformPaths } from "./platform-paths.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function findWindowsHost(options = {}) {
  const env = options.env ?? process.env;
  const paths = options.paths ?? getPlatformPaths(options);
  const candidates = [
    env.POKE_GATE_WINDOWS_HOST,
    join(paths.dataDir, "native", "PokeGate.WindowsHost.exe"),
    join(sourceRoot, "native", "windows", "bin", "PokeGate.WindowsHost.exe"),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function buildWindowsHostInvocation(command, options = {}) {
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error("Command is empty.");
  }

  const paths = options.paths ?? getPlatformPaths({ ...options, platform: "win32" });
  const executable = options.executable ?? findWindowsHost({ ...options, paths });
  if (!executable) throw new Error("Windows sandbox host is not installed; command was not run.");
  if (!existsSync(paths.sandboxDir)) {
    throw new Error("Windows sandbox directory is not installed; command was not run.");
  }

  const policy = options.policy === "sandbox" ? "sandbox" : "limited";
  const shell = options.shellName === "cmd" ? "cmd" : "powershell";
  const cwd = options.cwd ?? paths.homeDir;
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    executable,
    args: [
      "run",
      "--policy", policy,
      "--shell", shell,
      "--cwd", cwd,
      "--sandbox-dir", paths.sandboxDir,
      "--timeout-ms", String(timeoutMs),
      "--", command,
    ],
    shellName: shell,
  };
}
