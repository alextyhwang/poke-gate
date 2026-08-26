param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "bin"),
  [string]$SandboxDirectory = (Join-Path $env:LOCALAPPDATA "Poke Gate\sandbox")
)

$ErrorActionPreference = "Stop"
$compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $compiler)) {
  $compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path -LiteralPath $compiler)) {
  throw "The Windows .NET Framework C# compiler was not found."
}

$automationAssembly = [System.Management.Automation.PSObject].Assembly.Location
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$output = Join-Path $OutputDirectory "PokeGate.WindowsHost.exe"
$source = Join-Path $PSScriptRoot "PokeGate.WindowsHost.cs"

& $compiler /nologo /target:exe /optimize+ /platform:x64 "/out:$output" "/reference:$automationAssembly" $source
if ($LASTEXITCODE -ne 0) {
  throw "Windows host compilation failed with exit code $LASTEXITCODE."
}

Write-Output $output

$trayOutput = Join-Path $OutputDirectory "PokeGate.Tray.exe"
$traySource = Join-Path $PSScriptRoot "PokeGate.Tray.cs"
& $compiler /nologo /target:winexe /optimize+ /platform:x64 "/out:$trayOutput" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll $traySource
if ($LASTEXITCODE -ne 0) {
  throw "Windows tray compilation failed with exit code $LASTEXITCODE."
}

Write-Output $trayOutput

New-Item -ItemType Directory -Path $SandboxDirectory -Force | Out-Null
& (Join-Path $env:WINDIR "System32\icacls.exe") $SandboxDirectory /setintegritylevel "(OI)(CI)L" | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Failed to mark the sandbox directory as low integrity."
}

Write-Output $SandboxDirectory
