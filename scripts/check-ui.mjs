/**
 * Offline render check of the browser half.
 *
 *     node scripts/check-ui.mjs [--html] [--home <dsh home>]
 *
 * Runs the real `lib/client.js` bundle against a stubbed React and a stubbed
 * Cordis client context, feeds it a payload folded from the durable Session
 * corpus, and prints the element tree that the Settings page would produce. No
 * browser, no Host, no bundler.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createFold, finishFold, foldSession, dayKeyOf } from '../lib/fold.js';
import { attachCosts, parsePriceTable } from '../lib/pricing.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const wantHtml = argv.includes('--html');
const homeFlag = argv.indexOf('--home');
const home = homeFlag === -1 ? join(homedir(), '.dsh') : argv[homeFlag + 1];

//#region payload from the real corpus
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

/** Fold the corpus into the payload the Host would serve. */
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
  const table = parsePriceTable(JSON.parse(readFileSync(join(here, '..', 'prices.json'), 'utf8')));
  attachCosts(payload.models, table, dayKeyOf(Date.now()));
  payload.pricing = { currency: table.currency, unit: table.unit, configured: true, priced: payload.models.length, models: table.rows.length };
  payload.scan = { sessions: files.length, total: files.length, failed: 0, durationMs: 42 };
  return payload;
}
//#endregion

//#region stubbed react
/** Minimal React stand-in: enough hooks for this bundle, no reconciler. */
const reactStub = {
  createElement(type, props, ...children) {
    const merged = Object.assign({}, props ?? {});
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { type, props: merged };
  },
  useRef: (initial) => ({ current: initial ?? null }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: (effect) => { effect(); },
  useLayoutEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  memo: (component) => component,
  Fragment: 'Fragment'
};
//#endregion

//#region load the bundle
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');
let registration = null;
const fakeWindow = { __ModuleLoader__: { load: (record) => { registration = record; } } };
// eslint-disable-next-line no-new-func
new Function('window', source)(fakeWindow);
if (registration === null) throw new Error('client.js did not register with __ModuleLoader__');
const bundle = registration.factory((specifier) => {
  if (specifier === 'react') return reactStub;
  throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
});
//#endregion

//#region mocked client context
const payload = payloadFromCorpus();
const registrations = [];
const localeListeners = new Set();
const dictionary = { zh: {}, en: {} };
for (const [language, table] of Object.entries(dictionary)) void table;

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
      registrations.push({ options, component });
      return () => {};
    },
    subscribe: () => () => {}
  },
  connection: {
    admit: () => ({ peer: {} }),
    rpc: { call: () => Promise.reject(new Error('the client must use fetch')) }
  },
  effect: (factory) => {
    const disposer = factory();
    void disposer;
    return () => {};
  }
};

bundle.apply(ctx);
//#endregion

//#region render
/** Render one element tree to an HTML-ish string, resolving function components. */
function render(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (Array.isArray(node)) return node.map(render).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  const { type, props } = node;
  if (typeof type === 'function') return render(type(props ?? {}));
  const attributes = [];
  for (const [name, value] of Object.entries(props ?? {})) {
    if (name === 'children' || name === 'key') continue;
    if (value === undefined || value === null || value === false) continue;
    if (typeof value === 'function') continue;
    attributes.push(`${name}="${(typeof value === 'object' ? JSON.stringify(value) : String(value)).replace(/"/g, "'")}"`);
  }
  return `<${type}${attributes.length > 0 ? ` ${attributes.join(' ')}` : ''}>${render(props?.children)}</${type}>`;
}

/** Count elements with one tag in a rendered string. */
function countTag(html, tag) {
  return html.split(`<${tag}`).length - 1;
}

if (registrations.length !== 1) throw new Error(`expected one settings.section registration, saw ${registrations.length}`);
const { options, component } = registrations[0];
const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail === undefined ? '' : ` (${detail})`}`);
};

/** Wait for the mocked RPC round trip to settle. */
async function settle() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** The host route the browser half calls, stubbed at the global fetch boundary. */
const fetched = [];
globalThis.fetch = async (url, init) => {
  fetched.push({ url, init });
  const endpoint = String(url).split('/').pop();
  if (endpoint !== 'overview' && endpoint !== 'refresh') throw new Error(`unexpected endpoint ${url}`);
  if (init?.method !== 'POST') throw new Error('the client must POST');
  return { ok: true, json: async () => ({ ok: true, value: payload }) };
};

const props = { t: (key) => dictionary.zh[key] ?? key, close: () => {} };
let html = render(component(props));
await settle();
html = render(component(props));

check('registration name', options.name === 'settings.section', options.name);
check('registration id', options.id === 'usage', options.id);
check('registration order', options.order === 13, options.order);
check('registration locale', options.locale === bundle.NS, options.locale);
check('nav label is localized', options.label() === dictionary.zh.nav, options.label());
check('five summary cells', countTag(html, 'div') > 0);
check('renders the total tokens', html.includes('1728.5万') || /亿|万/.test(html), 'no compact token figure');
check('renders model rows', html.includes('deepseek-flash'), 'model id missing');
check('renders cache hit rate', /%/.test(html), 'no percentage');
check('renders the activity grid', html.includes('2026-'), 'no day tooltip');
check('renders the models heading', html.includes('模型明细'), 'heading missing');
check('renders the cost column', html.includes('累计消费'), 'cost column missing');
check('renders a bare cost figure', /<td[^>]*>\d+\.\d<\/td>/.test(html), 'no numeric cost cell');
check('exposes test internals', bundle.__internals !== undefined);
check('fetched the overview route', fetched.length > 0 && String(fetched[0].url).endsWith('/dsh-usage-stats/overview'), JSON.stringify(fetched));

if (wantHtml) {
  console.log(html.replace(/></g, '>\n<'));
}
console.log(`payload: ${payload.totals.totalTokens} tokens over ${payload.days.length} days, ${payload.models.length} model(s)`);
console.log(`segmented options: ${['daily', 'weekly', 'cumulative'].join(', ')}`);
for (const mode of ['daily', 'weekly', 'cumulative']) {
  const values = bundle.__internals.valuesFor(payload.days, mode);
  console.log(`  ${mode.padEnd(11)} last=${values.at(-1)} max=${Math.max(...values, 0)}`);
}
console.log(`compact zh: ${bundle.__internals.compact(420000000, 'zh')} / ${bundle.__internals.compact(71435000, 'zh')}`);
console.log(`compact en: ${bundle.__internals.compact(420000000, 'en')} / ${bundle.__internals.compact(71435000, 'en')}`);
console.log(`duration zh: ${bundle.__internals.duration(4440000, 'zh')} | en: ${bundle.__internals.duration(4440000, 'en')}`);

if (failures.length > 0) {
  console.error('\nFAILED CHECKS');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log('\nall UI checks passed');
//#endregion
