// The pure half of check-test-count.mjs: given CLAUDE.md's text and an
// actual test count, decide the verdict and the message to print. Split out
// so it can be unit-tested directly — the shell script does IO (spawn
// vitest, read CLAUDE.md off disk) that a test would otherwise have to fake
// its way around. See tests/check-test-count.test.ts.
//
// A `.ts` file, not `.mjs` like the script that imports it: this needs real
// types (the verdict shape), and `scripts/inspect-media.ts` is already the
// precedent for a TypeScript file under `scripts/` that Node runs directly
// via its native type-stripping — no build step. `.mjs` was considered for
// symmetry with check-test-count.mjs, but would need a same-named `.d.mts`
// companion declaration file so the `.ts` test file that imports this can
// type-check the import. `.gitignore` has a blanket `*.mts`/`*.MTS` (there
// for AVCHD camera video, not source code); `383dd9e` added path negations
// (`!/scripts/**/*.mts` and three siblings) that rescue TypeScript's own
// `.mts` files under `src/`, `scripts/`, `tests/`, and the repo root, so a
// `.d.mts` here would in fact reach git today (verified: `git check-ignore
// -q --no-index scripts/test-count-verdict.d.mts` exits 1, not ignored).
// The choice stands on its other grounds regardless — one file, one runtime,
// no build step — this just isn't one of them anymore.
//
// Same constraint as inspect-media.ts: no TS parameter properties, no
// `enum` — Node's type-stripping can erase type annotations but not those,
// since they carry real runtime behavior.

// Exported so a test can assert this regex still matches CLAUDE.md's actual
// line, guarding against the two drifting apart silently.
//
// GLOBAL, and every occurrence is checked. The first version matched only
// the first one, so a second "**N tests pass**" anywhere else in CLAUDE.md —
// a stale figure left in a decision-record entry, say — could sit there
// wrong forever while the check stayed green. There is one such line and
// there should be exactly one: a count repeated in two places is a count
// that will disagree with itself.
export const TEST_COUNT_PATTERN = /\*\*(\d+) tests pass\*\*/g;

/**
 * What vitest's JSON reporter reports. `passed` alone is not the suite:
 * `numPassedTests` EXCLUDES skipped and todo tests, so marking a test
 * `.skip` and decrementing the number in CLAUDE.md used to pass this check
 * while silently dropping the coverage it claims.
 */
export interface TestCounts {
  passed: number;
  skipped: number;
  todo: number;
}

export interface TestCountVerdict {
  ok: boolean;
  message: string;
}

export function verdictForTestCount(
  claudeMdText: string,
  counts: TestCounts,
): TestCountVerdict {
  // A skipped test is not a passing test, and it is not a failing one either
  // — which is what makes it dangerous here. Nothing else in `make check`
  // notices it, so a `.skip` added to quiet a flake would disappear from
  // view entirely and the documented count would still be "right".
  if (counts.skipped > 0 || counts.todo > 0) {
    const parts = [
      counts.skipped > 0 ? `${counts.skipped} skipped` : null,
      counts.todo > 0 ? `${counts.todo} todo` : null,
    ].filter((p) => p !== null);
    return {
      ok: false,
      message:
        `check-test-count: the suite has ${parts.join(' and ')} test(s). A skipped test is ` +
        'not a passing test — it is coverage this project claims and does not have, and ' +
        'nothing else in `make check` would notice it. Delete it, fix it, or unskip it. ' +
        'If a skip is genuinely the right answer, say so here in ' +
        'scripts/test-count-verdict.ts rather than leaving it silent.',
    };
  }

  const matches = [...claudeMdText.matchAll(TEST_COUNT_PATTERN)];

  if (matches.length === 0) {
    return {
      ok: false,
      message:
        'check-test-count: could not find a "**NNN tests pass**" line in CLAUDE.md to check.',
    };
  }

  if (matches.length > 1) {
    const found = matches.map((m) => m[1]).join(', ');
    return {
      ok: false,
      message:
        `check-test-count: CLAUDE.md has ${matches.length} "**NNN tests pass**" lines (${found}). ` +
        'There must be exactly one — two copies of a count are two things to keep in step, ' +
        'and this check only ever repaired the first. Delete all but the current one.',
    };
  }

  const documented = Number(matches[0]![1]);

  if (documented !== counts.passed) {
    return {
      ok: false,
      message:
        `check-test-count: CLAUDE.md says "${documented} tests pass" but the suite actually ` +
        `has ${counts.passed} passing. Update the "${documented} tests pass" line in CLAUDE.md to ${counts.passed}.`,
    };
  }

  return {
    ok: true,
    message: `check-test-count: CLAUDE.md's "${documented} tests pass" matches the suite, and nothing is skipped. OK.`,
  };
}
