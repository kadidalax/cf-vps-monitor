[CmdletBinding()]
param(
  [Alias("s")]
  [string]$Server,

  [Alias("t")]
  [string]$Token,

  [Alias("n")]
  [string]$Name = $env:COMPUTERNAME,
  [Alias("Interval")]
  [int]$ReportInterval = 3,
  [int]$PingInterval = 120,
  [Alias("r")]
  [ValidateRange(1, 31)]
  [int]$TrafficResetDay = 1,
  [ValidateSet("websocket", "http")]
  [string]$Mode = "websocket",
  [Alias("i")]
  [string]$InstanceId = "",
  [string]$InstallDir = "",
  [string]$ServiceName = "",
  [string]$SourceUrl = "",
  [switch]$BuildFromSource,
  [string]$BinaryPath = "",
  [string]$BinaryUrl = "",
  [string]$BinaryBaseUrl = "",
  [string]$ChecksumUrl = "",
  [string]$ReleaseTag = "",
  [string]$Proxy = "",
  [string]$MountInclude = "",
  [string]$MountExclude = "",
  [string]$NicInclude = "",
  [string]$NicExclude = "",
  [switch]$DisableWebSsh,
  [switch]$DisableAutoUpdate,
  [switch]$IgnoreUnsafeCert,
  [string]$InstallGhproxy = "",
  [switch]$DryRun,
  [switch]$Uninstall,
  [switch]$UninstallAll,
  [switch]$Yes,
  [switch]$KeepFiles
)

$ErrorActionPreference = "Stop"

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Description,
    [scriptblock]$Action
  )

  if ($DryRun) {
    Write-Host "[dry-run] $Description"
    return
  }

  & $Action
}

if (-not $DryRun -and -not (Test-Admin)) {
  throw "Please run this script from an elevated PowerShell session."
}

function ConvertTo-InstanceId {
  param([string]$Value)
  $candidate = if ([string]::IsNullOrWhiteSpace($Value)) { "default" } else { $Value }
  $cleaned = ($candidate.ToLowerInvariant() -replace '[^a-z0-9_.-]+', '-') -replace '^-+', '' -replace '-+$', ''
  if ([string]::IsNullOrWhiteSpace($cleaned)) {
    $cleaned = "default"
  }
  if ($cleaned.Length -gt 48) {
    $cleaned = $cleaned.Substring(0, 48)
  }
  if ($cleaned -match '^\.+$' -or $cleaned.EndsWith('.') -or
      $cleaned -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)') {
    throw "-InstanceId must identify a normal directory, not a dot segment or reserved Windows name."
  }
  return $cleaned
}

function Set-InstanceDefaults {
  $base = ConvertTo-InstanceId $InstanceId
  $script:NormalizedInstanceId = $base
  if ([string]::IsNullOrWhiteSpace($script:ServiceName)) {
    $script:ServiceName = "CFVpsMonitorAgent-$base"
  }
  if ([string]::IsNullOrWhiteSpace($script:InstallDir)) {
    $script:InstallDir = Join-Path "$env:ProgramFiles\CF VPS Monitor" $base
  }
}

