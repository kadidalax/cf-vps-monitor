import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../worker/package.json', import.meta.url));
const ts = require('typescript');

// Executes the actual named function body while replacing only its external
// dependencies. Useful for entrypoints whose unrelated imports require workerd.
export async function loadTypeScriptFunctions(url, names, dependencies) {
  const source = await readFile(url, 'utf8');
  const ast = ts.createSourceFile(url.pathname, source, ts.ScriptTarget.Latest, true);
  names ??= ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && node.body).map(node => node.name.text);
  const declarations = names.map(name => {
    const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration, `Production function ${name} exists`);
    return declaration.getText(ast).replace(/^export\s+/, '');
  });
  const javascript = ts.transpileModule(declarations.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${javascript}\nreturn { ${names.join(', ')} };`)(...Object.values(dependencies));
}
