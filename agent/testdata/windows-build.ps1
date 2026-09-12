param([string]$Installer, [string]$Root, [switch]$GoodSource)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$PSNativeCommandUseErrorActionPreference = $false
$env:TEMP = Join-Path $Root 'temp'
$env:GOWORK = 'off'
$env:GOPROXY = 'off'
$env:GOSUMDB = 'off'
$sourceDir = Join-Path $Root 'source'
New-Item -ItemType Directory -Path $env:TEMP, $sourceDir | Out-Null
[IO.File]::WriteAllText((Join-Path $env:TEMP 'cf-vps-monitor-agent.exe'), 'stale old binary')
[IO.File]::WriteAllText((Join-Path $sourceDir 'go.mod'), "module installer-fixture`ngo 1.25.0`n")
$body = if ($GoodSource) { "package main`nfunc main() {}`n" } else { "package main`nfunc main( { broken`n" }
[IO.File]::WriteAllText((Join-Path $sourceDir 'main.go'), $body)
$source = Get-Content -LiteralPath $Installer -Raw
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors) { throw $parseErrors[0].Message }
foreach ($definition in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  . ([scriptblock]::Create($definition.Extent.Text))
}
function Resolve-BuildDirectory { return $sourceDir }
$BinaryPath = ''; $BuildFromSource = $true; $DryRun = $false
$block = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.IfStatementAst] -and
  $n.Extent.Text.StartsWith('if ($BinaryPath -eq "" -and $BuildFromSource)') }, $false)
if (-not $block) { throw 'Real source build branch was not found.' }
$failure = $null
try { . ([scriptblock]::Create($block.Extent.Text)) } catch { $failure = $_.Exception.Message }
$selected = $BinaryPath -and (Test-Path -LiteralPath $BinaryPath -PathType Leaf)
[pscustomobject]@{ failed = [bool]$failure; error = $failure; selected = [bool]$selected;
  binary = $BinaryPath; stalePath = (Join-Path $env:TEMP 'cf-vps-monitor-agent.exe');
  length = if ($selected) { (Get-Item -LiteralPath $BinaryPath).Length } else { 0 } } | ConvertTo-Json -Compress