function Get-AgentInstallMarker {
  param([string]$Directory)
  $markerPath = Join-Path $Directory '.cf-vps-monitor-instance.json'
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { return $null }
  try { return Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

function Test-LegacyAgentInstallDirectory {
  param([string]$Directory, [string]$TaskName)
  $runner = Join-Path $Directory 'run-agent.ps1'
  if (-not (Test-Path -LiteralPath (Join-Path $Directory 'cf-vps-monitor-agent.exe') -PathType Leaf) -or
      -not (Test-Path -LiteralPath $runner -PathType Leaf)) { return $false }
  $tasks = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
  if ($tasks.Count -ne 1 -or -not (Test-AgentTaskDefinition -Task $tasks[0] -Directory $Directory -TaskName $TaskName)) { return $false }

  # Legacy installers had no marker. Only their dedicated files prove the whole directory is ours.
  foreach ($entry in Get-ChildItem -LiteralPath $Directory -Force) {
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
    if ($entry.PSIsContainer) {
      if ($entry.Name -ne 'state') { return $false }
      foreach ($stateEntry in Get-ChildItem -LiteralPath $entry.FullName -Force) {
        if ($stateEntry.PSIsContainer -or ($stateEntry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
        if ($stateEntry.Name -notin @('agent.log', 'runner.log') -and
            $stateEntry.Name -notmatch '^traffic-state\.json(?:\.bak|\.tmp(?:-\d+)?|\.backup-\d+)?$') { return $false }
      }
    } elseif ($entry.Name -notin @('cf-vps-monitor-agent.exe', 'run-agent.ps1')) { return $false }
  }
  return $true
}

function Test-AgentTaskDefinition {
  param($Task, [string]$Directory, [string]$TaskName)
  if (-not $Task -or $Task.TaskName -cne $TaskName -or $Task.TaskPath -cne '\') { return $false }
  $actions = @($Task.Actions)
  if ($actions.Count -ne 1) { return $false }
  $runner = Join-Path $Directory 'run-agent.ps1'
  $expectedExecute = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $expectedArguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $runner + '"'
  if (-not [string]::Equals($actions[0].Execute, $expectedExecute, [StringComparison]::OrdinalIgnoreCase) -or
      $actions[0].Arguments -cne $expectedArguments -or
      -not [string]::Equals($actions[0].WorkingDirectory, $Directory, [StringComparison]::OrdinalIgnoreCase)) { return $false }

  return $true
}

function Assert-AgentInstallDirectory {
  param([string]$Directory, [string]$Id, [string]$TaskName, [switch]$RequireOwnership)
  if ([string]::IsNullOrWhiteSpace($Directory) -or
      ($Directory -notmatch '^[A-Za-z]:[\\/]' -and $Directory -notmatch '^\\\\[^\\]+\\[^\\]+\\') -or
      $Directory -match '^\\\\[?.]\\') {
    throw '-InstallDir must be a fully qualified, ordinary filesystem directory.'
  }
  $resolved = [IO.Path]::GetFullPath($Directory).TrimEnd('\', '/')
  $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Directory))
  if ($resolved.Equals($root.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
    throw '-InstallDir must not be a drive or share root.'
  }
  $instanceRoot = [IO.Path]::GetFullPath((Join-Path $env:ProgramFiles 'CF VPS Monitor')).TrimEnd('\', '/')
  $protected = @($root, $instanceRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:SystemRoot, $env:ProgramData, $env:USERPROFILE)
  foreach ($directoryRoot in $protected) {
    if ($directoryRoot -and $resolved.Equals([IO.Path]::GetFullPath($directoryRoot).TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
      throw '-InstallDir must not be a drive root, shared instance root, or system/user parent directory.'
    }
  }
  if ($env:SystemRoot -and $resolved.StartsWith($env:SystemRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw '-InstallDir must not be inside the Windows system directory.'
  }
  foreach ($part in ($resolved -split '[\\/]' | Select-Object -Skip 1)) {
    if ($part -match '[. ]$' -or $part -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)') {
      throw '-InstallDir contains an ambiguous or reserved Windows path component.'
    }
  }
  $ancestor = $resolved
  while ($ancestor) {
    if (Test-Path -LiteralPath $ancestor) {
      $entry = Get-Item -LiteralPath $ancestor -Force
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '-InstallDir must not traverse a junction or symbolic link.' }
    }
    $ancestor = Split-Path -Parent $ancestor
  }
  $exists = Test-Path -LiteralPath $resolved
  if ($exists -and -not (Test-Path -LiteralPath $resolved -PathType Container)) { throw '-InstallDir must be a directory.' }
  $marker = Get-AgentInstallMarker $resolved
  $owned = $marker -and $marker.application -eq 'cf-vps-monitor-agent' -and $marker.version -eq 1 -and
    $marker.instance_id -ceq $Id -and $marker.service_name -ceq $TaskName -and
    [string]::Equals([string]$marker.install_dir, $resolved, [StringComparison]::OrdinalIgnoreCase)
  # Default and custom legacy installs need the same exact task and dedicated-file proof.
  if (-not $owned -and -not (Test-Path -LiteralPath (Join-Path $resolved '.cf-vps-monitor-instance.json')) -and
      $exists) {
    $owned = Test-LegacyAgentInstallDirectory -Directory $resolved -TaskName $TaskName
  }
  if (-not $owned -and ($RequireOwnership -or ($exists -and @(Get-ChildItem -LiteralPath $resolved -Force).Count -gt 0))) {
    throw '-InstallDir does not contain a matching CF VPS Monitor installation marker. Refusing to modify an unowned directory.'
  }
  if ($exists -and @(Get-ChildItem -LiteralPath $resolved -Force -Recurse | Where-Object {
    $_.Attributes -band [IO.FileAttributes]::ReparsePoint
  }).Count -gt 0) { throw '-InstallDir contains a junction or symbolic link; recursive changes are refused.' }
  return $resolved
}

function Write-AgentInstallMarker {
  $marker = @{ application = 'cf-vps-monitor-agent'; version = 1; instance_id = $NormalizedInstanceId; service_name = $ServiceName; install_dir = $InstallDir }
  $marker | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $InstallDir '.cf-vps-monitor-instance.json') -Encoding UTF8
}

function Assert-AgentLegacyService {
  param([string]$Directory, [string]$TaskName)
  $service = Get-Service -Name $TaskName -ErrorAction SilentlyContinue
  if (-not $service) { return }
  $definitions = @(Get-CimInstance -ClassName Win32_Service -ErrorAction Stop | Where-Object { $_.Name -ceq $TaskName })
  if ($definitions.Count -ne 1) { throw "Cannot prove ownership of existing service: $TaskName" }
  $command = ([string]$definitions[0].PathName).Trim()
  $executable = if ($command -match '^"([^"]+)"(?:\s|$)') { $Matches[1] }
    elseif ($command -match '^([^\s"]+)(?:\s|$)') { $Matches[1] } else { '' }
  $expected = Join-Path $Directory 'cf-vps-monitor-agent.exe'
  if (-not [string]::Equals($executable, $expected, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Existing service belongs to another application: $TaskName"
  }
}

function Assert-AgentSystemResources {
  param([string]$Directory, [string]$Id, [string]$TaskName)
  # Query all same-name tasks first: another TaskPath is an identity conflict,
  # not permission to overwrite the root task or stop an unrelated folder task.
  $tasks = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
  if ($tasks.Count -gt 0) {
    if ($tasks.Count -ne 1 -or -not (Test-AgentTaskDefinition -Task $tasks[0] -Directory $Directory -TaskName $TaskName)) {
      throw "Existing scheduled task belongs to another instance: $TaskName"
    }
    $null = Assert-AgentInstallDirectory -Directory $Directory -Id $Id -TaskName $TaskName -RequireOwnership
  }
  if (Get-Service -Name $TaskName -ErrorAction SilentlyContinue) {
    $null = Assert-AgentInstallDirectory -Directory $Directory -Id $Id -TaskName $TaskName -RequireOwnership
    Assert-AgentLegacyService -Directory $Directory -TaskName $TaskName
  }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repository = "kadidalax/cf-vps-monitor"
$branch = "main"
$autoBinaryUrl = $false

function Test-SafeReleaseTag {
  param([string]$Tag)
  if ($Tag.Length -gt 128 -or $Tag -cnotmatch '\A[A-Za-z0-9_][A-Za-z0-9._+-]*\z' -or
      $Tag.Contains('..') -or $Tag.EndsWith('.') -or $Tag.EndsWith('.lock', [StringComparison]::Ordinal)) { return $false }
  if (-not $Tag.Contains('+')) { return $true }
  $number = '(0|[1-9][0-9]*)'
  $prerelease = '(0|[1-9][0-9]*|[0-9]*[A-Za-z-][A-Za-z0-9-]*)'
  $pattern = "\Av${number}\.${number}\.${number}(-${prerelease}(\.${prerelease})*)?(\+[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*)?\z"
  return $Tag -cmatch $pattern
}

function Resolve-ReleaseBase {
  if ([string]::IsNullOrEmpty($ReleaseTag)) {
    return "https://github.com/$repository/releases/latest/download"
  }
  if (-not (Test-SafeReleaseTag $ReleaseTag)) {
    throw '-ReleaseTag must be a safe tag of at most 128 ASCII characters; build metadata requires vSemVer.'
  }
  return "https://github.com/$repository/releases/download/$([Uri]::EscapeDataString($ReleaseTag))"
}

$releaseBase = Resolve-ReleaseBase

function ConvertTo-PowerShellLiteral {
  param([string]$Value)
  return "'" + ($Value -replace "'", "''") + "'"
}

function Join-GitHubProxy {
  param([string]$Url)
  if ([string]::IsNullOrWhiteSpace($InstallGhproxy)) {
    return $Url
  }
  return $InstallGhproxy.TrimEnd("/") + "/" + $Url
}

function Assert-HttpsUrl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [string]$Url
  )
  if (-not [string]::IsNullOrWhiteSpace($Url) -and -not $Url.StartsWith("https://", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Name must use an https:// URL."
  }
}

function Normalize-HttpUrl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [string]$Url,
    [bool]$AllowPath = $true
  )
  if ([string]::IsNullOrWhiteSpace($Url)) {
    return ""
  }
  try {
    $uri = [Uri]$Url
  } catch {
    throw "$Name must be a valid http:// or https:// URL."
  }
  if (-not $uri.IsAbsoluteUri -or ($uri.Scheme -ne "http" -and $uri.Scheme -ne "https") -or
      -not [string]::IsNullOrWhiteSpace($uri.UserInfo) -or
      -not [string]::IsNullOrWhiteSpace($uri.Query) -or
      -not [string]::IsNullOrWhiteSpace($uri.Fragment) -or
      [string]::IsNullOrWhiteSpace($uri.Host)) {
    throw "$Name must use an http:// or https:// URL without credentials, query, or fragment."
  }
  $path = if ($AllowPath -and $uri.AbsolutePath -ne "/") { $uri.AbsolutePath.TrimEnd("/") } else { "" }
  return "$($uri.Scheme)://$($uri.Authority)$path"
}

function Invoke-DownloadFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [Parameter(Mandatory = $true)]
    [string]$OutFile
  )

  if ($DryRun) {
    $proxyText = if ([string]::IsNullOrWhiteSpace($Proxy)) { "" } else { " -Proxy `"$Proxy`"" }
    Write-Host "[dry-run] Invoke-WebRequest $Url$proxyText -OutFile `"$OutFile`""
    return
  }

  $downloadParams = @{
    Uri = $Url
    UseBasicParsing = $true
    OutFile = $OutFile
  }
  if (-not [string]::IsNullOrWhiteSpace($Proxy)) {
    $downloadParams.Proxy = $Proxy
  }
  Invoke-WebRequest @downloadParams
}

function New-AgentTemporaryDirectory {
  $directory = Join-Path $env:TEMP ('cf-vps-monitor-' + [Guid]::NewGuid().ToString('N'))
  if (-not $DryRun) { New-Item -ItemType Directory -Path $directory | Out-Null }
  return $directory
}

function Resolve-BuildDirectory {
  $localMain = Join-Path $scriptDir "main.go"
  if (Test-Path -LiteralPath $localMain) {
    return $scriptDir
  }

  $archiveUrl = if ([string]::IsNullOrWhiteSpace($SourceUrl)) {
    "https://github.com/$repository/archive/refs/heads/$branch.zip"
  } else {
    $SourceUrl
  }
  $archiveUrl = Join-GitHubProxy $archiveUrl
  $sourceWorkDir = New-AgentTemporaryDirectory
  $archivePath = Join-Path $sourceWorkDir 'source.zip'
  $extractDir = Join-Path $sourceWorkDir 'source'

  Invoke-DownloadFile -Url $archiveUrl -OutFile $archivePath

  if ($DryRun) {
    Write-Host "[dry-run] Expand-Archive -LiteralPath `"$archivePath`" -DestinationPath `"$extractDir`""
    return (Join-Path $extractDir "<detected-agent-directory>")
  }

  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force
  $mainGo = Get-ChildItem -LiteralPath $extractDir -Recurse -Filter main.go |
    Where-Object { $_.FullName -match "\\agent\\main\.go$" } |
    Select-Object -First 1
  if (-not $mainGo) {
    throw "Cannot find agent/main.go in source archive: $archiveUrl"
  }
  return $mainGo.Directory.FullName
}

function Get-DefaultBinaryUrl {
  $arch = switch ($env:PROCESSOR_ARCHITECTURE.ToLowerInvariant()) {
    "amd64" { "amd64" }
    "x86" { "386" }
    "arm64" { "amd64" }
    default { "amd64" }
  }
  if ($arch -ne "amd64") {
    throw "Unsupported Windows CPU architecture for prebuilt agent: $env:PROCESSOR_ARCHITECTURE"
  }
  $base = Get-AgentAssetBase
  $url = "$base/cf-vps-monitor-agent-windows-amd64.exe"
  if (-not [string]::IsNullOrWhiteSpace($BinaryBaseUrl)) {
    return $url
  }
  return Join-GitHubProxy $url
}

function Get-DefaultChecksumUrl {
  $url = "$(Get-AgentAssetBase)/SHA256SUMS"
  if (-not [string]::IsNullOrWhiteSpace($BinaryBaseUrl)) {
    return $url
  }
  return Join-GitHubProxy $url
}

function Get-AgentAssetBase {
  if ([string]::IsNullOrWhiteSpace($BinaryBaseUrl)) {
    return $releaseBase.TrimEnd("/")
  }
  return $BinaryBaseUrl.TrimEnd("/")
}

function Test-DownloadedChecksum {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$FileName,
    [Parameter(Mandatory = $true)]
    [string]$Url
  )

  if ($DryRun) {
    Write-Host "[dry-run] verify SHA256SUMS for $FileName from $Url"
    return
  }

  $sumsPath = Join-Path $env:TEMP ("cf-vps-monitor-agent-sha256-" + [Guid]::NewGuid().ToString("N") + ".txt")
  Invoke-DownloadFile -Url $Url -OutFile $sumsPath
  try {
    $line = Get-Content -LiteralPath $sumsPath |
      Where-Object {
        $parts = ($_ -split '\s+') | Where-Object { $_ -ne "" }
        ($parts.Count -ge 2) -and ((Split-Path -Leaf $parts[-1].TrimStart("*")) -eq $FileName)
      } |
      Select-Object -First 1
    if (-not $line) {
      throw "Cannot find $FileName in SHA256SUMS from $Url."
    }
    $expected = (($line -split '\s+') | Where-Object { $_ -ne "" } | Select-Object -First 1).ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      throw "Checksum verification failed for $FileName. Expected $expected, got $actual."
    }
  } finally {
    Remove-Item -LiteralPath $sumsPath -Force -ErrorAction SilentlyContinue
  }
}

function Remove-AgentTask {
  param([string]$Name)
  $task = Get-ScheduledTask -TaskName $Name -TaskPath '\' -ErrorAction SilentlyContinue
  if (-not $task) {
    return $false
  }
  Invoke-Step "Stop-ScheduledTask -TaskName `"$Name`"" {
    Stop-ScheduledTask -TaskName $Name -TaskPath '\' -ErrorAction Stop
  }
  Invoke-Step "Unregister-ScheduledTask -TaskName `"$Name`" -Confirm:`$false" {
    Unregister-ScheduledTask -TaskName $Name -TaskPath '\' -Confirm:$false -ErrorAction Stop
  }
  return $true
}

function Remove-LegacyService {
  param([string]$Name, [string]$Directory = $InstallDir)
  $existing = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if (-not $existing) {
    return $false
  }
  Assert-AgentLegacyService -Directory $Directory -TaskName $Name
  if ($existing.Status -ne "Stopped") {
    Invoke-Step "Stop-Service -Name `"$Name`" -Force" {
      Stop-Service -Name $Name -Force
    }
  }
  Invoke-Step "sc.exe delete `"$Name`"" {
    sc.exe delete $Name | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to remove legacy service: $Name (exit $LASTEXITCODE)" }
  }
  return $true
}

function Get-AgentInstanceProcesses {
  param([string]$Executable)
  return @(Get-Process -Name 'cf-vps-monitor-agent' -ErrorAction SilentlyContinue | Where-Object {
    [string]::Equals($_.Path, $Executable, [StringComparison]::OrdinalIgnoreCase)
  })
}

function Stop-AgentInstanceProcesses {
  param([string]$Executable)
  foreach ($process in (Get-AgentInstanceProcesses $Executable)) {
    Stop-Process -Id $process.Id -Force -ErrorAction Stop
    if (-not $process.WaitForExit(15000)) { throw "Agent process $($process.Id) did not exit; replacement aborted." }
  }
}

function Wait-AgentInstanceStarted {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $task = Get-ScheduledTask -TaskName $ServiceName -TaskPath '\' -ErrorAction Stop
    if ($task.State -eq 'Running' -and @(Get-AgentInstanceProcesses $targetExe).Count -gt 0) { return }
    if ($task.State -ne 'Running' -and $task.State -ne 'Queued') { throw 'Agent scheduled task exited before the Agent started.' }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Agent startup could not be confirmed within 15 seconds.'
}

function Install-AgentInstance {
  param([string]$RunnerContent)
  $null = Assert-AgentInstallDirectory -Directory $InstallDir -Id $NormalizedInstanceId -TaskName $ServiceName
  Assert-AgentSystemResources -Directory $InstallDir -Id $NormalizedInstanceId -TaskName $ServiceName
  New-Item -ItemType Directory -Force $InstallDir | Out-Null
  New-Item -ItemType Directory -Force $StateDir | Out-Null
  $stageDir = Join-Path $InstallDir ('.upgrade-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stageDir | Out-Null
  $stagedExe = Join-Path $stageDir 'new-agent.exe'
  $stagedRunner = Join-Path $stageDir 'new-runner.ps1'
  $markerPath = Join-Path $InstallDir '.cf-vps-monitor-instance.json'
  $previousTask = Get-ScheduledTask -TaskName $ServiceName -TaskPath '\' -ErrorAction SilentlyContinue
  $previousTaskXml = if ($previousTask) { Export-ScheduledTask -TaskName $ServiceName -TaskPath '\' -ErrorAction Stop } else { $null }
  $previousTaskRunning = $previousTask -and $previousTask.State -eq 'Running'
  $previousService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  $previousServiceRunning = $previousService -and $previousService.Status -ne 'Stopped'
  $backups = @{}
  $stopped = $false
  $registered = $false
  $canCleanStage = $false
  try {
    # Finish staging and preserve the old bytes before stopping the running instance.
    Copy-Item -LiteralPath $BinaryPath -Destination $stagedExe -Force
    if ((Get-Item -LiteralPath $stagedExe).Length -eq 0) { throw 'Staged Agent executable is empty.' }
    [IO.File]::WriteAllText($stagedRunner, $RunnerContent, [Text.UTF8Encoding]::new($true))
    foreach ($file in @($targetExe, $runnerPath, $markerPath)) {
      if (Test-Path -LiteralPath $file -PathType Leaf) {
        $backup = Join-Path $stageDir ('old-' + (Split-Path $file -Leaf))
        Copy-Item -LiteralPath $file -Destination $backup
        $backups[$file] = $backup
      }
    }

    $stopped = $true
    if ($previousTask) { Stop-ScheduledTask -TaskName $ServiceName -TaskPath '\' -ErrorAction Stop }
    if ($previousServiceRunning) { Stop-Service -Name $ServiceName -Force -ErrorAction Stop }
    Stop-AgentInstanceProcesses $targetExe
    Copy-Item -LiteralPath $stagedExe -Destination $targetExe -Force
    Copy-Item -LiteralPath $stagedRunner -Destination $runnerPath -Force
    Write-AgentInstallMarker

    takeown.exe /F $InstallDir /R /A /D Y 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot take ownership of the Agent directory.' }
    icacls $InstallDir /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:RX' '*S-1-5-19:(OI)(CI)RX' /T /C | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot set Agent directory permissions.' }
    icacls $StateDir /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:M' '*S-1-5-19:(OI)(CI)M' /T /C | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot set Agent state permissions.' }
    if (-not (Test-Path -LiteralPath $AgentLogPath)) { New-Item -ItemType File -Path $AgentLogPath | Out-Null }

    $action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $taskArguments -WorkingDirectory $InstallDir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCAL SERVICE' -LogonType ServiceAccount -RunLevel Limited
    Register-ScheduledTask -TaskName $ServiceName -TaskPath '\' -Description 'CF VPS Monitor Agent' -Action $action `
      -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    $registered = $true
    Start-ScheduledTask -TaskName $ServiceName -TaskPath '\' -ErrorAction Stop
    Wait-AgentInstanceStarted
    # Keep the legacy service definition until the replacement has actually started.
    [void](Remove-LegacyService $ServiceName)
    $canCleanStage = $true
  } catch {
    $installFailure = $_
    if ($stopped) {
      try {
        if ($registered) { Stop-ScheduledTask -TaskName $ServiceName -TaskPath '\' -ErrorAction SilentlyContinue }
        Stop-AgentInstanceProcesses $targetExe
        foreach ($file in @($targetExe, $runnerPath, $markerPath)) {
          if ($backups.ContainsKey($file)) { Copy-Item -LiteralPath $backups[$file] -Destination $file -Force }
          elseif (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file -Force }
        }
        if ($previousTaskXml) {
          Register-ScheduledTask -TaskName $ServiceName -TaskPath '\' -Xml $previousTaskXml -Force | Out-Null
          if ($previousTaskRunning) { Start-ScheduledTask -TaskName $ServiceName -TaskPath '\' -ErrorAction Stop; Wait-AgentInstanceStarted }
        } elseif ($registered) { Unregister-ScheduledTask -TaskName $ServiceName -TaskPath '\' -Confirm:$false }
        if ($previousServiceRunning) { Start-Service -Name $ServiceName -ErrorAction Stop }
        $canCleanStage = $true
      } catch { Write-Warning "Agent rollback failed: $($_.Exception.Message). Recovery files remain in $stageDir"; throw $installFailure }
    }
    throw $installFailure
  } finally {
    # Delete only this attempt's validated staging directory after successful recovery or install.
    $stageResolved = [IO.Path]::GetFullPath($stageDir)
    if ($canCleanStage -and $stageResolved.StartsWith($InstallDir.TrimEnd('\') + '\.upgrade-', [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $stageResolved -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  Get-ScheduledTask -TaskName $ServiceName -TaskPath '\'
}

function Uninstall-AllAgents {
  if (-not $Yes) {
    throw '-UninstallAll requires -Yes because it removes owned CF VPS Monitor installations.'
  }
  $rootDir = Join-Path $env:ProgramFiles 'CF VPS Monitor'
  $candidates = @()
  $skipped = 0
  if (Test-Path -LiteralPath $rootDir -PathType Container) {
    $candidates += @(Get-ChildItem -LiteralPath $rootDir -Directory -Force | ForEach-Object {
      @{ Directory = $_.FullName; TaskName = $null }
    })
  }
  # A custom task name is supported at installation. Its full action identity and
  # directory ownership, rather than a name prefix, determine whether it is ours.
  foreach ($task in @(Get-ScheduledTask -ErrorAction Stop)) {
    $actions = @($task.Actions)
    if ($task.TaskPath -cne '\' -or $actions.Count -ne 1 -or
        [string]::IsNullOrWhiteSpace($actions[0].WorkingDirectory)) {
      $skipped++
      continue
    }
    $candidates += @{ Directory = [string]$actions[0].WorkingDirectory; TaskName = [string]$task.TaskName }
  }
  # A marked older installation may have a service instead of a scheduled task.
  foreach ($service in @(Get-CimInstance -ClassName Win32_Service -ErrorAction Stop)) {
    $command = ([string]$service.PathName).Trim()
    $executable = if ($command -match '^"([^"]+)"(?:\s|$)') { $Matches[1] }
      elseif ($command -match '^([^\s"]+)(?:\s|$)') { $Matches[1] } else { '' }
    if ($executable -and [IO.Path]::GetFileName($executable) -ieq 'cf-vps-monitor-agent.exe') {
      $candidates += @{ Directory = [IO.Path]::GetDirectoryName($executable); TaskName = [string]$service.Name }
    }
  }
  $plans = @()
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($candidate in $candidates) {
    $directory = [string]$candidate.Directory
    try {
      $marker = Get-AgentInstallMarker $directory
      $id = ConvertTo-InstanceId $(if ($marker) { [string]$marker.instance_id } else { Split-Path $directory -Leaf })
      $taskName = if ($candidate.TaskName) { [string]$candidate.TaskName }
        elseif ($marker) { [string]$marker.service_name } else { "CFVpsMonitorAgent-$id" }
      if ([string]::IsNullOrWhiteSpace($taskName) -or $taskName -match '[\\/\*?\[\]]') { throw 'Unsafe task name' }
      $resolved = Assert-AgentInstallDirectory -Directory $directory -Id $id -TaskName $taskName -RequireOwnership
      Assert-AgentSystemResources -Directory $resolved -Id $id -TaskName $taskName
      if ($seen.Add($resolved + [char]0 + $taskName)) {
        $plans += @{ Directory = $resolved; TaskName = $taskName; Id = $id }
      }
    } catch {
      $skipped++
      Write-Warning "Skipping unowned or unsafe directory: $directory"
    }
  }
  $completed = 0
  $failed = 0
  foreach ($plan in $plans) {
    try {
      Assert-AgentSystemResources -Directory $plan.Directory -Id $plan.Id -TaskName $plan.TaskName
      [void](Remove-AgentTask $plan.TaskName)
      [void](Remove-LegacyService -Name $plan.TaskName -Directory $plan.Directory)
      if (-not $KeepFiles) {
        $removeDir = $plan.Directory
        Invoke-Step "Remove owned instance directory `"$removeDir`"" { Remove-Item -LiteralPath $removeDir -Recurse -Force }
      }
      $completed++
    } catch {
      $failed++
      Write-Warning "Failed to uninstall $($plan.TaskName): $($_.Exception.Message)"
    }
  }
  Write-Host "Agent uninstall summary: discovered=$($plans.Count) completed=$completed skipped=$skipped failed=$failed"
  if ($failed) { throw "Failed to uninstall $failed owned Agent instance(s)." }
}

Set-InstanceDefaults

if ($UninstallAll) {
  Uninstall-AllAgents
  exit 0
}

if ([string]::IsNullOrWhiteSpace($ServiceName)) {
  throw "-ServiceName cannot be empty."
}
if ($ServiceName -match '[\\/\*?\[\]]') {
  throw '-ServiceName cannot contain path separators or wildcard characters.'
}

$InstallDir = Assert-AgentInstallDirectory -Directory $InstallDir -Id $NormalizedInstanceId -TaskName $ServiceName -RequireOwnership:$Uninstall
Assert-AgentSystemResources -Directory $InstallDir -Id $NormalizedInstanceId -TaskName $ServiceName

$targetExe = Join-Path $InstallDir "cf-vps-monitor-agent.exe"
$runnerPath = Join-Path $InstallDir "run-agent.ps1"
$StateDir = Join-Path $InstallDir "state"
$AgentLogPath = Join-Path $StateDir "agent.log"

if ($Uninstall) {
  $removedTask = Remove-AgentTask $ServiceName
  $removedService = Remove-LegacyService $ServiceName
  if (-not $removedTask -and -not $removedService) {
    Write-Host "Task/service not found: $ServiceName"
  }

  if (-not $KeepFiles) {
    Invoke-Step "Remove-Item -LiteralPath `"$InstallDir`" -Recurse -Force" {
      if (Test-Path -LiteralPath $InstallDir) {
        Remove-Item -LiteralPath $InstallDir -Recurse -Force
      }
    }
  }

  Write-Host "Uninstalled $ServiceName."
  exit 0
}

if ([string]::IsNullOrWhiteSpace($Server) -or [string]::IsNullOrWhiteSpace($Token)) {
  throw "-Server and -Token are required for install or upgrade."
}

if ($BinaryPath -ne "" -and ($BinaryUrl -ne "" -or $BuildFromSource)) {
  throw "Use only one of -BinaryPath, -BinaryUrl, or -BuildFromSource."
}

if ($BinaryUrl -ne "" -and $BuildFromSource) {
  throw "Use only one of -BinaryUrl or -BuildFromSource."
}

Assert-HttpsUrl -Name "-BinaryUrl" -Url $BinaryUrl
Assert-HttpsUrl -Name "-BinaryBaseUrl" -Url $BinaryBaseUrl
Assert-HttpsUrl -Name "-ChecksumUrl" -Url $ChecksumUrl
Assert-HttpsUrl -Name "-SourceUrl" -Url $SourceUrl
$Proxy = Normalize-HttpUrl -Name "-Proxy" -Url $Proxy -AllowPath $false
$InstallGhproxy = Normalize-HttpUrl -Name "-InstallGhproxy" -Url $InstallGhproxy

if ($BinaryPath -eq "" -and $BinaryUrl -eq "" -and -not $BuildFromSource) {
  $BinaryUrl = Get-DefaultBinaryUrl
  $ChecksumUrl = Get-DefaultChecksumUrl
  $autoBinaryUrl = $true
}

if ($BinaryPath -eq "" -and $BinaryUrl -ne "") {
  if ([string]::IsNullOrWhiteSpace($ChecksumUrl) -and -not $autoBinaryUrl) {
    throw "Custom -BinaryUrl requires -ChecksumUrl for SHA256 verification."
  }
  $downloadOut = Join-Path (New-AgentTemporaryDirectory) 'cf-vps-monitor-agent.exe'
  Invoke-DownloadFile -Url $BinaryUrl -OutFile $downloadOut
  Test-DownloadedChecksum -Path $downloadOut -FileName (Split-Path $BinaryUrl -Leaf) -Url $ChecksumUrl
  $BinaryPath = $downloadOut
}

if ($BinaryPath -eq "" -and $BuildFromSource) {
  $go = Get-Command go -ErrorAction SilentlyContinue
  if (-not $go -and -not $DryRun) {
    throw "Go is required for -BuildFromSource. Use the default prebuilt install or pass -BinaryUrl."
  }
  $buildOut = Join-Path (New-AgentTemporaryDirectory) 'cf-vps-monitor-agent.exe'
  $buildDir = Resolve-BuildDirectory
  $buildCommand = "go build -trimpath -ldflags=`"-s -w`" -o `"$buildOut`" ."
  if ($DryRun) {
    Write-Host "[dry-run] cd `"$buildDir`"; $buildCommand"
  } else {
    Push-Location $buildDir
    try {
      go build -trimpath -ldflags="-s -w" -o $buildOut .
      if ($LASTEXITCODE -ne 0) { throw "Agent source build failed with exit code $LASTEXITCODE. No binary will be installed." }
      if (-not (Test-Path -LiteralPath $buildOut -PathType Leaf) -or (Get-Item -LiteralPath $buildOut).Length -eq 0) {
        throw 'Agent source build did not produce a nonempty executable.'
      }
    } finally {
      Pop-Location
    }
  }
  $BinaryPath = $buildOut
}

if (-not (Test-Path $BinaryPath) -and -not $DryRun) {
  throw "Binary not found: $BinaryPath"
}

$powerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$taskArguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $runnerPath + '"'

if ($DryRun) {
  Write-Host "[dry-run] New-Item -ItemType Directory -Force `"$InstallDir`""
  Write-Host "[dry-run] New-Item -ItemType Directory -Force `"$StateDir`""
  Write-Host "[dry-run] Stage and verify `"$BinaryPath`"; back up current executable, runner, and task"
  Write-Host "[dry-run] Stop matching task/service/processes and wait for executable handles to close"
  Write-Host "[dry-run] Replace `"$targetExe`" with the staged executable"
  Write-Host "[dry-run] Write scheduled task runner `"$runnerPath`" (token hidden)"
  Write-Host "[dry-run] Lock ACL on `"$InstallDir`" to SYSTEM, Administrators, and LocalService read/execute; grant LocalService modify on `"$StateDir`""
  Write-Host "[dry-run] Register-ScheduledTask -TaskName `"$ServiceName`" -User `"NT AUTHORITY\LOCAL SERVICE`""
  Write-Host "[dry-run] Start and verify `"$ServiceName`"; restore previous files/task on failure"
  exit 0
}

$runnerContent = @"
`$ErrorActionPreference = "Stop"
`$env:CF_MONITOR_SERVER = $(ConvertTo-PowerShellLiteral $Server)
`$env:CF_MONITOR_TOKEN = $(ConvertTo-PowerShellLiteral $Token)
`$env:CF_MONITOR_NAME = $(ConvertTo-PowerShellLiteral $Name)
`$env:CF_MONITOR_MODE = $(ConvertTo-PowerShellLiteral $Mode)
`$env:CF_MONITOR_MOUNT_INCLUDE = $(ConvertTo-PowerShellLiteral $MountInclude)
`$env:CF_MONITOR_MOUNT_EXCLUDE = $(ConvertTo-PowerShellLiteral $MountExclude)
`$env:CF_MONITOR_NIC_INCLUDE = $(ConvertTo-PowerShellLiteral $NicInclude)
`$env:CF_MONITOR_NIC_EXCLUDE = $(ConvertTo-PowerShellLiteral $NicExclude)
`$env:CF_MONITOR_TRAFFIC_RESET_DAY = $(ConvertTo-PowerShellLiteral ([string]$TrafficResetDay))
`$env:CF_MONITOR_TRAFFIC_STATE_FILE = Join-Path `$PSScriptRoot "state\traffic-state.json"
`$logPath = Join-Path `$PSScriptRoot "state\agent.log"
`$runnerLogPath = Join-Path `$PSScriptRoot "state\runner.log"
Set-Location `$PSScriptRoot

try {
  `$agentPath = Join-Path `$PSScriptRoot "cf-vps-monitor-agent.exe"
  `$command = '"' + `$agentPath + '" --interval $ReportInterval --ping-interval $PingInterval --traffic-reset-day $TrafficResetDay >> "' + `$logPath + '" 2>&1'
  & `$env:ComSpec /d /c `$command
  `$exitCode = `$LASTEXITCODE
} catch {
  `$exitCode = 1
  `$_.Exception.Message | Out-File -FilePath `$runnerLogPath -Append -Encoding UTF8
}
exit `$exitCode
"@
Install-AgentInstance -RunnerContent $runnerContent
