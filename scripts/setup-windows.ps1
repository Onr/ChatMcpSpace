[CmdletBinding()]
param([switch]$NoCreate)
$ErrorActionPreference = 'Stop'
$BaseUrl = '__JETSPACE_BASE_URL__'
if ($env:OS -ne 'Windows_NT') { throw 'This installer requires native Windows PowerShell.' }
$Node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $Node) { throw 'Install Node.js 22+: winget install --id OpenJS.NodeJS.LTS -e --source winget. Reopen PowerShell, then run this installer again.' }
$NodeMajor = [int]((& $Node.Source --version).TrimStart('v').Split('.')[0])
if ($NodeMajor -lt 22) { throw 'Upgrade Node.js to version 22 or newer and reopen PowerShell.' }
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
    $Acl.SetOwner($Sid)
    $Acl.SetAccessRuleProtection($true, $false)
    foreach ($Identity in @($Sid, $SystemSid)) {
        $Rule = [Security.AccessControl.FileSystemAccessRule]::new($Identity, 'FullControl', $Inheritance, 'None', 'Allow')
        $Acl.AddAccessRule($Rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $Acl
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
# Refuse updates while an installed listener holds a lock; stop agents first.
foreach ($Lock in $ExistingItems | Where-Object { -not $_.PSIsContainer -and $_.Name -like '*.lock' }) {
    $RunnerPid = 0
    if ([int]::TryParse((Get-Content -LiteralPath $Lock.FullName -Raw).Trim(), [ref]$RunnerPid)) {
        if (Get-Process -Id $RunnerPid -ErrorAction SilentlyContinue) { throw 'Stop all native agents before updating this installation.' }
    }
}
foreach ($Item in $ExistingItems) { Set-PrivateAcl -Path $Item.FullName }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
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
# A PowerShell function forwards argument objects without cmd.exe interpolation.
$Cli = Join-Path $Root 'windows-cli.ps1'
$QuotedCli = $Cli.Replace("'", "''")
$FunctionLine = "function global:jetspace { & '$QuotedCli' @args }"
$ProfilePath = $PROFILE.CurrentUserAllHosts
$ProfileFolder = Split-Path -Parent $ProfilePath
New-Item -ItemType Directory -Path $ProfileFolder -Force | Out-Null
$StartMarker = '# >>> Jetspace Windows >>>'
$EndMarker = '# <<< Jetspace Windows <<<'
$Existing = if (Test-Path -LiteralPath $ProfilePath) { Get-Content -LiteralPath $ProfilePath -Raw } else { '' }
$Block = "$StartMarker`r`n$FunctionLine`r`n$EndMarker"
$Pattern = '(?ms)^# >>> Jetspace Windows >>>\r?\n.*?^# <<< Jetspace Windows <<<'
if ($Existing -match $Pattern) { $Existing = [regex]::Replace($Existing, $Pattern, [Text.RegularExpressions.MatchEvaluator]{ param($Match) $Block }) }
else { $Existing += "`r`n$Block`r`n" }
Set-Content -LiteralPath $ProfilePath -Value $Existing -Encoding UTF8
Set-Item -Path Function:global:jetspace -Value ([scriptblock]::Create("& '$QuotedCli' @args"))
foreach ($Item in Get-PrivateItems -Directory $Root) { Set-PrivateAcl -Path $Item.FullName }
Write-Host "Installed native Windows CLI in $Root"
Write-Host 'Install and sign in to Codex, Claude Code or Gemini CLI before creating an agent.'
Write-Host 'The jetspace command is available in new PowerShell windows if profile scripts are enabled.'
Write-Host "Always available: powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Cli`" help"
Write-Host 'Chief of Staff spawning and shared rooms are not supported by this native runtime.'
if (-not $NoCreate) { & $Cli create }
