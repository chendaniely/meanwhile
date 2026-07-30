#!/usr/bin/env node
// Confirms CLAUDE.md's "**NNN tests pass**" line matches the suite it
// describes. That number has gone stale four separate times across this
// project's history — each time by hand, each time forgotten a commit or
// two later. This makes it self-correcting: `make check` fails loudly
// instead of shipping a wrong number silently.
//
// Plain JS, not TypeScript: this only runs from `make check`/CI, never
// bundled or imported, so there is no reason to route it through Node's
// type-stripping at all.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// The JSON reporter gives an exact, machine-read count. Scraping the human
// reporter's text ("Tests  475 passed (475)") would be one reporter-format
// change away from silently breaking this check.
let report;
try {
  const stdout = execFileSync('npx', ['vitest', 'run', '--reporter=json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  report = JSON.parse(stdout);
} catch (err) {
  console.error('check-test-count: could not get a test count from vitest.');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const actual = report.numPassedTests;

const claudeMdPath = new URL('../CLAUDE.md', import.meta.url);
const claudeMd = readFileSync(claudeMdPath, 'utf8');
const match = claudeMd.match(/\*\*(\d+) tests pass\*\*/);

if (!match) {
  console.error(
    'check-test-count: could not find a "**NNN tests pass**" line in CLAUDE.md to check.',
  );
  process.exit(1);
}

const documented = Number(match[1]);

if (documented !== actual) {
  console.error(
    `check-test-count: CLAUDE.md says "${documented} tests pass" but the suite actually ` +
      `has ${actual} passing. Update the "${documented} tests pass" line in CLAUDE.md to ${actual}.`,
  );
  process.exit(1);
}

console.log(`check-test-count: CLAUDE.md's "${documented} tests pass" matches the suite. OK.`);
