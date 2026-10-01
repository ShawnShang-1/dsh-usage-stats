/**
 * Real-DOM render check for the browser half.
 *
 *     cd dsh-usage-stats
 *     npm i --no-save react@18.3.1 react-dom@18.3.1 jsdom@24
 *     node scripts/check-dom.mjs
 *
 * Unlike `check-ui.mjs` (which stubs React), this mounts the shipped
 * `lib/client.js` through real React and a real jsdom document, lets effects and
 * the mocked Host route settle, and asserts the rendered DOM: the five headline
 * figures, the activity grid, the per-model detail table with its cache hit rate,
 * that the three aggregations shade the grid differently, and that the refresh
 * control issues a refresh request.
 *
 * The three packages are dev-only and deliberately not dependencies of this
 * plugin: the Host loads the bundle, never this script.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { createFold, finishFold, foldSession, dayKeyOf } from '../lib/fold.js';
import { attachCosts, parsePriceTable } from '../lib/pricing.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginFlag = process.argv.indexOf('--plugin');
const plugin = pluginFlag === -1 ? join(here, '..') : process.argv[pluginFlag + 1];
const argv = process.argv.slice(2);
const homeFlag = argv.indexOf('--home');
const home = homeFlag === -1 ? join(homedir(), '.dsh') : argv[homeFlag + 1];

//#region DOM
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'dsh-app://app/'
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom ships no ResizeObserver; the grid falls back to its fixed cell size.
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.ResizeObserver = window.ResizeObserver;
//#endregion

//#region payload
/** Every session log under one root. */
function sessionFiles(root) {
  const files = [];
  for (const workspace of readdirSync(root)) {
    const directory = join(root, workspace);
    if (!statSync(directory).isDirectory()) continue;
    for (const session of readdirSync(directory)) {
      const inner = join(directory, session);
      if (!statSync(inner).isDirectory()) continue;
      for (const file of readdirSync(inner)) {
        if (file.startsWith('session.v') && file.endsWith('.jsonl.zstd')) files.push(join(inner, file));
      }
    }
  }
  return files;
}

/** Fold the durable corpus into the payload the Host would serve. */
function payloadFromCorpus() {
  const fold = createFold();
  const files = sessionFiles(join(home, 'sessions'));
  for (const file of files) {
    const text = execFileSync('zstdcat', [file], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8');
    let header = null;
    const events = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const record = JSON.parse(trimmed);
      if (record.type === 'session') header = record;
      else events.push(record);
    }
    foldSession(fold, header ?? {}, events);
  }
  const payload = finishFold(fold, Date.now());
  payload.scan = { sessions: files.length, total: files.length, failed: 0, durationMs: 0 };
  return payload;
}
const payload = payloadFromCorpus();
const table = parsePriceTable(JSON.parse(readFileSync(join(plugin, 'prices.json'), 'utf8')));
attachCosts(payload.models, table, dayKeyOf(Date.now()));
payload.pricing = {
  currency: table.currency,
  unit: table.unit,
  configured: table.byKey.size > 0,
  priced: payload.models.filter((model) => model.cost !== null).length,
  models: table.rows.length
};
//#endregion

//#region mocked host and client context
const requests = [];
globalThis.fetch = async (url, init) => {
  requests.push(`${init?.method ?? 'GET'} ${url}`);
  const endpoint = String(url).split('/').pop();
  if (endpoint !== 'overview' && endpoint !== 'refresh') throw new Error(`unexpected endpoint ${url}`);
  return { ok: true, status: 200, json: async () => ({ ok: true, value: payload }) };
};

const dictionary = { zh: {}, en: {} };
let registration = null;
window.__ModuleLoader__ = { load: (record) => { registration = record; } };
new Function('window', readFileSync(join(plugin, 'lib', 'client.js'), 'utf8'))(window);
const bundle = registration.factory((specifier) => {
  if (specifier === 'react') return React;
  throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
});

const ctx = {
  locale: {
    bind: () => (key) => dictionary.zh[key] ?? key,
    register: (namespace, tables) => {
      void namespace;
      Object.assign(dictionary.zh, tables.zh);
      Object.assign(dictionary.en, tables.en);
      return () => {};
    },
    getSnapshot: () => ({ active: 'zh' })
  },
  slots: {
    inject: (name, callback) => callback(),
    register: (options, component) => {
      if (options.name === 'settings.section') ctx.registered = { options, component };
      return () => {};
    }
  },
  effect: (factory) => {
    void factory();
    return () => {};
  }
};
bundle.apply(ctx);
if (ctx.registered === undefined) throw new Error('the plugin registered no settings.section entry');
const { options, component } = ctx.registered;
//#endregion

