$ErrorActionPreference = "Stop"
$AllArgs = @($args)
$Command = if ($AllArgs.Count -gt 0) { [string]$AllArgs[0] } else { "help" }
$Rest = if ($AllArgs.Count -gt 1) { @($AllArgs[1..($AllArgs.Count - 1)]) } else { @() }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir
$LogDir = Join-Path $RootDir "logs"

$Components = @{
    core = @{
        Label = "Lily Essence Core"
        Folder = "lily_essence_core"
        Runtime = "python"
        Entry = "web_server.py"
        PortKey = "LILY_CORE_PORT"
        DefaultPort = 8000
    }
    wa = @{
        Label = "Lily WhatsApp Bridge"
        Folder = "lily_wa_vessel"
        Runtime = "node"
        Entry = "bridge.js"
        PortKey = "BRIDGE_CONTROL_PORT"
        DefaultPort = 8091
    }
    file = @{
        Label = "Lily File Vessel"
        Folder = "lily_file_vessel"
        Runtime = "python"
        Entry = "app.py"
        PortKey = "LILY_FILE_VESSEL_PORT"
        DefaultPort = 10893
    }
    home = @{
        Label = "Lily Home Vessel"
        Folder = "lily_home_vessel"
        Runtime = "python"
        Entry = "app.py"
        PortKey = "LILY_HOME_VESSEL_PORT"
        DefaultPort = 10896
    }
    tool = @{
        Label = "Lily Tool Vessel"
        Folder = "lily_tool_vessel"
        Runtime = "python"
        Entry = "app.py"
        PortKey = "LILY_TOOL_VESSEL_PORT"
        DefaultPort = 8092
    }
    voice = @{
        Label = "Lily Voice Vessel"
        Folder = "lily_voice_vessel"
        Runtime = "python"
        Entry = "app.py"
        PortKey = "LILY_VOICE_VESSEL_PORT"
        DefaultPort = 10881
    }
    stt = @{
        Label = "Lily STT Vessel"
        Folder = "lily_stt_vessel"
        Runtime = "python"
        Entry = "app.py"
        PortKey = "LILY_STT_VESSEL_PORT"
        DefaultPort = 10894
    }
    stream_voice = @{
        Label = "Lily Stream Voice Vessel"
        Folder = "lily_stream_voice_vessel"
        Runtime = "python"
        Entry = "app.py"
        PortKey = "LILY_STREAM_VOICE_PORT"
        DefaultPort = 10897
    }
    finance = @{
        Label = "Lily Finance Vessel"
        Folder = "lily_finance_vessel"
        Runtime = "python"
        Entry = "app.py"
        PortKey = "LILY_FINANCE_VESSEL_PORT"
        DefaultPort = 10895
    }
    hotkey = @{
        Label = "Lily Hotkey Vessel"
        Folder = "lily_hotkey_vessel"
        Runtime = "python"
        Entry = "app.py"
        PortKey = ""
        DefaultPort = 0
        ProcessOnly = $true
    }
    model = @{
        Label = "Lily Model Vessel"
        Folder = "lily_model_vessel"
        Runtime = "python"
        Entry = "app.py"
        PortKey = "LILY_MODEL_VESSEL_PORT"
        DefaultPort = 10898
    }
    hud = @{
        Label = "Lily HUD Vessel"
        Folder = "lily_hud_vessel"
        Runtime = "npm"
        Entry = "run dev"
        PortKey = "LILY_HUD_HEALTH_PORT"
        DefaultPort = 10899
    }
    private = @{
        Label = "Lily Private Realm"
        Folder = "lily_private_realm"
        Runtime = "npm"
        Entry = "run dev -- --host"
        PortKey = ""
        DefaultPort = 5230
    }
    control = @{
        Label = "Lily Control Center"
        Folder = "lily_control_center"
        Runtime = "npm"
        Entry = "run dev -- --host"
        PortKey = ""
        DefaultPort = 5231
    }
    stream = @{
        Label = "Lily Stream Stage"
        Folder = "lily_stream_stage"
        Runtime = "npm"
        Entry = "run dev -- --host"
        PortKey = ""
        DefaultPort = 5232
    }
}

