import assert from "node:assert/strict";
import test from "node:test";

import { buildShellInvocation } from "../src/command-runner.js";

test("Windows defaults to a profile-free non-interactive PowerShell", () => {
  assert.deepEqual(buildShellInvocation("Get-ChildItem", { platform: "win32", env: {} }), {
    executable: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Get-ChildItem"],
    shellName: "powershell",
  });
});

test("Windows cmd disables AutoRun and delayed expansion", () => {
  assert.deepEqual(buildShellInvocation("dir", {
    platform: "win32",
    shellName: "cmd",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  }), {
    executable: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/v:off", "/s", "/c", "dir"],
    shellName: "cmd",
  });
});

test("unsupported Windows shells fail closed", () => {
  assert.throws(
    () => buildShellInvocation("dir", { platform: "win32", shellName: "bash", env: {} }),
    /Unsupported Windows shell/,
  );
});
