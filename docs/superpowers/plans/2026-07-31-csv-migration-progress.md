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
| 5 | `43d84b0` | `src/core/settings-csv.ts` | **1174** |

**Nothing imports any of them.** `ingest.ts`, `App.tsx`, the save path and
`manifest.json` are all untouched. Five pure, tested modules and no behaviour
change — that is deliberate, and it means the work so far is safe to sit on.

## Task 5 is UNVERIFIED — close this first

`43d84b0` was interrupted before its **break-it verification** ran. Its 52 tests
pass; **no mutation was planted to prove any of them bite.**

That matters more here than it sounds. Each of the four codecs before it found
real defects in its own tests this way: Task 2 shipped a **tautological**
assertion (it compared the output to the constant that produced it, so renaming
the constant killed 25 other tests and left that one green); Tasks 3 and 4 each
**discarded a mutation for killing nothing** and replaced it with one that
discriminated. Assume `settings-csv.ts` has one of those until proven otherwise.

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

- **Five Google Sheets**, named and empty except notes: `test-event`,
  `test-people`, `test-notes`, `test-markers`, `test-placements`.
- **`~/Desktop/meanwhile-cm100-settings.csv`** — the real settings file,
  `key,value`, all five URLs verified resolving, plus a `github_repo` key that
  nothing reads yet (deliberately — it proves unknown-key preservation).
- **The data repo** `chendaniely/meanwhile-cm100-g` holds real data at
  `9248b20`: three notes, a roster of Dan / REDACTED / Rylen with device names
  as aliases and REDACTED pinned, and `manifest.json`.
- **The photo folder** is `~/Desktop/Ridgeline 100_ Example City` — 231
  files, flat, with the three data files symlinked in. See `EVENT.md`.

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
- **`timeSource: 'manual'` has no producer anywhere.** `placements.csv` starts
  empty and stays empty until hand-placement is built. It is a durable home
  waiting for a feature, not a rescue of existing data.
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

## Five specs were written and four rejected — read the spec's rejection notes

The design took six versions. Each rejection is recorded *inside* the spec so
the ground is not re-lost. The recurring failure was mine: confidently-stated
mechanism claims that were factually wrong, and repeated attempts to make
machine-generated data behave like authored data. If a future session finds
itself proposing an `items.csv`, read v4's rejection first.
