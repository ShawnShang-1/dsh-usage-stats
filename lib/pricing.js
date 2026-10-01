/**
 * Model pricing: turn the fold's tariff-split token counters into money.
 *
 * Pure and dependency-free, like {@link module:dsh-usage-stats/lib/fold}: a raw
 * price document in, a normalized table plus the two operations that use it out.
 * Nothing here knows about Cordis or the filesystem, so `scripts/check-prices.mjs`
 * exercises it directly.
 *
 * A price table prices **four counters per tariff** — cached prompt tokens, fresh
 * prompt tokens, output tokens, and cache writes — quoted per `unit` tokens
 * (default one million). Entries may price only `peak`; `offPeak` then falls back
 * to it, so a provider without off-peak rates needs one set of numbers.
 *
 * @module dsh-usage-stats/lib/pricing
 */

/** Default denominator: prices are quoted per million tokens. */
export const DEFAULT_UNIT = 1000000;

/** The tariffs an entry may price. */
export const TARIFFS = ['peak', 'offPeak'];

/**
 * DeepSeek's published off-peak window, in the provider's own clock (UTC+8):
 * 00:30–08:30 every day, and the whole weekend.
 */
export const DEFAULT_OFF_PEAK = {
  start: '00:30',
  end: '08:30',
  weekends: true,
  utcOffsetMinutes: 480,
};

/** The four rate fields, in the order they are documented. */
const RATE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];

/**
 * Read one non-negative finite number.
 * @param {unknown} value - candidate.
 * @param {number} fallback - used when the value is unusable.
 * @returns {number} the rate.
 */
