#!/usr/bin/env node

const args = process.argv.slice(2);

const VALID_MODES = ['full', 'limited', 'sandbox'];

function parseMode() {
  const idx = args.indexOf('--mode');
  if (idx === -1) return null;
  const value = args[idx + 1];
  if (!value || !VALID_MODES.includes(value)) {
    console.error(`Invalid --mode value. Must be one of: ${VALID_MODES.join(', ')}`);
    process.exit(1);
  }
  return value;
}

async function main() {
  if (args[0] === 'run-agent') {
    const runArgs = args.slice(1);
    const cwdIdx = runArgs.indexOf('--cwd');
    let cwd;
    if (cwdIdx !== -1) {
      cwd = runArgs[cwdIdx + 1];
      if (!cwd) {
        console.error('Missing value for --cwd.');
        process.exit(1);
      }
      runArgs.splice(cwdIdx, 2);
    }
    const prompt = runArgs.join(' ').trim();
    if (!prompt) {
      console.error('Usage: poke-gate run-agent [--cwd <directory>] <prompt>');
      console.error('Example: poke-gate run-agent "Summarize my documents"');
      process.exit(1);
    }
    const { CodexRunManager, extractCodexFinalMessage } = await import('../src/codex-runner.js');
    const manager = new CodexRunManager();
    const started = manager.start({ prompt, cwd });
    console.log(`Codex run ${started.id} started in ${started.cwd}`);
    const completed = await manager.wait(started.id);
    const finalMessage = extractCodexFinalMessage(completed.stdout);
    if (finalMessage) console.log(finalMessage);
    if (completed.stderr.trim()) console.error(completed.stderr.trim());
    if (completed.status !== 'completed') process.exitCode = completed.exitCode || 1;
  } else if (args[0] === 'run-scheduled-agent') {
    const name = args[1];
    if (!name) {
      console.error('Usage: poke-gate run-scheduled-agent <name>');
      process.exit(1);
    }
    const { runAgent } = await import('../src/agents.js');
    await runAgent(name);
  } else if (args[0] === 'agent' && args[1] === 'get') {
    const name = args[2];
    if (!name) {
      console.error('Usage: poke-gate agent get <name>');
      console.error('Example: poke-gate agent get beeper');
      process.exit(1);
    }
    const { downloadAgent } = await import('../src/agents.js');
    await downloadAgent(name);
  } else if (args[0] === 'agent' && args[1] === 'create') {
    const promptIdx = args.indexOf('--prompt');
    const prompt =
      promptIdx !== -1 ? args.slice(promptIdx + 1).join(' ') : args.slice(2).join(' ') || null;
    const { createAgent } = await import('../src/agent-create.js');
    await createAgent(prompt);
  } else if (args[0] === 'download-macos') {
    const { downloadMacOSApp } = await import('../src/download-macos.js');
    await downloadMacOSApp();
  } else if (args[0] === 'disconnect-all') {
    const { disconnectAllCommand } = await import('../src/disconnect-all.js');
    await disconnectAllCommand(args.slice(1));
  } else if (args[0] === 'take-screenshot') {
    const { takeScreenshot } = await import('../src/take-screenshot.js');
    await takeScreenshot();
  } else {
    const mode = parseMode();
    if (mode) {
      process.env.POKE_GATE_PERMISSION_MODE = mode;
    }
    await import('../src/app.js');
  }
}

main();
