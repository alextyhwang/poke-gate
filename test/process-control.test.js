import assert from "node:assert/strict";
import test from "node:test";

import { buildProcessTreeTerminationInvocation } from "../src/process-control.js";

test("Windows process trees terminate through taskkill with an exact PID", () => {
  assert.deepEqual(
    buildProcessTreeTerminationInvocation(4242, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
    }),
    {
      executable: "C:\\Windows\\System32\\taskkill.exe",
      args: ["/PID", "4242", "/T", "/F"],
    },
  );
});

test("invalid process IDs fail closed", () => {
  assert.throws(() => buildProcessTreeTerminationInvocation(0), /valid child process ID/);
});
