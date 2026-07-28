import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * `src/core/` is a pure TypeScript kernel. It is imported by the viewer today
 * and by an ingest CLI later, so it must run identically under Node and in a
 * browser. That means no React, no Node APIs, and no browser globals.
 *
 * This test is load-bearing. CLAUDE.md says never weaken it. If a core module
 * seems to need something banned here, the answer is to hand-roll it or to
 * lift the impure part up into `src/viewer/` — not to add an exception.
 *
 * Concretely, two rules this has already forced:
 *   - GPX parsing cannot use DOMParser, so course.ts hand-rolls a small XML
 *     scanner. That is why the future CLI gets GPX support for free.
 *   - Metadata extraction takes an ArrayBuffer, never a File or a Blob. The
 *     browser-specific job of turning a file into bytes belongs to the viewer.
 */

const CORE_DIR = join(import.meta.dirname, '..', 'src', 'core');

const BANNED_GLOBALS = [
  // Browser / DOM
  'window',
  'document',
  'navigator',
  'location',
  'localStorage',
  'sessionStorage',
  'fetch',
  'XMLHttpRequest',
  'DOMParser',
  'Blob',
  'File',
  'FileReader',
  'URL',
  'Image',
  'HTMLElement',
  'createImageBitmap',
  'requestAnimationFrame',
  'alert',
  // Node
  'process',
  'Buffer',
  '__dirname',
  '__filename',
  'require',
];

/**
 * TextDecoder is deliberately NOT banned. It is a WHATWG Encoding global
 * present in every browser and in Node since v11 — it is not a DOM API, and
 * hand-rolling UTF-8 would be strictly worse code for no purity gain.
 */

function coreFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...coreFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * Strip comments and string literals so that the word "document" in a comment
 * or a "process the file" message does not trip the global scan. Replaces each
 * stripped span with spaces to keep byte offsets — and therefore line numbers
 * — intact.
 */
function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  const blank = (n: number) => ' '.repeat(n);

  while (i < src.length) {
    const two = src.slice(i, i + 2);

    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += blank(stop - i);
      i = stop;
    } else if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      const quote = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\') j++;
        j++;
      }
      const stop = Math.min(j + 1, src.length);
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

function importSpecifiers(code: string): string[] {
  const specs: string[] = [];
  // `import ... from 'x'`, `export ... from 'x'`, and bare `import 'x'`.
  const re = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(re)) {
    const spec = m[1] ?? m[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

describe('src/core purity', () => {
  const files = coreFiles(CORE_DIR);

  it('finds core modules to check', () => {
    // Guards against this whole suite silently passing on an empty directory.
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [relative(CORE_DIR, f), f]))(
    '%s imports only sibling core modules',
    (_name, file) => {
      // Import specifiers are read from the raw source: stripping strings
      // would erase them.
      const specs = importSpecifiers(readFileSync(file, 'utf8'));
      const bare = specs.filter((s) => !s.startsWith('./') && !s.startsWith('../'));
      expect(
        bare,
        `core must not depend on packages or builtins; found ${bare.join(', ')}`,
      ).toEqual([]);
    },
  );

  it.each(files.map((f) => [relative(CORE_DIR, f), f]))(
    '%s uses no host globals',
    (_name, file) => {
      const code = stripCommentsAndStrings(readFileSync(file, 'utf8'));
      const found = BANNED_GLOBALS.filter((g) =>
        // Not preceded by `.` or a word char, so `this.window` and
        // `myLocation` do not match, but a bare `window` does.
        new RegExp(String.raw`(?<![.\w$])${g}\b`).test(code),
      );
      expect(
        found,
        `core must run under both Node and the browser; found ${found.join(', ')}`,
      ).toEqual([]);
    },
  );
});