function Show-Help {
    Write-Host "Lily Windows launcher"
    Write-Host ""
    Write-Host "Usage:"
    Write-Host "  lily status"
    Write-Host "  lily ports      list | check | status"
    Write-Host "  lily topology   list | check | status | current"
    Write-Host "  lily core       start | stop | restart | status"
    Write-Host "  lily wa         start | stop | restart | status"
    Write-Host "  lily file       start | stop | restart | status | install-startup | uninstall-startup"
    Write-Host "  lily model      start | stop | restart | status"
    Write-Host "  lily hud        start | stop | restart | status"
    Write-Host "  lily home       start | stop | restart | status"
    Write-Host "  lily tool       start | stop | restart | status"
    Write-Host "  lily finance    start | stop | restart | status | install-startup | uninstall-startup"
    Write-Host "  lily stt        start | stop | restart | status"
    Write-Host "  lily hotkey     start | stop | restart | status"
    Write-Host "  lily voice      start | stop | restart | status   # GPT-SoVITS + Voice Vessel"
    Write-Host "  lily sovits     start | stop | restart | status   # GPT-SoVITS only"
    Write-Host "  lily private    start | stop | restart | status"
    Write-Host "  lily control    start | stop | restart | status"
    Write-Host "  lily stream     start | stop | restart | status"
    Write-Host "  lily profile    start | stop | restart | status | debug"
}

function Read-EnvValue {
    param(
        [string]$Folder,
        [string]$Key,
        [string]$Fallback
    )

    foreach ($fileName in @(".env", ".env.example")) {
        $path = Join-Path $Folder $fileName
        if (-not (Test-Path $path)) {
            continue
        }
        foreach ($rawLine in Get-Content $path) {
            $line = $rawLine.Trim()
            if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) {
                continue
            }
            if ($line.StartsWith("export ")) {
                $line = $line.Substring(7).Trim()
            }
            $name, $value = $line.Split("=", 2)
            if ($name.Trim() -eq $Key) {
                return $value.Trim().Trim('"').Trim("'")
            }
        }
    }
    return $Fallback
}

function Get-ComponentConfig {
    param([string]$Name)

    $key = $Name.ToLowerInvariant()
    if ($key -eq "tools") {
        $key = "tool"
    }
    if ($key -eq "files") {
        $key = "file"
    }
    if ($key -eq "house") {
        $key = "home"
    }
    if ($key -eq "whatsapp") {
        $key = "wa"
    }
    if ($key -eq "speech") {
        $key = "stt"
    }
    if (-not $Components.ContainsKey($key)) {
        throw "Unknown component: $Name"
    }

    $config = $Components[$key]
    $folder = Join-Path $RootDir $config.Folder
    $port = [int]$config.DefaultPort
    if ($config.PortKey) {
        $port = [int](Read-EnvValue -Folder $folder -Key $config.PortKey -Fallback ([string]$config.DefaultPort))
    }
    return @{
        Name = $key
        Label = $config.Label
        Folder = $folder
        Runtime = $config.Runtime
        Entry = $config.Entry
        Port = $port
        ProcessOnly = [bool]$config.ProcessOnly
    }
}

function Get-ListenerPids {
    param([int]$Port)

    @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique)
}

function Get-PortFromUrl {
    param(
        [string]$Url,
        [int]$Fallback
    )

    if (-not $Url) {
        return $Fallback
    }
    try {
        $uri = [Uri]$Url
        if ($uri.Port -gt 0) {
            return $uri.Port
        }
    } catch {
    }
    return $Fallback
}

