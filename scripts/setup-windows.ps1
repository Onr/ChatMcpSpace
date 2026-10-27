[CmdletBinding()]
param([switch]$NoCreate)
$ErrorActionPreference = 'Stop'
$BaseUrl = '__JETSPACE_BASE_URL__'
if ($env:OS -ne 'Windows_NT') { throw 'This installer requires native Windows PowerShell.' }
$Root = Join-Path $env:LOCALAPPDATA 'Jetspace'
$Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$SystemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
function Set-PrivateAcl {
    param([string]$Path)
    $Item = Get-Item -LiteralPath $Path -Force
    if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing reparse point: $Path" }
    if ($Item.PSIsContainer) {
        $Acl = [Security.AccessControl.DirectorySecurity]::new()
        $Inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    } else {
        $Acl = [Security.AccessControl.FileSecurity]::new()
        $Inheritance = [Security.AccessControl.InheritanceFlags]::None
    }
    # Only persist the DACL. Set-Acl also requests audit-section privileges on
    # some hosts, which breaks a normal user's reinstall (SeSecurityPrivilege).
    $Acl.SetAccessRuleProtection($true, $false)
    foreach ($Identity in @($Sid, $SystemSid)) {
        $Rule = [Security.AccessControl.FileSystemAccessRule]::new($Identity, 'FullControl', $Inheritance, 'None', 'Allow')
        $Acl.AddAccessRule($Rule)
    }
    if ($PSVersionTable.PSEdition -eq 'Core') {
        [IO.FileSystemAclExtensions]::SetAccessControl($Item, $Acl)
    } else {
        $Item.SetAccessControl($Acl)
    }
    $Verified = Get-Acl -LiteralPath $Path
    if (-not $Verified.AreAccessRulesProtected) { throw "Could not protect installation permissions: $Path" }
    foreach ($Access in $Verified.Access) {
        if ($Access.AccessControlType -eq 'Allow' -and $Access.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($Sid.Value, $SystemSid.Value)) {
            throw "Installation permissions still allow another user: $Path"
        }
    }
}
New-Item -ItemType Directory -Path $Root -Force | Out-Null
Set-PrivateAcl -Path $Root
# Walk one level at a time so junctions cannot redirect recursive ACL updates.
function Get-PrivateItems {
    param([string]$Directory)
    $Queue = [Collections.Generic.Queue[string]]::new()
    $Queue.Enqueue($Directory)
    while ($Queue.Count -gt 0) {
        foreach ($Item in Get-ChildItem -LiteralPath $Queue.Dequeue() -Force) {
            if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing reparse point: $($Item.FullName)" }
            $Item
            if ($Item.PSIsContainer) { $Queue.Enqueue($Item.FullName) }
        }
    }
}
$ExistingItems = @(Get-PrivateItems -Directory $Root)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# Windows PowerShell 5.1 downloads many times slower while drawing progress bars.
$ProgressPreference = 'SilentlyContinue'

function Test-SupportedNode {
    param([string]$Path)
    if (-not $Path) { return $false }
    try {
        $Version = & $Path --version
        return ($LASTEXITCODE -eq 0 -and $Version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22)
    } catch { return $false }
}

function Install-NodeRuntime {
    # Use official portable builds so setup also works without WinGet or admin rights.
    $Architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $Arch = switch ($Architecture) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } 'x86' { 'x86' } default { throw "Unsupported Windows architecture: $Architecture" } }
    $NodeStage = Join-Path $Root ('node-download-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $NodeStage | Out-Null
    try {
        Write-Host 'Node.js 22+ is missing or too old. Setup will automatically install an official Node.js LTS build for Jetspace (no administrator rights needed).'
        $Releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
        $Release = $Releases | Where-Object { $_.lts -and $_.version -match '^v(\d+)\.\d+\.\d+$' -and [int]$Matches[1] -ge 22 -and $_.files -contains "win-$Arch-zip" } | Select-Object -First 1
        if (-not $Release) { throw 'No compatible Node.js LTS download was found.' }
        $Folder = "node-$($Release.version)-win-$Arch"
        $ArchiveName = "$Folder.zip"
        $DownloadUrl = "https://nodejs.org/dist/$($Release.version)"
        $Checksums = (Invoke-WebRequest -UseBasicParsing -Uri "$DownloadUrl/SHASUMS256.txt").Content
        $Checksum = [regex]::Match($Checksums, '(?m)^([a-fA-F0-9]{64})\s+' + [regex]::Escape($ArchiveName) + '\r?$')
        if (-not $Checksum.Success) { throw 'The official Node.js checksum is missing.' }
        $Archive = Join-Path $NodeStage $ArchiveName
        Write-Host "Downloading Node.js $($Release.version) ($Arch) from nodejs.org..."
        Invoke-WebRequest -UseBasicParsing -Uri "$DownloadUrl/$ArchiveName" -OutFile $Archive
        if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $Checksum.Groups[1].Value) { throw 'Node.js download integrity check failed.' }
        Expand-Archive -LiteralPath $Archive -DestinationPath $NodeStage
        $Extracted = Join-Path $NodeStage $Folder
        if (-not (Test-SupportedNode -Path (Join-Path $Extracted 'node.exe'))) { throw 'The downloaded Node.js runtime could not run or is too old.' }
        $Destination = Join-Path $Root 'nodejs'
        $Previous = Join-Path $NodeStage 'previous-nodejs'
        if (Test-Path -LiteralPath $Destination) { Move-Item -LiteralPath $Destination -Destination $Previous }
        try { Move-Item -LiteralPath $Extracted -Destination $Destination }
        catch {
            if (Test-Path -LiteralPath $Previous) { Move-Item -LiteralPath $Previous -Destination $Destination }
            throw
        }
        Write-Host "Installed Node.js $($Release.version) in $Destination. Setup will continue in this window."
    } catch {
        throw "Automatic Node.js setup failed: $($_.Exception.Message) Check your connection to https://nodejs.org and rerun this setup command. Alternatively, install Node.js 22+ from https://nodejs.org/en/download, reopen PowerShell and rerun setup."
    } finally { Remove-Item -LiteralPath $NodeStage -Recurse -Force -ErrorAction SilentlyContinue }
}

