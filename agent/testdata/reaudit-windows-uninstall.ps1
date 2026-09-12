param(
  [string]$Installer,
  [string]$Root,
  [string]$TasksFile,
  [string]$FailTaskName
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:ProgramFiles = Join-Path $Root 'program-files'
$global:ReauditUninstallTasks = @(Get-Content -LiteralPath $TasksFile -Raw -Encoding UTF8 | ConvertFrom-Json)

# Load only the real function definitions. All system/file mutation is intercepted
# at Invoke-Step; discovery, ownership validation, planning and failure handling run.
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($statement in $ast.EndBlock.Statements) {
  if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) {
    . ([scriptblock]::Create($statement.Extent.Text))
  }
}
function Get-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName, [string]$TaskPath)
  $selected = @($global:ReauditUninstallTasks)
  if ($TaskName) { $selected = @($selected | Where-Object { $_.TaskName -ieq $TaskName }) }
  if ($TaskPath) { $selected = @($selected | Where-Object { $_.TaskPath -ieq $TaskPath }) }
  return $selected
}
function Get-Service { [CmdletBinding()] param([string]$Name) }
function Get-CimInstance { [CmdletBinding()] param([string]$ClassName) }
function Invoke-Step {
  param([string]$Description, [scriptblock]$Action)
  Write-Host "ACTION $Description"
  if ($Description.StartsWith('Unregister-ScheduledTask ') -and $Description.Contains('"' + $FailTaskName + '"')) {
    throw 'Synthetic task removal failure'
  }
}
$Yes = $true
$KeepFiles = $false
$DryRun = $false
try {
  Uninstall-AllAgents
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 17
}
