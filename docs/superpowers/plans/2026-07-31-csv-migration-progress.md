# CSV migration — where the build stopped

**Read this before touching the CSV work.** The design is
`docs/superpowers/specs/2026-07-31-event-as-csv-set-design.md` (v6). This file
is only *where we got to* and *what will waste your time if you rediscover it*.

## The goal, in the owner's words

> "i want the local <> sheets <> git to all have the same files that can be
> synced manually or automatically or semi-automatically"

> "ok then read the csvs i will import after save"

So: the app **reads** five CSVs from local files, a git repo, or Google Sheets
URLs; **Save** downloads them; the owner imports them back by hand. **No write
path to Sheets is built or planned** — reading a published sheet needs no auth,
writing needs OAuth and an origin-bound client ID.

## Done — tasks 1–5 of 8

| # | Commit | Module | Tests after |
|---|---|---|---|
| 1 | `7cbed04` | `src/core/wallclock.ts` — the shared timestamp ladder | 930 |
| 2 | `914091c` | `src/core/event-csv.ts` | 984 |
| 3 | `509739a` | `src/core/markers-csv.ts` | 1045 |
| 4 | `0b252c6` | `src/core/placements-csv.ts` + `applyPlacements` | 1120 |
| 5 | `43d84b0` + `cf8e774` | `src/core/settings-csv.ts` | **1186** |

**Four of the five are imported by nothing. The exception matters:**
`wallclock.ts` is imported by `notes.ts:44`, and `notes.ts` is in the shipped
bundle — that was the point of task 1, lifting the timestamp ladder out so
several files could share it. `event-csv.ts` is imported by `settings-csv.ts`.
Only `markers-csv.ts`, `placements-csv.ts` and `settings-csv.ts` are test-only.

Verified from the build rather than assumed: `range_from_year`, `markers.csv`,
`placements.csv`, `notes_url`, `keyValueCsvKind` and `item_id` appear **zero**
times in `dist/`. `ingest.ts`, `App.tsx`, the save path and `manifest.json` are
untouched, so no new format is live. But `notes.ts` and `time.ts` were both
edited, and calling this "no behaviour change" would elide that — the change
they carry is the timezone/fingerprint fix in `0a1cbe6`, which is live.

## Task 5 was interrupted and is now CLOSED — `cf8e774`

`43d84b0` was cut off before its break-it verification ran, so its 52 tests
passed with nothing proving any of them bit. Closing it took **102 mutations**
and found a real bug:

**The bug:** a settings file that had lost its header row returned a
`{key: '', …}` row, which `formatSettingsCsv` silently drops — so **one Save
put a setting off disk with nothing reported.** The writer's own comment
asserted this could not happen, which is why nobody had looked.

Fixed; 0 survivors; 52 → 64 tests. No tautology was found, unlike Task 2, which
had shipped an assertion comparing the output to the constant that produced it.

**The transferable lesson: a passing suite is not a verified one.** Every one of
the five codecs found a real defect in its own tests or code this way. Do not
skip the mutation pass on tasks 6–8 because the suite is green.

## Remaining — tasks 6–8

6. **The network read path.** `fetch` a settings file and the five CSVs.
   `response.ok` **and** content-type sniffing before any byte reaches
   `parseCsv` — see the failure table below. None of it may live in
   `src/core/`; the purity test forbids browser globals.
7. **The setup page.** Take a settings file (upload or URL), report per file:
   reachable / recognised as which / row count / **which known columns are
   absent**.
8. **Wiring, and retiring `manifest.json`.** The largest task by far. See
   "What must be re-derived" in the spec — five sources multiply
   `shallowestFirst`, `unreadableAbove`, `ignoredCandidate`, `importError`,
   the `existing*` carry-forwards and `filesForSave`.

## What the owner has already set up

**This is a public repo. The specifics live in `EVENT.md`, which is gitignored
for exactly that reason — crew names and local paths do not belong here.**

