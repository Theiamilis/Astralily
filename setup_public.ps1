[CmdletBinding()]
param(
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$CoreDir = Join-Path $RepoRoot 'lily_essence_core'
$RealmDir = Join-Path $RepoRoot 'lily_private_realm'
$CoreEnv = Join-Path $CoreDir '.env'
$RealmEnv = Join-Path $RealmDir '.env'
$CoreVenvPython = Join-Path $CoreDir 'venv\Scripts\python.exe'

function Get-Executable([string[]]$Names) {
    foreach ($name in $Names) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($null -ne $command) { return $command.Source }
    }
    return $null
}

function Invoke-Checked([string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory) {
    Push-Location $WorkingDirectory
    try {
        & $Executable @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed ($LASTEXITCODE): $Executable $($Arguments -join ' ')"
        }
    }
    finally {
        Pop-Location
    }
}

function Get-EnvValue([string]$Path, [string]$Key) {
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    $content = [System.IO.File]::ReadAllText($Path)
    $pattern = '(?m)^' + [regex]::Escape($Key) + '=(.*)$'
    $match = [regex]::Match($content, $pattern)
    if ($match.Success) { return $match.Groups[1].Value.Trim() }
    return ''
}

function Set-EnvValue([string]$Path, [string]$Key, [string]$Value) {
    $content = if (Test-Path -LiteralPath $Path) { [System.IO.File]::ReadAllText($Path) } else { '' }
    $line = $Key + '=' + $Value
    $pattern = '(?m)^' + [regex]::Escape($Key) + '=.*$'
    if ([regex]::IsMatch($content, $pattern)) {
        $content = [regex]::Replace($content, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $line })
    }
    else {
        if ($content.Length -gt 0 -and -not $content.EndsWith("`n")) { $content += "`r`n" }
        $content += $line + "`r`n"
    }
    [System.IO.File]::WriteAllText($Path, $content, (New-Object System.Text.UTF8Encoding($false)))
}

function New-LocalToken {
    $bytes = New-Object byte[] 32
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return ([Convert]::ToBase64String($bytes)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

$python = Get-Executable @('py.exe', 'python.exe', 'python3.exe')
if ($null -eq $python) { throw 'Python 3.10+ was not found. Install Python and run setup_public again.' }
$pythonArgs = @()
if ((Split-Path -Leaf $python).ToLowerInvariant() -eq 'py.exe') { $pythonArgs = @('-3') }

$pythonVersion = (& $python @pythonArgs -c 'import sys; print(sys.version_info.major, sys.version_info.minor, sep=chr(46))').Trim()
$pythonParts = $pythonVersion.Split('.')
if ([int]$pythonParts[0] -lt 3 -or ([int]$pythonParts[0] -eq 3 -and [int]$pythonParts[1] -lt 10)) {
    throw "Python 3.10+ is required; found $pythonVersion."
}

$node = Get-Executable @('node.exe', 'node')
if ($null -eq $node) { throw 'Node.js 20+ was not found. Install Node.js and run setup_public again.' }
$nodeVersion = (& $node --version).Trim().TrimStart('v')
if ([int]($nodeVersion.Split('.')[0]) -lt 20) { throw "Node.js 20+ is required; found $nodeVersion." }

Write-Host "Lily public setup (Python $pythonVersion, Node $nodeVersion)"
if ($CheckOnly) {
    Write-Host 'Toolchain check passed.'
    exit 0
}

if (-not (Test-Path -LiteralPath $CoreEnv)) {
    Copy-Item -LiteralPath (Join-Path $CoreDir '.env.example') -Destination $CoreEnv
}
if (-not (Test-Path -LiteralPath $RealmEnv)) {
    Copy-Item -LiteralPath (Join-Path $RealmDir '.env.example') -Destination $RealmEnv
}

if (-not (Test-Path -LiteralPath $CoreVenvPython)) {
    Write-Host '[1/4] Creating Core virtual environment...'
    Invoke-Checked $python ($pythonArgs + @('-m', 'venv', 'venv')) $CoreDir
}
else { Write-Host '[1/4] Core virtual environment already exists.' }

Write-Host '[2/4] Installing Core dependencies...'
Invoke-Checked $CoreVenvPython @('-m', 'pip', 'install', '-r', 'requirements.txt') $CoreDir

Write-Host '[3/4] Installing Private Realm dependencies...'
$npm = Get-Executable @('npm.cmd', 'npm')
if ($null -eq $npm) { throw 'npm was not found with Node.js.' }
Invoke-Checked $npm @('ci') $RealmDir

$ownerToken = Get-EnvValue $CoreEnv 'LILY_OWNER_API_TOKEN'
if ([string]::IsNullOrWhiteSpace($ownerToken)) { $ownerToken = New-LocalToken }
Set-EnvValue $CoreEnv 'LILY_OWNER_API_TOKEN' $ownerToken
Set-EnvValue $RealmEnv 'VITE_LILY_OWNER_API_TOKEN' $ownerToken

Write-Host '[4/4] Local token configured (value intentionally not printed).'
Write-Host ''
Write-Host 'Setup complete. Run .\start_public.bat and open http://localhost:5230'
