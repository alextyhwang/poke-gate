# Windows deployment

Windows runs Poke Gate as an interactive per-user background task at sign-in. This is intentional: a Session 0 Windows service cannot capture the signed-in user's desktop. The notification-area controller is optional.

## Install

From Windows PowerShell in a checkout with `npm ci` already completed:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

The default install:

- copies the application and a private Node runtime to `%LOCALAPPDATA%\Poke Gate`;
- compiles the native security host with the built-in .NET Framework compiler;
- marks `%LOCALAPPDATA%\Poke Gate\sandbox` as Low integrity;
- registers a per-user `Poke Gate` Scheduled Task at logon;
- uses Limited mode unless `-PermissionMode full` or `-PermissionMode sandbox` is supplied;
- does not start immediately unless `-StartNow` is supplied.

Add `-InstallTray $true` to register the optional C# notification-area controller. It can start or stop the gateway and open `%LOCALAPPDATA%\Poke Gate\logs`. It is off by default because the measured tray footprint would push the combined idle working set above the release budget.

The installer prefers a system Node installation, then a bundled `runtime\windows-x64\node.exe`, then a Codex-managed Node runtime. It copies the selected executable into Poke Gate's own data directory, so later T3 Code updates cannot invalidate the startup task.

## Codex runs

`run_agent` launches `codex exec` asynchronously, requires an exact approval, and defaults to the user's Documents known folder. `get_agent_run` reports progress; `cancel_agent_run` terminates the exact Codex process tree. On Windows, Poke Gate discovers the T3 plugin Codex executable under `%USERPROFILE%\.codex` or the Codex app runtime under `%LOCALAPPDATA%\OpenAI\Codex`.

## Command containment

Limited and Sandbox commands route through `PokeGate.WindowsHost.exe`. The helper:

- parses PowerShell with `System.Management.Automation.Language.Parser`;
- rejects parse errors, dynamic invocation, member invocation, redirection, and non-allowlisted commands;
- starts PowerShell or CMD with profiles and AutoRun disabled;
- disables token privileges and assigns Low mandatory integrity;
- gives the child only the Low-integrity sandbox directory for temporary writes;
- assigns the suspended child to a kill-on-close Job Object before it can execute;
- limits the tree to 32 processes and kills it on timeout.

The native host fails closed. Full mode keeps direct PowerShell/CMD execution, but destructive commands and Codex launches still require Poke Gate approval.

## Measured resource use

Measurements on Alayna's Windows 11 x64 computer (16 GiB RAM, Node 24.19):

| Component | Working set | Private memory | Idle CPU |
| --- | ---: | ---: | ---: |
| Bare Node runtime | 54.7 MiB | 18.1 MiB | no sampled growth |
| Loaded MCP gateway, 60-second sample | 65.2 MiB steady / 67.3 MiB peak | 30.2 MiB peak | effectively 0% after warm-up |
| Optional native C# tray | 28.5 MiB peak | 21.9 MiB peak | 0% sampled |
| One read-only Codex run | 142.4 MiB peak | 80.6 MiB peak | on-demand only; exited after 7.1 s |

The default background-only Node design passes the 80 MiB working-set and 64 MiB private-memory targets. A resident Rust rewrite is not justified by current measurements. If a tray is required while retaining the 80 MiB combined limit, replace only the C# tray with a Rust/Win32 controller. A five-minute connected sample and 24-hour soak remain release gates.
