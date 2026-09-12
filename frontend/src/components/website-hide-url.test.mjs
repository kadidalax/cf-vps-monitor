import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { productionDeclaration } from '../../test/helpers/production-module.mjs';

const list = await readFile(new URL('./WebsiteMonitorList.tsx', import.meta.url), 'utf8');
const details = await readFile(new URL('./WebsiteMonitorDetails.tsx', import.meta.url), 'utf8');
const index = await readFile(new URL('../pages/Index.tsx', import.meta.url), 'utf8');
const adminWebsites = await readFile(new URL('../pages/admin/Websites.tsx', import.meta.url), 'utf8');

// --- 类型：url 必须可为 null，否则下游会用空串兜底而绕过判断 ---
assert.match(list, /url: string \| null;/, 'WebsiteMonitorSummary.url 必须是 string | null');
const normalizeWebsiteSummary = productionDeclaration('src/pages/Index.tsx', 'normalizeWebsiteSummary', {
  readWebsiteHidden: productionDeclaration('src/pages/Index.tsx', 'readWebsiteHidden'),
});
assert.equal(normalizeWebsiteSummary({ id: 1, url: null }).url, null,
  '归一化必须保留公开 API 的 null 网址');

// --- 回归锁：地址隐藏时不得渲染任何链接元素 ---
const listHrefCount = (list.match(/href=\{monitor\.url\}/g) || []).length;
const listGuardCount = (list.match(/\{monitor\.url \? \(/g) || []).length;
assert.equal(listHrefCount, 1, '列表中 href={monitor.url} 应只出现一次');
assert.equal(listGuardCount, 1, '该处必须且只需一个 url 存在性守卫');
assert.ok(
  list.indexOf('{monitor.url ? (') < list.indexOf('href={monitor.url}'),
  '守卫必须包裹在 <a href> 之外——不能先渲染链接再靠样式隐藏',
);
assert.match(list, /<span className="kuma-monitor-name-plain">\{monitor\.name\}<\/span>/,
  '隐藏地址时名称必须是纯文本 span，而不是被样式盖住的 <a>');

const detailsHrefCount = (details.match(/href=\{monitor\.url\}/g) || []).length;
assert.equal(detailsHrefCount, 1, '详情页 href={monitor.url} 应只出现一次');
assert.ok(
  details.indexOf('{monitor.url ? (') < details.indexOf('href={monitor.url}'),
  '详情页守卫必须包裹在 <a href> 之外',
);

// --- 回归锁：TCP 判定不得再依赖 url 字符串（隐藏后 url 为 null 会误判） ---
assert.doesNotMatch(
  list,
  /if \(monitor\.url\.startsWith\('tcp:'\)\)/,
  'TCP 判定不得直接对 monitor.url 取 startsWith——隐藏地址后会抛错或误判',
);
assert.match(list, /monitor\.method === 'TCP'/, 'TCP 判定应使用服务端下发的 method');
assert.match(list, /method\?: 'GET' \| 'HEAD' \| 'TCP';/, 'Summary 需要 method 字段');

// --- 管理端开关 ---
assert.match(adminWebsites, /hide_url: false,/, '表单初值需含 hide_url');
assert.match(adminWebsites, /hide_url: Boolean\(monitor\.hide_url\)/, '编辑时需回填 hide_url');
assert.match(adminWebsites, /checked=\{form\.hide_url\}[^]*?对游客隐藏地址/,
  '需存在「对游客隐藏地址」开关');
assert.match(adminWebsites, /对游客隐藏此监控/, '原开关需改名为「对游客隐藏此监控」');
assert.doesNotMatch(adminWebsites, /\/>对游客隐藏<\/label>/, '不得保留含义模糊的旧标签「对游客隐藏」');

// 新开关必须在旧开关左侧
assert.ok(
  adminWebsites.indexOf('对游客隐藏地址') < adminWebsites.indexOf('对游客隐藏此监控'),
  '「对游客隐藏地址」应位于「对游客隐藏此监控」左侧',
);

console.log('website-hide-url.test.mjs: all assertions passed');
