/**
 * Usage statistics, host half implementation.
 *
 * Reads every logical Session the corpus knows, folds each durable log with
 * {@link module:dsh-usage-stats/lib/fold}, and answers the browser half over one
 * exact prefix route on the composed webserver. The route admits through
 * `ctx.connection.admit`, so it inherits the browser trust fence and the
 * persistent browser session every other `/api`-family route uses, and then
 * answers plain JSON — the browser half is the only client.
 *
 * Nothing here touches a model: it reads logs the harness already wrote.
 *
 * The relative import below carries `entry.js`'s revision query, so the whole
 * implementation graph is one cache generation rather than one per file.
 *
 * @module dsh-usage-stats/lib/host
 */

const { createFold, finishFold, foldSession, dayKeyOf } = await import(`./fold.js${new URL(import.meta.url).search}`);
const { parsePriceTable, createTariffClassifier, attachCosts } = await import(`./pricing.js${new URL(import.meta.url).search}`);

import { readFileSync } from 'node:fs';

/** Loader row identity this plugin's config is addressed by. */
export const name = 'usage-stats';

/** Required services. */
export const inject = ['sessionQuery', 'connection'];

/** Route prefix; must match the browser half. */
const CHANNEL = '/dsh-usage-stats';

/** Sessions read at once. Session logs are zstd JSONL, so this is I/O bound. */
const MAX_CONCURRENCY = 4;

/** How long one completed scan is served before a background re-scan. */
const DEFAULT_TTL_MS = 30000;

/** Upper bound on the corpus one scan folds. */
const DEFAULT_MAX_SESSIONS = 4000;

/** Accepted request body size, in bytes. The browser half sends `{}`. */
const MAX_BODY_BYTES = 65536;

/**
 * Read the plugin's own price table. It is re-read on every scan, so editing
 * `prices.json` and pressing **刷新** in the panel is the whole update loop.
 * @param {object} ctx - host Cordis context, for the diagnostic.
 * @param {object} [config] - the Loader config, whose `prices` list overrides the file.
 * @returns {object} a table from {@link parsePriceTable}.
 */
function loadPriceTable(ctx, config) {
  let document = {};
  try {
    document = JSON.parse(readFileSync(new URL('../prices.json', import.meta.url), 'utf8'));
  } catch (error) {
    ctx.logger?.warn?.(`usage-stats: prices.json is unreadable, every model will show "—": ${String(error)}`);
  }
  return parsePriceTable(document, config?.prices);
}

/**
 * Read one config number with a fallback.
 * @param {unknown} value - configured value.
 * @param {number} fallback - value used when the config is absent or unusable.
 * @param {number} min - smallest accepted value.
 * @returns {number} the effective value.
 */
function numberConfig(value, fallback, min) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? Math.trunc(value) : fallback;
}

/**
 * Write one JSON response.
 * @param {object} res - the node response.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - JSON-serializable body.
 * @returns {void}
 */
function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Drain and parse a request body.
 * @param {object} req - the node request.
 * @returns {Promise<object>} the parsed body, or `{}` when empty.
 */
async function readJson(req) {
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > MAX_BODY_BYTES) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Mount the usage fold and its HTTP route.
 * @param {object} ctx - host Cordis context.
 * @param {object} [config] - this plugin's Loader config.
 * @returns {void}
 */
export function apply(ctx, config) {
  const ttlMs = numberConfig(config?.ttlMs, DEFAULT_TTL_MS, 0);
  const maxSessions = numberConfig(config?.maxSessions, DEFAULT_MAX_SESSIONS, 1);

  /** Last completed scan: `{ at, payload }`. */
  let cache = null;
  /** The scan in flight, so concurrent readers share one pass. */
  let inflight = null;

  /**
   * Fold the whole corpus once.
   * @returns {Promise<object>} the aggregate payload.
   */
  async function scan() {
    const startedAt = Date.now();
    const table = loadPriceTable(ctx, config);
    const tariffOf = createTariffClassifier(table);
    const records = await ctx.sessionQuery.listSessions();
    const selected = records.length > maxSessions ? records.slice(0, maxSessions) : records;
    const fold = createFold();
    const queue = [...selected];
    let failed = 0;

    const worker = async () => {
      for (;;) {
        const record = queue.shift();
        if (record === undefined) return;
        try {
          const snapshot = await ctx.sessionQuery.readSession(record.header.id);
          foldSession(fold, snapshot?.session ?? record.header, snapshot?.events ?? [], tariffOf);
        } catch (error) {
          failed += 1;
          ctx.logger?.debug?.(`usage-stats: skipped session ${String(record.header?.id)}: ${String(error)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, queue.length) }, worker));

    const now = Date.now();
    const payload = finishFold(fold, now);
    const today = dayKeyOf(now);

    // Money is priced here, not in the browser: the rates stay on the Host side
    // and the panel only picks which of the two numbers to show.
    const priced = attachCosts(payload.models, table, today);
    payload.pricing = {
      currency: table.currency,
      unit: table.unit,
      configured: table.byKey.size > 0,
      priced,
      models: table.rows.length,
    };
    payload.scan = {
      sessions: selected.length,
      total: records.length,
      failed,
      durationMs: Date.now() - startedAt,
    };
    return payload;
  }

  /**
   * Run one scan, joining an in-flight pass instead of starting a second.
   * @returns {Promise<object>} the aggregate payload.
   */
  function runScan() {
    if (inflight === null) {
      inflight = scan().then((payload) => {
        cache = { at: Date.now(), payload };
        return payload;
      }).finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  /**
   * Answer one read, serving the cached pass while it is fresh and refreshing
   * stale data in the background so the panel never blocks on a second scan.
   * @param {boolean} force - ignore the cached pass and wait for a new one.
   * @returns {Promise<object>} the aggregate payload.
   */
  async function overview(force) {
    if (cache === null) return runScan();
    if (force) return runScan();
    if (Date.now() - cache.at >= ttlMs) runScan().catch((error) => {
      ctx.logger?.warn?.(`usage-stats: background refresh failed: ${String(error)}`);
    });
    return cache.payload;
  }

  const route = {
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      const admission = ctx.connection.admit(req);
      if ('rejection' in admission) {
        res.writeHead(admission.rejection, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
      }
      if ((req.method ?? 'GET') !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' });
        res.end('method not allowed');
        return;
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      const endpoint = pathname === CHANNEL ? '' : pathname.slice(CHANNEL.length + 1);
      try {
        await readJson(req);
        if (endpoint === 'overview') return send(res, 200, { ok: true, value: await overview(false) });
        if (endpoint === 'refresh') return send(res, 200, { ok: true, value: await overview(true) });
        return send(res, 404, { ok: false, error: `unknown endpoint ${JSON.stringify(endpoint)}` });
      } catch (error) {
        return send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  };

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register(route), 'usage-stats: prefix route');
  });
}