//#region render
const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`);
};
const container = document.getElementById('root');
const root = createRoot(container);
const props = { t: (key) => dictionary.zh[key] ?? key, close: () => {} };
const click = async (label) => {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (button === undefined) throw new Error(`no button labelled ${label}`);
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
};
/** The shade percentage every titled day cell carries, in document order. */
const shades = () => [...container.querySelectorAll('div[title]')]
  .map((cell) => /(\d+)%, transparent/.exec(cell.getAttribute('style') ?? '')?.[1] ?? 'none')
  .join(',');

await act(async () => {
  root.render(React.createElement(component, props));
});
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 30));
});
const text = container.textContent ?? '';

check('nav label', options.label() === '使用统计', options.label());
check('requested the route', requests.some((entry) => entry.endsWith('/dsh-usage-stats/overview')), JSON.stringify(requests));
check('renders the page title', text.includes('Token 活动'));
check('renders all five headline figures',
  ['累计 Token 数', '峰值 Token 数', '最长聊天时长', '当前连续天数', '最长连续天数'].every((label) => text.includes(label)),
  text.slice(0, 160));
check('renders the model detail table', text.includes('模型明细') && text.includes('deepseek-flash'));
check('renders the requested columns',
  ['输入', '输出', '缓存读取', '缓存命中率'].every((label) => text.includes(label)));
check('renders a cache hit rate', /\d+(\.\d+)?%/.test(text), 'no percentage');
check('renders a per-model row', container.querySelectorAll('tbody tr').length >= payload.models.length,
  String(container.querySelectorAll('tbody tr').length));
check('renders the segmented control', ['每日', '每周', '累计'].every((label) => text.includes(label)));

/** Header labels, then each body row's cells, as text. */
const headers = () => [...container.querySelectorAll('thead th')].map((cell) => cell.textContent);
const rowCells = () => [...container.querySelectorAll('tbody tr')].map((row) => [...row.children].map((cell) => cell.textContent));

check('the share column is gone', !headers().includes('占比'), headers().join('|'));
check('the model cell shows only the model', !text.includes('deepseek-official'), text.slice(0, 200));
check('the range caption is gone', !text.includes('统计区间') && !text.includes('天有活动'));
check('the colour legend is gone',
  ![...container.querySelectorAll('span')].some((span) => span.textContent === '少' || span.textContent === '多'));
check('the cost column defaults to the cumulative figure', headers().includes('累计消费'), headers().join('|'));
check('a cost is rendered as a bare number', Number.isFinite(Number(rowCells()[0]?.at(-1))) && Number(rowCells()[0].at(-1)) > 0,
  JSON.stringify(rowCells()[0]));
const totalCostCell = rowCells()[0].at(-1);

await click('今日');
check('the cost column follows the toggle', headers().includes('今日消费'), headers().join('|'));
const todayCostCell = rowCells()[0].at(-1);
check('today\'s cost is its own figure', Number.isFinite(Number(todayCostCell)) && Number(todayCostCell) > 0,
  JSON.stringify(rowCells()[0]));
check('today differs from the cumulative figure', todayCostCell !== totalCostCell || payload.models[0].cost.today === payload.models[0].cost.total,
  `${todayCostCell} vs ${totalCostCell}`);
await click('累计');

/** Shade percentages of the cells that carry a background at all. */
const lit = (shades) => shades.split(',').filter((shade) => shade !== 'none').map(Number);

/** Shade of every cell, in document order (7 rows per week column). */
const daily = shades();
const dailyLit = lit(daily);
check('the grid spans the whole payload window',
  container.querySelectorAll('div[title]').length === payload.days.length,
  `${container.querySelectorAll('div[title]').length} cells for ${payload.days.length} days`);
check('the empty calendar is drawn, not just the active days',
  daily.split(',').length > 300, String(daily.split(',').length));
check('active days are shaded', dailyLit.length >= payload.activeDays, dailyLit.join(','));
check('the busiest day is the darkest', Math.max(...dailyLit) === 100, dailyLit.join(','));

// 每周 lights every cell of a week that saw activity, and no cell of a quiet week.
await click('每周');
const weeklyShades = shades().split(',');
const weeklyLit = lit(weeklyShades.join(','));
check('每周 pulls quiet days into their week',
  weeklyLit.length > dailyLit.length && weeklyLit.every((alpha) => alpha === weeklyLit[0]),
  `daily=${dailyLit.length} weekly=${weeklyLit.length} shades=[${[...new Set(weeklyLit)].join(',')}]`);

// 累计 only rises, so a later cell can never be lighter than an earlier one.
await click('累计');
const cumulative = shades();
const cumulativeShades = cumulative.split(',');
const firstLit = cumulativeShades.findIndex((shade) => shade !== 'none');
const cumulativeLit = lit(cumulative);
check('累计 deepens monotonically over time',
  cumulativeLit.every((alpha, index) => index === 0 || alpha >= cumulativeLit[index - 1]), cumulativeLit.join(','));
check('累计 ends at the window total', cumulativeLit.at(-1) === 100, cumulativeLit.join(','));
check('累计 is one unbroken run to today',
  cumulativeShades.slice(firstLit).every((shade) => shade !== 'none'), `first lit at ${firstLit}`);
check('每周 shades differently from 每日', weeklyShades.join(',') !== daily);
check('the tooltip follows the aggregation',
  (container.querySelector('div[title]')?.getAttribute('title') ?? '').endsWith('累计'));
check('the tooltip carries the date and the value',
  /^\d{4}-\d{2}-\d{2} · /.test(container.querySelector('div[title]')?.getAttribute('title') ?? ''));

await click('每日');
const before = requests.length;
await click('刷新');
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 30));
});
check('the refresh control issues a refresh request',
  requests.length > before && requests.at(-1).endsWith('/dsh-usage-stats/refresh'),
  JSON.stringify(requests.slice(before)));

console.log(`mounted nodes       ${container.querySelectorAll('*').length}`);
console.log(`day cells           ${container.querySelectorAll('div[title]').length} (window ${payload.window.from} .. ${payload.window.to})`);
console.log(`model rows          ${container.querySelectorAll('tbody tr').length}`);
console.log(`model headers       ${headers().join(' | ')}`);
console.log(`model cells         ${JSON.stringify(rowCells()[0])}`);
console.log(`cost total/today    ${totalCostCell} / ${todayCostCell}`);
console.log(`shades daily/weekly/cumulative  ${dailyLit.join(',')} / ${weeklyLit.join(',')} / ${cumulativeLit.join(',')}`);
console.log(`requests            ${requests.join(', ')}`);
console.log(`visible text        ${text.replace(/\s+/g, ' ').slice(0, 200)}…`);

if (failures.length > 0) {
  console.error('\nFAILED CHECKS');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log('\nall real-DOM checks passed');
//#endregion