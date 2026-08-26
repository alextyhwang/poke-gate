import { homedir } from "node:os";
import path from "node:path";

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}

export function getPlatformPaths(options = {}) {
  const env = options.env ?? process.env;
  const currentPlatform = options.platform ?? process.platform;
  const userHome = options.home ?? homedir();
  const pathApi = currentPlatform === "win32" ? path.win32 : path.posix;

  if (currentPlatform === "win32") {
    const roamingRoot = firstNonEmpty(env.APPDATA, pathApi.join(userHome, "AppData", "Roaming"));
    const localRoot = firstNonEmpty(env.LOCALAPPDATA, pathApi.join(userHome, "AppData", "Local"));
    const configDir = firstNonEmpty(env.POKE_GATE_CONFIG_DIR, pathApi.join(roamingRoot, "Poke Gate"));
    const dataDir = firstNonEmpty(env.POKE_GATE_DATA_DIR, pathApi.join(localRoot, "Poke Gate"));

    return {
      platform: currentPlatform,
      homeDir: userHome,
      documentsDir: firstNonEmpty(env.POKE_GATE_DOCUMENTS_DIR, pathApi.join(userHome, "Documents")),
      downloadsDir: firstNonEmpty(env.POKE_GATE_DOWNLOADS_DIR, pathApi.join(userHome, "Downloads")),
      configDir,
      dataDir,
      agentsDir: pathApi.join(configDir, "agents"),
      logsDir: pathApi.join(dataDir, "logs"),
      runtimeDir: pathApi.join(dataDir, "runtime"),
      sandboxDir: pathApi.join(dataDir, "sandbox"),
      authBrowserProfileDir: pathApi.join(dataDir, "auth-browser-profile"),
    };
  }

  const configRoot = firstNonEmpty(env.XDG_CONFIG_HOME, pathApi.join(userHome, ".config"));
  const dataRoot = firstNonEmpty(env.XDG_DATA_HOME, pathApi.join(userHome, ".local", "share"));
  const configDir = firstNonEmpty(env.POKE_GATE_CONFIG_DIR, pathApi.join(configRoot, "poke-gate"));
  const dataDir = firstNonEmpty(env.POKE_GATE_DATA_DIR, pathApi.join(dataRoot, "poke-gate"));

  return {
    platform: currentPlatform,
    homeDir: userHome,
    documentsDir: firstNonEmpty(env.POKE_GATE_DOCUMENTS_DIR, pathApi.join(userHome, "Documents")),
    downloadsDir: firstNonEmpty(env.POKE_GATE_DOWNLOADS_DIR, pathApi.join(userHome, "Downloads")),
    configDir,
    dataDir,
    agentsDir: pathApi.join(configDir, "agents"),
    logsDir: pathApi.join(dataDir, "logs"),
    runtimeDir: pathApi.join(dataDir, "runtime"),
    sandboxDir: pathApi.join(dataDir, "sandbox"),
    authBrowserProfileDir: pathApi.join(dataDir, "auth-browser-profile"),
  };
}

export function expandHomePath(value, userHome = homedir()) {
  if (typeof value !== "string") return value;
  if (value === "~") return userHome;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    const pathApi = /^[A-Za-z]:[\\/]/.test(userHome) ? path.win32 : path.posix;
    return pathApi.join(userHome, value.slice(2));
  }
  return value;
}

export function resolveUserPath(value, options = {}) {
  const paths = options.paths ?? getPlatformPaths(options);
  const pathApi = paths.platform === "win32" ? path.win32 : path.posix;
  const fallback = options.fallback ?? paths.homeDir;
  const expanded = expandHomePath(firstNonEmpty(value, fallback), paths.homeDir);
  return pathApi.isAbsolute(expanded) ? pathApi.resolve(expanded) : pathApi.resolve(fallback, expanded);
}
