param(
  [string]$Installer,
  [string]$Root,
  [string]$OptionsFile,
  [string]$TasksFile,
  [string]$ServicesFile
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:ProgramFiles = Join-Path $Root 'program-files'
$global:ReauditPreviewTasks = @(Get-Content -LiteralPath $TasksFile -Raw -Encoding UTF8 | ConvertFrom-Json)
$global:ReauditPreviewServices = if ($ServicesFile) { @(Get-Content -LiteralPath $ServicesFile -Raw -Encoding UTF8 | ConvertFrom-Json) } else { @() }
function global:Get-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName, [string]$TaskPath)
  $selected = @($global:ReauditPreviewTasks)
  if ($TaskName) { $selected = @($selected | Where-Object { $_.TaskName -ieq $TaskName }) }
  if ($TaskPath) { $selected = @($selected | Where-Object { $_.TaskPath -ieq $TaskPath }) }
  return $selected
}
function global:Get-Service {
  [CmdletBinding()]
  param([string]$Name)
  return @($global:ReauditPreviewServices | Where-Object { $_.Name -ieq $Name })
}
function global:Get-CimInstance {
  [CmdletBinding()]
  param([string]$ClassName)
  if ($ClassName -eq 'Win32_Service') { return $global:ReauditPreviewServices }
}
$options = Get-Content -LiteralPath $OptionsFile -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
& $Installer -DryRun @options
exit $LASTEXITCODE
