/**
 * Must be imported FIRST (before anything that pulls in node:sqlite):
 * node:sqlite prints an ExperimentalWarning on startup, which is pure noise
 * for CLI users. A 'warning' listener disables Node's default print, so we
 * re-emit everything except experimental warnings ourselves.
 */
process.on('warning', (w: NodeJS.ErrnoException) => {
  if (w.name === 'ExperimentalWarning') return;
  process.stderr.write(`${w.stack ?? w.message}\n`);
});
