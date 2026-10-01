/**
 * Pure fold from durable Session events to the usage aggregate the Settings page
 * renders. No Cordis, no filesystem, no clock of its own — every input arrives as
 * an argument so the same code runs inside the plugin and in a Node check script.
 *
 * A session log's billed usage lives on `assistant/message` events (`data.usage`),
 * whose route lives on the message's `source` (`{kind: 'model', provider, model}`).
 * `TokenUsage.inputTokens` counts *uncached* prompt tokens, so the cache hit rate
 * is `cacheRead / (cacheRead + inputTokens)`.
 *
 * Every sample is also split by **tariff** (`peak` / `offPeak`), because providers
 * that discount off-peak hours bill the same tokens differently. The fold does not
 * know any price: the caller passes a `tariffOf(time)` classifier, and the Host
 * turns the split into money.
 *
 * @module dsh-usage-stats/lib/fold
 */

/** Milliseconds in one day. */
export const DAY_MS = 86400000;

/** Width of the activity window, in days, ending today. */
export const WINDOW_DAYS = 371;

/** Payload cap on the per-session list, newest first. */
export const MAX_SESSION_ROWS = 200;

/** The tariff every sample carries when no classifier splits them. */
export const DEFAULT_TARIFF = 'peak';

/** @param {number} value - candidate count. @returns {number} a finite non-negative count. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** @param {number} value - two-digit source. @returns {string} zero-padded. */
function pad2(value) {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Local-calendar day key of one epoch millisecond (`YYYY-MM-DD`).
 * Streaks and the heatmap are local-calendar facts, so every bucket is local.
 * @param {number} ms - epoch milliseconds.
 * @returns {string} the local day key.
 */
export function dayKeyOf(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Stable integer index of one `YYYY-MM-DD` key, so consecutive local days differ
 * by exactly one and streaks survive daylight-saving transitions.
 * @param {string} key - a day key from {@link dayKeyOf}.
 * @returns {number} days since the epoch, in UTC arithmetic over local parts.
 */
export function dayIndexOf(key) {
  const [year, month, day] = key.split('-').map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

/**
 * Inverse of {@link dayKeyOf} for a day index.
 * @param {number} index - days since the epoch.
 * @returns {string} the local day key.
 */
export function dayKeyOfIndex(index) {
  const date = new Date(index * DAY_MS);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** One day's activity bucket. @returns {object} a zeroed bucket. */
function emptyDay() {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    requests: 0,
  };
}

/** The four counters one tariff prices. @returns {object} zeroed counters. */
function emptyTariff() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** One model's aggregate. @returns {object} a zeroed bucket. */
function emptyModel(provider, model) {
  return {
    provider,
    model,
    key: `${provider}/${model}`,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    requests: 0,
    cacheHitRate: 0,
    tariffs: {},
  };
}

/** An empty accumulator. @returns {object} the fold. */
export function createFold() {
  return {
    totals: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      requests: 0,
    },
    models: new Map(),
    modelDays: new Map(),
    days: new Map(),
    sessions: [],
    firstTime: Infinity,
    lastTime: -Infinity,
  };
}

/**
 * Fold one token sample into the accumulator's totals, its model bucket, its
 * per-model day bucket, and the day bucket — each split by tariff.
 * @param {object} fold - accumulator from {@link createFold}.
 * @param {object} usage - the event's `TokenUsage`.
 * @param {string} provider - route provider id.
 * @param {string} model - route model id.
 * @param {number} time - event time in epoch milliseconds.
 * @param {string} tariff - `peak` or `offPeak`.
 * @returns {number} the sample's total token count.
 */
function addSample(fold, usage, provider, model, time, tariff) {
  const inputTokens = count(usage.inputTokens);
  const outputTokens = count(usage.outputTokens);
  const cacheReadTokens = count(usage.cacheReadTokens);
  const cacheWriteTokens = count(usage.cacheWriteTokens);
  const reasoningTokens = count(usage.reasoningTokens);
  const totalTokens = typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens) && usage.totalTokens > 0
    ? Math.trunc(usage.totalTokens)
    : inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

  const key = `${provider}/${model}`;
  let bucket = fold.models.get(key);
  if (bucket === undefined) {
    bucket = emptyModel(provider, model);
    fold.models.set(key, bucket);
  }
  let modelDays = fold.modelDays.get(key);
  if (modelDays === undefined) {
    modelDays = new Map();
    fold.modelDays.set(key, modelDays);
  }
  const dayKey = dayKeyOf(time);
  let modelDay = modelDays.get(dayKey);
  if (modelDay === undefined) {
    modelDay = { totalTokens: 0, requests: 0, tariffs: {} };
    modelDays.set(dayKey, modelDay);
  }
  let day = fold.days.get(dayKey);
  if (day === undefined) {
    day = emptyDay();
    fold.days.set(dayKey, day);
  }

  for (const target of [fold.totals, bucket, day]) {
    target.totalTokens += totalTokens;
    target.inputTokens += inputTokens;
    target.outputTokens += outputTokens;
    target.cacheReadTokens += cacheReadTokens;
    target.cacheWriteTokens += cacheWriteTokens;
    target.reasoningTokens += reasoningTokens;
    target.requests += 1;
  }
  modelDay.totalTokens += totalTokens;
  modelDay.requests += 1;

  for (const holder of [bucket, modelDay]) {
    let counters = holder.tariffs[tariff];
    if (counters === undefined) {
      counters = emptyTariff();
      holder.tariffs[tariff] = counters;
    }
    counters.inputTokens += inputTokens;
    counters.outputTokens += outputTokens;
    counters.cacheReadTokens += cacheReadTokens;
    counters.cacheWriteTokens += cacheWriteTokens;
  }
  return totalTokens;
}

/**
 * Fold one session's complete event log into the accumulator.
 * @param {object} fold - accumulator from {@link createFold}.
 * @param {object} header - the session header (`id`, `createdAt`, `cwd`, …).
 * @param {ReadonlyArray<object>} events - the session's raw events in seq order.
 * @param {(time: number) => string} [tariffOf] - classifies one event time; defaults to one tariff.
 * @returns {object} the per-session summary this fold recorded.
 */
export function foldSession(fold, header, events, tariffOf) {
  const classify = tariffOf ?? (() => DEFAULT_TARIFF);
  let headerRoute = null;
  let firstTime = Infinity;
  let lastTime = -Infinity;
  let tokens = 0;
  let requests = 0;
  const models = new Set();

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    const time = typeof event.time === 'number' ? event.time : undefined;
    if (time !== undefined) {
      if (time < firstTime) firstTime = time;
      if (time > lastTime) lastTime = time;
      if (time < fold.firstTime) fold.firstTime = time;
      if (time > fold.lastTime) fold.lastTime = time;
    }
    if (event.type === 'request/header') {
      const config = event.data?.header?.config;
      if (config !== undefined && config !== null) headerRoute = { provider: config.provider, model: config.model };
      continue;
    }
    if (event.type !== 'assistant/message') continue;
    const usage = event.data?.usage;
    if (usage === undefined || usage === null) continue;
    const source = event.data?.message?.source;
    const routed = source !== undefined && source !== null && source.kind === 'model' ? source : undefined;
    const provider = routed?.provider ?? headerRoute?.provider ?? 'unknown';
    const model = routed?.model ?? headerRoute?.model ?? 'unknown';
    const sampleTime = typeof event.time === 'number' ? event.time : lastTime;
    const tariff = classify(sampleTime);
    tokens += addSample(fold, usage, provider, model, sampleTime, tariff);
    requests += 1;
    models.add(`${provider}/${model}`);
  }

  const session = {
    id: header?.id ?? 'unknown',
    createdAt: count(header?.createdAt) || (Number.isFinite(firstTime) ? firstTime : 0),
    cwd: typeof header?.cwd === 'string' ? header.cwd : null,
    origin: typeof header?.origin === 'string' ? header.origin : null,
    agentPreset: typeof header?.agentPreset === 'string' ? header.agentPreset : null,
    firstTime: Number.isFinite(firstTime) ? firstTime : null,
    lastTime: Number.isFinite(lastTime) ? lastTime : null,
    durationMs: Number.isFinite(firstTime) && Number.isFinite(lastTime) ? lastTime - firstTime : 0,
    requests,
    tokens,
    models: [...models],
  };
  fold.sessions.push(session);
  return session;
}

