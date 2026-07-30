import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `scripts/require-node.mjs` gates `make inspect`.
 *
 * It exists because `package.json`'s `engines` field is advisory — npm warns
 * and installs anyway — so nothing was stopping a reader on an older Node
 * from getting a cryptic `Unknown file extension ".ts"` an hour later. See
 * that file's header for why this is not `engine-strict=true`.
 *
 * It is driven as a SUBPROCESS rather than imported. Two reasons: it is a
 * `.mjs` file with no type declarations, so a `.ts` test cannot import it
 * without a `.d.mts` companion (the same problem `scripts/test-count-verdict.ts`
 * discusses in its own header, solved there by being `.ts`); and what
 * actually has to work is the exit code and the message a person sees, which
 * only running it can check. It takes the version to judge as `argv[2]`
 * precisely so this test can hand it versions this machine is not running.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = `${repoRoot}/scripts/require-node.mjs`;

function run(version: string): { status: number; out: string } {
  try {
    const out = execFileSync('node', [SCRIPT, version], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, out };
  } catch (err) {
    const e = err as { status?: number; stderr?: string; stdout?: string };
    return { status: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('require-node', () => {
  it('refuses a Node below the floor, and says what to do about it', () => {
    const { status, out } = run('20.11.0');
    expect(status).toBe(1);
    expect(out).toContain('Node 20.11.0');
    expect(out).toContain('22.18.0');
    // A refusal that does not say how to fix itself is just an obstacle.
    expect(out).toMatch(/nodejs\.org|brew/);
    // And it must not overstate what it is gating: the site runs fine below
    // this floor, only `make inspect` does not.
    expect(out).toContain('make inspect');
  });

  it('accepts the floor exactly, and anything above it', () => {
    for (const version of ['22.18.0', '22.18.4', '22.20.0', '24.0.0', '25.8.2']) {
      expect(run(version).status, version).toBe(0);
    }
  });

  it('refuses the versions just below the floor, including the same major', () => {
    for (const version of ['22.17.9', '22.6.0', '21.7.3', '18.20.0']) {
      expect(run(version).status, version).toBe(1);
    }
  });

  it('reads the floor from package.json rather than carrying a second copy', () => {
    const pkg = JSON.parse(readFileSync(`${repoRoot}/package.json`, 'utf8')) as {
      engines?: { node?: string };
    };
    const floor = pkg.engines?.node ?? '';
    // The shape the script understands. If this ever stops being a bare
    // `>=X.Y.Z`, the script fails loudly rather than passing by default —
    // that is the point of the assertion, not a formatting preference.
    expect(floor).toMatch(/^>=\d+\.\d+\.\d+$/);
    const bare = floor.replace('>=', '');
    expect(run(bare).status).toBe(0);
    expect(run(`${bare.split('.')[0]}.0.0`).status).toBe(1);
  });
});
