export function buildShellInvocation(command, options = {}) {
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error("Command is empty.");
  }

  const currentPlatform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (currentPlatform === "win32") {
    const shellName = (options.shellName || "powershell").toLowerCase();
    if (shellName === "powershell") {
      return {
        executable: env.POKE_GATE_POWERSHELL_PATH?.trim() || "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
        shellName,
      };
    }
    if (shellName === "cmd") {
      return {
        executable: env.ComSpec?.trim() || "cmd.exe",
        args: ["/d", "/v:off", "/s", "/c", command],
        shellName,
      };
    }
    throw new Error(`Unsupported Windows shell: ${options.shellName}`);
  }

  const executable = env.POKE_GATE_SHELL?.trim() || (currentPlatform === "darwin" ? "/bin/zsh" : "/bin/sh");
  return { executable, args: ["-lc", command], shellName: "posix" };
}