- **Five Google Sheets** exist, one per data file, named and empty except
  notes. Their URLs are in the owner's settings file, not in this repo.
- **A real settings file** exists on the owner's disk: `key,value`, all five
  URLs verified resolving, plus a `github_repo` key that nothing reads yet
  (deliberately — it proves unknown-key preservation survives a round trip).
- **The private data repo** holds real data — a handful of notes, a roster
  renamed from device names with the old names kept as aliases, one person
  pinned, and a `manifest.json`. Its name and location are in `EVENT.md`.
- **The photo folder** is a flat directory of 231 files with the data files
  symlinked in. Path in `EVENT.md`. The symlinks are not optional: a Save run
  against that folder before they existed wrote an empty `notes.csv` over a
  file it had never read.

## Measured facts — do not re-derive these

- **A leading apostrophe protects a value through Sheets for exactly ONE pass.**
  Sheets consumes the guard and never re-emits it, so the export is bare and the
  next import mangles. This killed an earlier design that guarded timestamps.
  It is why every timestamp is stored as bare integers.
- **`time_source` cannot tell naive from zoned.** `metadata.ts:190` emits
  `filename` for both Pixel (UTC) and Android (local). A design that inferred
  it would have shifted real photos six hours.
- **`inferEventTimezone` deliberately does not count `Z`** (`time.ts:196`), so
  offset 0 canonicalises to `+00:00`, never `Z`.
- **CORS works**: `…/export?format=csv` from `https://chendaniely.github.io`
  returns 307 → 200, `text/csv`, no key. A sheet shared to named people returns
  an **HTML sign-in page with HTTP 200** — which is why content-type sniffing
  is mandatory, not defensive.
- **A wrong `gid` returns HTTP 400 with 3KB of HTML.** Never hand that to
  `parseCsv`.
- **Nothing in the VIEWER can originate a `timeSource: 'manual'`.** Be precise
  here: `applyPlacements` (`placements-csv.ts:633`) sets it, and `assemble.ts`
  carries an existing one forward — but no UI can mint one, because the
  unplaced tray is read-only. So `placements.csv` starts empty and stays empty
  until hand-placement is built: a durable home waiting for a feature, not a
  rescue of existing data. (An earlier draft of this line said "no producer
  anywhere", which the commit three rows above in that table had already made
  false.)
- **`assembleManifest` builds items from the files on disk**, so a persisted
  item index cannot be a source. That is why items are derived and there is no
  `items.csv`.

## Traps that cost real time this session

- **The test-count guard fires on `make check` and looks like a failure.**
  Adding one file to `src/core/` adds **two** tests automatically, because
  `core-purity.test.ts` has two `it.each` generators. Expect your tests + 2.
- **The GPX timing test flakes under concurrent load.** Re-run with nothing
  else running. Do not loosen it — it masked a real signal once today.
- **Do not run a reviewer and an implementer against the same tree.** A
  mutation or a test run against a moving tree produces a false result.
- **`scripts/check-owner-quotes.mjs` reads every tracked `.md`.** Quoting the
  owner anywhere without appending the same text verbatim to `PROMPTS.md` fails
  the build. Never invent a quote to satisfy it.

## Six drafts, four rejected by review — read the spec's own rejection notes

v6 is what shipped. The spec records why v1, v4 and v5 were rejected; v2 and v3
are named but their reasoning is compressed into the timestamp section rather
than given their own entries.

The recurring failure was mine, twice over: confidently-stated mechanism claims
that turned out factually wrong, and repeated attempts to make the
machine-generated item index behave like authored data. **v4 proposed a
2,000-row `items.csv` and was rejected because `assembleManifest` builds items
from the files on disk, so such a file cannot be a source at all.** If a future
session finds itself proposing one, that is the finding to re-read — it is in
the spec under "The shape, unchanged from v5 and verified".
