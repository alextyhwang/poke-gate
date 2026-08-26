param(
  [string]$SourceDirectory = (Split-Path -Parent $PSScriptRoot),
  [string]$DataDirectory = (Join-Path $env:LOCALAPPDATA "Poke Gate"),
  [string]$InstallDirectory,
  [string]$NodeSource,
  [ValidateSet("full", "limited", "sandbox")]
  [string]$PermissionMode = "limited",
  [bool]$RegisterStartup = $true,
  [bool]$InstallTray = $false,
  [switch]$StartNow
)

$ErrorActionPreference = "Stop"
if (-not $InstallDirectory) {
  $InstallDirectory = Join-Path $DataDirectory "app"
}

$SourceDirectory = [IO.Path]::GetFullPath($SourceDirectory)
$DataDirectory = [IO.Path]::GetFullPath($DataDirectory)
$InstallDirectory = [IO.Path]::GetFullPath($InstallDirectory)
if (-not (Test-Path -LiteralPath (Join-Path $SourceDirectory "src\app.js"))) {
  throw "SourceDirectory is not a Poke Gate checkout: $SourceDirectory"
}
if (-not (Test-Path -LiteralPath (Join-Path $SourceDirectory "node_modules\poke"))) {
  throw "Production dependency is missing. Run npm ci before installing."
}

if (-not $NodeSource) {
  $pathNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($pathNode) {
    $NodeSource = $pathNode.Source
  } else {
    $bundledNode = Join-Path $SourceDirectory "runtime\windows-x64\node.exe"
    if (Test-Path -LiteralPath $bundledNode) {
      $NodeSource = $bundledNode
    } else {
      $codexRuntimeRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\runtimes\cua_node"
      $NodeSource = Get-ChildItem -LiteralPath $codexRuntimeRoot -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1 -ExpandProperty FullName
    }
  }
}
if (-not $NodeSource -or -not (Test-Path -LiteralPath $NodeSource)) {
  throw "Node.js was not found. Pass -NodeSource or bundle runtime\windows-x64\node.exe."
}

New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $DataDirectory -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $InstallDirectory "node_modules") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $DataDirectory "runtime") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $DataDirectory "logs") -Force | Out-Null

foreach ($name in @("src", "bin", "scripts", "native")) {
  Copy-Item -LiteralPath (Join-Path $SourceDirectory $name) -Destination $InstallDirectory -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $SourceDirectory "package.json") -Destination $InstallDirectory -Force
Copy-Item -LiteralPath (Join-Path $SourceDirectory "node_modules\poke") -Destination (Join-Path $InstallDirectory "node_modules") -Recurse -Force

$installedNode = Join-Path $DataDirectory "runtime\node.exe"
Copy-Item -LiteralPath $NodeSource -Destination $installedNode -Force

$nativeOutput = Join-Path $DataDirectory "native"
$sandboxDirectory = Join-Path $DataDirectory "sandbox"
& (Join-Path $InstallDirectory "native\windows\build.ps1") -OutputDirectory $nativeOutput -SandboxDirectory $sandboxDirectory | Out-Null
$nativeHost = Join-Path $nativeOutput "PokeGate.WindowsHost.exe"
if (-not (Test-Path -LiteralPath $nativeHost)) {
  throw "The native Windows host was not built."
}

$taskName = "Poke Gate"
if ($RegisterStartup) {
  $entryPoint = Join-Path $InstallDirectory "bin\poke-gate.js"
  $action = New-ScheduledTaskAction -Execute $installedNode -Argument ("`"{0}`" --mode {1}" -f $entryPoint, $PermissionMode) -WorkingDirectory $InstallDirectory
  $userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
  $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Poke Gate per-user background gateway" -Force | Out-Null

  if ($InstallTray) {
    $trayTaskName = "Poke Gate Tray"
    $trayExecutable = Join-Path $nativeOutput "PokeGate.Tray.exe"
    $trayAction = New-ScheduledTaskAction -Execute $trayExecutable -Argument ("--logs `"{0}`"" -f (Join-Path $DataDirectory "logs")) -WorkingDirectory $DataDirectory
    Register-ScheduledTask -TaskName $trayTaskName -Action $trayAction -Trigger $trigger -Principal $principal -Settings $settings -Description "Optional Poke Gate notification-area controller" -Force | Out-Null
  }
}

if ($StartNow) {
  if (-not $RegisterStartup) {
    throw "-StartNow requires -RegisterStartup `$true."
  }
  Start-ScheduledTask -TaskName $taskName
}

[pscustomobject]@{
  InstallDirectory = $InstallDirectory
  DataDirectory = $DataDirectory
  Node = $installedNode
  NativeHost = $nativeHost
  SandboxDirectory = $sandboxDirectory
  PermissionMode = $PermissionMode
  StartupRegistered = $RegisterStartup
  TrayInstalled = $InstallTray
  Started = [bool]$StartNow
} | ConvertTo-Json -Depth 3