function Get-SovitsConfig {
    $voiceFolder = Join-Path $RootDir "lily_voice_vessel"
    $coreFolder = Join-Path $RootDir "lily_essence_core"
    $url = Read-EnvValue -Folder $voiceFolder -Key "GPTSOVITS_API_URL" -Fallback ""
    if (-not $url) {
        $url = Read-EnvValue -Folder $coreFolder -Key "GPTSOVITS_API_URL" -Fallback "http://127.0.0.1:10880"
    }
    $folder = Join-Path $RootDir "tools\GPT-SoVITS"
    $streamMode = Read-EnvValue -Folder $RootDir -Key "TTS_STREAM_MODE" -Fallback "batch"
    return @{
        Label = "GPT-SoVITS"
        Folder = $folder
        Port = [int](Get-PortFromUrl -Url $url -Fallback 10880)
        Python = Join-Path $folder "venv\Scripts\python.exe"
        Api = Join-Path $folder "api.py"
        StreamMode = $streamMode.ToLowerInvariant()
    }
}

function Get-SovitsProcessPids {
    $needle = "GPT-SoVITS"
    @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            ($_.Name -like "python*.exe") -and
            ($_.CommandLine -like "*$needle*") -and
            ($_.CommandLine -like "*api.py*")
        } |
        Select-Object -ExpandProperty ProcessId -Unique)
}

function Ensure-ComponentRuntime {
    param([hashtable]$Config)

    $python = Join-Path $Config.Folder "venv\Scripts\python.exe"
    if (Test-Path $python) {
        return $python
    }

    Write-Host "Preparing $($Config.Label) runtime..."
    Push-Location $Config.Folder
    try {
        py -3 -m venv venv
        & ".\venv\Scripts\python.exe" -m pip install --upgrade pip
        & ".\venv\Scripts\python.exe" -m pip install -r requirements.txt
        if (-not (Test-Path ".env") -and (Test-Path ".env.example")) {
            Copy-Item ".env.example" ".env"
        }
    } finally {
        Pop-Location
    }

    return $python
}

function Ensure-NodeRuntime {
    param([hashtable]$Config)

    $node = (Get-Command node -ErrorAction Stop).Source
    $nodeModules = Join-Path $Config.Folder "node_modules"
    $packageJson = Join-Path $Config.Folder "package.json"
    if ((Test-Path $nodeModules) -or -not (Test-Path $packageJson)) {
        return $node
    }

    Write-Host "Preparing $($Config.Label) Node dependencies..."
    Push-Location $Config.Folder
    try {
        npm install
        if (-not (Test-Path ".env") -and (Test-Path ".env.example")) {
            Copy-Item ".env.example" ".env"
        }
    } finally {
        Pop-Location
    }

    return $node
}

function Get-ComponentExecutable {
    param([hashtable]$Config)

    if ($Config.Runtime -eq "node") {
        return Ensure-NodeRuntime $Config
    }
    if ($Config.Runtime -eq "npm") {
        Ensure-NodeRuntime $Config | Out-Null
        $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if (-not $npm) {
            $npm = Get-Command npm -ErrorAction Stop
        }
        return $npm.Source
    }
    return Ensure-ComponentRuntime $Config
}

function Get-ComponentEntryPath {
    param([hashtable]$Config)

    return Join-Path $Config.Folder $Config.Entry
}

function Get-ComponentArguments {
    param([hashtable]$Config)

    if ($Config.Runtime -eq "npm") {
        return $Config.Entry
    }
    $entryPath = Get-ComponentEntryPath $Config
    return "`"$entryPath`""
}

function Get-ComponentProcessPids {
    param([hashtable]$Config)

    $entryPath = (Get-ComponentEntryPath $Config)
    $entryName = Split-Path -Leaf $entryPath
    $folder = $Config.Folder
    @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $line = $_.CommandLine
            if (-not $line) {
                return $false
            }
            ($line -like "*$entryPath*") -or (($line -like "*$entryName*") -and ($line -like "*$folder*"))
        } |
        Select-Object -ExpandProperty ProcessId -Unique)
}

function Start-HiddenProcess {
    param(
        [string]$FilePath,
        [string]$Arguments,
        [string]$WorkingDirectory,
        [string]$StdOut,
        [string]$StdErr
    )

    $commandLine = "`"`"$FilePath`" $Arguments 1>> `"$StdOut`" 2>> `"$StdErr`"`""
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $env:ComSpec
    $startInfo.Arguments = "/d /s /c $commandLine"
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    return [System.Diagnostics.Process]::Start($startInfo)
}

