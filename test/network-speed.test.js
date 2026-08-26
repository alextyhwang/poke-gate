import assert from "node:assert/strict";
import test from "node:test";

import { runNetworkSpeedTests } from "../src/mcp-server.js";

test("network speed tests use fetch without shell commands or temporary files", async () => {
  const calls = [];
  const times = [0, 2_000, 3_000, 7_000];
  const result = await runNetworkSpeedTests("both", {
    downloadBytes: 1_000_000,
    uploadBytes: 2_000_000,
    now: () => times.shift(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(url.includes("__down") ? 1_000_000 : 0),
      };
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.downloadMbps, 4);
  assert.equal(result.structuredContent.uploadMbps, 4);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.body.byteLength, 2_000_000);
});

test("network speed tests report endpoint failures", async () => {
  const result = await runNetworkSpeedTests("download", {
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /HTTP 503/);
});
