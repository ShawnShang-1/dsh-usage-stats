/**
 * End-to-end check of the host half.
 *
 *     node scripts/check-host.mjs
 *
 * Mounts the real `lib/host.js` against a stub Cordis context whose
 * `sessionQuery` reads the durable corpus, captures the webserver route it
 * registers, drives one request through it, and asserts the JSON the browser
 * would receive — including the two money figures. No Host, no HTTP server.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { apply } from '../lib/host.js';
import { dayKeyOf } from '../lib/fold.js';
import { parsePriceTable } from '../lib/pricing.js';

const here = dirname(fileURLToPath(import.meta.url));
const plugin = join(here, '..');
const argv = process.argv.slice(2);
const homeFlag = argv.indexOf('--home');
const home = homeFlag === -1 ? join(homedir(), '.dsh') : argv[homeFlag + 1];

//#region corpus
/** Every session directory under one root. */
function sessionDirs(root) {
  const dirs = [];
  for (const workspace of readdirSync(root)) {
    const directory = join(root, workspace);
    if (!statSync(directory).isDirectory()) continue;
    for (const session of readdirSync(directory)) {
      const inner = join(directory, session);
      if (statSync(inner).isDirectory()) dirs.push(inner);
    }
  }
  return dirs;
}

/** Read one durable log the way the persistence backend would. */
function readLog(directory) {
  const file = readdirSync(directory).find((name) => name.startsWith('session.v') && name.endsWith('.jsonl.zstd'));
  const text = execFileSync('zstdcat', [join(directory, file)], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8');
  let header = null;
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const record = JSON.parse(trimmed);
    if (record.type === 'session') header = record;
    else events.push(record);
  }
  return { header, events };
}

const corpus = sessionDirs(join(home, 'sessions')).map((directory, index) => {
  const { header, events } = readLog(directory);
  return { id: `session-${index}`, header, events };
});
//#endregion

//#region stub context
const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`);
};

let route = null;
const ctx = {
  logger: { warn: (message) => failures.push(`host warned: ${message}`), debug: () => {} },
  sessionQuery: {
    listSessions: async () => corpus.map((entry) => ({ header: entry.header, live: false, persisted: true })),
    readSession: async (id) => {
      const entry = corpus.find((candidate) => candidate.header.id === id || candidate.id === id);
      if (entry === undefined) throw new Error(`no such session ${id}`);
      return { session: entry.header, events: entry.events };
    },
  },
  connection: { admit: () => ({ peer: {} }) },
  effect: () => () => {},
  inject: (dependencies, callback) => {
    if (!dependencies.includes('webServer')) throw new Error('the host half must ask for webServer');
    callback({
      effect: (factory) => {
        factory();
        return () => {};
      },
      webServer: {
        register: (registered) => {
          route = registered;
          return () => {};
        },
      },
    });
  },
};
//#endregion

//#region drive one request
await apply(ctx, {});
check('registered a prefix route', route !== null && route.kind === 'prefix' && route.path === '/dsh-usage-stats',
  JSON.stringify(route === null ? null : { kind: route.kind, path: route.path }));

/** Answer one request through the captured handler. */
async function request(pathname, { method = 'POST', cookie = true } = {}) {
  const chunks = [];
  const req = {
    url: pathname,
    method,
    headers: cookie ? { host: '127.0.0.1:19387', cookie: 'x=1' } : { host: '127.0.0.1:19387' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{}');
    },
  };
  let status = 0;
  let body = '';
  const res = {
    writeHead(code) {
      status = code;
    },
    end(text) {
      body = text ?? '';
    },
  };
  await route.handler(req, res);
  void chunks;
  let json = null;
  try {
    json = body === '' ? null : JSON.parse(body);
  } catch {
    json = null;
  }
  return { status, body, json };
}

const overview = await request('/dsh-usage-stats/overview');
check('overview answers 200', overview.status === 200, String(overview.status));
check('overview reports ok', overview.json?.ok === true, JSON.stringify(overview.json)?.slice(0, 120));

const payload = overview.json?.value;
check('the payload carries the full window', payload?.window?.days === 371, String(payload?.window?.days));
check('the payload carries the totals', payload?.totals?.requests === corpus.reduce((sum, entry) => sum + entry.events.filter((event) => event.type === 'assistant/message' && event.data?.usage).length, 0),
  `${payload?.totals?.requests} requests`);
check('every model row carries a tariff split',
  payload.models.every((model) => model.tariffs !== undefined && Object.keys(model.tariffs).length > 0));
check('every model row carries per-day tariff buckets',
  payload.models.every((model) => model.days.every((row) => row.tariffs !== undefined)));
check('money is attached to every priced model',
  payload.models.every((model) => model.cost !== null && typeof model.cost.total === 'number' && typeof model.cost.today === 'number'),
  JSON.stringify(payload.models.map((model) => model.cost)));
check('the pricing block names the table', payload.pricing?.configured === true && payload.pricing?.priced === payload.models.length,
  JSON.stringify(payload.pricing));

// The independent recomputation: price the same tariff buckets a second time.
const document = JSON.parse(execFileSync('cat', [join(plugin, 'prices.json')], { encoding: 'utf8' }));
const table = parsePriceTable(document);
const today = dayKeyOf(Date.now());

/** What one tariff-split counter set costs, rebuilt from the raw rates. */
function rebuild(tariffs, price) {
  let sum = 0;
  for (const [tariff, counters] of Object.entries(tariffs ?? {})) {
    const rates = price[tariff] ?? price.peak;
    sum += counters.inputTokens / table.unit * rates.input
      + counters.outputTokens / table.unit * rates.output
      + counters.cacheReadTokens / table.unit * rates.cacheRead
      + counters.cacheWriteTokens / table.unit * rates.cacheWrite;
  }
  return sum;
}

for (const model of payload.models) {
  const price = table.byKey.get(model.key.toLowerCase()) ?? table.byKey.get(model.model.toLowerCase());
  if (price === undefined) continue;
  check(`${model.model}: total cost matches a rebuild`,
    Math.abs(model.cost.total - rebuild(model.tariffs, price)) < 1e-9,
    `${model.cost.total} vs ${rebuild(model.tariffs, price)}`);
  const todayRow = model.days.find((row) => row.date === today);
  const expectedToday = rebuild(todayRow?.tariffs ?? {}, price);
  check(`${model.model}: today's cost matches a rebuild`, Math.abs(model.cost.today - expectedToday) < 1e-9,
    `${model.cost.today} vs ${expectedToday}`);
  check(`${model.model}: the tariff split covers every token`,
    Object.values(model.tariffs).reduce((sum, counters) => sum + counters.inputTokens, 0) === model.inputTokens,
    `${JSON.stringify(model.tariffs)} vs ${model.inputTokens}`);
}

