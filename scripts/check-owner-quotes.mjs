#!/usr/bin/env node
// Confirms every owner quote this repository's markdown prints is actually
// in PROMPTS.md, verbatim, as one contiguous run inside ONE prompt.
//
// EVERY TRACKED `.md` FILE IS CHECKED, not just CLAUDE.md. The first two
// versions read CLAUDE.md alone, which was where the decision record lives
// and so where the quoting was densest — but `CHANGELOG.md` pairs every
// release with the prompt that asked for it (24 citations), `README.md` and
// `TODO.md` quote the owner too, and none of that was covered. The 2026-07-30
// gate widened it to `git ls-files '*.md'` and immediately found an
// unsourced quote in `TODO.md` that had been there since the UI pass. Only
// PROMPTS.md itself is skipped: it is the source of truth, so checking it
// against itself is vacuous.
//
// Why this exists. CLAUDE.md's decision record quotes the owner constantly,
// and PROMPTS.md is the append-only verbatim log those quotes are supposed
// to come from. Nothing kept the two honest, and three separate failure
// modes had accumulated by the 2026-07-30 pre-release gate:
//
//   (a) a quote with no source at all — said out loud, never logged, or
//       simply invented as a framing sentence around a real one;
//   (b) a SPLICED quote — two fragments of two different prompts joined
//       with no elision marker, presented as one thing the owner said;
//   (c) a silently corrected typo. The owner writes "tehre" and "rememer";
//       tidying those up in CLAUDE.md makes the quote no longer a quote.
//
// The first pass at this check only looked at `> ` blockquotes and so
// missed CLAUDE.md's OTHER convention entirely — the inline italic form,
// `*"…"*` — which is where ALL FOUR of the surviving bad quotes were
// hiding. Both conventions are covered here. See WHAT COUNTS AS A QUOTE
// below.
//
// Plain JS, not TypeScript, and self-contained: same reasoning as
// check-test-count.mjs — this only ever runs from `make check`/CI, is never
// bundled or imported by the app, and needs no types beyond what a reader
// can see. (check-test-count.mjs splits its pure half into
// test-count-verdict.ts so a unit test can reach it; do the same here if a
// test is ever added, and the exported functions below are already shaped
// for it.)
//
// ---------------------------------------------------------------------
// WHAT COUNTS AS A QUOTE
// ---------------------------------------------------------------------
// Two conventions, derived by reading every candidate in CLAUDE.md rather
// than assumed:
//
//   1. BLOCKQUOTE — a contiguous run of lines starting with `>`. In
//      CLAUDE.md and CHANGELOG.md these are almost all owner prompts. In
//      README.md and under docs/ a blockquote is markdown's only admonition
//      syntax, so most of them are callouts rather than citations; the
//      allowlist carves those out one at a time, with a reason each.
//
//   2. INLINE ITALIC — `*"…"*` (also `_"…"_`, and smart quotes). Mostly
//      owner quotes; a handful quote a message the app itself prints or a
//      button in somebody else's product.
//
// NARROWING (1) TO "BLOCKQUOTES THAT OPEN WITH A QUOTATION MARK" WAS TRIED
// AND REJECTED ON EVIDENCE. It looked clean — it would have retired most of
// the allowlist below in one line — but measured across every tracked `.md`
// file it silently drops a real citation: `CLAUDE.md`'s consistency-pass
// quote opens with the elision marker `[...]` and only then the quote mark.
// One silent miss is the failure this script exists to prevent, and a rule
// that is 98% right is exactly how the inline-italic convention went
// unchecked for two versions. The dumb superset plus written-down exceptions
// fails loud instead, and the tax is one allowlist entry per new admonition.
//
// The rule for (2) is deliberately DUMB: every inline italic double-quoted
// span is treated as a claim to quote, and the short allowlist below carves
// out the ones that are not, each with a reason. The alternative — deciding
// from the introducing phrase, since owner quotes are led in by "The
// owner:", "at the owner's request:", "The owner's phrase was", "who asked
// to", "and then said:" — was tried and rejected: that list is open-ended,
// a new phrasing silently drops a quote out of the check, and silently
// missing a real quote is exactly the failure this script exists to stop.
// Flagging a superset and writing down the exceptions fails loud instead.
//
// A third convention exists in CLAUDE.md and is NOT checked here: a bare
// `"…"` span attributed by the surrounding prose ("The owner's phrase was
// …"). Detecting those needs precisely the introducing-phrase guesswork
// rejected above, and CLAUDE.md uses bare double quotes for dozens of
// non-quotes (UI labels, field names, error strings), so there is no dumb
// superset to fall back on either. Left out on purpose — but not left
// unexamined: there were three such attributed bare quotes in CLAUDE.md
// when this was written ("saved in metadata of the file,", "we can pin this
// later.", "re-create bits of the strava/garmin interface"), and all three
// were checked against PROMPTS.md by hand and matched.
//
// ---------------------------------------------------------------------
// WHAT IS NORMALISED, AND WHAT IS NOT
// ---------------------------------------------------------------------
// Normalised (both sides), because these are transcription artefacts of
// putting the same words in a markdown file twice:
//
//   - the `> ` blockquote prefix, and line wrapping: a quote wrapped at 76
//     columns in one file and 72 in the other is the same quote;
//   - runs of whitespace, collapsed to one space;
//   - smart quotes and apostrophes, folded to their straight equivalents
//     (an editor turns ' into ' without anyone deciding to);
//   - markdown emphasis asterisks, which CLAUDE.md adds INSIDE quotes to
//     stress a phrase. Underscores are NOT stripped: the owner's prose
//     contains column names like `also_known_as`, and folding those would
//     both mangle the diagnostic and let two different names match.
//
// NOT normalised, because normalising them would hide the very defects this
// checks for:
//
//   - spelling. "tehre" must stay "tehre";
//   - letter case;
//   - dashes and ellipsis characters, EXCEPT where used as an explicit
//     elision marker (below).
//
// ELISION. CLAUDE.md abbreviates long prompts with `[...]` (and `...`/`…`).
// A quote is therefore split on those markers into fragments, and every
// fragment must appear IN ONE PROMPT, IN ORDER, NON-OVERLAPPING. That
// requirement is what catches splicing (b): fragments from two prompts each
// exist somewhere, but no single prompt contains them all.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fragments shorter than this are skipped: after an elision marker a quote
// can leave behind a stub like "and" or "it's", which matches everything
// and proves nothing. A citation with no fragment at least this long
// therefore passes vacuously — accepted, because a quotation that short
// carries no claim worth checking.
const MIN_FRAGMENT_CHARS = 12;

