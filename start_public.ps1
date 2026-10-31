[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$CoreDir = Join-Path $RepoRoot 'lily_essence_core'
$RealmDir = Join-Path $RepoRoot 'lily_private_realm'
$CorePython = Join-Path $CoreDir 'venv\Scripts\python.exe'
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)

if (-not (Test-Path -LiteralPath $CorePython)) { throw 'Core is not set up. Run setup_public.bat first.' }
if ($null -eq $npm) { throw 'npm was not found. Install Node.js 20+ and run setup_public again.' }
if (-not (Test-Path -LiteralPath (Join-Path $RealmDir 'node_modules'))) { throw 'Private Realm dependencies are missing. Run setup_public.bat first.' }

Write-Host 'Starting Lily Core and Private Realm. Press Ctrl+C to stop both.'
$coreProcess = Start-Process -FilePath $CorePython -ArgumentList @('web_server.py') -WorkingDirectory $CoreDir -PassThru -NoNewWindow
try {
    Push-Location $RealmDir
    try { & $npm.Source run dev -- --host 127.0.0.1 }
    finally { Pop-Location }
}
finally {
    if ($null -ne $coreProcess -and -not $coreProcess.HasExited) {
        Stop-Process -Id $coreProcess.Id -Force -ErrorAction SilentlyContinue
    }
}