function Start-LilyComponent {
    param([string]$Name)

    $config = Get-ComponentConfig $Name
    $pids = if ($config.ProcessOnly) { Get-ComponentProcessPids $config } else { Get-ListenerPids $config.Port }
    if ($pids.Count -gt 0) {
        if ($config.ProcessOnly) {
            Write-Host "[OK] $($config.Label) already running (PID $($pids -join ', '))"
            return
        }
        Write-Host "[OK] $($config.Label) already running on port $($config.Port) (PID $($pids -join ', '))"
        return
    }

    $executable = Get-ComponentExecutable $config
    $componentLogDir = Join-Path $LogDir $config.Name
    New-Item -ItemType Directory -Force $componentLogDir | Out-Null
    $stdout = Join-Path $componentLogDir "$($config.Name).out.log"
    $stderr = Join-Path $componentLogDir "$($config.Name).err.log"

    $process = Start-HiddenProcess -FilePath $executable -Arguments (Get-ComponentArguments $config) -WorkingDirectory $config.Folder -StdOut $stdout -StdErr $stderr
    $pids = @()
    for ($attempt = 0; $attempt -lt 24; $attempt++) {
        Start-Sleep -Milliseconds 500
        $pids = if ($config.ProcessOnly) { Get-ComponentProcessPids $config } else { Get-ListenerPids $config.Port }
        if ($pids.Count -gt 0 -or $process.HasExited) {
            break
        }
    }
    if ($pids.Count -gt 0) {
        if ($config.ProcessOnly) {
            Write-Host "[OK] started $($config.Label) (PID $($pids -join ', '))"
            return
        }
        Write-Host "[OK] started $($config.Label) on port $($config.Port) (PID $($pids -join ', '))"
        return
    }
    if ($config.ProcessOnly -and -not $process.HasExited) {
        Write-Host "[..] launched $($config.Label) (PID $($process.Id)). Check status after it initializes."
        return
    }
    if ($config.ProcessOnly) {
        Write-Host "[--] $($config.Label) exited early. Check $stderr"
        return
    }
    Write-Host "[--] $($config.Label) did not open port $($config.Port). Check $stderr"
}

function Start-SovitsEngine {
    $config = Get-SovitsConfig
    $pids = Get-ListenerPids $config.Port
    if ($pids.Count -gt 0) {
        Write-Host "[OK] $($config.Label) already running on port $($config.Port) (PID $($pids -join ', '))"
        return
    }

    if (-not (Test-Path $config.Python)) {
        throw "$($config.Label) runtime was not found: $($config.Python). Run setup_gptsovits.bat first."
    }
    if (-not (Test-Path $config.Api)) {
        throw "$($config.Label) API script was not found: $($config.Api)"
    }

    $componentLogDir = Join-Path $LogDir "sovits"
    New-Item -ItemType Directory -Force $componentLogDir | Out-Null
    $stdout = Join-Path $componentLogDir "sovits.out.log"
    $stderr = Join-Path $componentLogDir "sovits.err.log"

    $arguments = "api.py -hp -p $($config.Port)"
    if ($config.StreamMode -eq "stream") {
        $arguments += " -sm normal -mt ogg"
    }
    $process = Start-HiddenProcess -FilePath $config.Python -Arguments $arguments -WorkingDirectory $config.Folder -StdOut $stdout -StdErr $stderr
    Start-Sleep -Seconds 4

    $pids = Get-ListenerPids $config.Port
    if ($pids.Count -gt 0) {
        Write-Host "[OK] started $($config.Label) on port $($config.Port) (PID $($pids -join ', '))"
        return
    }
    if ($process.HasExited) {
        Write-Host "[--] $($config.Label) exited early. Check $stderr"
        return
    }
    Write-Host "[..] launched $($config.Label) (PID $($process.Id)); model may still be warming up. Check with: lily sovits status"
}

