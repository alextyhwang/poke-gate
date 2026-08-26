import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Poke } from "poke";
import { getPokeAuthToken } from "./poke-auth.js";
import { getPlatformPaths } from "./platform-paths.js";

const { configDir: CONFIG_DIR } = getPlatformPaths();
const STATE_PATH = join(CONFIG_DIR, "state.json");

export function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function saveState(state) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export async function getWebhook() {
  const state = loadState();
  if (state.webhookUrl && state.webhookToken) {
    return { webhookUrl: state.webhookUrl, webhookToken: state.webhookToken };
  }

  const token = getPokeAuthToken();
  if (!token) throw new Error("No Poke auth token available.");

  const poke = new Poke({ apiKey: token });
  const result = await poke.createWebhook({ condition: "poke-gate", action: "poke-gate" });

  const webhook = { webhookUrl: result.webhookUrl, webhookToken: result.webhookToken };
  saveState({ ...state, ...webhook });
  return webhook;
}

export async function sendToWebhook(message) {
  const { webhookUrl, webhookToken } = await getWebhook();
  const token = getPokeAuthToken();
  if (!token) throw new Error("No Poke auth token available.");

  const poke = new Poke({ apiKey: token });
  return poke.sendWebhook({ webhookUrl, webhookToken, data: { message } });
}
