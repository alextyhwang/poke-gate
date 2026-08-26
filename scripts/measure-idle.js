import { startMcpServer } from "../src/mcp-server.js";
import "../src/tunnel.js";

const sampleMs = Number.parseInt(process.env.POKE_GATE_IDLE_SAMPLE_MS || "5000", 10);
const { httpServer, port } = await startMcpServer();

await new Promise((resolve) => setTimeout(resolve, 2_000));
globalThis.gc?.();
await new Promise((resolve) => setTimeout(resolve, 250));

const startedAt = process.hrtime.bigint();
const cpuStarted = process.cpuUsage();
await new Promise((resolve) => setTimeout(resolve, sampleMs));

const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
const cpu = process.cpuUsage(cpuStarted);
const memory = process.memoryUsage();
const cpuPercent = ((cpu.user + cpu.system) / 1000 / elapsedMs) * 100;

console.log(JSON.stringify({
  platform: process.platform,
  architecture: process.arch,
  nodeVersion: process.version,
  sampleMs,
  port,
  rssMiB: Number((memory.rss / 1024 / 1024).toFixed(1)),
  heapUsedMiB: Number((memory.heapUsed / 1024 / 1024).toFixed(1)),
  heapTotalMiB: Number((memory.heapTotal / 1024 / 1024).toFixed(1)),
  externalMiB: Number((memory.external / 1024 / 1024).toFixed(1)),
  averageCpuPercent: Number(cpuPercent.toFixed(3)),
}, null, 2));

await new Promise((resolve) => httpServer.close(resolve));
