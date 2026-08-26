[CmdletBinding()]
param(
  [string]$TaskName = "Poke Gate",
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"

function Wait-ForUser {
  if (-not $NoPause) {
    [void](Read-Host "Press Enter to close")
  }
}

try {
  Write-Host "Poke Gate API key setup" -ForegroundColor Cyan
  Write-Host "Create a key at https://poke.com/kitchen/api-keys, then paste it below."
  Write-Host "The key is entered privately and is not printed to the screen."
  Write-Host ""

  $secureKey = Read-Host "Poke API key" -AsSecureString
  $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  try {
    $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
  }

  if ([string]::IsNullOrWhiteSpace($apiKey)) {
    throw "No API key was entered."
  }

  try {
    $profileResponse = Invoke-WebRequest `
      -Uri "https://poke.com/api/v1/user/profile" `
      -Headers @{ Authorization = ("Bearer " + $apiKey.Trim()) } `
      -UseBasicParsing `
      -TimeoutSec 15
    if ([int]$profileResponse.StatusCode -ne 200) {
      throw "Poke returned HTTP $([int]$profileResponse.StatusCode)."
    }
  } catch {
    throw "Poke rejected this key. Create an account key at https://poke.com/kitchen/api-keys, not an MCP Integration key."
  }

  $credentialsDirectory = Join-Path $env:USERPROFILE ".config\poke"
  $credentialsPath = Join-Path $credentialsDirectory "credentials.json"
  New-Item -ItemType Directory -Path $credentialsDirectory -Force | Out-Null
  $credentialsJson = @{ token = $apiKey.Trim() } | ConvertTo-Json
  [IO.File]::WriteAllText($credentialsPath, $credentialsJson, (New-Object Text.UTF8Encoding($false)))

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $accessRule = New-Object Security.AccessControl.FileSystemAccessRule(
    $identity,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
  )
  $acl = New-Object Security.AccessControl.FileSecurity
  $acl.SetOwner([Security.Principal.NTAccount]$identity)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule($accessRule)
  Set-Acl -LiteralPath $credentialsPath -AclObject $acl

  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $TaskName
  }

  $apiKey = $null
  $profileResponse = $null
  $credentialsJson = $null
  Write-Host ""
  Write-Host "Poke Gate is configured and has been restarted." -ForegroundColor Green
  Wait-ForUser
} catch {
  Write-Host ""
  Write-Host ("Setup failed: " + $_.Exception.Message) -ForegroundColor Red
  Wait-ForUser
  exit 1
}
