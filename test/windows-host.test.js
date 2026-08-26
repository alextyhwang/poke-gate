import assert from "node:assert/strict";
import test from "node:test";

import { buildWindowsHostInvocation } from "../src/windows-host.js";

const paths = {
  platform: "win32",
  homeDir: "C:\\Users\\demo",
  dataDir: "C:\\Users\\demo\\AppData\\Local\\Poke Gate",
  sandboxDir: "/Users/captainatw/poke-gate/test",
};

test("Windows restricted commands route through the native host", () => {
  const invocation = buildWindowsHostInvocation("Get-ChildItem", {
    executable: "C:\\PokeGate.WindowsHost.exe",
    paths,
    cwd: "C:\\Users\\demo\\Documents",
    policy: "limited",
    timeoutMs: 5_000,
  });

  assert.equal(invocation.executable, "C:\\PokeGate.WindowsHost.exe");
  assert.deepEqual(invocation.args, [
    "run",
    "--policy", "limited",
    "--shell", "powershell",
    "--cwd", "C:\\Users\\demo\\Documents",
    "--sandbox-dir", paths.sandboxDir,
    "--timeout-ms", "5000",
    "--", "Get-ChildItem",
  ]);
});

test("Windows host invocation preserves explicit CMD selection", () => {
  const invocation = buildWindowsHostInvocation("dir", {
    executable: "C:\\PokeGate.WindowsHost.exe",
    paths,
    shellName: "cmd",
  });
  assert.equal(invocation.shellName, "cmd");
  assert.equal(invocation.args.includes("cmd"), true);
});
