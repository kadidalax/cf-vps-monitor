param([string]$Installer, [string]$Root, [switch]$FailStart, [switch]$UnicodeConfig)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$rootPath = [IO.Path]::GetFullPath($Root)
if (-not (Split-Path $rootPath -Leaf).StartsWith('cf-agent-test-')) { throw 'Fixture root is not a test directory.' }
$script:InstallDir = Join-Path $rootPath 'instance'
$script:StateDir = Join-Path $InstallDir 'state'
$script:ServiceName = 'CFVpsMonitorAgent-fixture'
$script:NormalizedInstanceId = 'fixture'
$script:targetExe = Join-Path $InstallDir 'cf-vps-monitor-agent.exe'
$script:runnerPath = Join-Path $InstallDir 'run-agent.ps1'
$script:AgentLogPath = Join-Path $StateDir 'agent.log'
$script:processes = [Collections.Generic.List[Diagnostics.Process]]::new()
$script:Task = $null
$script:failNextStart = [bool]$FailStart
$script:events = [Collections.Generic.List[string]]::new()
$script:Server = 'https://monitor.example.test'; $script:Token = 'new-token'; $script:Name = 'fixture'
$script:Mode = 'websocket'; $script:TrafficResetDay = 1; $script:ReportInterval = 3; $script:PingInterval = 120
$script:MountInclude = ''; $script:MountExclude = ''; $script:NicInclude = ''; $script:NicExclude = ''
if ($UnicodeConfig) { $script:Name = "上海'节点\A"; $script:NicInclude = "网卡\eth'"; $script:MountInclude = "C:\数据,D:\x'x" }
$script:DryRun = $false
$env:GOWORK = 'off'; $env:GOPROXY = 'off'; $env:GOSUMDB = 'off'
$env:TEMP = Join-Path $rootPath 'temp'
$env:CF_MONITOR_TEST_OUTPUT = Join-Path $rootPath 'running.json'
New-Item -ItemType Directory -Path $InstallDir, $StateDir, $env:TEMP | Out-Null
$oldExe = Join-Path $rootPath 'old.exe'
$script:BinaryPath = Join-Path $rootPath 'new.exe'
& go build -trimpath '-ldflags=-X main.marker=old' -o $oldExe (Join-Path $PSScriptRoot 'installer-process.go')
if ($LASTEXITCODE -ne 0) { throw 'Old fixture build failed.' }
& go build -trimpath '-ldflags=-X main.marker=new' -o $BinaryPath (Join-Path $PSScriptRoot 'installer-process.go')
if ($LASTEXITCODE -ne 0) { throw 'New fixture build failed.' }
Copy-Item -LiteralPath $oldExe -Destination $targetExe
$priorRunner = "`$env:CF_MONITOR_TOKEN = 'old-token'`n& (Join-Path `$PSScriptRoot 'cf-vps-monitor-agent.exe')`n"
[IO.File]::WriteAllText($runnerPath, $priorRunner)
$oldHash = (Get-FileHash -LiteralPath $targetExe).Hash
$env:CF_MONITOR_TOKEN = 'old-token'
$oldProcess = Start-Process -FilePath $targetExe -PassThru -WindowStyle Hidden
$script:processes.Add($oldProcess)
$until = [DateTime]::UtcNow.AddSeconds(5)
while (-not (Test-Path -LiteralPath $env:CF_MONITOR_TEST_OUTPUT) -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 20 }
if (-not (Test-Path -LiteralPath $env:CF_MONITOR_TEST_OUTPUT)) { throw 'Fixture did not start.' }
$source = Get-Content -LiteralPath $Installer -Raw
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors) { throw $parseErrors[0].Message }
foreach ($definition in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  . ([scriptblock]::Create($definition.Extent.Text))
}

