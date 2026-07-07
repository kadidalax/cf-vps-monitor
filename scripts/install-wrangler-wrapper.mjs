import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const sh = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")

case \`uname\` in
  *CYGWIN*|*MINGW*|*MSYS*) basedir=\`cygpath -w "$basedir"\`;;
esac

if [ -x "$basedir/node" ]; then
  exec "$basedir/node" "$basedir/../../scripts/wrangler-wrapper.mjs" "$@"
else
  exec node "$basedir/../../scripts/wrangler-wrapper.mjs" "$@"
fi
`;

const cmd = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\..\\..\\scripts\\wrangler-wrapper.mjs" %*
`;

const ps1 = `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  $exe=".exe"
}

if (Test-Path "$basedir/node$exe") {
  & "$basedir/node$exe" "$basedir/../../scripts/wrangler-wrapper.mjs" $args
} else {
  & "node$exe" "$basedir/../../scripts/wrangler-wrapper.mjs" $args
}
exit $LASTEXITCODE
`;

export function installWranglerWrapper(rootDir = root) {
  const binDir = join(rootDir, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  for (const name of ['wrangler', 'wrangler.cmd', 'wrangler.ps1']) {
    rmSync(join(binDir, name), { force: true });
  }
  writeFileSync(join(binDir, 'wrangler'), sh, { mode: 0o755 });
  writeFileSync(join(binDir, 'wrangler.cmd'), cmd);
  writeFileSync(join(binDir, 'wrangler.ps1'), ps1);
  chmodSync(join(binDir, 'wrangler'), 0o755);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  installWranglerWrapper();
}
