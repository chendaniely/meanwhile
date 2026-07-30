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

describe('verdictForTestCount', () => {
  it('passes when the documented count matches the actual count', () => {
    const verdict = verdictForTestCount('the race. **479 tests pass** (`make check`).', 479);
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain('479');
    expect(verdict.message.toLowerCase()).toContain('matches');
  });

  it('fails when the counts disagree, and names both numbers and the line to edit', () => {
    const verdict = verdictForTestCount('the race. **479 tests pass** (`make check`).', 481);
    expect(verdict.ok).toBe(false);
    // Both the stale documented number and the real number must appear...
    expect(verdict.message).toContain('479');
    expect(verdict.message).toContain('481');
    // ...and the message must say what to change, not just that something's
    // wrong: a failure that doesn't name the fix wastes the reader's time.
    expect(verdict.message).toContain('Update the "479 tests pass" line in CLAUDE.md to 481');
  });

  it('fails with the "could not find" message when no "**NNN tests pass**" line exists', () => {
    const verdict = verdictForTestCount('This file mentions no test count at all.', 479);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('could not find');
    // It must not silently pass just because there was nothing to compare.
    expect(verdict.message).not.toContain('undefined');
    expect(verdict.message).not.toContain('NaN');
  });

  it('matches the real CLAUDE.md line, so the regex has not drifted from the format it checks', () => {
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    const claudeMd = readFileSync(`${repoRoot}/CLAUDE.md`, 'utf8');
    const match = claudeMd.match(TEST_COUNT_PATTERN);
    expect(match).not.toBeNull();
    // Sanity: what matched is actually a number, not stray punctuation.
    expect(Number.isInteger(Number(match?.[1]))).toBe(true);
  });
});
