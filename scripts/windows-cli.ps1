[CmdletBinding()]
param(
    [ValidateSet('tui','help','doctor','create','start','stop','restart','status','logs','list','send','retry','skip','repair-encryption','verify')]
    [string]$Command = 'tui',
    [string]$Name,
    [string]$Message,
    [string]$Project,
    [ValidateSet('codex','claude','gemini')][string]$Provider,
    [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$Root = Join-Path $env:LOCALAPPDATA 'Jetspace'
$Runner = Join-Path $Root 'windows-agent-runner.js'
if ($env:OS -ne 'Windows_NT') { throw 'Use this CLI in native Windows PowerShell.' }
$BundledNode = Join-Path $Root 'nodejs/node.exe'
$SystemNode = Get-Command node.exe -ErrorAction SilentlyContinue
$Node = $null
foreach ($Candidate in @($BundledNode, $SystemNode.Source)) {
    if (-not $Candidate) { continue }
    try {
        $Version = & $Candidate --version
        if ($LASTEXITCODE -eq 0 -and $Version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) {
            $Node = @{ Source = $Candidate }
            break
        }
    } catch { continue }
}
if (-not $Node) { throw 'Rerun Windows setup to automatically install Node.js 22 or newer.' }
$env:PATH = (Split-Path -Parent $Node.Source) + [IO.Path]::PathSeparator + $env:PATH

$ProviderLabels = [ordered]@{ codex = 'Codex (OpenAI / ChatGPT account)'; claude = 'Claude Code (Anthropic account)'; gemini = 'Gemini CLI (Google account)' }

function Get-InstalledProviders {
    $Output = & $Node.Source $Runner providers
    if ($LASTEXITCODE -ne 0) { throw 'Jetspace command failed. See the error above.' }
    return ($Output | Out-String | ConvertFrom-Json)
}

# Same idea as Linux setup: find an installed AI CLI, or offer to install one.
function Install-Provider {
    param($Installable)
    Write-Host 'No AI CLI was found. Your agent uses one of these, signed in with your own account:'
    $Choices = @($ProviderLabels.Keys)
    for ($Index = 0; $Index -lt $Choices.Count; $Index++) { Write-Host "  $($Index + 1)) $($ProviderLabels[$Choices[$Index]])" }
    $Answer = Read-Host 'Install one now? Enter 1, 2 or 3 (Enter to cancel)'
    $Number = 0
    if (-not [int]::TryParse("$Answer".Trim(), [ref]$Number) -or $Number -lt 1 -or $Number -gt $Choices.Count) { return $null }
    $Selected = $Choices[$Number - 1]
    $Npm = Join-Path (Split-Path -Parent $Node.Source) 'npm.cmd'
    if (-not (Test-Path -LiteralPath $Npm)) { throw 'npm was not found next to Node.js. Rerun Windows setup, then try again.' }
    # Install outside the bundled Node.js folder, which setup may replace.
    $Prefix = Join-Path $env:APPDATA 'npm'
    Write-Host "Installing $($Installable.$Selected) with npm..."
    & $Npm install -g --prefix $Prefix $Installable.$Selected
    if ($LASTEXITCODE -ne 0) { throw "Installing $Selected failed. Check the npm output above, then run jetspace create again." }
    if (@($env:PATH -split ';') -notcontains $Prefix) { $env:PATH = $Prefix + ';' + $env:PATH }
    $SignIn = switch ($Selected) {
        'codex' { @{ Args = @('login'); Hint = 'Your browser opens to sign in; this window continues afterwards.' } }
        'claude' { @{ Args = @(); Hint = 'Sign in when Claude Code asks, then type /exit to come back here. If it asks for Git Bash, install Git for Windows first.' } }
        'gemini' { @{ Args = @(); Hint = 'Choose Login with Google, then type /quit to come back here.' } }
    }
    Write-Host "Next, sign in to $Selected. $($SignIn.Hint)"
    if ((Read-Host 'Sign in now? [Y/n]') -notmatch '^(n|no)$') {
        & (Join-Path $Prefix "$Selected.cmd") @($SignIn.Args)
    } else { Write-Host "Sign in before sending your first message: run $Selected in a new window." }
    return $Selected
}

function Invoke-NativeAgent {
    param([string[]]$Arguments)
    & $Node.Source $Runner @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Jetspace command failed. See the error above.' }
}

function Test-JetspaceTerminal {
    return (-not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected)
}

function Confirm-JetspaceAgentSetup {
    param([string]$AgentName, [string]$BaseUrl)
    Write-Host ''
    Write-Host 'One last check: receive a website message and deliver a reply.' -ForegroundColor Cyan
    Write-Host "Open $BaseUrl and send Hello to $AgentName. Keep this window open."
    Write-Host 'Waiting up to 5 minutes. This checks the message password and your signed-in AI CLI.'
    while ($true) {
        $Output = & $Node.Source $Runner wait-for-setup $AgentName
        if ($LASTEXITCODE -ne 0) { throw "Could not verify $AgentName. Run jetspace logs with this agent name for details." }
        $Result = $Output | Out-String | ConvertFrom-Json
        switch ($Result.status) {
            'verified' {
                Write-Host 'Verified: your website message was received and its reply was delivered.' -ForegroundColor Green
                return $true
            }
            'password-mismatch' {
                Write-Host 'The message password does not match the website. Your message is still waiting.' -ForegroundColor Yellow
                if ((Read-Host 'Enter the matching password now? [Y/n]') -match '^(n|no)$') {
                    Write-Host "Setup is not verified. Resume with: jetspace verify $AgentName"
                    return $false
                }
                try {
                    & (Join-Path $Root 'windows-cli.ps1') repair-encryption -Name $AgentName | Out-Host
                } catch {
                    Write-Host $_.Exception.Message -ForegroundColor Red
                    Write-Host 'Your waiting message was preserved. You can try the password again.'
                }
            }
            'waiting' {
                Write-Host "Setup is not verified yet. Continue later with: jetspace verify $AgentName" -ForegroundColor Yellow
                Write-Host 'Your agent remains available while Windows is awake. You do not need to create it again.'
                return $false
            }
            { $_ -in @('task-failed','failed') } {
                Write-Host 'The first reply failed. Here is the local agent log:' -ForegroundColor Red
                Invoke-NativeAgent -Arguments @('logs', $AgentName) | Out-Host
                throw "Setup is not verified. Resolve the error above, then run jetspace verify $AgentName. A task with an uncertain outcome needs explicit retry or skip after inspecting its work."
            }
            'stopped' { throw "Setup is not verified because the agent stopped. Run jetspace logs $AgentName for details, then jetspace start $AgentName and jetspace verify $AgentName." }
            default { throw 'The runtime returned an unknown verification status. Rerun Windows setup to update it.' }
        }
    }
}

function Select-JetspaceOption {
    param([string]$Title, [string[]]$Options, [scriptblock]$ReadKey = { [Console]::ReadKey($true) })
    if ($Options.Count -eq 0) { return -1 }
    $Selected = 0
    while ($true) {
        Clear-Host
        Write-Host '  JETSPACE' -ForegroundColor Cyan
        Write-Host '  Your agents on this computer' -ForegroundColor DarkGray
        Write-Host ''
        Write-Host "  $Title"
        Write-Host ''
        try {
            $Width = [Math]::Max(10, [Console]::WindowWidth - 5)
            $Visible = [Math]::Max(3, [Console]::WindowHeight - 9)
        } catch { $Width = 75; $Visible = 15 }
        $First = [Math]::Max(0, [Math]::Min($Selected - [Math]::Floor($Visible / 2), $Options.Count - $Visible))
        $Last = [Math]::Min($Options.Count, $First + $Visible)
        for ($Index = $First; $Index -lt $Last; $Index++) {
            # Names/projects are data; strip terminal control characters.
            $Label = $Options[$Index] -replace '[\x00-\x1f\x7f]', ' '
            if ($Label.Length -gt $Width) { $Label = $Label.Substring(0, $Width - 3) + '...' }
            if ($Index -eq $Selected) { Write-Host "  > $Label" -ForegroundColor Cyan }
            else { Write-Host "    $Label" }
        }
        Write-Host ''
        Write-Host '  Up/Down: move   Enter: select   Esc/Q: back or exit' -ForegroundColor DarkGray
        $Key = & $ReadKey
        switch ($Key.Key.ToString()) {
            'UpArrow' { $Selected = ($Selected + $Options.Count - 1) % $Options.Count }
            'DownArrow' { $Selected = ($Selected + 1) % $Options.Count }
            'Home' { $Selected = 0 }
            'End' { $Selected = $Options.Count - 1 }
            'Enter' { return $Selected }
            'Escape' { return -1 }
            'Q' { return -1 }
        }
    }
}

function Show-JetspaceTui {
    if (-not (Test-JetspaceTerminal)) {
        Write-Host 'The Jetspace menu needs an interactive terminal. Open PowerShell and run jetspace.'
        Write-Host 'For scripts, use jetspace list, jetspace status NAME, or jetspace help.'
        return
    }
    $Actions = @(
        @{ Label = 'Create New Agent'; Command = 'create' },
        @{ Label = 'Start Existing Agent'; Command = 'start' },
        @{ Label = 'Restart Agent'; Command = 'restart' },
        @{ Label = 'Stop Running Agent'; Command = 'stop' },
        @{ Label = 'View Agent Status'; Command = 'status' },
        @{ Label = 'View Agent Logs'; Command = 'logs' },
        @{ Label = 'Send a Message'; Command = 'send' },
        @{ Label = 'Check Installation and Connection'; Command = 'doctor' },
        @{ Label = 'Help'; Command = 'help' },
        @{ Label = 'Repair Message Encryption'; Command = 'repair-encryption' },
        @{ Label = 'Verify Website Message and Reply'; Command = 'verify' },
        @{ Label = 'Exit'; Command = 'exit' }
    )
    while ($true) {
        $Choice = Select-JetspaceOption -Title 'What would you like to do?' -Options @($Actions | ForEach-Object { $_.Label })
        if ($Choice -lt 0 -or $Actions[$Choice].Command -eq 'exit') { return }
        $Action = $Actions[$Choice].Command
        try {
            $Arguments = @($Action)
            if ($Action -in @('start','restart','stop','status','logs','send','repair-encryption','verify')) {
                $Lines = @(& $Node.Source $Runner list)
                if ($LASTEXITCODE -ne 0) { throw 'Could not list agents. Choose Check Installation and Connection for diagnostics.' }
                $Agents = @($Lines | ForEach-Object {
                    $Parts = "$_" -split "`t", 3
                    if ($Parts.Count -eq 3) {
                        [pscustomobject]@{ Name = $Parts[0]; Status = $Parts[1]; Project = $Parts[2] }
                    }
                })
                if ($Action -eq 'stop') { $Agents = @($Agents | Where-Object { $_.Status -eq 'running' }) }
                if ($Agents.Count -eq 0) {
                    Write-Host $(if ($Action -eq 'stop') { 'No agents are running.' } else { 'No agents are installed yet. Choose Create New Agent to get started.' })
                    [void](Read-Host 'Press Enter to return to the menu')
                    continue
                }
                $AgentChoice = Select-JetspaceOption -Title 'Select an agent' -Options @($Agents | ForEach-Object { "$($_.Name)  [$($_.Status)]  $($_.Project)" })
                if ($AgentChoice -lt 0) { continue }
                $Arguments += $Agents[$AgentChoice].Name
                if ($Action -eq 'send') {
                    $Text = Read-Host 'Message (Enter to cancel)'
                    if (-not "$Text".Trim()) { continue }
                    $Arguments += $Text
                }
            }
            Clear-Host
            # Call the existing command as argument objects. Agent names and
            # message text never become executable PowerShell or cmd.exe text.
            & (Join-Path $Root 'windows-cli.ps1') @Arguments
        } catch {
            Write-Host $_.Exception.Message -ForegroundColor Red
        }
        [void](Read-Host 'Press Enter to return to the menu')
    }
}

switch ($Command) {
    'tui' { Show-JetspaceTui }
    'help' {
        Write-Host 'Jetspace native Windows agents (Node.js 22+)'
        Write-Host 'jetspace (or jetspace tui) opens the interactive menu; use arrows and Enter.'
        Write-Host 'jetspace create [-Name NAME] [-Project PATH] [-Provider codex|claude|gemini]'
        Write-Host '  Uses every installed AI CLI; -Provider only picks the default. Switch per agent in the dashboard.'
        Write-Host 'jetspace start|stop|restart|status|logs|retry|skip NAME'
        Write-Host 'jetspace repair-encryption NAME (verify the website encryption password against a waiting message, then restart)'
        Write-Host 'jetspace verify NAME (finish setup by checking a real website message and reply)'
        Write-Host 'jetspace list'
        Write-Host 'jetspace doctor (check installation and available providers; no credentials required)'
        Write-Host 'jetspace send NAME "Message to the dashboard"'
        Write-Host ''
        Write-Host 'Agents use your installed, signed-in AI CLI (Codex, Claude Code or Gemini); create offers to install one if none is found.'
        Write-Host 'In Command Prompt, quote messages for send and avoid & | % ^ characters; PowerShell has no such limits.'
        Write-Host 'Chief of Staff spawning, shared rooms and automatic runtime updates are not available here.'
        Write-Host 'To update, rerun the Windows setup command. It stops your running agents, updates them and starts them again.'
        Write-Host 'If a run was interrupted, inspect the project before choosing retry (repeat) or skip (acknowledge).'
    }
    'create' {
        Write-Host ''
        Write-Host 'Create a Jetspace agent. It runs on this computer with your own AI CLI and replies in your Jetspace chats.'
        if (-not $Name) { $Name = Read-Host 'Agent name (for example windows-helper; press Enter to skip for now)' }
        if (-not $Name -or -not $Name.Trim()) {
            Write-Host 'Installation is ready. No agent was created. Run jetspace create when ready.'
            return
        }
        # Fail before asking for account credentials or registering anything.
        $Detected = Get-InstalledProviders
        $Found = @($Detected.found)
        if ($Found.Count -eq 0) {
            $Installed = Install-Provider -Installable $Detected.installable
            if ($Installed) { $Found = @((Get-InstalledProviders).found) }
            if ($Found.Count -eq 0) {
                Write-Host 'No agent was created. Install Codex, Claude Code or Gemini CLI, sign in, then run jetspace create again.'
                return
            }
        }
        if ($Provider -and $Found -notcontains $Provider) { throw "$Provider is not installed. Found: $($Found -join ', ')." }
        $Default = if ($Provider) { $Provider } else { $Found[0] }
        Write-Host "Found AI CLI: $($Found -join ', '). Default: $Default."
        if ($Found.Count -gt 1) { Write-Host 'You can switch between them anytime in the agent settings on the dashboard.' }
        Write-Host "Make sure you are signed in to $Default. Jetspace never sees your AI account."
        Write-Host 'Checking the connection to Jetspace...'
        Invoke-NativeAgent -Arguments @('check-connection')
        if (-not $Project) {
            $Here = (Get-Location).Path
            $Answer = Read-Host "Project folder the agent works in [$Here]"
            $Project = if ("$Answer".Trim()) { "$Answer".Trim().Trim('"') } else { $Here }
        }
        if (-not (Test-Path -LiteralPath $Project -PathType Container)) { throw "Folder not found: $Project. Create it or choose another folder, then run jetspace create again." }
        $Project = (Resolve-Path -LiteralPath $Project).Path
        if ($env:USERPROFILE -and $Project.TrimEnd('\') -eq $env:USERPROFILE.TrimEnd('\')) {
            Write-Host 'Note: this is your whole user folder. A dedicated project folder keeps the agent focused on one project.'
        }
        Write-Host 'By default the agent can read this folder but cannot change files.'
        $AllowEdits = (Read-Host 'Allow the agent to edit files in this folder? [y/N]') -match '^(y|yes)$'
        Write-Host 'Connect your Jetspace account. Copy the API key from Settings > API key.'
        $ApiSecret = Read-Host 'Jetspace API key' -AsSecureString
        Write-Host 'Enter the same password used in Jetspace Settings > Decryption Password.'
        Write-Host 'Recommended: in Settings click Copy Agent Connection Code, then paste it here to use this browser''s exact key.'
        Write-Host 'The password or code stays on this computer. Never paste it into chat.'
        $PasswordSecret = Read-Host 'Agent connection code or message encryption password' -AsSecureString
        try {
            $Configuration = Get-Content -LiteralPath (Join-Path $Root 'installation.json') -Raw | ConvertFrom-Json
            $Payload = @{
                baseUrl = $Configuration.baseUrl
                agentName = $Name.Trim()
                project = $Project
                provider = $Default
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
        if ($NoStart) {
            Write-Host 'Agent registered. Website messages and replies have not been verified.'
            Write-Host "Start it with: jetspace start $($Name.Trim())"
            Write-Host "Then finish setup with: jetspace verify $($Name.Trim())"
            return
        }
        Invoke-NativeAgent -Arguments @('start', $Name.Trim())
        $Verified = Confirm-JetspaceAgentSetup -AgentName $Name.Trim() -BaseUrl $Configuration.baseUrl
        Write-Host ''
        if ($Verified) { Write-Host "Setup complete. $($Name.Trim()) runs in the background while Windows is awake." }
        Write-Host "Manage it: jetspace status|logs|stop|start $($Name.Trim())"
    }
    'verify' {
        if (-not $Name) { throw 'Use: jetspace verify NAME' }
        $Configuration = Get-Content -LiteralPath (Join-Path $Root 'installation.json') -Raw | ConvertFrom-Json
        [void](Confirm-JetspaceAgentSetup -AgentName $Name -BaseUrl $Configuration.baseUrl)
    }
    'repair-encryption' {
        if (-not $Name) { throw 'Use: jetspace repair-encryption NAME' }
        Invoke-NativeAgent -Arguments @('stop', $Name)
        Write-Host 'Use the same password as Settings > Decryption Password in the browser that sent the message.'
        Write-Host 'If the password fails, open Settings in that browser and click Copy Agent Connection Code. Paste the code here.'
        Write-Host 'The code or password stays on this computer and is checked against the waiting message before saving.'
        $PasswordSecret = Read-Host 'Agent connection code or message encryption password' -AsSecureString
        try {
            $Payload = @{ password = [Net.NetworkCredential]::new('', $PasswordSecret).Password }
            $Payload | ConvertTo-Json -Compress | & $Node.Source $Runner repair-encryption $Name
            if ($LASTEXITCODE -ne 0) { throw 'Encryption repair failed. The agent is stopped; see the error above.' }
        } finally {
            if ($Payload) { $Payload.password = $null; $Payload = $null }
            $PasswordSecret.Dispose()
        }
        if (-not $NoStart) { Invoke-NativeAgent -Arguments @('start', $Name) }
    }
    'send' {
        if (-not $Name -or -not $Message) { throw 'Use: jetspace send NAME "Message"' }
        $Message | & $Node.Source $Runner send $Name
        if ($LASTEXITCODE -ne 0) { throw 'Message delivery failed.' }
    }
    default { Invoke-NativeAgent -Arguments @($Command, $Name) }
}
