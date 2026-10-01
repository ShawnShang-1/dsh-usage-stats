/**
 * Package entry for the usage statistics host half.
 *
 * The Loader mounts `./entry.js` (the profile's bundle patch names it
 * directly), which re-imports `./host.js` by file revision. This file only
 * keeps the package's `main` export meaningful for anything that imports the
 * package by name.
 *
 * @module dsh-usage-stats
 */

export * from './entry.js';
