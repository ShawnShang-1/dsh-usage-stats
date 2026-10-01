/**
 * Loader entry for the usage statistics host half.
 *
 * This file is deliberately tiny and stable. The vendored Loader keeps Node's
 * ESM module cache, so a row whose specifier never changes keeps executing the
 * module it first imported — editing the implementation in a running process
 * would otherwise change nothing.
 *
 * `apply` therefore digests the file metadata of every implementation module (`host.js`, `fold.js`, `pricing.js`)
 * and imports `host.js` through that digest, and `host.js` passes the same
 * query on to `fold.js`. One edit anywhere in the implementation is a fresh
 * module graph on the next activation, with no manual bump.
 *
 * @module dsh-usage-stats/lib/entry
 */

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';

/** Loader row identity this plugin's config is addressed by. */
export const name = 'usage-stats';

/** Required services. */
export const inject = ['sessionQuery', 'connection'];

/** Implementation modules whose revisions together identify one code generation. */
const GRAPH = ['./host.js', './fold.js', './pricing.js'];

/**
 * Digest the implementation graph's file metadata.
 * @returns {string} a short revision that changes whenever any graph file does.
 */
function graphRevision() {
  const hash = createHash('sha1');
  for (const name of GRAPH) {
    const stat = statSync(new URL(name, import.meta.url));
    hash.update(`${name}\u0000${Math.trunc(stat.mtimeMs)}\u0000${stat.size}\u0000`);
  }
  return hash.digest('hex').slice(0, 12);
}

/**
 * Mount the usage fold under a cache-busted implementation revision.
 * @param {object} ctx - host Cordis context.
 * @param {object} [config] - this plugin's Loader config.
 * @returns {Promise<void>} resolved once the implementation has mounted.
 */
export async function apply(ctx, config) {
  const implementation = await import(`./host.js?rev=${graphRevision()}`);
  return implementation.apply(ctx, config);
}