//#region off-peak pricing, end to end
const OFF_PEAK_HOUR = 3;
const offPeakAt = Date.UTC(2026, 9, 1, OFF_PEAK_HOUR) - table.offPeak.utcOffsetMinutes * 60000;
const synthetic = {
  header: { version: 4, id: 'session-off-peak', createdAt: offPeakAt, cwd: '/tmp', isSeeded: false },
  events: [{
    type: 'assistant/message',
    seq: 1,
    time: offPeakAt,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2_000_000 },
    },
  }],
};
let offPeakRoute = null;
const offPeakCtx = {
  logger: { warn: (message) => failures.push(`host warned: ${message}`), debug: () => {} },
  sessionQuery: {
    listSessions: async () => [{ header: synthetic.header, live: false, persisted: true }],
    readSession: async () => ({ session: synthetic.header, events: synthetic.events }),
  },
  connection: { admit: () => ({ peer: {} }) },
  effect: () => () => {},
  inject: (_dependencies, callback) => callback({
    effect: (factory) => {
      factory();
      return () => {};
    },
    webServer: { register: (registered) => { offPeakRoute = registered; return () => {}; } },
  }),
};
await apply(offPeakCtx, {});
const offPeakReq = { url: '/dsh-usage-stats/overview', method: 'POST', headers: { host: '127.0.0.1:19387', cookie: 'x=1' }, async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); } };
let offPeakBody = '';
await offPeakRoute.handler(offPeakReq, { writeHead: () => {}, end: (text) => { offPeakBody = text ?? ''; } });
const offPeakPayload = JSON.parse(offPeakBody).value;
const offPeakModel = offPeakPayload.models[0];
check('a 03:00 sample lands in the off-peak tariff', Object.keys(offPeakModel.tariffs).join(',') === 'offPeak',
  JSON.stringify(offPeakModel.tariffs));
const flash = table.byKey.get('deepseek-flash');
const expectedOffPeak = flash.offPeak.input + flash.offPeak.output;
check('an off-peak sample bills at the discounted rate', Math.abs(offPeakModel.cost.total - expectedOffPeak) < 1e-9,
  `${offPeakModel.cost.total} vs ${expectedOffPeak}`);
check('a peak sample of the same size would cost more', expectedOffPeak < flash.peak.input + flash.peak.output,
  `${expectedOffPeak} vs ${flash.peak.input + flash.peak.output}`);
//#endregion

const unauthorised = await request('/dsh-usage-stats/overview', { cookie: false });
const rejected = await request('/dsh-usage-stats/overview', { method: 'GET' });
const missing = await request('/dsh-usage-stats/nope');
void unauthorised;
void rejected;
check('a GET is refused', rejected.status === 405, String(rejected.status));
check('an unknown endpoint is 404', missing.status === 404, String(missing.status));
check('a refresh request answers 200', (await request('/dsh-usage-stats/refresh')).status === 200);
//#endregion

console.log(`sessions folded     ${corpus.length}`);
console.log(`requests            ${payload.totals.requests}`);
console.log(`window              ${payload.window.from} .. ${payload.window.to} (${payload.window.days} days)`);
for (const model of payload.models) {
  console.log(`  ${model.key.padEnd(34)} today=${model.cost === null ? '—' : model.cost.today.toFixed(4)} total=${model.cost === null ? '—' : model.cost.total.toFixed(4)}`);
}
console.log(`tariffs present     ${[...new Set(payload.models.flatMap((model) => Object.keys(model.tariffs)))].join(', ')}`);
console.log(`pricing             ${JSON.stringify(payload.pricing)}`);

if (failures.length > 0) {
  console.error('\nFAILED CHECKS');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log('\nall host checks passed');