$BundledNode = Join-Path $Root 'nodejs/node.exe'
$SystemNode = Get-Command node.exe -ErrorAction SilentlyContinue
if (Test-SupportedNode -Path $BundledNode) { $NodePath = $BundledNode }
elseif ($SystemNode -and (Test-SupportedNode -Path $SystemNode.Source)) { $NodePath = $SystemNode.Source }
else { Install-NodeRuntime; $NodePath = $BundledNode }
# Child provider processes need the same supported Node, even with an old PATH.
$env:PATH = (Split-Path -Parent $NodePath) + [IO.Path]::PathSeparator + $env:PATH

# Rerunning setup is the update path. Running agents hold files that are about
# to be replaced, so stop them with the installed runner and restart them below.
$Runner = Join-Path $Root 'windows-agent-runner.js'
# Older runners also launch Windows PowerShell through Node. Give them a clean
# module path during updates so a PowerShell 7 session can list/stop agents.
function Invoke-WindowsRunner {
    param([string[]]$Arguments)
    $ModulePath = [Environment]::GetEnvironmentVariable('PSModulePath', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('PSModulePath', $null, 'Process')
        & $NodePath $Runner @Arguments
    } finally {
        [Environment]::SetEnvironmentVariable('PSModulePath', $ModulePath, 'Process')
    }
}
# The jetspace command may not exist yet, so messages show the full command.
$FullCli = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Root 'windows-cli.ps1')`""
# Node prints UTF-8; Windows PowerShell 5.1 would otherwise garble non-ASCII agent names.
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ExistingAgents = @()
$RunningAgents = @()
if (Test-Path -LiteralPath $Runner -PathType Leaf) {
    $Listed = Invoke-WindowsRunner -Arguments @('list')
    if ($LASTEXITCODE -eq 0) {
        foreach ($Line in @($Listed)) {
            $Parts = "$Line" -split "`t"
            if ($Parts.Count -lt 2 -or -not $Parts[0]) { continue }
            $ExistingAgents += $Parts[0]
            if ($Parts[1] -eq 'running') { $RunningAgents += $Parts[0] }
        }
    }
}
foreach ($Name in $RunningAgents) {
    Write-Host "Stopping $Name to update it. It starts again when setup finishes."
    Invoke-WindowsRunner -Arguments @('stop', $Name)
    if ($LASTEXITCODE -ne 0) { throw "Could not stop $Name (see the message above). Run: $FullCli stop `"$Name`", then rerun this setup command." }
}
foreach ($Lock in $ExistingItems | Where-Object { -not $_.PSIsContainer -and $_.Name -like '*.lock' }) {
    $RunnerPid = 0
    if ((Test-Path -LiteralPath $Lock.FullName) -and [int]::TryParse((Get-Content -LiteralPath $Lock.FullName -Raw).Trim(), [ref]$RunnerPid)) {
        if (Get-Process -Id $RunnerPid -ErrorAction SilentlyContinue) { throw "A Jetspace agent is still running (process $RunnerPid). Run: $FullCli list, stop the running agent with $FullCli stop NAME, then rerun this setup command." }
    }
}
foreach ($Item in Get-PrivateItems -Directory $Root) { Set-PrivateAcl -Path $Item.FullName }

$Manifest = Invoke-RestMethod -Uri "$BaseUrl/setup/windows/manifest.json"
$Required = @('windows-cli.ps1', 'windows-agent-runner.js', 'external-agent-bridge.js')
$Stage = Join-Path $Root ('download-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Stage | Out-Null
try {
    foreach ($Name in $Required) {
        $Expected = $Manifest.files.$Name
        if ($Expected -notmatch '^[a-f0-9]{64}$') { throw "Missing checksum for $Name" }
        $Target = Join-Path $Stage $Name
        Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/setup/windows/$Name" -OutFile $Target
        if ((Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) { throw "Download integrity check failed for $Name. Run setup again." }
    }
    foreach ($Name in $Required) { Move-Item -LiteralPath (Join-Path $Stage $Name) -Destination (Join-Path $Root $Name) -Force }
} finally { Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue }
@{ baseUrl = $BaseUrl } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Root 'installation.json') -Encoding UTF8
$Cli = Join-Path $Root 'windows-cli.ps1'
$QuotedCli = $Cli.Replace("'", "''")
# The registry stores the user PATH unexpanded; keep %VARIABLE% entries intact.
function Get-UserPathValue {
    $Key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
    if (-not $Key) { return '' }
    try { return [string]$Key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    finally { $Key.Dispose() }
}
function Set-UserPathValue {
    param([string]$Value)
    $Key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try { $Key.SetValue('Path', $Value, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
    finally { $Key.Dispose() }
    # Setting a user variable through .NET notifies Explorer, so new windows see PATH.
    [Environment]::SetEnvironmentVariable('JETSPACE_PATH_REFRESH', '1', 'User')
    [Environment]::SetEnvironmentVariable('JETSPACE_PATH_REFRESH', $null, 'User')
}
function Add-UserPath {
    param([string]$Directory)
    $Entries = @((Get-UserPathValue) -split ';' | Where-Object { $_.Trim() })
    if (@($Entries | Where-Object { $_.Trim().TrimEnd('\') -eq $Directory.TrimEnd('\') }).Count -eq 0) {
        Set-UserPathValue -Value ((@($Entries) + $Directory) -join ';')
    }
}
# A .cmd launcher works in PowerShell and Command Prompt without profile
# scripts, so it is unaffected by the default Restricted execution policy.
$Bin = Join-Path $Root 'bin'
New-Item -ItemType Directory -Path $Bin -Force | Out-Null
$Launcher = "@echo off`r`n`"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`" -NoProfile -ExecutionPolicy Bypass -File `"%~dp0..\windows-cli.ps1`" %*`r`n"
[IO.File]::WriteAllText((Join-Path $Bin 'jetspace.cmd'), $Launcher, [Text.Encoding]::ASCII)
$CommandReady = $true
try { Add-UserPath -Directory $Bin }
catch {
    $CommandReady = $false
    Write-Warning "Could not add jetspace to your PATH ($($_.Exception.Message)). Use the full command shown below in new windows."
}
if (@($env:PATH -split [IO.Path]::PathSeparator) -notcontains $Bin) { $env:PATH = $Bin + [IO.Path]::PathSeparator + $env:PATH }
# Earlier versions added a profile function. Profile scripts are blocked by
# the default execution policy and then print an error in every new window.
try {
    $ProfilePath = $PROFILE.CurrentUserAllHosts
    if ($ProfilePath -and (Test-Path -LiteralPath $ProfilePath -PathType Leaf)) {
        $Existing = Get-Content -LiteralPath $ProfilePath -Raw
        $Pattern = '(?ms)\r?\n?^# >>> Jetspace Windows >>>\r?\n.*?^# <<< Jetspace Windows <<<\r?\n?'
        if ($Existing -match $Pattern) {
            $Remaining = [regex]::Replace($Existing, $Pattern, "`r`n")
            if ($Remaining.Trim()) { Set-Content -LiteralPath $ProfilePath -Value $Remaining.Trim() -Encoding UTF8 }
            else { Remove-Item -LiteralPath $ProfilePath -Force }
        }
    }
} catch { }
# A PowerShell function forwards argument objects without cmd.exe interpolation.
Set-Item -Path Function:global:jetspace -Value ([scriptblock]::Create("& '$QuotedCli' @args"))
foreach ($Item in Get-PrivateItems -Directory $Root) { Set-PrivateAcl -Path $Item.FullName }
# Exercise the installed runtime's permission check before reporting success or
# asking for an agent name. Exit codes from native commands do not throw in 5.1.
$VerifiedAgents = Invoke-WindowsRunner -Arguments @('list')
if ($LASTEXITCODE -ne 0) { throw 'Jetspace installation verification failed. Run jetspace doctor for diagnostics, then rerun setup.' }
Write-Host ''
Write-Host "Jetspace is installed in $Root"
if ($CommandReady) { Write-Host 'The jetspace command now works here and in new PowerShell or Command Prompt windows. Run jetspace to open the interactive menu.' }
else { Write-Host "In new windows use: powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Cli`" help" }
foreach ($Name in $RunningAgents) {
    Write-Host "Starting $Name again..."
    Invoke-WindowsRunner -Arguments @('start', $Name)
    if ($LASTEXITCODE -ne 0) { Write-Warning "$Name did not start again (see the message above). Start it with: jetspace start $Name" }
}
if ($NoCreate) { return }
if ($ExistingAgents.Count -gt 0) {
    # Updating must not ask for a new agent; the existing ones keep working.
    Write-Host "Update complete. Your agents: $($ExistingAgents -join ', ')."
    Write-Host 'Add another agent: jetspace create    See all agents: jetspace list'
} else { & $Cli create }
