#!/usr/bin/env node
// Refuses, legibly, when the running Node is below this project's floor.
//
// WHY THIS EXISTS, AND WHY IT IS NOT `engine-strict`.
//
// `package.json`'s `engines` field is ADVISORY. npm prints `npm warn
// EBADENGINE` and installs anyway — verified on Node v25.8.2 by setting the
// floor to `>=99.0.0`: three warning lines, then "up to date", exit 0. The
// README claimed for several versions that the field "enforces" the floor.
// It does not, and a non-JS reader who trusts that sentence gets a warning
// buried in install output followed, much later, by `make inspect` dying
// with `Unknown file extension ".ts"`.
//
// The obvious fix is a committed `.npmrc` with `engine-strict=true`, which
// does make `npm install` refuse (also verified). It was rejected on two
// measurements:
//
//   1. `engine-strict` enforces EVERY package's engines, not ours. 90
//      installed packages declare `engines.node`, and 19 of them declare a
//      disjunction with a gap — jsdom, vite, vitest and friends all say
//      `^20.19.0 || ^22.12.0 || >=24.0.0`. On Node 23 (which clears this
//      project's own floor of 22.18) `npm install` would be refused outright
//      by a transitive dependency's opinion. That is the "blocks someone for
//      no real reason" case, and it is not hypothetical.
//   2. The 22.18 floor belongs to ONE command. It is set by
//      `scripts/inspect-media.ts`, which Node runs as TypeScript with no
//      build step — unflagged type-stripping arrived in 22.18. `make dev`
//      and `make build` run fine on Node 20.19 (vite's own floor). Blocking
//      an install that would have worked, for a command the reader may never
//      run, is the wrong trade.
//
// So the gate sits exactly where the requirement is: `make inspect` runs
// this first. npm stays advisory and the README now says so.
//
// Plain `.mjs`, and deliberately dependency-free and syntax-conservative:
// this has to run on the OLD Node it exists to reject. A `.ts` file could
// not — Node below 22.6 cannot execute one at all, so the check would never
// get the chance to print its message.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Parse a `>=X.Y.Z` range into a comparable triple.
 *
 * Deliberately handles ONE shape and returns null for anything else, rather
 * than reaching for semver. A range this script cannot read must not be
 * silently treated as satisfied — see `verdictForNode`, which turns null
 * into a failure that names the problem.
 */
export function parseFloor(range) {
  const match = /^\s*>=\s*(\d+)\.(\d+)\.(\d+)\s*$/.exec(range ?? '');
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** `1.2.3-nightly` → [1, 2, 3]; null when it is not a version at all. */
export function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Whether `version` meets `range`, and what to print if it does not.
 *
 * Kept pure and exported so `tests/require-node.test.ts` can drive it over
 * versions this machine is not running.
 */
export function verdictForNode(range, version) {
  const floor = parseFloor(range);
  if (floor === null) {
    return {
      ok: false,
      message:
        `require-node: package.json's engines.node is "${range}", which this check cannot read.\n` +
        '  It understands ">=X.Y.Z" and nothing else, on purpose: a range it cannot read\n' +
        '  must fail rather than pass by default. Simplify the range, or teach\n' +
        '  scripts/require-node.mjs the new shape.',
    };
  }

  const running = parseVersion(version);
  if (running === null) {
    return {
      ok: false,
      message: `require-node: could not read a version number out of "${version}".`,
    };
  }

  const floorText = floor.join('.');
  for (let i = 0; i < 3; i++) {
    if (running[i] > floor[i]) break;
    if (running[i] < floor[i]) {
      return {
        ok: false,
        message:
          `\nmeanwhile needs Node ${floorText} or newer. This is Node ${running.join('.')}.\n\n` +
          '  `make inspect` runs scripts/inspect-media.ts as TypeScript with no build\n' +
          `  step, which Node only does without a flag from ${floorText} on.\n\n` +
          '  Install a newer Node from https://nodejs.org/, or with:  brew upgrade node\n\n' +
          '  (The site itself — `make dev`, `make build` — does not need this; only\n' +
          '  `make inspect` does.)\n',
      };
    }
  }

  return {
    ok: true,
    message: `require-node: Node ${running.join('.')} meets the ${floorText} floor. OK.`,
  };
}

function main() {
  // The floor is read from package.json rather than written here, so there
  // is one place to change it and no second copy to go stale.
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  // argv[2] lets the test drive versions this machine is not running.
  const version = process.argv[2] ?? process.versions.node;
  const verdict = verdictForNode(packageJson.engines?.node, version);

  if (!verdict.ok) {
    console.error(verdict.message);
    process.exit(1);
  }
  if (process.argv[2]) console.log(verdict.message);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
