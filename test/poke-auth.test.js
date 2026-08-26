import assert from "node:assert/strict";
import test from "node:test";

import { ensurePokeAuthenticated, getPokeCredentialsPath, resolvePokeToken } from "../src/poke-auth.js";

test("POKE_API_KEY takes precedence over login token", () => {
  assert.equal(resolvePokeToken({ env: { POKE_API_KEY: "from-env" }, token: "from-login" }), "from-env");
});

test("login token is used when POKE_API_KEY is not set", () => {
  assert.equal(resolvePokeToken({ env: {}, token: "from-login" }), "from-login");
});

test("missing env and login token resolves to undefined", () => {
  assert.equal(resolvePokeToken({ env: {}, token: undefined }), undefined);
});

test("Windows-compatible Poke credentials path follows the SDK layout", () => {
  assert.equal(
    getPokeCredentialsPath({ env: {}, home: "C:\\Users\\demo", platform: "win32" }),
    "C:\\Users\\demo\\.config\\poke\\credentials.json",
  );
});

test("browser authentication is used when device login is unavailable", async () => {
  let savedToken;
  let fallbackError;
  const token = await ensurePokeAuthenticated({
    getTokenImpl: () => undefined,
    isLoggedInImpl: () => false,
    loginImpl: async () => { throw new Error("device endpoint unavailable"); },
    browserTokenImpl: async () => "browser-session-token",
    saveCredentialsImpl: (value) => { savedToken = value; },
    onBrowserLogin: (error) => { fallbackError = error.message; },
  });

  assert.equal(token, "browser-session-token");
  assert.equal(savedToken, "browser-session-token");
  assert.equal(fallbackError, "device endpoint unavailable");
});
