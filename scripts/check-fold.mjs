/**
 * Offline check of {@link module:dsh-usage-stats/lib/fold} against the durable
 * Session corpus, using the same inputs `ctx.sessionQuery` serves.
 *
 *     node scripts/check-fold.mjs [--home <dsh home>] [--json]
 *
 * Reads every `session.v*.jsonl.zstd` under `<home>/sessions` (default `~/.dsh`)
 * through the `zstdcat` executable, so the plugin's fold is exercised without a
 * running Host.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createFold, finishFold, foldSession } from '../lib/fold.js';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const homeFlag = argv.indexOf('--home');
const home = homeFlag === -1 ? join(homedir(), '.dsh') : argv[homeFlag + 1];

/** Every session log file under one root. */
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
  return files.sort();
}

/** Parse one decompressed log into its header and events. */
function readLog(file) {
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
  return { header, events };
}

const fold = createFold();
const files = sessionFiles(join(home, 'sessions'));
for (const file of files) {
  const { header, events } = readLog(file);
  foldSession(fold, header ?? {}, events);
}
const payload = finishFold(fold, Date.now());

if (json) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  const compact = (value) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  console.log(`logs                 ${files.length}`);
  console.log(`total tokens         ${payload.totals.totalTokens} (${compact(payload.totals.totalTokens)})`);
  console.log(`  input              ${payload.totals.inputTokens}`);
  console.log(`  output             ${payload.totals.outputTokens}`);
  console.log(`  cache read         ${payload.totals.cacheReadTokens}`);
  console.log(`  cache write        ${payload.totals.cacheWriteTokens}`);
  console.log(`requests             ${payload.totals.requests}`);
  console.log(`peak day             ${payload.peakDay?.date} ${payload.peakDay?.totalTokens}`);
  console.log(`longest session      ${Math.round((payload.longestSession?.durationMs ?? 0) / 60000)} min`);
  console.log(`streak current/max   ${payload.currentStreakDays} / ${payload.longestStreakDays}`);
  console.log(`first/last activity  ${payload.firstActivity} .. ${payload.lastActivity}`);
  console.log(`window               ${payload.window.from} .. ${payload.window.to} (${payload.window.days} days)`);
  console.log('models');
  for (const model of payload.models) {
    console.log(`  ${model.key.padEnd(34)} total=${String(model.totalTokens).padStart(12)} in=${String(model.inputTokens).padStart(10)} out=${String(model.outputTokens).padStart(8)} cacheRead=${String(model.cacheReadTokens).padStart(12)} hit=${(model.cacheHitRate * 100).toFixed(2)}%`);
  }
}
