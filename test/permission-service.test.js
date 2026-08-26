import assert from "node:assert/strict";
import test from "node:test";

import { PermissionService } from "../src/permission-service.js";

function createClock(startMs = 0) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

test("safe and risky tool classification", () => {
  const service = new PermissionService({ secret: "test-secret" });

  assert.equal(service.isRisky("read_file"), false);
  assert.equal(service.isRisky("read_image"), false);
  assert.equal(service.isRisky("list_directory"), false);
  assert.equal(service.isRisky("system_info"), false);

  assert.equal(service.isRisky("run_command"), true);
  assert.equal(service.isRisky("write_file"), true);
  assert.equal(service.isRisky("take_screenshot"), true);
  assert.equal(service.isRisky("run_agent"), true);
  assert.equal(service.isRisky("cancel_agent_run"), true);
});

test("session whitelist match", () => {
  const service = new PermissionService({ secret: "test-secret" });

  service.allowPatternForSession("s1", "rm /tmp/*");

  assert.equal(service.isAllowedBySessionPattern("s1", "rm /tmp/file-a"), true);
});

test("whitelist isolation across sessions", () => {
  const service = new PermissionService({ secret: "test-secret" });

  service.allowPatternForSession("s1", "rm /tmp/*");

  assert.equal(service.isAllowedBySessionPattern("s2", "rm /tmp/file-a"), false);
});

test("expired token invalid", () => {
  const clock = createClock(10_000);
  const service = new PermissionService({ secret: "test-secret", now: clock.now });

  const approval = service.requestApproval("s1", "run_command", { command: "ls" });
  clock.advance(5 * 60 * 1000 + 1);

  const ok = service.validateApprovalToken("s1", approval.token, "run_command", { command: "ls" });
  assert.equal(ok, false);
});

test("hash mismatch invalid", () => {
  const service = new PermissionService({ secret: "test-secret" });

  const approval = service.requestApproval("s1", "run_command", { command: "echo hi" });
  const ok = service.validateApprovalToken("s1", approval.token, "run_command", { command: "echo bye" });

  assert.equal(ok, false);
});

test("consumed token cannot be reused", () => {
  const service = new PermissionService({ secret: "test-secret" });

  const approval = service.requestApproval("s1", "run_command", { command: "pwd" });

  const first = service.validateApprovalToken("s1", approval.token, "run_command", { command: "pwd" });
  const second = service.validateApprovalToken("s1", approval.token, "run_command", { command: "pwd" });

  assert.equal(first, true);
  assert.equal(second, false);
});

test("glob semantics with anchored wildcard", () => {
  const service = new PermissionService({ secret: "test-secret" });

  service.allowPatternForSession("s1", "rm /tmp/*");

  assert.equal(service.isAllowedBySessionPattern("s1", "rm /tmp/a"), true);
  assert.equal(service.isAllowedBySessionPattern("s1", "rm ~/a"), false);
});

test("concurrent approvals generate unique approvalRequestId", async () => {
  const service = new PermissionService({ secret: "test-secret" });

  const approvals = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      Promise.resolve(service.requestApproval("s1", "run_command", { command: `echo ${i}` })),
    ),
  );

  const ids = new Set(approvals.map((item) => item.approvalRequestId));
  assert.equal(ids.size, approvals.length);
});