function Get-ScheduledTask { [CmdletBinding()] param([string]$TaskName, [string]$TaskPath) return $script:Task }
function Export-ScheduledTask { [CmdletBinding()] param([string]$TaskName, [string]$TaskPath) return ($script:Task | ConvertTo-Json -Depth 8 -Compress) }
function Stop-FixtureProcesses {
  foreach ($process in @($script:processes)) {
    if (-not $process.HasExited) { $process.Kill($true); $process.WaitForExit(5000) | Out-Null }
  }
  foreach ($process in @(Get-Process -Name 'cf-vps-monitor-agent' -ErrorAction SilentlyContinue)) {
    if ([string]::Equals($process.Path, $targetExe, [StringComparison]::OrdinalIgnoreCase)) {
      $process.Kill(); $process.WaitForExit(5000) | Out-Null
    }
  }
}
function Stop-ScheduledTask { [CmdletBinding()] param([string]$TaskName, [string]$TaskPath) $script:events.Add('stop'); Stop-FixtureProcesses; if ($script:Task) { $script:Task.State = 'Ready' } }
function Unregister-ScheduledTask { [CmdletBinding(SupportsShouldProcess)] param([string]$TaskName, [string]$TaskPath) $script:events.Add('unregister'); $script:Task = $null }
function Get-Service { [CmdletBinding()] param([string]$Name) }
function takeown.exe { $global:LASTEXITCODE = 0 }
function icacls { $global:LASTEXITCODE = 0 }
function New-ScheduledTaskAction { param($Execute, $Argument, $WorkingDirectory) return [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory } }
function New-ScheduledTaskTrigger { param([switch]$AtStartup) return [pscustomobject]@{ AtStartup = $true } }
function New-ScheduledTaskSettingsSet { param([switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, $ExecutionTimeLimit, $RestartCount, $RestartInterval) return [pscustomobject]@{ RestartCount = $RestartCount } }
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) return [pscustomobject]@{ UserId = $UserId } }
function Register-ScheduledTask {
  [CmdletBinding()] param($TaskName, $TaskPath, $Description, $Action, $Trigger, $Settings, $Principal, $Xml, [switch]$Force)
  $script:events.Add('register')
  $script:Task = if ($Xml) { $Xml | ConvertFrom-Json } else { [pscustomobject]@{ TaskName = $TaskName; TaskPath = $TaskPath; State = 'Ready'; Actions = @($Action) } }
}
function Start-ScheduledTask {
  [CmdletBinding()] param([string]$TaskName, [string]$TaskPath)
  $script:events.Add('start')
  if ($script:failNextStart) { $script:failNextStart = $false; throw 'injected start failure' }
  $action = $script:Task.Actions[0]
  $process = Start-Process -FilePath $action.Execute -ArgumentList $action.Arguments -WorkingDirectory $action.WorkingDirectory -PassThru -WindowStyle Hidden
  $script:processes.Add($process)
  $script:Task.State = 'Running'
}
$script:Task = [pscustomobject]@{ TaskName = $ServiceName; TaskPath = '\'; State = 'Running'; Actions = @([pscustomobject]@{
  Execute = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
  Arguments = ('-NoProfile -ExecutionPolicy Bypass -File "' + $runnerPath + '"'); WorkingDirectory = $InstallDir
}) }
$boundary = $source.IndexOf('$powerShellPath = Join-Path')
if ($boundary -lt 0) { throw 'Installer application entry was not found.' }
$failure = $null
try {
  try { . ([scriptblock]::Create($source.Substring($boundary))) } catch { $failure = $_.Exception.Message }
  Start-Sleep -Milliseconds 500
  $running = Get-Content -LiteralPath $env:CF_MONITOR_TEST_OUTPUT -Raw | ConvertFrom-Json
  $oldProcess.Refresh()
  [pscustomobject]@{ failed = [bool]$failure; error = $failure; oldExited = $oldProcess.HasExited;
    marker = $running.marker; token = $running.token; restored = ((Get-FileHash -LiteralPath $targetExe).Hash -eq $oldHash);
    name = $running.name; nicInclude = $running.nic_include; mountInclude = $running.mount_include;
    runnerPrefix = ([BitConverter]::ToString([IO.File]::ReadAllBytes($runnerPath)[0..2]));
    interpreter = $script:Task.Actions[0].Execute;
    events = @($script:events); taskState = $script:Task.State } | ConvertTo-Json -Compress -Depth 8
} finally {
  Stop-FixtureProcesses
}
