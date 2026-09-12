import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from '../../node_modules/typescript/lib/typescript.js';

const frontendRoot = new URL('../../', import.meta.url);
const require = createRequire(new URL('package.json', frontendRoot));

export function readProductionSource(file) {
  return fs.readFileSync(new URL(file, frontendRoot), 'utf8');
}

export function evaluateProductionExpression(source, bindings = {}) {
  const javascript = ts.transpileModule(`globalThis.subject = (${source});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const context = vm.createContext({ URL, URLSearchParams, Response, Request, FormData, Headers, Date, Error, TypeError, DOMException, console, require, exports: {}, ...bindings });
  vm.runInContext(javascript, context);
  return context.subject;
}

export function productionDeclaration(file, name, bindings = {}) {
  const source = readProductionSource(file);
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  const visit = (node) => {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(ast) === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(found, `${file}: production declaration ${name} exists`);
  let expression;
  if (ts.isFunctionDeclaration(found)) expression = found.getText(ast).replace(/^export\s+(?:default\s+)?/, '');
  else {
    let initializer = found.initializer;
    if (ts.isCallExpression(initializer) && initializer.expression.getText(ast) === 'useCallback') initializer = initializer.arguments[0];
    expression = initializer.getText(ast);
  }
  return evaluateProductionExpression(expression, bindings);
}

export function productionJsx(file, predicate, bindings = {}) {
  const source = readProductionSource(file);
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  const visit = (node) => {
    if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && predicate(node, ast, ts)) found = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(found, `${file}: requested production JSX exists`);
  return evaluateProductionExpression(found.getText(ast), bindings);
}

export function productionEffect(file, bodyFragment, bindings = {}) {
  const source = readProductionSource(file);
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  const visit = node => {
    if (ts.isCallExpression(node) && ['useEffect', 'React.useEffect'].includes(node.expression.getText(ast)) && node.arguments[0]?.getText(ast).includes(bodyFragment)) found = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(found, `${file}: production effect ${bodyFragment} exists`);
  return evaluateProductionExpression(found.getText(ast), bindings);
}

export function productionModule(file, overrides = {}, globals = {}, selectedExpression) {
  const modules = new Map();
  const entry = new URL(file, frontendRoot);
  const load = (url) => {
    const filename = fileURLToPath(url);
    if (modules.has(filename)) return modules.get(filename).exports;
    let source = fs.readFileSync(url, 'utf8');
    if (url.href === entry.href && selectedExpression) source += `\nexport const auditSelected = (${selectedExpression});\n`;
    const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const module = { exports: {} };
    modules.set(filename, module);
    const nativeRequire = createRequire(url);
    const localRequire = (name) => {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (!name.startsWith('.')) return nativeRequire(name);
      for (const suffix of ['', '.ts', '.tsx', '/index.ts']) {
        const next = new URL(name + suffix, url);
        if (fs.existsSync(next) && fs.statSync(next).isFile()) return load(next);
      }
      return nativeRequire(name);
    };
    vm.runInNewContext(javascript, { module, exports: module.exports, require: localRequire, URL, URLSearchParams, Response, Request, Headers, FormData, Date, Error, TypeError, DOMException, console, setTimeout, clearTimeout, AbortController, btoa, atob, ...globals }, { filename });
    return module.exports;
  };
  return load(entry);
}

export function productionSelected(file, name, globals = {}) {
  const source = readProductionSource(file);
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let selected;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) selected = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(selected, `${file}: original selected declaration ${name} exists`);
  if (ts.isCallExpression(selected) && ['useMemo', 'useCallback'].includes(selected.expression.getText(ast))) selected = selected.arguments[0];
  return productionModule(file, {}, globals, selected.getText(ast)).auditSelected;
}
