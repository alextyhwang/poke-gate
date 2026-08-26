import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  buildCodexExecInvocation,
  CodexRunManager,
  extractCodexFinalMessage,
  findCodexExecutable,
} from "../src/codex-runner.js";

const workspace = process.cwd();
const paths = { platform: process.platform, homeDir: workspace, documentsDir: workspace };

test("Codex runs default to Documents with a workspace-write sandbox", () => {
  const invocation = buildCodexExecInvocation({
    prompt: "Organize my notes",
    env: { POKE_GATE_CODEX_PATH: "/opt/codex" },
    paths,
  });

  assert.equal(invocation.executable, "/opt/codex");
  assert.equal(invocation.cwd, workspace);
  assert.deepEqual(invocation.args, [
    "exec",
    "--cd",
    workspace,
    "--skip-git-repo-check",
    "--approve-for-me",
    "--json",
    "--color",
    "never",
    "Organize my notes",
  ]);
});

test("Codex run manager tracks an asynchronous run", async () => {
  const child = new EventEmitter();
  child.pid = 42;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const calls = [];

  const manager = new CodexRunManager({
    paths,
    env: {},
    spawnImpl(executable, args, options) {
      calls.push({ executable, args, options });
      return child;
    },
  });

  const started = manager.start({ prompt: "Summarize the documents" });
  assert.equal(started.status, "running");
  assert.equal(started.pid, 42);
  assert.equal(started.cwd, workspace);
  assert.equal(calls[0].options.shell, false);

  child.stdout.write('{"type":"message","text":"done"}\n');
  child.emit("close", 0, null);
  await new Promise((resolve) => setImmediate(resolve));

  const completed = manager.get(started.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.exitCode, 0);
  assert.match(completed.stdout, /done/);
});

test("Codex final message is extracted from JSONL output", () => {
  const output = [
    JSON.stringify({ type: "thread.started", thread_id: "abc" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Finished." } }),
  ].join("\n");

  assert.equal(extractCodexFinalMessage(output), "Finished.");
});

test("Windows falls back to codex.exe when no installed Codex path is found", () => {
  assert.equal(findCodexExecutable({
    env: {},
    paths: {
      platform: "win32",
      homeDir: "/Users/captainatw/poke-gate/test/fixtures/no-windows-home",
    },
  }), "codex.exe");
});
