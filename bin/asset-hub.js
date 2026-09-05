#!/usr/bin/env node
'use strict';
/**
 * `asset-hub` executable launcher.
 *
 * The core uses node:sqlite (Node 22+). Node prints an ExperimentalWarning
 * banner to stderr for it on every run; the banner bypasses the JS
 * 'warning' event, so we re-exec once with --no-warnings for clean output.
 * Set ASSET_HUB_REEXEC=0 to skip the re-exec (e.g. when debugging).
 */

// Trust the system CA bundle when one exists (corporate proxies / sandboxed
// TLS interception) — Node's bundled store misses these and every HTTPS
// provider call fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE. Same behavior as
// curl/browsers; must be set before any TLS connection is made.
if (!process.env.NODE_EXTRA_CA_CERTS) {
  try {
    require('node:fs').accessSync('/etc/ssl/certs/ca-certificates.crt');
    process.env.NODE_EXTRA_CA_CERTS = '/etc/ssl/certs/ca-certificates.crt';
  } catch { /* not present on this platform — keep Node defaults */ }
}

const path = require('node:path');
const fs = require('node:fs');

const entry = path.join(__dirname, '..', 'dist', 'cli', 'index.js');
if (!fs.existsSync(entry)) {
  console.error('asset-hub is not built yet. Run:');
  console.error('  npm install && npm run build');
  process.exit(1);
}

if (process.env.ASSET_HUB_REEXEC !== '0' && !process.execArgv.includes('--no-warnings')) {
  const { spawnSync } = require('node:child_process');
  const res = spawnSync(
    process.execPath,
    ['--no-warnings', entry, ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, ASSET_HUB_REEXEC: '0' } },
  );
  process.exit(res.status ?? (res.error ? 1 : 0));
}
require(entry);
