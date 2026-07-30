import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TEST_COUNT_PATTERN, verdictForTestCount } from '../scripts/test-count-verdict.ts';

/**
 * `scripts/check-test-count.mjs` gates `make check` and CI. Its risk isn't
 * "does it run" — it's the regex and the comparison: if the CLAUDE.md
 * format drifts, the check must fail LOUDLY ("could not find") rather than
 * silently passing. `verdictForTestCount` is the pure decision extracted
 * from that script (the IO — spawning vitest, reading CLAUDE.md off disk —
 * stays in the script) so the decision can be tested directly.
 */

/** The healthy case: everything ran, nothing was skipped. */
const clean = (passed: number) => ({ passed, skipped: 0, todo: 0 });

describe('verdictForTestCount', () => {
  it('passes when the documented count matches the actual count', () => {
    const verdict = verdictForTestCount('the race. **479 tests pass** (`make check`).', clean(479));
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain('479');
    expect(verdict.message.toLowerCase()).toContain('matches');
  });

  it('fails when the counts disagree, and names both numbers and the line to edit', () => {
    const verdict = verdictForTestCount('the race. **479 tests pass** (`make check`).', clean(481));
    expect(verdict.ok).toBe(false);
    // Both the stale documented number and the real number must appear...
    expect(verdict.message).toContain('479');
    expect(verdict.message).toContain('481');
    // ...and the message must say what to change, not just that something's
    // wrong: a failure that doesn't name the fix wastes the reader's time.
    expect(verdict.message).toContain('Update the "479 tests pass" line in CLAUDE.md to 481');
  });

  it('fails with the "could not find" message when no "**NNN tests pass**" line exists', () => {
    const verdict = verdictForTestCount('This file mentions no test count at all.', clean(479));
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('could not find');
    // It must not silently pass just because there was nothing to compare.
    expect(verdict.message).not.toContain('undefined');
    expect(verdict.message).not.toContain('NaN');
  });

  it('matches the real CLAUDE.md line, so the regex has not drifted from the format it checks', () => {
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    const claudeMd = readFileSync(`${repoRoot}/CLAUDE.md`, 'utf8');
    const matches = [...claudeMd.matchAll(TEST_COUNT_PATTERN)];
    expect(matches.length).toBe(1);
    // Sanity: what matched is actually a number, not stray punctuation.
    expect(Number.isInteger(Number(matches[0]?.[1]))).toBe(true);
  });

  // -------------------------------------------------------------------
  // The two ways this check could be satisfied without being true. Both
  // were live until the 2026-07-30 gate; each is a way to keep the number
  // in CLAUDE.md honest while the thing it describes quietly rots.
  // -------------------------------------------------------------------

  it('refuses a skipped test even when the documented count still matches', () => {
    // The exact cheat: `.skip` a test, drop CLAUDE.md's number by one.
    // `numPassedTests` excludes it, so the arithmetic works out and the
    // coverage is gone.
    const verdict = verdictForTestCount('the race. **478 tests pass** (`make check`).', {
      passed: 478,
      skipped: 1,
      todo: 0,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('1 skipped');
    expect(verdict.message.toLowerCase()).toContain('not a passing test');
  });

  it('refuses a todo test, and counts skipped and todo separately', () => {
    const verdict = verdictForTestCount('the race. **470 tests pass** (`make check`).', {
      passed: 470,
      skipped: 2,
      todo: 3,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('2 skipped');
    expect(verdict.message).toContain('3 todo');
  });

  it('refuses a second "**NNN tests pass**" line rather than checking only the first', () => {
    // The first version read `String.match` without the global flag, so a
    // stale second copy could disagree forever behind a green check.
    const verdict = verdictForTestCount(
      'the race. **479 tests pass** (`make check`).\n\nBack at M11, **462 tests pass**.',
      clean(479),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('2');
    // It must name both numbers so the reader can see which one is stale.
    expect(verdict.message).toContain('479');
    expect(verdict.message).toContain('462');
  });

  it('does not let a stale second line pass by matching the count in either position', () => {
    // Same shape, but the STALE number is first — the case the old
    // first-match-only read would have failed on for the wrong reason, and
    // the case a last-match-only read would miss.
    const verdict = verdictForTestCount(
      'Back at M11, **462 tests pass**.\n\nToday **479 tests pass** (`make check`).',
      clean(479),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('exactly one');
  });
});
