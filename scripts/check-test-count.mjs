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
//
// This file is the IO shell only — spawn vitest, read CLAUDE.md off disk.
// The decision (given CLAUDE.md's text and a count, what's the verdict and
// message) is `verdictForTestCount` in test-count-verdict.ts, kept pure so
// it can be unit-tested without either IO step. See
// tests/check-test-count.test.ts. `.ts`, not `.mjs`, per that file's own
// header — Node runs it directly via its native type-stripping, same as
// `scripts/inspect-media.ts`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verdictForTestCount } from './test-count-verdict.ts';

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

const verdict = verdictForTestCount(claudeMd, actual);

if (!verdict.ok) {
  console.error(verdict.message);
  process.exit(1);
}

console.log(verdict.message);