function Stop-LilyComponent {
    param([string]$Name)

    $config = Get-ComponentConfig $Name
    $pids = if ($config.ProcessOnly) { Get-ComponentProcessPids $config } else { Get-ListenerPids $config.Port }
    if ($pids.Count -eq 0) {
        if ($config.ProcessOnly) {
            Write-Host "[--] $($config.Label) is not running"
            return
        }
        Write-Host "[--] $($config.Label) is not running on port $($config.Port)"
        return
    }
    foreach ($pidValue in $pids) {
        Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
    }
    if ($config.ProcessOnly) {
        Write-Host "[OK] stopped $($config.Label)"
        return
    }
    Write-Host "[OK] stopped $($config.Label) on port $($config.Port)"
}

function Stop-SovitsEngine {
    $config = Get-SovitsConfig
    $pids = @()
    $pids += Get-ListenerPids $config.Port
    $pids += Get-SovitsProcessPids
    $pids = @($pids | Where-Object { $_ } | Sort-Object -Unique)
    if ($pids.Count -eq 0) {
        Write-Host "[--] $($config.Label) is not running on port $($config.Port)"
        return
    }
    foreach ($pidValue in $pids) {
        Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
    }
    Write-Host "[OK] stopped $($config.Label) on port $($config.Port)"
}

function Show-ComponentStatus {
    param([string]$Name)

    $config = Get-ComponentConfig $Name
    $pids = if ($config.ProcessOnly) { Get-ComponentProcessPids $config } else { Get-ListenerPids $config.Port }
    if ($pids.Count -gt 0) {
        if ($config.ProcessOnly) {
            Write-Host "[ONLINE] $($config.Label) (PID $($pids -join ', '))"
            return
        }
        Write-Host "[ONLINE] $($config.Label) on port $($config.Port) (PID $($pids -join ', '))"
        return
    }
    if ($config.ProcessOnly) {
        Write-Host "[OFFLINE] $($config.Label)"
        return
    }
    Write-Host "[OFFLINE] $($config.Label) on port $($config.Port)"
}

function Show-SovitsStatus {
    $config = Get-SovitsConfig
    $pids = Get-ListenerPids $config.Port
    if ($pids.Count -gt 0) {
        Write-Host "[ONLINE] $($config.Label) on port $($config.Port) (PID $($pids -join ', '))"
        return
    }
    $warming = Get-SovitsProcessPids
    if ($warming.Count -gt 0) {
        Write-Host "[STARTING] $($config.Label) process exists but port $($config.Port) is not listening yet (PID $($warming -join ', '))"
        return
    }
    Write-Host "[OFFLINE] $($config.Label) on port $($config.Port)"
}

function Invoke-SovitsCommand {
    param([string[]]$ComponentArgs)

    $action = "status"
    if ($ComponentArgs.Count -gt 0) {
        $action = $ComponentArgs[0].ToLowerInvariant()
    }

    switch ($action) {
        "start" { Start-SovitsEngine }
        "up" { Start-SovitsEngine }
        "stop" { Stop-SovitsEngine }
        "down" { Stop-SovitsEngine }
        "restart" {
            Stop-SovitsEngine
            Start-Sleep -Seconds 1
            Start-SovitsEngine
        }
        "status" { Show-SovitsStatus }
        default { throw "Unknown GPT-SoVITS action: $action" }
    }
}

function Invoke-VoiceStackCommand {
    param([string[]]$ComponentArgs)

    $action = "status"
    if ($ComponentArgs.Count -gt 0) {
        $action = $ComponentArgs[0].ToLowerInvariant()
    }

    switch ($action) {
        "start" {
            Start-SovitsEngine
            Start-LilyComponent "voice"
        }
        "up" {
            Start-SovitsEngine
            Start-LilyComponent "voice"
        }
        "stop" {
            Stop-LilyComponent "voice"
            Stop-SovitsEngine
        }
        "down" {
            Stop-LilyComponent "voice"
            Stop-SovitsEngine
        }
        "restart" {
            Stop-LilyComponent "voice"
            Stop-SovitsEngine
            Start-Sleep -Seconds 1
            Start-SovitsEngine
            Start-LilyComponent "voice"
        }
        "status" {
            Show-SovitsStatus
            Show-ComponentStatus "voice"
        }
        default { throw "Unknown voice action: $action" }
    }
}

