import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const miniPingChart = await readFile(new URL('./MiniPingChart.tsx', import.meta.url), 'utf8');
const miniPingChartFloat = await readFile(new URL('./MiniPingChartFloat.tsx', import.meta.url), 'utf8');
const nodeCard = await readFile(new URL('./NodeCard.tsx', import.meta.url), 'utf8');
const nodeTable = await readFile(new URL('./NodeTable.tsx', import.meta.url), 'utf8');
const nodeDisplay = await readFile(new URL('./NodeDisplay.tsx', import.meta.url), 'utf8');

assert.match(miniPingChart, /includeHidden\??: boolean/);
assert.match(miniPingChart, /includeHidden,\s*signal/);
assert.match(miniPingChartFloat, /includeHidden\??: boolean/);
assert.match(miniPingChartFloat, /<MiniPingChart[^>]+includeHidden=\{includeHidden\}/s);
assert.match(nodeCard, /includeHidden\??: boolean/);
assert.match(nodeCard, /<MiniPingChartFloat[^>]+includeHidden=\{includeHidden\}/s);
assert.match(nodeTable, /includeHidden\??: boolean/);
assert.match(nodeTable, /<MiniPingChart[^>]+includeHidden=\{includeHidden\}/s);
assert.match(nodeDisplay, /includeHidden\??: boolean/);
assert.match(nodeDisplay, /<NodeTable[^>]+includeHidden=\{includeHidden\}/s);
