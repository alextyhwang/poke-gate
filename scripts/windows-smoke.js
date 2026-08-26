import http from "node:http";

import { startMcpServer } from "../src/mcp-server.js";

if (process.platform !== "win32") {
  throw new Error("The Windows smoke test must run on Windows.");
}
if (process.env.POKE_GATE_PERMISSION_MODE !== "limited") {
  throw new Error("Set POKE_GATE_PERMISSION_MODE=limited for this smoke test.");
}

function callTool(port, id, args) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "run_command", arguments: args },
  });

  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      method: "POST",
      path: "/mcp",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Mcp-Session-Id": "windows-smoke",
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    });
    request.on("error", reject);
    request.end(body);
  });
}

const { httpServer, port } = await startMcpServer();
try {
  const commandArgs = { command: "Get-Location", shell: "powershell" };
  const approval = await callTool(port, 1, commandArgs);
  const token = approval.result?.structuredContent?.approvalToken;
  if (!token) throw new Error("The command did not request approval as expected.");

  const executed = await callTool(port, 2, {
    ...commandArgs,
    approve: true,
    approval_token: token,
  });
  if (executed.result?.isError) {
    throw new Error(executed.result.content?.[0]?.text || "Native command execution failed.");
  }
  const commandResult = JSON.parse(executed.result?.content?.[0]?.text || "{}");
  if (!commandResult.sandboxApplied) {
    throw new Error("The native Windows sandbox was not applied.");
  }

  console.log(JSON.stringify({
    status: "ok",
    output: commandResult.stdout.trim(),
    sandboxApplied: true,
  }, null, 2));
} finally {
  await new Promise((resolve) => httpServer.close(resolve));
}