/**
 * Consecutive-day runs over a set of active day indices.
 * @param {ReadonlySet<number>} active - active day indices.
 * @param {number} endIndex - the window's last day index.
 * @returns {{current: number, longest: number}} the current (ending at the window end or the day before) and longest runs.
 */
function streaksOf(active, endIndex) {
  let longest = 0;
  let run = 0;
  let previous = Number.NaN;
  for (const index of [...active].sort((a, b) => a - b)) {
    run = index === previous + 1 ? run + 1 : 1;
    previous = index;
    if (run > longest) longest = run;
  }
  let cursor = active.has(endIndex) ? endIndex : endIndex - 1;
  let current = 0;
  while (active.has(cursor)) {
    current += 1;
    cursor -= 1;
  }
  return { current, longest };
}

/**
 * Finish the accumulator into the JSON payload the browser renders.
 * @param {object} fold - accumulator from {@link createFold}.
 * @param {number} now - current epoch milliseconds (injected, so the fold stays pure).
 * @returns {object} the aggregate payload.
 */
export function finishFold(fold, now) {
  const todayIndex = dayIndexOf(dayKeyOf(now));
  const firstIndex = Number.isFinite(fold.firstTime) ? dayIndexOf(dayKeyOf(fold.firstTime)) : todayIndex;
  // A clock behind the newest recorded event still gets a non-empty window.
  const endIndex = Math.max(todayIndex, firstIndex);
  // The grid is always the complete window, so a young corpus still draws a full
  // calendar instead of a single column. `firstActivity` carries the real start.
  const startIndex = endIndex - (WINDOW_DAYS - 1);

  const days = [];
  const active = new Set();
  for (let index = startIndex; index <= endIndex; index += 1) {
    const key = dayKeyOfIndex(index);
    const bucket = fold.days.get(key) ?? emptyDay();
    if (bucket.totalTokens > 0 || bucket.requests > 0) active.add(index);
    days.push({ date: key, ...bucket });
  }
  for (const [key, bucket] of fold.days) {
    if (bucket.totalTokens > 0 || bucket.requests > 0) active.add(dayIndexOf(key));
  }

  let peakDay = null;
  let peakAllTime = null;
  for (const [key, bucket] of fold.days) {
    if (bucket.totalTokens <= 0) continue;
    if (peakAllTime === null || bucket.totalTokens > peakAllTime.totalTokens) {
      peakAllTime = { date: key, totalTokens: bucket.totalTokens, requests: bucket.requests };
    }
  }
  for (const day of days) {
    if (day.totalTokens <= 0) continue;
    if (peakDay === null || day.totalTokens > peakDay.totalTokens) peakDay = { date: day.date, totalTokens: day.totalTokens };
  }

  let longestSession = null;
  for (const session of fold.sessions) {
    if (session.durationMs <= 0) continue;
    if (longestSession === null || session.durationMs > longestSession.durationMs) longestSession = session;
  }

  const models = [...fold.models.values()].map((model) => {
    const promptTokens = model.inputTokens + model.cacheReadTokens;
    const modelDays = fold.modelDays.get(model.key);
    const dayRows = modelDays === undefined ? [] : [...modelDays.entries()]
      .map(([date, bucket]) => ({ date, ...bucket }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    return {
      ...model,
      cacheHitRate: promptTokens > 0 ? model.cacheReadTokens / promptTokens : 0,
      days: dayRows,
    };
  }).sort((a, b) => b.totalTokens - a.totalTokens);

  const sessions = [...fold.sessions]
    .sort((a, b) => (b.lastTime ?? b.createdAt) - (a.lastTime ?? a.createdAt))
    .slice(0, MAX_SESSION_ROWS);

  const { current, longest } = streaksOf(active, endIndex);

  return {
    generatedAt: now,
    window: { from: dayKeyOfIndex(startIndex), to: dayKeyOfIndex(endIndex), days: days.length },
    totals: fold.totals,
    peakDay,
    peakAllTime,
    longestSession,
    currentStreakDays: current,
    longestStreakDays: longest,
    activeDays: active.size,
    firstActivity: Number.isFinite(fold.firstTime) ? dayKeyOf(fold.firstTime) : null,
    lastActivity: Number.isFinite(fold.lastTime) ? dayKeyOf(fold.lastTime) : null,
    days,
    models,
    sessions,
  };
}
