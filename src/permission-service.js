import { createHash, createHmac, randomUUID } from "node:crypto";

const SAFE_TOOLS = new Set(["read_file", "read_image", "list_directory", "system_info"]);
const RISKY_TOOLS = new Set(["run_command", "write_file", "take_screenshot", "run_agent", "cancel_agent_run"]);

const TOKEN_TTL_MS = 5 * 60 * 1000;

function nowMs(nowFn) {
  const value = nowFn();
  if (value instanceof Date) return value.getTime();
  return Number(value);
}

function normalizeForStableJson(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(normalizeForStableJson);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeForStableJson(value[key]);
    }
    return normalized;
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

function hashArgs(toolArgs) {
  const stable = JSON.stringify(normalizeForStableJson(toolArgs ?? {}));
  return createHash("sha256").update(stable).digest("hex");
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patternMatches(pattern, commandText) {
  const regexSource = `^${pattern.split("*").map(escapeRegex).join(".*")}$`;
  return new RegExp(regexSource).test(commandText);
}

export class PermissionService {
  constructor({ secret, now } = {}) {
    if (!secret) throw new Error("PermissionService requires a secret");

    this.secret = secret;
    this.now = typeof now === "function" ? now : () => Date.now();
    this.pendingApprovals = new Map();
    this.sessionWhitelist = new Map();
  }

  isRisky(toolName) {
    return RISKY_TOOLS.has(toolName);
  }

  requestApproval(sessionId, toolName, toolArgs) {
    const argsHash = hashArgs(toolArgs);
    const approvalRequestId = randomUUID();
    const expiresAt = nowMs(this.now) + TOKEN_TTL_MS;
    const tokenPayload = `${approvalRequestId}:${sessionId}:${toolName}:${argsHash}:${expiresAt}`;
    const token = createHmac("sha256", this.secret).update(tokenPayload).digest("hex");

    this.pendingApprovals.set(token, {
      approvalRequestId,
      sessionId,
      toolName,
      argsHash,
      expiresAt,
      consumed: false,
    });

    return { approvalRequestId, token, expiresAt };
  }

  validateApprovalToken(sessionId, token, toolName, toolArgs) {
    const record = this.pendingApprovals.get(token);
    if (!record) return false;
    if (record.consumed) return false;

    if (nowMs(this.now) > record.expiresAt) {
      this.pendingApprovals.delete(token);
      return false;
    }

    const argsHash = hashArgs(toolArgs);
    if (
      record.sessionId !== sessionId ||
      record.toolName !== toolName ||
      record.argsHash !== argsHash
    ) {
      return false;
    }

    record.consumed = true;
    return true;
  }

  allowPatternForSession(sessionId, pattern) {
    if (!this.sessionWhitelist.has(sessionId)) {
      this.sessionWhitelist.set(sessionId, new Set());
    }
    this.sessionWhitelist.get(sessionId).add(pattern);
  }

  isAllowedBySessionPattern(sessionId, commandText) {
    const patterns = this.sessionWhitelist.get(sessionId);
    if (!patterns) return false;

    for (const pattern of patterns) {
      if (patternMatches(pattern, commandText)) return true;
    }

    return false;
  }

  clearSession(sessionId) {
    this.sessionWhitelist.delete(sessionId);

    for (const [token, record] of this.pendingApprovals.entries()) {
      if (record.sessionId === sessionId) {
        this.pendingApprovals.delete(token);
      }
    }
  }
}

export { SAFE_TOOLS, RISKY_TOOLS, TOKEN_TTL_MS };
