# Windows-first Poke Gate plan

The Windows fork keeps the MCP/tunnel core portable while treating Windows as the primary deployment target. The first release targets Windows 11 and Windows 10 22H2 on x64, with ARM64 after the native sandbox and screenshot paths pass integration testing.

## Resident architecture and resource budget

The background deployment should have one resident gateway process, not a resident gateway plus a heavyweight tray runtime. A small native tray/controller may be added only if the combined idle budget still passes.

Release gates on Alayna's computer:

- no Codex, PowerShell, or CMD child process while idle;
- working set at or below 80 MiB for the connected gateway;
- private memory at or below 64 MiB;
- average idle CPU below 0.1% over five minutes;
- no sustained disk writes while connected and inactive;
- no unbounded handle, thread, or memory growth over 24 hours.

The measured bare Node runtime on that Windows computer used 54.7 MiB working set and 18.1 MiB private memory. The actual loaded Windows MCP gateway measured 65.2 MiB steady / 67.3 MiB peak working set and 30.2 MiB peak private memory over 60 seconds, with effectively zero steady-state CPU after warm-up. Node therefore remains the resident core. The optional native C# tray measured another 28.5 MiB working set, so it is disabled by default; a required always-on tray should be rewritten as a small Rust/Win32 controller.

If the connected Windows build exceeds the budget, the resident core moves to Rust (`tokio`, `reqwest`, `windows-rs`) and Node is removed from the installed service. Codex remains an on-demand child process and does not count toward idle use. Tauri is not the fallback because a resident WebView would undermine the memory goal; a Rust service with a native Win32 tray is the preferred low-footprint design.

Run the repeatable core measurement with:

```sh
npm run measure:idle
```

## `run_agent` becomes a Codex run

`run_agent` no longer executes a scheduled JavaScript file. It starts `codex exec` using the Codex installation exposed by T3 Code.

- Required input: `prompt`.
- Optional input: `cwd`.
- Default working directory: the user's Documents known folder.
- Codex sandbox: `--approve-for-me`, which routes approvals through Codex's workspace-write sandbox. Do not also pass `--sandbox`; the verified T3 Code build treats those options as mutually exclusive.
- Approval: exact Poke Gate approval is required before launch.
- Execution is asynchronous and returns a run ID.
- `get_agent_run` returns status and bounded output.
- `cancel_agent_run` cancels a run and also requires approval.
- The legacy scheduled-script CLI is available as `run-scheduled-agent` during migration.

On Alayna's computer, the verified default is `C:\Users\a\Documents`, and T3 Code exposes `codex-cli 0.148.0-alpha.21` with all required `codex exec` options.

A real read-only smoke run completed in 7.1 seconds, returned `READY`, and peaked at 142.4 MiB working set and 80.6 MiB private memory. That memory is on-demand and exits with the run; it is not part of the idle service budget.

## Delivery phases

1. Centralize AppData, Documents, Downloads, logs, runtime, and sandbox paths.
2. Add explicit PowerShell/CMD invocation with no shell nesting by Node.
3. Route restricted Windows commands through PowerShell AST classification in the native host.
4. Add Windows Job Object process-tree ownership for commands and exact process-tree termination for Codex/browser runs.
5. Add a disabled-privilege, Low-integrity restricted token. Consider AppContainer as a later hardening layer; sandbox mode fails closed when the native host is unavailable.
6. Add native screenshots through the interactive user process. A true Session 0 Windows service cannot capture Alayna's desktop, so deployment uses a per-user background process launched at sign-in.
7. Add per-user named-pipe single-instance handling, Scheduled Task startup, and an optional native tray.
8. Package a copied runtime, add Windows CI, deploy to Alayna's computer, and run the connected/24-hour resource soak tests.

## Windows security policy

Full mode supports PowerShell and CMD, but file deletion, disk/volume operations, Registry mutation, elevation, shutdown, boot configuration, and service modification require an exact approval.

Limited mode permits only statically understandable read-only commands. Dynamic invocation, encoded commands, profiles, redirection, nested shells, and ambiguous syntax are rejected.

Sandbox mode permits a broader command set only after the native Windows sandbox host is installed. Missing containment is an error; it never falls back to unsandboxed execution.

The native host will combine a restricted token/AppContainer with a Job Object. Job Objects own and terminate the process tree; AppContainer/restricted-token policy provides filesystem, Registry, network, credential, and UI isolation.
