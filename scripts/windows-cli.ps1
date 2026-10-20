[CmdletBinding()]
param(
    [ValidateSet('help','create','start','stop','restart','status','logs','list','send','retry','skip')]
    [string]$Command = 'help',
    [string]$Name,
    [string]$Message,
    [string]$Project = (Get-Location).Path,
    [ValidateSet('codex','claude','gemini')][string]$Provider = 'codex',
    [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$Root = Join-Path $env:LOCALAPPDATA 'Jetspace'
$Runner = Join-Path $Root 'windows-agent-runner.js'
if ($env:OS -ne 'Windows_NT') { throw 'Use this CLI in native Windows PowerShell.' }
$Node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $Node) { throw 'Install Node.js 22 or newer, then reopen PowerShell.' }
$NodeMajor = [int]((& $Node.Source --version).TrimStart('v').Split('.')[0])
if ($NodeMajor -lt 22) { throw 'Node.js 22 or newer is required.' }

function Invoke-NativeAgent {
    param([string[]]$Arguments)
    & $Node.Source $Runner @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Jetspace command failed. See the error above.' }
}

switch ($Command) {
    'help' {
        Write-Host 'Jetspace native Windows agents (Node.js 22+)'
        Write-Host 'jetspace create [-Name NAME] [-Provider codex|claude|gemini] [-Project PATH]'
        Write-Host 'jetspace start|stop|restart|status|logs|retry|skip NAME'
        Write-Host 'jetspace list'
        Write-Host 'jetspace send NAME "Message to the dashboard"'
        Write-Host ''
        Write-Host 'Install and sign in to a provider CLI first. Your existing provider tools and permissions apply.'
        Write-Host 'Chief of Staff spawning, shared rooms and automatic runtime updates are not available here.'
        Write-Host 'To update, stop your agents, rerun the Windows installer, then start your agents.'
        Write-Host 'If a run was interrupted, inspect the project before choosing retry (repeat) or skip (acknowledge).'
    }
    'create' {
        if (-not $Name) { $Name = Read-Host 'Agent name (choose a new name)' }
        if (-not $Name.Trim()) { throw 'An agent name is required.' }
        if (-not $PSBoundParameters.ContainsKey('Provider')) {
            $Selection = Read-Host 'Provider: codex, claude or gemini [codex]'
            if ($Selection) { $Provider = $Selection.Trim().ToLowerInvariant() }
        }
        if ($Provider -notin @('codex','claude','gemini')) { throw 'Choose codex, claude or gemini.' }
        Write-Host "Project: $Project"
        Write-Host 'The runner uses installed providers only. Sign in to each provider CLI before starting.'
        Write-Host 'Default: provider permission checks; Codex uses a read-only sandbox.'
        Write-Host 'Allowing edits enables workspace-write for Codex and automatic edit approval for Claude/Gemini.'
        $AllowEdits = (Read-Host 'Allow automatic workspace edits for this agent? [y/N]') -match '^(y|yes)$'
        $ApiSecret = Read-Host 'Jetspace API key (Settings > API key)' -AsSecureString
        $PasswordSecret = Read-Host 'Jetspace account password (used locally for message encryption)' -AsSecureString
        try {
            $Configuration = Get-Content -LiteralPath (Join-Path $Root 'installation.json') -Raw | ConvertFrom-Json
            $Payload = @{
                baseUrl = $Configuration.baseUrl
                agentName = $Name.Trim()
                project = (Resolve-Path -LiteralPath $Project).Path
                provider = $Provider
                allowEdits = $AllowEdits
                apiKey = [Net.NetworkCredential]::new('', $ApiSecret).Password
                password = [Net.NetworkCredential]::new('', $PasswordSecret).Password
            }
            $Payload | ConvertTo-Json -Compress -Depth 5 | & $Node.Source $Runner init
            if ($LASTEXITCODE -ne 0) { throw 'Agent setup failed. See the error above.' }
        } finally {
            if ($Payload) { $Payload.apiKey = $null; $Payload.password = $null; $Payload = $null }
            $ApiSecret.Dispose(); $PasswordSecret.Dispose()
        }
        if (-not $NoStart) { Invoke-NativeAgent -Arguments @('start', $Name.Trim()) }
    }
    'send' {
        if (-not $Name -or -not $Message) { throw 'Use: jetspace send NAME "Message"' }
        $Message | & $Node.Source $Runner send $Name
        if ($LASTEXITCODE -ne 0) { throw 'Message delivery failed.' }
    }
    default { Invoke-NativeAgent -Arguments @($Command, $Name) }
}
