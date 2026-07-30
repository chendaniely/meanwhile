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
// symmetry with check-test-count.mjs, but a same-named `.d.mts` companion
// declaration file (needed so the `.ts` test file that imports this can
// type-check the import) would be silently excluded by `.gitignore`'s
// blanket `*.mts`/`*.MTS` (there for AVCHD camera video, not source code),
// so it would never make it into git.
//
// Same constraint as inspect-media.ts: no TS parameter properties, no
// `enum` — Node's type-stripping can erase type annotations but not those,
// since they carry real runtime behavior.

// Exported so a test can assert this regex still matches CLAUDE.md's actual
// line, guarding against the two drifting apart silently.
export const TEST_COUNT_PATTERN = /\*\*(\d+) tests pass\*\*/;

export interface TestCountVerdict {
  ok: boolean;
  message: string;
}

export function verdictForTestCount(claudeMdText: string, actualCount: number): TestCountVerdict {
  const match = claudeMdText.match(TEST_COUNT_PATTERN);

  if (!match) {
    return {
      ok: false,
      message:
        'check-test-count: could not find a "**NNN tests pass**" line in CLAUDE.md to check.',
    };
  }

  const documented = Number(match[1]);

  if (documented !== actualCount) {
    return {
      ok: false,
      message:
        `check-test-count: CLAUDE.md says "${documented} tests pass" but the suite actually ` +
        `has ${actualCount} passing. Update the "${documented} tests pass" line in CLAUDE.md to ${actualCount}.`,
    };
  }

  return {
    ok: true,
    message: `check-test-count: CLAUDE.md's "${documented} tests pass" matches the suite. OK.`,
  };
}
