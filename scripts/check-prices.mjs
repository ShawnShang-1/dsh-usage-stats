/**
 * Unit check for {@link module:dsh-usage-stats/lib/pricing} and the shipped
 * `prices.json`.
 *
 *     node scripts/check-prices.mjs
 *
 * Covers rate matching, the off-peak window in the provider's own clock, and the
 * money arithmetic against a hand-computed sample.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePriceTable, createTariffClassifier, priceFor, costOf, formatCost } from '../lib/pricing.js';

const plugin = join(dirname(fileURLToPath(import.meta.url)), '..');
const document = JSON.parse(readFileSync(join(plugin, 'prices.json'), 'utf8'));
const table = parsePriceTable(document);
const extended = parsePriceTable(document, [{ model: 'my-local-model', input: 1, output: 2, cacheRead: 0.1 }]);

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`);
};

/** Epoch milliseconds of one wall-clock time in the provider's zone (UTC+8). */
const beijing = (year, month, day, hour, minute = 0) =>
  Date.UTC(year, month - 1, day, hour, minute) - table.offPeak.utcOffsetMinutes * 60000;

//#region matching
check('names a price per shipped entry', table.rows.length === document.models.length, `${table.rows.length} rows for ${document.models.length} entries`);
const flash = priceFor(table, 'deepseek-official', 'deepseek-flash');
check('matches provider/model exactly', flash !== null && flash.model === 'deepseek-flash');
check('matches a bare model id', priceFor(table, 'somewhere-else', 'deepseek-v4-pro')?.model === 'deepseek-v4-pro', 'v4-pro not matched');
check('is case-insensitive', priceFor(table, 'DeepSeek-Official', 'DeepSeek-Flash') !== null);
check('config overrides extend the file', priceFor(extended, 'x', 'my-local-model')?.peak.output === 2);
check('a config override does not touch the file table', priceFor(table, 'x', 'my-local-model') === null);
check('an unpriced model stays unpriced', priceFor(table, 'openai', 'gpt-whatever') === null);
check('off-peak falls back only when declared', flash.offPeak !== null && extended.rows.find((row) => row.model === 'my-local-model').offPeak === null);
//#endregion

//#region off-peak window
const tariffOf = createTariffClassifier(table);
check('2026-10-01 is a Thursday', new Date(Date.UTC(2026, 9, 1)).getUTCDay() === 4, String(new Date(Date.UTC(2026, 9, 1)).getUTCDay()));
check('2026-10-03 is a Saturday', new Date(Date.UTC(2026, 9, 3)).getUTCDay() === 6, String(new Date(Date.UTC(2026, 9, 3)).getUTCDay()));
check('00:30 starts the window', tariffOf(beijing(2026, 10, 1, 0, 30)) === 'offPeak');
check('00:29 is still peak', tariffOf(beijing(2026, 10, 1, 0, 29)) === 'peak');
check('02:00 is off-peak', tariffOf(beijing(2026, 10, 1, 2)) === 'offPeak');
check('08:29 is off-peak', tariffOf(beijing(2026, 10, 1, 8, 29)) === 'offPeak');
check('08:30 ends the window', tariffOf(beijing(2026, 10, 1, 8, 30)) === 'peak');
check('midday is peak on a weekday', tariffOf(beijing(2026, 10, 1, 12)) === 'peak');
check('a weekend midday is off-peak', tariffOf(beijing(2026, 10, 3, 12)) === 'offPeak');
check('a weekend 00:00 is off-peak', tariffOf(beijing(2026, 10, 4, 0)) === 'offPeak');

const noWeekends = parsePriceTable({ ...document, offPeakWindow: { ...document.offPeakWindow, weekends: false } });
check('weekends can be switched off', createTariffClassifier(noWeekends)(beijing(2026, 10, 3, 12)) === 'peak');
const noWindow = parsePriceTable({ ...document, offPeakWindow: null });
check('a null window classifies everything as peak',
  ['peak', 'offPeak'].every((_ignored, index) => createTariffClassifier(noWindow)(beijing(2026, 10, 1, index)) === 'peak'));
//#endregion

//#region money
const unit = table.unit;
/** One million tokens of each kind, on one tariff. */
const million = { inputTokens: unit, outputTokens: unit, cacheReadTokens: unit, cacheWriteTokens: unit };
const peak = priceFor(table, 'deepseek-official', 'deepseek-flash');
check('peak sample prices at input+output+cacheRead rates',
  costOf({ peak: million }, peak, unit) === peak.peak.input + peak.peak.output + peak.peak.cacheRead + peak.peak.cacheWrite,
  String(costOf({ peak: million }, peak, unit)));
check('off-peak sample prices at the discounted rates',
  costOf({ offPeak: million }, peak, unit) === peak.offPeak.input + peak.offPeak.output + peak.offPeak.cacheRead + peak.offPeak.cacheWrite,
  String(costOf({ offPeak: million }, peak, unit)));
check('both tariffs add up',
  costOf({ peak: million, offPeak: million }, peak, unit) ===
    costOf({ peak: million }, peak, unit) + costOf({ offPeak: million }, peak, unit));
check('a tariff a row does not price uses its peak rates',
  costOf({ offPeak: million }, extended.rows.find((row) => row.model === 'my-local-model'), unit) === 1 + 2 + 0.1);
check('no price costs nothing', costOf({ peak: million }, null, unit) === 0);

// A hand-computed bill: 1M fresh input, 10M cached input, 0.5M output on peak rates.
const bill = costOf({
  peak: { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 10_000_000, cacheWriteTokens: 0 },
}, peak, unit);
const expected = 1 * peak.peak.input + 0.5 * peak.peak.output + 10 * peak.peak.cacheRead;
check('the hand-computed bill matches', Math.abs(bill - expected) < 1e-9, `${bill} vs ${expected}`);

check('costs below the last digit round down', formatCost(0.04) === '<0.1', formatCost(0.04));
check('costs keep one decimal', formatCost(12.34) === '12.3', formatCost(12.34));
check('large costs keep the decimal too', formatCost(1234.56) === '1234.6', formatCost(1234.56));
check('an exact cost still shows its decimal', formatCost(100) === '100.0', formatCost(100));
check('a missing cost renders as a dash', formatCost(null) === '—');
//#endregion

console.log(`price table        ${table.rows.length} entries, unit ${table.unit}, currency ${JSON.stringify(table.currency)}`);
console.log(`off-peak window    ${table.offPeak.start}..${table.offPeak.end} min, weekends=${String(table.offPeak.weekends)}, UTC${table.offPeak.utcOffsetMinutes / 60 >= 0 ? '+' : ''}${table.offPeak.utcOffsetMinutes / 60}`);
console.log(`deepseek-flash     peak in/out/cacheRead = ${peak.peak.input}/${peak.peak.output}/${peak.peak.cacheRead}, off-peak = ${peak.offPeak.input}/${peak.offPeak.output}/${peak.offPeak.cacheRead}`);
console.log(`hand-computed bill ${bill} (1M fresh + 10M cached + 0.5M output, peak)`);

if (failures.length > 0) {
  console.error('\nFAILED CHECKS');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log('\nall pricing checks passed');