// Quoted spans that are NOT claims to quote the owner. Keyed on the
// normalised quoted text, not a file and line, so an entry survives edits
// around it — and so that CHANGING one of these texts makes the checker flag
// it again rather than silently keeping the pass.
//
// One consequence of text-keying, now that every tracked `.md` is scanned:
// an entry exempts that text in ANY of them. That is deliberate for the
// data-quality rule, which appears verbatim in three files and is supposed
// to — the entry is what says so. It is a mild weakening everywhere else,
// accepted because the alternative (keying on file + text) would need three
// near-identical entries for that one rule and a per-file staleness tally,
// and because every exemption here is written down where a reader can
// disagree with it.
export const ALLOWLIST = [
  {
    text: 'AirDrop, a shared Drive/Dropbox folder, or a Google Photos album. Never iMessage, WhatsApp, Messenger, Instagram, or Slack.',
    reason:
      "The README's data-quality rule, pulled into CLAUDE.md and the design spec as a blockquote. Not attributed to the owner. All three copies must match verbatim — a shortened paraphrase in CLAUDE.md is what the 2026-07-30 gate found — and because this entry is keyed on the text alone, it goes stale the moment any of the three drifts.",
  },
  {
    text: 'update the site, or clear the schema cell',
    reason:
      'A message the app itself prints when a notes row carries a newer schema version. Quoted as a UI string, not as something the owner said.',
  },
  {
    text: 'Download all',
    reason:
      "Google Photos' own button label, quoted so a reader can find it in that product's UI. Appears in README.md and the design spec.",
  },
  {
    text: "Status: working, but not finished. Point it at a folder and you get a chronological feed and a swimlane view of everyone's photos and video, croppable to the part of the event you care about. Drop a GPX or TCX in too and a course view appears — a real topographic map with the elevation, heart rate, cadence and pace charts underneath. The moment grid isn't built yet. See [Running it](#running-it).",
    reason:
      "README.md's status callout. A blockquote used as markdown's only admonition syntax, written by Claude about the project — not a citation of anything.",
  },
  {
    text: "Open the activity on strava.com and add `/export_tcx` to the address: `https://www.strava.com/activities/<id>/export_tcx` The ⋯ → Export GPX menu item also works, if you don't need the heart-rate data.",
    reason: "README.md admonition: instructions for the reader, not a quotation.",
  },
  {
    text: "Chrome or Edge specifically, for now. Reading a folder off your own disk uses a browser feature Safari and Firefox don't have yet. That only affects building a timeline on your own machine — once a timeline points at photos on the web, any browser can open it.",
    reason: "README.md admonition explaining the browser limit. Not a quotation.",
  },
  {
    text: "I'm putting everyone's photos from the race onto one shared timeline, so we can see what each of us was doing at the same moments. For it to work I need the original files, because the timestamp inside them is what places each photo. Sending them through WhatsApp, iMessage, Messenger or Instagram strips that out and the photo can't be used. Easiest ways that keep it intact: - AirDrop them to me (iPhone/Mac) - Drop them in the shared Drive/Dropbox folder - Add them to the shared Google Photos album Videos too, please. And don't worry about picking the good ones — send everything, it's easier to leave things out later than to chase them down.",
    reason:
      'A sample message README.md offers the reader to send their own crew. Written by Claude for them to copy, not something anyone said.',
  },
  {
    text: 'For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.',
    reason:
      'Boilerplate the plan template writes at the top of every plan document, addressed to the agent executing it.',
  },
  {
    text: 'Blank is the normal case',
    reason:
      "The notes-as-csv design spec quoting its own column documentation a few lines above, to point back at it.",
  },
  {
    text: 'An offset ... is wrong on either side of a daylight-saving change',
    reason:
      'The notes-as-csv design spec quoting its own earlier sentence, to carry the argument forward.',
  },
];