function Test-LocalEndpoint {
    param([string]$Url)

    if (-not $Url) {
        return $false
    }
    try {
        $uri = [Uri]$Url
        return $uri.Host.ToLowerInvariant() -in @("127.0.0.1", "localhost", "0.0.0.0", "::1", "::")
    } catch {
        return $false
    }
}

function Get-LocalProfileItems {
    $coreFolder = Join-Path $RootDir "lily_essence_core"
    $waFolder = Join-Path $RootDir "lily_wa_vessel"
    $items = New-Object System.Collections.Generic.List[string]
    $items.Add("model")
    $items.Add("hud")

    $voiceServiceUrl = Read-EnvValue -Folder $coreFolder -Key "LILY_VOICE_SERVICE_URL" -Fallback ""
    if ($voiceServiceUrl) {
        if (Test-LocalEndpoint $voiceServiceUrl) {
            $items.Add("voice")
        }
    } else {
        $sovitsUrl = Read-EnvValue -Folder $coreFolder -Key "GPTSOVITS_API_URL" -Fallback "http://127.0.0.1:10880"
        if (Test-LocalEndpoint $sovitsUrl) {
            $items.Add("sovits")
        }
    }

    $toolMode = (Read-EnvValue -Folder $coreFolder -Key "LILY_TOOL_AGENT_MODE" -Fallback "local").ToLowerInvariant()
    $toolUrl = Read-EnvValue -Folder $coreFolder -Key "LILY_TOOL_AGENT_URL" -Fallback ""
    if ($toolMode -eq "remote" -and (Test-LocalEndpoint $toolUrl)) {
        $items.Add("tool")
    }

    $fileUrl = Read-EnvValue -Folder $waFolder -Key "LILY_FILE_VESSEL_URL" -Fallback ""
    if (Test-LocalEndpoint $fileUrl) {
        $items.Add("file")
    }

    foreach ($definition in @(
        @{ Name = "home"; Key = "LILY_HOME_VESSEL_URL"; Fallback = "http://127.0.0.1:10896" },
        @{ Name = "stt"; Key = "LILY_STT_SERVICE_URL"; Fallback = "http://127.0.0.1:10894/api/stt/transcribe" },
        @{ Name = "finance"; Key = "LILY_FINANCE_VESSEL_URL"; Fallback = "http://127.0.0.1:10895" }
    )) {
        $url = Read-EnvValue -Folder $coreFolder -Key $definition.Key -Fallback $definition.Fallback
        if (Test-LocalEndpoint $url) {
            $items.Add($definition.Name)
        }
    }

    $items.Add("core")
    $items.Add("private")
    return @($items | Select-Object -Unique)
}

function Invoke-ProfileItem {
    param(
        [string]$Name,
        [string]$Action
    )

    if ($Name -eq "voice") {
        Invoke-VoiceStackCommand -ComponentArgs @($Action)
        return
    }
    if ($Name -eq "sovits") {
        Invoke-SovitsCommand -ComponentArgs @($Action)
        return
    }
    Invoke-ComponentCommand -Name $Name -ComponentArgs @($Action)
}

function Get-ProfileLogFiles {
    param([string[]]$Items)

    $logs = New-Object System.Collections.Generic.List[object]
    foreach ($item in $Items) {
        if ($item -in @("voice", "sovits")) {
            $logs.Add(@{ Label = "GPT-SoVITS"; Path = (Join-Path $LogDir "sovits\sovits.out.log") })
        }
        if ($item -eq "voice") {
            $logs.Add(@{ Label = "Voice Vessel"; Path = (Join-Path $LogDir "voice\voice.out.log") })
        } elseif ($item -ne "sovits") {
            $logs.Add(@{ Label = $Components[$item].Label; Path = (Join-Path $LogDir "$item\$item.out.log") })
        }
    }
    return @($logs | Sort-Object { $_.Path } -Unique)
}

