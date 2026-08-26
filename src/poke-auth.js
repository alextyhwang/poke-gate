import { getToken, isLoggedIn, login } from "poke";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { getPokeBrowserSessionToken } from "./browser-session-token.js";

export function getPokeCredentialsPath(options = {}) {
  const env = options.env ?? process.env;
  const userHome = options.home ?? homedir();
  const pathApi = (options.platform ?? process.platform) === "win32" ? path.win32 : path.posix;
  const configRoot = env.XDG_CONFIG_HOME || pathApi.join(userHome, ".config");
  return pathApi.join(configRoot, "poke", "credentials.json");
}

export function savePokeCredentials(token, options = {}) {
  if (typeof token !== "string" || token.length === 0) throw new Error("Poke token is empty.");
  const credentialsPath = getPokeCredentialsPath(options);
  mkdirSync(path.dirname(credentialsPath), { recursive: true });
  writeFileSync(credentialsPath, JSON.stringify({ token }, null, 2), "utf8");
  try { chmodSync(credentialsPath, 0o600); } catch {}
  return credentialsPath;
}

export function resolvePokeToken(options = {}) {
  const { env = process.env } = options;
  const loginToken = Object.hasOwn(options, "token") ? options.token : getToken();
  return env.POKE_API_KEY || loginToken;
}

export function getPokeAuthToken() {
  return resolvePokeToken();
}

export async function ensurePokeAuthenticated(options = {}) {
  const {
    onLogin,
    onBrowserLogin,
    loginImpl = login,
    browserTokenImpl = getPokeBrowserSessionToken,
    saveCredentialsImpl = savePokeCredentials,
    getTokenImpl = getPokeAuthToken,
    isLoggedInImpl = isLoggedIn,
  } = options;

  if (!getTokenImpl() && !isLoggedInImpl()) {
    onLogin?.();
    try {
      await loginImpl();
    } catch (loginError) {
      onBrowserLogin?.(loginError);
      const browserToken = await browserTokenImpl();
      saveCredentialsImpl(browserToken);
      return browserToken;
    }
  }

  const token = getTokenImpl();
  if (!token) {
    throw new Error("Authentication failed: no token returned by Poke SDK.");
  }

  return token;
}
