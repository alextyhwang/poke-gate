import assert from "node:assert/strict";
import test from "node:test";

import { WINDOWS_CAPTURE_SCRIPT } from "../src/take-screenshot.js";

test("Windows screenshot captures the complete virtual screen", () => {
  assert.match(WINDOWS_CAPTURE_SCRIPT, /SystemInformation\]::VirtualScreen/);
  assert.match(WINDOWS_CAPTURE_SCRIPT, /CopyFromScreen/);
  assert.match(WINDOWS_CAPTURE_SCRIPT, /ImageFormat\]::Png/);
  assert.match(WINDOWS_CAPTURE_SCRIPT, /Dispose\(\)/);
});
