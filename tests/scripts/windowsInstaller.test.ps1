# No network, provider execution, account registration or real profile changes.
# On Windows the actual installer ACL code runs. Other hosts simulate only that
# Windows-specific API so the remaining PowerShell installer is exercised.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Installer = Get-Content -LiteralPath (Join-Path $Repo 'scripts/setup-windows.ps1') -Raw
$CliSource = Get-Content -LiteralPath (Join-Path $Repo 'scripts/windows-cli.ps1') -Raw
$NativeWindows = $env:OS -eq 'Windows_NT'
$SavedLocalAppData = $env:LOCALAPPDATA
$SavedOs = $env:OS
$SavedPath = $env:PATH
$SavedArchitecture = $env:PROCESSOR_ARCHITECTURE
$SavedWowArchitecture = $env:PROCESSOR_ARCHITEW6432
$FixtureNode = (Get-Command node).Source
$TestRoot = Join-Path ([IO.Path]::GetTempPath()) ('jetspace installer''case-' + [guid]::NewGuid().ToString('N'))
$script:Passed = 0
New-Item -ItemType Directory -Path $TestRoot | Out-Null

function Assert-That([bool]$Condition, [string]$Label) {
    if (-not $Condition) { throw "FAILED: $Label" }
    $script:Passed++
    Write-Host "PASS $Label"
}

