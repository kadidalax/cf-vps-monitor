param([string]$Installer, [string]$Root, [string]$OptionsFile, [string]$LegacyTaskFile)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:ProgramFiles = Join-Path $Root 'program-files'
$global:PreviewTasks = if ($LegacyTaskFile) { @(Get-Content -LiteralPath $LegacyTaskFile -Raw -Encoding UTF8 | ConvertFrom-Json) } else { @() }
function global:Get-ScheduledTask {
  [CmdletBinding()] param([string]$TaskName, [string]$TaskPath)
  return @($global:PreviewTasks | Where-Object { $_.TaskName -ceq $TaskName })
}
function global:Get-Service { [CmdletBinding()] param([string]$Name) }
$options = Get-Content -LiteralPath $OptionsFile -Raw | ConvertFrom-Json -AsHashtable
& $Installer -DryRun @options
exit $LASTEXITCODE