/**
 * Fold the transcription artefacts of writing the same words into two
 * markdown files, and nothing else. See the header for what stays.
 */
export function normalise(text) {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Contiguous runs of lines starting with `>`, with the marker stripped and
 * the lines joined — one entry per run. Used for BOTH files: it is how
 * CLAUDE.md cites a prompt and how PROMPTS.md records one.
 */
export function extractBlockquotes(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*>/.test(lines[i])) {
      if (!current) current = { line: i + 1, parts: [] };
      current.parts.push(lines[i].replace(/^\s*>\s?/, ''));
    } else if (current) {
      blocks.push({ line: current.line, lineCount: current.parts.length, raw: current.parts.join(' ') });
      current = null;
    }
  }
  if (current) {
    blocks.push({ line: current.line, lineCount: current.parts.length, raw: current.parts.join(' ') });
  }
  return blocks;
}

/**
 * Inline italic double-quoted spans: `*"…"*` or `_"…"_`, straight or smart
 * quotes, possibly wrapped across lines. The delimiter character is excluded
 * from the body so a span cannot run past the italic that closes it.
 */
export function extractInlineItalicQuotes(markdown) {
  const found = [];
  for (const [open, close, body] of [
    ['\\*', '\\*', '[^*]'],
    ['_', '_', '[^_]'],
  ]) {
    const re = new RegExp(`${open}["“](${body}*?)["”]${close}`, 'gs');
    let match;
    while ((match = re.exec(markdown)) !== null) {
      found.push({
        line: markdown.slice(0, match.index).split('\n').length,
        raw: match[1],
      });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/** Strip the surrounding quotation marks a citation carries, if any. */
function unquote(text) {
  return text
    .replace(/^\s*["“]/, '')
    .replace(/["”]\s*[.,]?\s*$/, '')
    .trim();
}

/**
 * Split a citation on its elision markers into the fragments that must each
 * be found. `[...]`, `[…]`, a bare `…`, and ` ... ` between spaces all mean
 * "words omitted here"; a `...` with no space before it is ordinary prose
 * and is left alone.
 */
export function fragmentsOf(quotedText) {
  return unquote(quotedText)
    .split(/\[\s*(?:\.\.\.|…)\s*\]|\s\.\.\.\s|…/)
    .map((fragment) => normalise(fragment).replace(/^[,.;:'"\s]+|[,.;:'"\s]+$/g, ''))
    .filter((fragment) => fragment.length >= MIN_FRAGMENT_CHARS);
}

/**
 * The longest run of leading WORDS of `fragment` that appears in some
 * prompt. A bare "this 120-character string is not in PROMPTS.md" is not
 * actionable — a corrected typo, a paraphrase and a splice all look
 * identical. Reporting where the two texts stop agreeing points straight at
 * the edit: "…so we need to" / then diverges, and the word after it is the
 * one CLAUDE.md changed.
 */
export function divergencePoint(fragment, prompts) {
  const words = fragment.split(' ');
  let matched = 0;
  for (let take = 1; take <= words.length; take++) {
    const prefix = words.slice(0, take).join(' ');
    if (!prompts.some((prompt) => prompt.includes(prefix))) break;
    matched = take;
  }
  // One or two words in common is every English sentence agreeing with every
  // other; printing that as a divergence point is noise, not a pointer.
  if (matched < 4) return null;
  return {
    matched: words.slice(0, matched).join(' '),
    divergesAt: words.slice(matched, matched + 6).join(' '),
  };
}

/**
 * The verdict for one citation. `ok` when some single prompt contains every
 * fragment, in order and without overlap. When that fails, `missing` names
 * the fragments that appear in no prompt at all — an empty `missing` with
 * `ok: false` is the signature of a SPLICE, every piece real but assembled
 * from more than one prompt.
 */
export function checkCitation(quotedText, prompts) {
  const fragments = fragmentsOf(quotedText);
  if (fragments.length === 0) return { ok: true, fragments, missing: [], spliced: false };

  const containedByAny = (fragment) => prompts.some((prompt) => prompt.includes(fragment));
  const missing = fragments.filter((fragment) => !containedByAny(fragment));

  const ok = prompts.some((prompt) => {
    let cursor = 0;
    for (const fragment of fragments) {
      const at = prompt.indexOf(fragment, cursor);
      if (at === -1) return false;
      cursor = at + fragment.length;
    }
    return true;
  });

  return { ok, fragments, missing, spliced: !ok && missing.length === 0 };
}

/** Every citation in CLAUDE.md, tagged with the convention it uses. */
export function citationsOf(claudeMd) {
  const blockquotes = extractBlockquotes(claudeMd).map((b) => ({ ...b, kind: 'blockquote' }));
  // The italic scan must not re-report an italicised phrase that sits inside
  // a blockquote already being checked as a whole.
  const blockLines = new Set();
  for (const b of blockquotes) {
    for (let i = 0; i < b.lineCount; i++) blockLines.add(b.line + i);
  }
  const inline = extractInlineItalicQuotes(claudeMd)
    .filter((q) => !blockLines.has(q.line))
    .map((q) => ({ ...q, kind: 'inline-italic' }));
  return [...blockquotes, ...inline].sort((a, b) => a.line - b.line);
}

/**
 * `sources` is `[{ path, text }]` — every tracked markdown file except
 * PROMPTS.md, which is the log being checked against.
 */
export function runCheck(sources, promptsMd) {
  const prompts = extractBlockquotes(promptsMd).map((b) => normalise(b.raw));
  const allowed = new Map(ALLOWLIST.map((entry) => [normalise(entry.text), entry]));
  const usedAllowances = new Set();

  const counts = { blockquote: 0, 'inline-italic': 0 };
  const skipped = { blockquote: 0, 'inline-italic': 0 };
  const failures = [];
  /** Per-file tally, so the summary says which files actually carry quotes. */
  const perFile = new Map();

  for (const { path, text } of sources) {
    for (const citation of citationsOf(text)) {
      const normalised = normalise(unquote(citation.raw));
      if (allowed.has(normalised)) {
        usedAllowances.add(normalised);
        skipped[citation.kind]++;
        continue;
      }
      counts[citation.kind]++;
      perFile.set(path, (perFile.get(path) ?? 0) + 1);
      const verdict = checkCitation(citation.raw, prompts);
      if (verdict.ok) continue;
      failures.push({
        file: path,
        ...citation,
        ...verdict,
        divergences: verdict.missing.map((fragment) => ({
          fragment,
          ...(divergencePoint(fragment, prompts) ?? { matched: null, divergesAt: null }),
        })),
      });
    }
  }

  // An allowlist entry that no longer matches anything is an exemption
  // nobody can see the effect of, and the next quote worded like it would
  // inherit the exemption by accident. Fail on it rather than let it rot.
  const stale = [...allowed.keys()].filter((text) => !usedAllowances.has(text));

  return { counts, skipped, failures, stale, perFile };
}

/**
 * Every tracked markdown file except PROMPTS.md.
 *
 * `git ls-files` rather than a directory walk: it is already the definition
 * of "tracked", so it inherits `.gitignore` (node_modules, dist, and the
 * owner's own media folder) for free, and a file that is not committed
 * cannot be documentation this check is responsible for. The pathspec
 * matches at any depth, so `docs/**` is covered.
 */
export function trackedMarkdown(repoRoot) {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '-z', '*.md'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // Failing loudly beats falling back to a directory walk: a fallback that
    // quietly scanned a different set of files is how a guard ends up
    // checking less than its output claims.
    throw new Error(
      "check-owner-quotes: `git ls-files` failed, so the set of files to check is unknown.\n" +
        '  This needs to run inside a git checkout (a source tarball will not do).\n' +
        `  ${err instanceof Error ? err.message : err}`,
    );
  }
  return out
    .split('\0')
    .filter((path) => path !== '' && path !== 'PROMPTS.md')
    .sort();
}

function main() {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const paths = trackedMarkdown(repoRoot);
  const sources = paths.map((path) => ({
    path,
    text: readFileSync(join(repoRoot, path), 'utf8'),
  }));
  const promptsMd = readFileSync(join(repoRoot, 'PROMPTS.md'), 'utf8');

  const { counts, skipped, failures, stale, perFile } = runCheck(sources, promptsMd);

  for (const text of stale) {
    console.error(
      `\ncheck-owner-quotes: allowlist entry no longer matches anything in any tracked\n` +
        `  markdown file:\n  "${text}"\n` +
        '  Remove it from ALLOWLIST in scripts/check-owner-quotes.mjs, or restore the text.',
    );
  }

  for (const failure of failures) {
    console.error(`\n${failure.file}:${failure.line} (${failure.kind})`);
    console.error(`  quoted: ${unquote(failure.raw).replace(/\s+/g, ' ').slice(0, 300)}`);
    if (failure.spliced) {
      console.error(
        '  SPLICED: every fragment appears in PROMPTS.md, but no single prompt',
      );
      console.error(
        '           contains them all in order — this is two prompts presented as one.',
      );
    }
    for (const { fragment, matched, divergesAt } of failure.divergences) {
      console.error(`  NOT IN PROMPTS.md: "${fragment}"`);
      if (matched === null) continue;
      console.error(`    PROMPTS.md agrees up to: "...${matched.split(' ').slice(-8).join(' ')}"`);
      // The file, not a hardcoded "CLAUDE.md": every tracked markdown file is
      // checked now, and naming the wrong one sends the reader to the wrong
      // place with a confident-looking diagnostic.
      console.error(
        `    then ${failure.file} has:${' '.repeat(Math.max(1, 16 - failure.file.length))}"${divergesAt} ..."`,
      );
    }
  }

  const total = counts.blockquote + counts['inline-italic'];
  const contributors = [...perFile.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([path, n]) => `${path} ${n}`)
    .join(', ');
  const summary =
    `check-owner-quotes: ${total} owner quotes checked across ${paths.length} tracked ` +
    `markdown files ` +
    `(${counts.blockquote} blockquote, ${counts['inline-italic']} inline italic; ` +
    `${skipped.blockquote + skipped['inline-italic']} allowlisted), ` +
    `${failures.length} unverified${stale.length > 0 ? `, ${stale.length} stale allowlist entries` : ''}.` +
    (contributors ? `\n  quotes by file: ${contributors}` : '');

  if (failures.length > 0 || stale.length > 0) {
    console.error(`\n${summary}`);
    console.error(
      'Every quote in this repository must appear in PROMPTS.md verbatim, typos intact,\n' +
        'as one contiguous run inside a single prompt. Fix the file to match the log,\n' +
        'or — only if the owner really said it and it was never logged — append it to\n' +
        'PROMPTS.md, which is append-only. If the span is not a citation at all (a\n' +
        'README admonition, a UI string, somebody else’s button label), add it to\n' +
        'ALLOWLIST in this script with a reason.',
    );
    process.exit(1);
  }

  console.log(`${summary} OK.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
