import { execFileSync } from "node:child_process";
import path from "node:path";

export function buildProcessTreeTerminationInvocation(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("A valid child process ID is required.");
  }

  const currentPlatform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (currentPlatform !== "win32") return null;

  const executable = env.SystemRoot
    ? path.win32.join(env.SystemRoot, "System32", "taskkill.exe")
    : "taskkill.exe";
  return { executable, args: ["/PID", String(pid), "/T", "/F"] };
}

export function terminateChildProcessTree(child, options = {}) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0 || child.killed) return false;

  const currentPlatform = options.platform ?? process.platform;
  if (currentPlatform === "win32") {
    const invocation = buildProcessTreeTerminationInvocation(child.pid, options);
    try {
      execFileSync(invocation.executable, invocation.args, {
        stdio: "ignore",
        windowsHide: true,
      });
      return true;
    } catch {
      try {
        return child.kill();
      } catch {
        return false;
      }
    }
  }

  try {
    return child.kill("SIGTERM");
  } catch {
    return false;
  }
}