function Open-ProfileDebugLogs {
    param([string[]]$Items)

    foreach ($log in Get-ProfileLogFiles $Items) {
        $escapedPath = $log.Path.Replace("'", "''")
        $escapedLabel = $log.Label.Replace("'", "''")
        $command = "`$Host.UI.RawUI.WindowTitle = '$escapedLabel'; Get-Content -LiteralPath '$escapedPath' -Tail 80 -Wait"
        Start-Process powershell.exe -ArgumentList @("-NoExit", "-Command", $command) | Out-Null
    }
}

function Invoke-LocalProfileCommand {
    param([string[]]$ProfileArgs)

    $action = "status"
    if ($ProfileArgs.Count -gt 0) {
        $action = $ProfileArgs[0].ToLowerInvariant()
    }
    $items = @(Get-LocalProfileItems)

    switch ($action) {
        "start" {
            foreach ($item in $items) {
                Invoke-ProfileItem -Name $item -Action "start"
            }
        }
        "up" {
            foreach ($item in $items) {
                Invoke-ProfileItem -Name $item -Action "start"
            }
        }
        "stop" {
            [array]::Reverse($items)
            foreach ($item in $items) {
                Invoke-ProfileItem -Name $item -Action "stop"
            }
        }
        "down" {
            [array]::Reverse($items)
            foreach ($item in $items) {
                Invoke-ProfileItem -Name $item -Action "stop"
            }
        }
        "restart" {
            $reverseItems = @($items)
            [array]::Reverse($reverseItems)
            foreach ($item in $reverseItems) {
                Invoke-ProfileItem -Name $item -Action "stop"
            }
            Start-Sleep -Seconds 1
            foreach ($item in $items) {
                Invoke-ProfileItem -Name $item -Action "start"
            }
        }
        "status" {
            foreach ($item in $items) {
                Invoke-ProfileItem -Name $item -Action "status"
            }
            $toolMode = Read-EnvValue -Folder (Join-Path $RootDir "lily_essence_core") -Key "LILY_TOOL_AGENT_MODE" -Fallback "local"
            if ($toolMode.ToLowerInvariant() -eq "local") {
                Write-Host "[INFO] Core uses the local OpenClaw CLI on demand; no persistent gateway is required."
            }
        }
        "debug" {
            foreach ($item in $items) {
                Invoke-ProfileItem -Name $item -Action "start"
            }
            Open-ProfileDebugLogs -Items $items
        }
        default { throw "Unknown local profile action: $action" }
    }
}

function Invoke-LiveStatus {
    $python = (Get-Command python -ErrorAction Stop).Source
    & $python (Join-Path $RootDir "scripts\live_check.py") --targets core,wa,tool,file,home,finance,stt,voice,sovits,hud --timeout 10
    Show-ComponentStatus "hotkey"
}

function Invoke-PortCommand {
    param([string[]]$PortArgs)
    $python = (Get-Command python -ErrorAction Stop).Source
    if ($PortArgs.Count -eq 0) {
        $PortArgs = @("list")
    }
    & $python (Join-Path $RootDir "scripts\ports.py") @PortArgs
}

function Invoke-TopologyCommand {
    param([string[]]$TopologyArgs)
    $python = (Get-Command python -ErrorAction Stop).Source
    if ($TopologyArgs.Count -eq 0) {
        $TopologyArgs = @("list")
    }
    & $python (Join-Path $RootDir "scripts\topology.py") @TopologyArgs
}

function Install-Path {
    $currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $parts = @()
    if ($currentUserPath) {
        $parts = $currentUserPath.Split(";") | Where-Object { $_ }
    }
    if ($parts -contains $ScriptDir) {
        Write-Host "[OK] scripts folder is already in the user PATH"
    } else {
        $newPath = (@($parts) + $ScriptDir) -join ";"
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        Write-Host "[OK] added scripts folder to the user PATH"
    }
    if (-not (($env:Path.Split(";") | Where-Object { $_ }) -contains $ScriptDir)) {
        $env:Path = "$env:Path;$ScriptDir"
    }
}