function rate(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Read one `HH:MM` clock time as minutes past midnight.
 * @param {unknown} value - candidate.
 * @param {number} fallback - minutes used when the value is unusable.
 * @returns {number} minutes past midnight.
 */
function minutesOf(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return fallback;
  return hours * 60 + minutes;
}

/**
 * Copy the four rates out of one raw entry.
 * @param {object} source - raw rates.
 * @returns {object} the four rates, each defaulting to zero.
 */
function ratesOf(source) {
  const result = {};
  for (const field of RATE_FIELDS) result[field] = rate(source?.[field]);
  return result;
}

/**
 * Normalize one price-table document plus any Loader-config overrides.
 * @param {object} document - parsed `prices.json`.
 * @param {ReadonlyArray<object>} [overrides] - the plugin's `config.prices`, applied after the document.
 * @returns {object} `{ unit, currency, note, offPeak, rows, byKey }`.
 */
export function parsePriceTable(document, overrides = []) {
  const source = document !== null && typeof document === 'object' ? document : {};
  const unit = rate(source.unit, DEFAULT_UNIT) || DEFAULT_UNIT;
  const currency = typeof source.currency === 'string' ? source.currency : '';
  const note = typeof source.note === 'string' ? source.note : '';

  let offPeak = null;
  const window = source.offPeakWindow === undefined ? DEFAULT_OFF_PEAK : source.offPeakWindow;
  if (window !== null && window !== false) {
    const start = minutesOf(window?.start, minutesOf(DEFAULT_OFF_PEAK.start, 30));
    const end = minutesOf(window?.end, minutesOf(DEFAULT_OFF_PEAK.end, 510));
    offPeak = {
      start,
      end,
      weekends: window?.weekends !== false,
      utcOffsetMinutes: typeof window?.utcOffsetMinutes === 'number' && Number.isFinite(window.utcOffsetMinutes)
        ? window.utcOffsetMinutes
        : DEFAULT_OFF_PEAK.utcOffsetMinutes,
    };
  }

  const declared = [
    ...Array.isArray(source.models) ? source.models : [],
    ...Array.isArray(overrides) ? overrides : [],
  ];
  const byKey = new Map();
  const rows = [];
  for (const raw of declared) {
    if (raw === null || typeof raw !== 'object') continue;
    const model = typeof raw.model === 'string' ? raw.model : typeof raw.id === 'string' ? raw.id : undefined;
    if (model === undefined || model === '') continue;
    const provider = typeof raw.provider === 'string' ? raw.provider : undefined;
    const row = {
      provider,
      model,
      peak: ratesOf(raw),
      offPeak: raw.offPeak === undefined || raw.offPeak === null ? null : ratesOf(raw.offPeak),
    };
    rows.push(row);
    const keys = provider === undefined
      ? [model]
      : [`${provider}/${model}`, model];
    for (const key of keys) byKey.set(key.toLowerCase(), row);
  }
  return { unit, currency, note, offPeak, rows, byKey };
}

/**
 * Build the tariff classifier a fold uses to split samples.
 * @param {object} table - a table from {@link parsePriceTable}.
 * @returns {(time: number) => string} `offPeak` or `peak`, in the provider's clock.
 */
export function createTariffClassifier(table) {
  const window = table.offPeak;
  if (window === null) return () => 'peak';
  return (time) => {
    // Shift the instant onto the provider's wall clock and read it as UTC.
    const shifted = new Date(time + window.utcOffsetMinutes * 60000);
    const weekday = shifted.getUTCDay();
    if (window.weekends && (weekday === 0 || weekday === 6)) return 'offPeak';
    const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
    const inside = window.start <= window.end
      ? minutes >= window.start && minutes < window.end
      : minutes >= window.start || minutes < window.end;
    return inside ? 'offPeak' : 'peak';
  };
}

/**
 * The rate row that prices one route.
 * @param {object} table - a table from {@link parsePriceTable}.
 * @param {string} provider - route provider id.
 * @param {string} model - route model id.
 * @returns {object|null} the row, or null when no rate matches.
 */
export function priceFor(table, provider, model) {
  const routed = `${provider ?? ''}/${model ?? ''}`.toLowerCase();
  return table.byKey.get(routed) ?? table.byKey.get(String(model ?? '').toLowerCase()) ?? null;
}

/**
 * Price one tariff-split counter set.
 * @param {object} tariffs - `{ peak: counters, offPeak: counters }` as the fold recorded them.
 * @param {object} price - a row from {@link parsePriceTable}.
 * @param {number} unit - token denominator the rates are quoted per.
 * @returns {number} the cost in the table's currency.
 */
export function costOf(tariffs, price, unit) {
  if (tariffs === null || tariffs === undefined || price === null || price === undefined) return 0;
  let cost = 0;
  for (const tariff of TARIFFS) {
    const counters = tariffs[tariff];
    if (counters === undefined || counters === null) continue;
    const rates = price[tariff] ?? price.peak;
    cost += counters.inputTokens / unit * rates.input;
    cost += counters.outputTokens / unit * rates.output;
    cost += counters.cacheReadTokens / unit * rates.cacheRead;
    cost += counters.cacheWriteTokens / unit * rates.cacheWrite;
  }
  return cost;
}

/**
 * Attach the two money figures the panel offers to folded model rows.
 * Mutates the rows in place — the payload they belong to is a fresh scan result.
 * @param {ReadonlyArray<object>} models - `payload.models` from {@link module:dsh-usage-stats/lib/fold}.
 * @param {object} table - a table from {@link parsePriceTable}.
 * @param {string} todayKey - the local day key the payload calls today.
 * @returns {number} how many rows got a price.
 */
export function attachCosts(models, table, todayKey) {
  let priced = 0;
  for (const model of models) {
    const price = priceFor(table, model.provider, model.model);
    const todayRow = Array.isArray(model.days) ? model.days.find((row) => row.date === todayKey) : undefined;
    model.cost = price === null ? null : {
      total: costOf(model.tariffs, price, table.unit),
      today: costOf(todayRow?.tariffs, price, table.unit),
    };
    if (price !== null) priced += 1;
  }
  return priced;
}

/**
 * Render one cost the way the panel shows it: no currency symbol, always exactly
 * one decimal, `—` when no rate matched, and `<0.01` below the last digit the
 * panel can show.
 * @param {number|null} cost - the amount, or null when unconfigured.
 * @param {number} [decimals] - digits kept.
 * @returns {string} the display text.
 */
export function formatCost(cost, decimals = 1) {
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return '—';
  if (cost > 0 && cost < 10 ** -decimals) return `<${(10 ** -decimals).toFixed(decimals)}`;
  return cost.toFixed(decimals);
}