function Test-Install([string]$Case, [bool]$BlockedProfile = $false, [bool]$BlockedPath = $false, [bool]$CorruptDownload = $false, [bool]$NoCreate = $true, [string]$NodeMode = 'current', [string]$NodeFailure = '', [string]$Architecture = 'AMD64', [bool]$BrokenBundle = $false, [string]$Agents = '', [bool]$RuntimeAclFailure = $false) {
    $CaseRoot = Join-Path $TestRoot $Case
    New-Item -ItemType Directory -Path $CaseRoot | Out-Null
    $env:LOCALAPPDATA = $CaseRoot
    $env:OS = 'Windows_NT'
    $env:PROCESSOR_ARCHITECTURE = $Architecture
    $env:PROCESSOR_ARCHITEW6432 = $null
    $Root = Join-Path $CaseRoot 'Jetspace'
    if ($BrokenBundle) {
        New-Item -ItemType Directory -Path (Join-Path $Root 'nodejs') -Force | Out-Null
        [IO.File]::WriteAllBytes((Join-Path $Root 'nodejs/node.exe'), [byte[]]@(0, 1, 2, 3))
    }
    $script:AgentCalls = @()
    $OriginalModulePath = $env:PSModulePath
    if ($Agents) {
        # An earlier installation with one running and one stopped agent. The
        # running one holds a lock, like the reported windos-test runner.
        $AgentDir = Join-Path $Root 'agents/fixture'
        New-Item -ItemType Directory -Path $AgentDir -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $Root 'windows-agent-runner.js'), 'previous runner')
        [IO.File]::WriteAllText((Join-Path $AgentDir 'state.json.lock'), "$PID")
        $script:AgentRunning = $true
    }
    $ProfilePath = Join-Path $CaseRoot 'profile/profile.ps1'
    if ($BlockedProfile) { Set-Content -LiteralPath (Join-Path $CaseRoot 'profile') -Value 'not a directory' }
    else {
        # A profile left by an earlier installer version must be cleaned up.
        New-Item -ItemType Directory -Path (Join-Path $CaseRoot 'profile') | Out-Null
        Set-Content -LiteralPath $ProfilePath -Value "# unrelated profile configuration`r`n# >>> Jetspace Windows >>>`r`nfunction global:jetspace { }`r`n# <<< Jetspace Windows <<<`r`n"
    }
    $script:UserPath = '%USERPROFILE%\tools;C:\Other'
    $script:UserPathWrites = 0
    $PROFILE = [pscustomobject]@{ CurrentUserAllHosts = $ProfilePath }
    $script:NodeDownloads = 0
    $script:ExpandedNode = 0
    $ExpectedArch = switch ($Architecture) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } 'x86' { 'x86' } }
    $ArchiveName = "node-v22.99.0-win-$ExpectedArch.zip"
    $script:Payloads = @{
        'windows-cli.ps1' = 'param([string]$Command) Set-Content -LiteralPath (Join-Path $env:LOCALAPPDATA "created.txt") -Value $Command'
        'windows-agent-runner.js' = '// fixture runner'
        'external-agent-bridge.js' = '// fixture bridge'
    }
    $script:Payloads[$ArchiveName] = 'official node archive fixture'
    $script:Hashes = @{}
    foreach ($Name in $script:Payloads.Keys) {
        $Bytes = [Text.Encoding]::UTF8.GetBytes($script:Payloads[$Name])
        $Sha = [Security.Cryptography.SHA256]::Create()
        try { $script:Hashes[$Name] = ([BitConverter]::ToString($Sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
        finally { $Sha.Dispose() }
    }
    function Get-Command {
        param($Name, $ErrorAction)
        if ($Name -eq 'node.exe') {
            if ($NodeMode -eq 'missing') { return $null }
            return @{ Source = 'fixture-system-node' }
        }
        return Microsoft.PowerShell.Core\Get-Command $Name -ErrorAction SilentlyContinue
    }
    function fixture-system-node {
        $global:LASTEXITCODE = 0
        if ($args[0] -ne '--version') {
            Assert-That (-not [Environment]::GetEnvironmentVariable('PSModulePath', 'Process')) "$Case runner does not inherit PowerShell 7 module paths"
            # Record which runner version handled each lifecycle command.
            $RunnerText = Get-Content -LiteralPath $args[0] -Raw
            $script:AgentCalls += "$($args[1]) $($args[2]) [$RunnerText]"
            $Lock = Join-Path $Root 'agents/fixture/state.json.lock'
            if ($args[1] -eq 'list') {
                if ($RuntimeAclFailure) { $global:LASTEXITCODE = 1; return }
                "windos-test`t$(if ($script:AgentRunning) { 'running' } else { 'stopped' })`tC:\Users\fixture"
                "idle-agent`tstopped`tC:\Users\fixture"
            }
            if ($args[1] -eq 'stop') {
                if ($Agents -eq 'stop-fails') { $global:LASTEXITCODE = 1; return }
                Remove-Item -LiteralPath $Lock -Force -ErrorAction SilentlyContinue
                $script:AgentRunning = $false
            }
            if ($args[1] -eq 'start') { $script:AgentRunning = $true }
            return
        }
        if ($NodeMode -eq 'outdated') { 'v20.0.0' } else { 'v22.0.0' }
    }
    function Invoke-RestMethod {
        param($Uri)
        if ($Uri -eq 'https://nodejs.org/dist/index.json') {
            if ($NodeFailure -eq 'network') { throw 'fixture network unavailable' }
            return @(
                @{ version = 'v26.0.0'; lts = $false; files = @("win-$ExpectedArch-zip") },
                @{ version = 'v22.99.0'; lts = 'fixture'; files = @("win-$ExpectedArch-zip") }
            )
        }
        return @{ files = $script:Hashes }
    }
    # The reported host throws here even for the current user. The installer
    # must persist only modified DACL sections using the .NET API instead.
    function Set-Acl { throw 'SeSecurityPrivilege is unavailable to a normal user' }
    function Invoke-WebRequest {
        param([switch]$UseBasicParsing, $Uri, $OutFile)
        $Name = ([uri]$Uri).Segments[-1]
        if ($Name -eq 'SHASUMS256.txt') {
            return @{ Content = $script:Hashes[$ArchiveName] + "  $ArchiveName`r`n" }
        }
        if ($Name -like 'node-*.zip') {
            Assert-That ($Name -eq $ArchiveName) "$Case selects the official LTS build for $ExpectedArch"
            $script:NodeDownloads++
        }
        $Body = if ($CorruptDownload) { 'corrupted download' } else { $script:Payloads[$Name] }
        if ($Name -like 'node-*.zip' -and $NodeFailure -eq 'checksum') { $Body = 'corrupt node archive' }
        [IO.File]::WriteAllText($OutFile, $Body, [Text.UTF8Encoding]::new($false))
    }
    # Simulate unpacking the downloaded archive. Execute a real supported Node
    # binary after extraction, including the CLI's fresh-window lookup.
    function Expand-Archive {
        param($LiteralPath, $DestinationPath)
        $script:ExpandedNode++
        $Folder = Join-Path $DestinationPath ([IO.Path]::GetFileNameWithoutExtension($LiteralPath))
        New-Item -ItemType Directory -Path $Folder | Out-Null
        Copy-Item -LiteralPath $FixtureNode -Destination (Join-Path $Folder 'node.exe')
        if (-not $NativeWindows) { & chmod +x (Join-Path $Folder 'node.exe') }
    }
    $Source = $Installer.Replace('__JETSPACE_BASE_URL__', 'https://fixture.example')
    if (-not $NativeWindows) {
        # Linux has no Windows SID/ACL APIs; retain real filesystem operations,
        # staging, checksums, profile management and invocation behavior.
        $Source = $Source.Replace('$Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User', '$Sid = $null')
        $Source = $Source.Replace("`$SystemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')", '$SystemSid = $null')
        $Ast = [Management.Automation.Language.Parser]::ParseInput($Source, [ref]$null, [ref]$null)
        $AclFunction = $Ast.Find({ param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Set-PrivateAcl' }, $true)
        $Source = $Source.Replace($AclFunction.Extent.Text, 'function Set-PrivateAcl { param([string]$Path) }')
    }
    # Never modify the real user PATH; the deduplication logic still runs.
    $Ast = [Management.Automation.Language.Parser]::ParseInput($Source, [ref]$null, [ref]$null)
    $PathReader = $Ast.Find({ param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Get-UserPathValue' }, $true)
    $PathWriter = $Ast.Find({ param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Set-UserPathValue' }, $true)
    $Source = $Source.Replace($PathReader.Extent.Text, 'function Get-UserPathValue { $script:UserPath }')
    $WriterFixture = if ($BlockedPath) { "function Set-UserPathValue { param([string]`$Value) throw 'registry is read-only' }" } else { 'function Set-UserPathValue { param([string]$Value) $script:UserPath = $Value; $script:UserPathWrites++ }' }
    $Source = $Source.Replace($PathWriter.Extent.Text, $WriterFixture)
    if ($CorruptDownload) {
        New-Item -ItemType Directory -Path $Root | Out-Null
        [IO.File]::WriteAllText((Join-Path $Root 'windows-cli.ps1'), 'original runtime')
    }
    $Failure = $null
    $Output = $null
    try { $Output = & ([scriptblock]::Create($Source)) -NoCreate:$NoCreate *>&1 | Out-String }
    catch { $Failure = $_ }
    Assert-That ($env:PSModulePath -eq $OriginalModulePath) "$Case restores the caller's module path"
    if ($RuntimeAclFailure) {
        Assert-That ($null -ne $Failure -and $Failure.ToString().Contains('installation verification failed')) "$Case fails when installed runtime cannot verify permissions"
        Assert-That (-not (Test-Path -LiteralPath (Join-Path $CaseRoot 'created.txt'))) "$Case stops before agent creation after verification failure"
        Remove-Item -LiteralPath $CaseRoot -Recurse -Force
        return
    }
    if ($NodeFailure) {
        Assert-That ($null -ne $Failure -and $Failure.ToString().Contains('Automatic Node.js setup failed:')) "$Case explains automatic install failure"
        Assert-That ($Failure.ToString().Contains('rerun this setup command')) "$Case provides retry instructions"
        Assert-That (-not (Test-Path -LiteralPath (Join-Path $Root 'nodejs/node.exe'))) "$Case never publishes unverified Node"
        Assert-That ($script:ExpandedNode -eq 0) "$Case never extracts an unverified download"
        Assert-That (@(Get-ChildItem -LiteralPath $Root -Filter 'node-download-*').Count -eq 0) "$Case removes partial download"
        Assert-That (-not (Test-Path -LiteralPath (Join-Path $Root 'installation.json'))) "$Case stops before CLI installation"
        $NodeFailure = ''
        & ([scriptblock]::Create($Source)) -NoCreate
        Assert-That (Test-Path -LiteralPath (Join-Path $Root 'installation.json')) "$Case succeeds on retry"
        Remove-Item -LiteralPath $CaseRoot -Recurse -Force
        return
    }
    if ($Agents -eq 'stop-fails') {
        Assert-That ($null -ne $Failure -and $Failure.ToString().Contains('Could not stop windos-test') -and $Failure.ToString().Contains('-ExecutionPolicy Bypass -File')) "$Case explains the failed stop with a full command"
        Assert-That ((Get-Content -LiteralPath (Join-Path $Root 'windows-agent-runner.js') -Raw) -eq 'previous runner') "$Case keeps the installed runner when an agent cannot be stopped"
        Remove-Item -LiteralPath $CaseRoot -Recurse -Force
        return
    }
    if ($CorruptDownload) {
        Assert-That ($null -ne $Failure -and $Failure.ToString().Contains('integrity check failed')) 'bad checksum stops installation'
        Assert-That ((Get-Content -LiteralPath (Join-Path $Root 'windows-cli.ps1') -Raw) -eq 'original runtime') 'bad download preserves the installed runtime'
        Assert-That (@(Get-ChildItem -LiteralPath $Root -Filter 'download-*').Count -eq 0) 'failed staging directory is removed'
        Remove-Item -LiteralPath $CaseRoot -Recurse -Force
        return
    }
    if ($Failure) { throw $Failure }
    Assert-That (Test-Path -LiteralPath (Join-Path $Root 'installation.json')) "$Case installs configuration"
    $Bin = Join-Path $Root 'bin'
    $Launcher = Get-Content -LiteralPath (Join-Path $Bin 'jetspace.cmd') -Raw
    Assert-That ($Launcher.Contains('-NoProfile -ExecutionPolicy Bypass -File "%~dp0..\windows-cli.ps1" %*')) "$Case installs a profile-independent jetspace launcher"
    Assert-That (@($env:PATH -split [IO.Path]::PathSeparator) -contains $Bin) "$Case makes jetspace available in this window"
    Assert-That (-not $Output.Contains('profile shortcut')) "$Case prints no profile warning"
    if ($BlockedPath) {
        Assert-That ($Output.Contains('registry is read-only') -and $Output.Contains('-ExecutionPolicy Bypass -File')) "$Case explains the PATH failure and prints the full command"
    } else {
        Assert-That ($script:UserPath -eq "%USERPROFILE%\tools;C:\Other;$Bin") "$Case adds the launcher to the user PATH without expanding entries"
        Assert-That ($Output.Contains('jetspace command now works')) "$Case explains the jetspace command"
    }
    if (-not $BlockedProfile) {
        $Remaining = Get-Content -LiteralPath $ProfilePath -Raw
        Assert-That (-not $Remaining.Contains('Jetspace Windows') -and $Remaining.Contains('# unrelated profile configuration')) "$Case removes only the old profile shortcut"
    }
    foreach ($Name in @('windows-cli.ps1', 'windows-agent-runner.js', 'external-agent-bridge.js')) {
        Assert-That ((Get-FileHash -LiteralPath (Join-Path $Root $Name)).Hash.ToLowerInvariant() -eq $script:Hashes[$Name]) "$Case verifies $Name"
    }
    $ExpectedDownloads = if ($NodeMode -eq 'current') { 0 } else { 1 }
    Assert-That ($script:NodeDownloads -eq $ExpectedDownloads) "$Case downloads Node only when needed"
    $HelpOutput = & ([scriptblock]::Create($CliSource)) help 6>&1
    Assert-That (($HelpOutput | Out-String).Contains('Jetspace native Windows agents')) "$Case real CLI can start with the selected Node runtime"
    if ($ExpectedDownloads) {
        $env:PATH = $SavedPath
        & ([scriptblock]::Create($CliSource)) help
        Assert-That ($env:PATH.StartsWith((Join-Path $Root 'nodejs'))) "$Case CLI finds bundled Node in a fresh window with a stale PATH"
    }
    if ($NativeWindows) {
        $Acl = Get-Acl -LiteralPath $Root
        Assert-That $Acl.AreAccessRulesProtected "$Case protects installation ACL"
        $Owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $Unexpected = @($Acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($Owner, 'S-1-5-18') })
        Assert-That ($Unexpected.Count -eq 0) "$Case restricts installation to owner and SYSTEM"
        # Run the actual Node -> Windows PowerShell ACL checker, including when
        # this harness is launched by pwsh with PS7's inherited module paths.
        $RealRunner = Join-Path $Repo 'scripts/windows-agent-runner.js'
        & $FixtureNode -e 'require(process.argv[1]).verifyPrivateDirectory(process.argv[2])' $RealRunner $Root
        Assert-That ($LASTEXITCODE -eq 0) "$Case real runner accepts installer ACLs through a Windows PowerShell subprocess"
        $Inherited = Join-Path $Root 'inherited-directory'
        New-Item -ItemType Directory -Path $Inherited | Out-Null
        & $FixtureNode -e 'try { require(process.argv[1]).verifyPrivateDirectory(process.argv[2]); process.exitCode=1; } catch (_) {}' $RealRunner $Inherited
        Assert-That ($LASTEXITCODE -eq 0) "$Case real runner rejects an unprotected installation directory"
        & $FixtureNode -e 'require(process.argv[1]).verifyPrivateDirectory(process.argv[2], false)' $RealRunner $Inherited
        Assert-That ($LASTEXITCODE -eq 0) "$Case real runner accepts private inherited agent storage"
    }
    if ($Agents) {
        $Runner = $script:Payloads['windows-agent-runner.js']
        Assert-That (($script:AgentCalls -join '|') -eq "list  [previous runner]|stop windos-test [previous runner]|list  [$Runner]|start windos-test [$Runner]") "$Case verifies the updated runner between stopping and restarting the agent"
        Assert-That (-not (Test-Path -LiteralPath (Join-Path $CaseRoot 'created.txt'))) "$Case does not ask for a new agent"
        Assert-That ($Output.Contains('Update complete. Your agents: windos-test, idle-agent.')) "$Case reports the updated agents"
    } elseif ($NoCreate) {
        Assert-That (-not (Test-Path -LiteralPath (Join-Path $CaseRoot 'created.txt'))) "$Case respects NoCreate"
    } else {
        Assert-That ((Get-Content -LiteralPath (Join-Path $CaseRoot 'created.txt') -Raw).Trim() -eq 'create') "$Case reaches agent creation"
    }
    jetspace help
    Assert-That ((Get-Content -LiteralPath (Join-Path $CaseRoot 'created.txt') -Raw).Trim() -eq 'help') "$Case shortcut forwards arguments through a path with spaces and apostrophes"
    if (-not $BlockedPath) {
        & ([scriptblock]::Create($Source)) -NoCreate *>&1 | Out-Null
        Assert-That ($script:UserPathWrites -eq 1) "$Case rerun keeps exactly one PATH entry"
        Assert-That ($script:NodeDownloads -eq $ExpectedDownloads) "$Case rerun reuses supported Node without downloading"
    }
    Remove-Item -LiteralPath $CaseRoot -Recurse -Force
}

try {
    foreach ($Text in @($Installer, $CliSource)) {
        $ParseErrors = $null
        [void][Management.Automation.Language.Parser]::ParseInput($Text, [ref]$null, [ref]$ParseErrors)
        Assert-That (@($ParseErrors).Count -eq 0) 'PowerShell script parses'
    }
    Test-Install -Case 'normal'
    Test-Install -Case 'blocked-profile' -BlockedProfile $true -NoCreate $false
    Test-Install -Case 'blocked-path' -BlockedPath $true
    Test-Install -Case 'corrupted-download' -CorruptDownload $true
    Test-Install -Case 'missing-node' -NodeMode 'missing' -NoCreate $false
    Test-Install -Case 'outdated-node' -NodeMode 'outdated'
    Test-Install -Case 'broken-bundle-replaced' -NodeMode 'outdated' -BrokenBundle $true
    Test-Install -Case 'broken-bundle-system-fallback' -BrokenBundle $true
    Test-Install -Case 'arm64-node' -NodeMode 'missing' -Architecture 'ARM64'
    Test-Install -Case 'x86-node' -NodeMode 'missing' -Architecture 'x86'
    Test-Install -Case 'corrupt-node' -NodeMode 'missing' -NodeFailure 'checksum'
    Test-Install -Case 'network-retry' -NodeMode 'missing' -NodeFailure 'network'
    Test-Install -Case 'update-running-agent' -NoCreate $false -Agents 'running'
    Test-Install -Case 'update-stop-fails' -NoCreate $false -Agents 'stop-fails'
    Test-Install -Case 'runtime-acl-fails' -NoCreate $false -RuntimeAclFailure $true
    # Execute the real CLI through its preflight with a fixture runner.
    $env:LOCALAPPDATA = Join-Path $TestRoot 'cli-preflight'
    $env:OS = 'Windows_NT'
    New-Item -ItemType Directory -Path (Join-Path $env:LOCALAPPDATA 'Jetspace') -Force | Out-Null
    '{"baseUrl":"https://fixture.example"}' | Set-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'Jetspace/installation.json')
    function Get-Command { param($Name, $ErrorAction) return @{ Source = 'fixture-node' } }
    function fixture-node {
        if ($args[0] -eq '--version') { $global:LASTEXITCODE = 0; 'v22.0.0'; return }
        $script:RunnerCalls += ,@($args | Select-Object -Skip 1)
        if ($args[1] -eq 'providers') {
            if ($script:ProviderMode -eq 'broken') { $global:LASTEXITCODE = 1; return }
            $global:LASTEXITCODE = 0
            @{ found = @($script:Found); installable = @{ codex = '@openai/codex'; claude = '@anthropic-ai/claude-code'; gemini = '@google/gemini-cli' } } | ConvertTo-Json -Compress
            return
        }
        if ($args[1] -eq 'check-connection' -and $script:ConnectionFailure) { $global:LASTEXITCODE = 1; return }
        if ($args[1] -eq 'init') { $script:InitPayload = ($input | Out-String | ConvertFrom-Json) }
        if ($args[1] -eq 'repair-encryption') {
            $script:RepairPayload = ($input | Out-String | ConvertFrom-Json)
            if ($script:RepairFailure) { $global:LASTEXITCODE = 1; return }
        }
        $global:LASTEXITCODE = 0
    }
    function Read-Host {
        param($Prompt, [switch]$AsSecureString)
        if ($AsSecureString) {
            $script:SecurePrompts++
            $script:Prompts += $Prompt
            if ($script:ProviderMode -ne 'found') { throw 'Credentials must not be requested without a provider' }
            return (ConvertTo-SecureString 'fixture-secret' -AsPlainText -Force)
        }
        $script:Prompts += $Prompt
        if ($Prompt -like 'Agent name*') { return '' }
        if ($Prompt -like 'Install one now*') { return '' }
        if ($Prompt -like 'Project folder*') { return '' }
        return 'n'
    }
    $script:ProviderMode = 'broken'; $script:RunnerCalls = @(); $script:Prompts = @()
    $Failure = $null
    try { & ([scriptblock]::Create($CliSource)) create -Name 'fixture' -NoStart 6>$null }
    catch { $Failure = $_ }
    Assert-That ($null -ne $Failure -and $Failure.ToString().Contains('Jetspace command failed') -and $script:RunnerCalls.Count -eq 1) 'provider discovery failure stops before any credential prompt'
    $script:ProviderMode = 'none'; $script:Found = @(); $script:RunnerCalls = @(); $script:Prompts = @()
    $Output = & ([scriptblock]::Create($CliSource)) create -Name 'fixture' -NoStart 6>&1 | Out-String
    Assert-That ($script:Prompts -contains 'Install one now? Enter 1, 2 or 3 (Enter to cancel)' -and $Output.Contains('No agent was created')) 'missing AI CLI offers installation and stops without credentials'
    Assert-That (-not ($script:RunnerCalls | Where-Object { $_[0] -eq 'init' })) 'missing AI CLI never registers an agent'
    $script:ProviderMode = 'found'; $script:Found = @('claude', 'gemini'); $script:RunnerCalls = @(); $script:Prompts = @(); $script:InitPayload = $null
    $script:ConnectionFailure = $true; $script:SecurePrompts = 0
    $Failure = $null
    try { & ([scriptblock]::Create($CliSource)) create -Name 'fixture' -NoStart 6>$null }
    catch { $Failure = $_ }
    Assert-That ($null -ne $Failure -and $null -eq $script:InitPayload -and $script:RunnerCalls.Count -eq 2) 'connection failure stops before registration'
    Assert-That ($script:SecurePrompts -eq 0) 'connection failure never requests account credentials'
    Assert-That (-not ($script:Prompts | Where-Object { $_ -like 'Project folder*' })) 'connection is checked before project and account prompts'
    $script:ConnectionFailure = $false; $script:Prompts = @(); $script:RunnerCalls = @()
    $Output = & ([scriptblock]::Create($CliSource)) create -Name 'fixture' -NoStart 6>&1 | Out-String
    Assert-That (-not ($script:Prompts | Where-Object { $_ -like 'Provider*' })) 'create never asks for a provider'
    Assert-That ($script:InitPayload.provider -eq 'claude' -and $script:InitPayload.project -eq (Get-Location).Path -and $script:InitPayload.allowEdits -eq $false) 'create defaults to the first installed provider and the current folder'
    Assert-That ($Output.Contains('Found AI CLI: claude, gemini. Default: claude.') -and $Output.Contains('switch between them')) 'create explains the detected providers'
    Assert-That ($script:Prompts -contains 'Message encryption password' -and $Output.Contains('Settings > Decryption Password')) 'create explains which password must match the website'
    $script:RunnerCalls = @(); $script:RepairFailure = $false
    & ([scriptblock]::Create($CliSource)) repair-encryption -Name 'fixture' 6>$null
    Assert-That (($script:RunnerCalls | ForEach-Object { $_[0] }) -join ',' -eq 'stop,repair-encryption,start') 'encryption repair stops the runner, verifies the password and resumes only after success'
    Assert-That ($script:RepairPayload.password -eq 'fixture-secret' -and -not ($script:RunnerCalls | Out-String).Contains('fixture-secret')) 'repair passes the password on stdin, never process arguments'
    $script:RunnerCalls = @(); $script:RepairFailure = $true
    $Failure = $null
    try { & ([scriptblock]::Create($CliSource)) repair-encryption -Name 'fixture' 6>$null } catch { $Failure = $_ }
    Assert-That ($null -ne $Failure -and ($script:RunnerCalls | ForEach-Object { $_[0] }) -join ',' -eq 'stop,repair-encryption') 'failed repair leaves the agent stopped without starting it'
    $script:RepairFailure = $false
    $script:InitPayload = $null
    $Failure = $null
    try { & ([scriptblock]::Create($CliSource)) create -Name 'fixture' -Provider codex -NoStart 6>$null }
    catch { $Failure = $_ }
    Assert-That ($null -eq $script:InitPayload -and $Failure.ToString().Contains('codex is not installed')) 'an unavailable explicit provider stops before registration'
    $script:Prompts = @(); $script:RunnerCalls = @()
    & ([scriptblock]::Create($CliSource)) create -NoStart 6>$null
    Assert-That ($script:RunnerCalls.Count -eq 0) 'blank name leaves installation ready without account prompts or provider execution'
    # Load the actual menu functions, then supply keys/actions without a console.
    $Ast = [Management.Automation.Language.Parser]::ParseInput($CliSource, [ref]$null, [ref]$null)
    $MenuFunctions = $Ast.FindAll({ param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -in @('Select-JetspaceOption','Show-JetspaceTui','Test-JetspaceTerminal') }, $true)
    . ([scriptblock]::Create(($MenuFunctions | ForEach-Object { $_.Extent.Text }) -join "`n"))
    function Clear-Host { }
    $script:Keys = [Collections.Generic.Queue[string]]::new()
    foreach ($Key in @('UpArrow','DownArrow','DownArrow','Enter')) { $script:Keys.Enqueue($Key) }
    $Selection = Select-JetspaceOption -Title 'Fixture' -Options @('one','two','three') -ReadKey { [pscustomobject]@{ Key = $script:Keys.Dequeue() } } 6>$null
    Assert-That ($Selection -eq 1) 'TUI arrows wrap and Enter selects the highlighted action'
    $Selection = Select-JetspaceOption -Title 'Fixture' -Options @('one') -ReadKey { [pscustomobject]@{ Key = 'Escape' } } 6>$null
    Assert-That ($Selection -eq -1) 'TUI Escape cancels without an action'
    function Test-JetspaceTerminal { return $true }
    $script:Choices = [Collections.Generic.Queue[int]]::new()
    foreach ($Choice in @(1, 1, 6, 0, -1)) { $script:Choices.Enqueue($Choice) }
    function Select-JetspaceOption { param($Title, $Options) return $script:Choices.Dequeue() }
    function menu-node {
        $global:LASTEXITCODE = 0
        "first-agent`tstopped`tC:\Project one"
        "agent 'two'; literal`tstopped`tC:\Project two"
    }
    $Node = @{ Source = 'menu-node' }; $Runner = 'fixture-runner'
    $Root = Join-Path $TestRoot 'menu-dispatch'
    New-Item -ItemType Directory -Path $Root | Out-Null
    Set-Content -LiteralPath (Join-Path $Root 'windows-cli.ps1') -Value 'param($Command, $Name, $Message) Add-Content -LiteralPath (Join-Path $PSScriptRoot "calls.jsonl") -Value (@{ Command=$Command; Name=$Name; Message=$Message } | ConvertTo-Json -Compress); if ($Command -eq "create") { throw "fixture failure" }'
    function Read-Host { param($Prompt) if ($Prompt -like 'Message*') { return 'hello & | % ^ ; literal' }; return '' }
    Show-JetspaceTui 6>$null
    $MenuCalls = @(Get-Content -LiteralPath (Join-Path $Root 'calls.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
    Assert-That ($MenuCalls.Count -eq 2 -and $MenuCalls[0].Command -eq 'start' -and $MenuCalls[0].Name -eq "agent 'two'; literal") 'TUI starts the selected agent with a literal name'
    Assert-That ($MenuCalls[1].Command -eq 'send' -and $MenuCalls[1].Name -eq 'first-agent' -and $MenuCalls[1].Message -eq 'hello & | % ^ ; literal') 'TUI sends message characters without shell interpolation'
    foreach ($Choice in @(3, 1, -1, 0, -1)) { $script:Choices.Enqueue($Choice) }
    Show-JetspaceTui 6>$null
    $MenuCalls = @(Get-Content -LiteralPath (Join-Path $Root 'calls.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
    Assert-That ($MenuCalls.Count -eq 3 -and $MenuCalls[2].Command -eq 'create' -and $script:Choices.Count -eq 0) 'TUI handles no running agents, cancelled selection and failed actions, then returns to the menu'
    function Test-JetspaceTerminal { return $false }
    Show-JetspaceTui 6>$null
    Assert-That (@(Get-Content -LiteralPath (Join-Path $Root 'calls.jsonl')).Count -eq 3) 'redirected input returns without reading keys or executing actions'
    # Execute the complete CLI with no command and replace only its terminal UI.
    $Menu = $Ast.Find({ param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Show-JetspaceTui' }, $true)
    $DefaultSource = $CliSource.Replace($Menu.Extent.Text, 'function Show-JetspaceTui { $script:MenuOpened = $true }')
    $script:MenuOpened = $false
    & ([scriptblock]::Create($DefaultSource)) 6>$null
    Assert-That $script:MenuOpened 'bare jetspace opens the TUI by default'
    Write-Host "Passed $script:Passed installer assertions ($([Environment]::OSVersion.Platform))."
    $global:LASTEXITCODE = 0
} finally {
    $env:LOCALAPPDATA = $SavedLocalAppData
    $env:OS = $SavedOs
    $env:PATH = $SavedPath
    $env:PROCESSOR_ARCHITECTURE = $SavedArchitecture
    $env:PROCESSOR_ARCHITEW6432 = $SavedWowArchitecture
    Remove-Item Function:global:jetspace -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $TestRoot -Recurse -Force -ErrorAction SilentlyContinue
}