function Invoke-StartupScript {
    param(
        [string]$Name,
        [string]$Action
    )

    $componentFolder = switch ($Name) {
        { $_ -in @("file", "files") } { "lily_file_vessel"; break }
        "finance" { "lily_finance_vessel"; break }
        default { throw "Startup install is only implemented for File and Finance Vessel right now." }
    }
    $scriptName = if ($Action -eq "install-startup") { "install_startup.ps1" } else { "uninstall_startup.ps1" }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RootDir "$componentFolder\$scriptName")
}

function Invoke-ComponentCommand {
    param(
        [string]$Name,
        [string[]]$ComponentArgs
    )

    $action = "status"
    if ($ComponentArgs.Count -gt 0) {
        $action = $ComponentArgs[0].ToLowerInvariant()
    }

    switch ($action) {
        "start" { Start-LilyComponent $Name }
        "up" { Start-LilyComponent $Name }
        "stop" { Stop-LilyComponent $Name }
        "down" { Stop-LilyComponent $Name }
        "restart" {
            Stop-LilyComponent $Name
            Start-Sleep -Seconds 1
            Start-LilyComponent $Name
        }
        "status" { Show-ComponentStatus $Name }
        "install-startup" { Invoke-StartupScript $Name "install-startup" }
        "uninstall-startup" { Invoke-StartupScript $Name "uninstall-startup" }
        default { throw "Unknown component action: $action" }
    }
}

$normalized = $Command.ToLowerInvariant()
switch ($normalized) {
    "help" { Show-Help }
    "-h" { Show-Help }
    "--help" { Show-Help }
    "status" { Invoke-LiveStatus }
    "ports" { Invoke-PortCommand $Rest }
    "topology" { Invoke-TopologyCommand $Rest }
    "install-path" { Install-Path }
    "core" { Invoke-ComponentCommand "core" $Rest }
    "wa" { Invoke-ComponentCommand "wa" $Rest }
    "whatsapp" { Invoke-ComponentCommand "wa" $Rest }
    "file" { Invoke-ComponentCommand "file" $Rest }
    "files" { Invoke-ComponentCommand "file" $Rest }
    "model" { Invoke-ComponentCommand "model" $Rest }
    "models" { Invoke-ComponentCommand "model" $Rest }
    "hud" { Invoke-ComponentCommand "hud" $Rest }
    "overlay" { Invoke-ComponentCommand "hud" $Rest }
    "home" { Invoke-ComponentCommand "home" $Rest }
    "house" { Invoke-ComponentCommand "home" $Rest }
    "tool" { Invoke-ComponentCommand "tool" $Rest }
    "tools" { Invoke-ComponentCommand "tool" $Rest }
    "finance" { Invoke-ComponentCommand "finance" $Rest }
    "stt" { Invoke-ComponentCommand "stt" $Rest }
    "stream_voice" { Invoke-ComponentCommand "stream_voice" $Rest }
    "speech" { Invoke-ComponentCommand "stt" $Rest }
    "hotkey" { Invoke-ComponentCommand "hotkey" $Rest }
    "voice" { Invoke-VoiceStackCommand $Rest }
    "sovits" { Invoke-SovitsCommand $Rest }
    "private" { Invoke-ComponentCommand "private" $Rest }
    "control" { Invoke-ComponentCommand "control" $Rest }
    "stream" { Invoke-ComponentCommand "stream" $Rest }
    "profile" { Invoke-LocalProfileCommand $Rest }
    "start" {
        $name = if ($Rest.Count -gt 0) { $Rest[0] } else { "file" }
        Start-LilyComponent $name
    }
    "stop" {
        $name = if ($Rest.Count -gt 0) { $Rest[0] } else { "file" }
        Stop-LilyComponent $name
    }
    "restart" {
        $name = if ($Rest.Count -gt 0) { $Rest[0] } else { "file" }
        Stop-LilyComponent $name
        Start-Sleep -Seconds 1
        Start-LilyComponent $name
    }
    default {
        Write-Host "[!] Unknown Lily command: $Command"
        Write-Host ""
        Show-Help
        exit 1
    }
}
