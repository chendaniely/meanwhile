# The authored event is five CSVs; the item index is derived — design v6

**Date:** 2026-07-31
**Status:** approved; tasks 1-5 of 8 built (see the progress note in `docs/superpowers/plans/`)
**Supersedes:** v1–v5. v5's shape was verified sound; v6 fixes what its review
found. Every rejection is recorded so the ground is not re-lost.

## The shape, unchanged from v5 and verified

**Items are never persisted.** `manifest.json` disappears with nothing
replacing it for the media index, because `assembleManifest` builds items by
iterating **the files on disk** (`assemble.ts:246`, `:260`, `id: file.path`) —
a persisted index cannot be a source, and does not need to be.

The review confirmed the complete set of per-item facts not re-derivable from
bytes is exactly three: `note` (already migrated to `notes.csv`), and
`at` + `timeSource: 'manual'` — plus `person`, which is re-derived and
therefore *destroyed* today. `placements.csv` carries the survivors.

| File | Holds | Rows | Merges? |
|---|---|---|---|
| `event.csv` | title, timezone, crop, course | ~15 | no |
| `people.csv` | roster | 1/person | by id |
| `notes*.csv` | what people wrote | 1/note | **row-bind, globs** |
| `markers.csv` | aid stations | 1/marker | **no — see below** |
| `placements.csv` | per-item corrections **only** | 0–20 | by `item_id` |

## Timestamps: reuse `resolveZoned`, do not build a second ladder

**v5's worst error.** It specified `_year … _second, _offset_min` — an offset
with no zone. `CLAUDE.md`'s format hardening is explicit that these are not
substitutable: "A zone NAME cannot express the repeated hour… An OFFSET alone
loses which zone the writer meant", and blanking the zone is recorded as
"unfixable retroactively, which is the whole reason this shipped now."

Concretely: a marker typed at `02:14` with a blank offset **silently moves**
when `event.timezone` is later corrected, while the zoned photographs beside it
stay put.

**So `markers.csv` and `placements.csv` use `notes*.csv`'s seven timestamp
columns, byte-for-byte identical in name and meaning:**

```
year, month, day, hour, minute, tz, utc_offset_min
```

**No prefix, and no `second`.** An earlier draft invented `at_year … _offset_min`
with an eighth `_second` column, which would have been wrong four ways: the
offset column would carry two spellings of one concept across the file set
(`utc_offset_min` vs `_offset_min`), which this project legislates against;
`readCalendarParts` (`notes.ts:397`) takes five integers and `wallClockToInstant`
hardcodes `:00` (`:657`), so `_second` cannot go through the existing reader at
all; and a prefixed name matches nothing `resolveZoned` looks for
(`notes.ts:562-563` reads `row.tz` and `row.utc_offset_min` by literal name).

**Minute precision is correct here, not a compromise.** These are times a
person types — "the photo was at 3:47" — not times a camera recorded. The
one-second granularity CLAUDE.md's collision analysis needed is about
EXIF-derived instants, which are derived and never stored. Matching notes
exactly also means `notes*.csv` needs no migration, and it has real committed
data.

`event.csv`'s crop stays key/value (`range_from_year`, `range_to_minute`, …) —
a different shape entirely, so no conflict.

**`resolveZoned` (`notes.ts:556-609`) is GENERALISED AND EXPORTED, not
"reused".** It implements the right three-rung ladder — own offset → own `tz` →
event zone — with a disagreement report at `:599`. But today it is unexported,
its `Resolved` type (`:436`) is unexported, and **every error message hardcodes
the noun**: `note "${label}" has a utc_offset_min of…` (`:575`, `:583`),
`could not be resolved in timezone` (`:591`, `:597`), plus `readCalendarInt`
and `readCalendarParts` (`:385`, `:404`, `:431`). A bad `markers.csv` row would
be reported to the author as a note.

**BUILT 2026-07-31 in `7cbed04`, and NOT the way this paragraph prescribed.**
It said "export it in place". The implementer extracted it to a new
`src/core/wallclock.ts` instead, and an independent audit confirmed the move is
**byte-identical** modulo the noun parameter, the `export` keywords and imports.

The deviation is correct and the reason is worth keeping: `wallclock.ts`
depends on `time.ts` alone, whereas `notes.ts` pulls in `csv.ts`, `schema.ts`
and ~1,300 lines of `Note`/merge/dedupe machinery. Exporting in place would
have made three future modules import all of that for five functions.

*(A circular import was also offered as justification. It is not real — the
graph is acyclic either way, and a future `markers.ts → notes.ts` edge would
stay acyclic. The committed comment does not claim a cycle; it makes the
ownership argument, which is honest. Recorded so nobody re-derives the wrong
reason.)*

Exported surface: `resolveZoned`, `readCalendarParts`, `wallClockToInstant`,
`readOffsetCell`, `nonEmpty`, `instantPartsInZone`, `Resolved`. Only
`resolveZoned` and `readCalendarParts` take the `noun`, defaulting to `'note'`;
`readCalendarInt` stays private with a *required* noun.

This also **deletes v5's `at_offset_min` hard-refusal rule**, which was wrong
three ways: writers always emit the full canonical header, so an all-naive file
has a blank offset column that Sheets may trim — and the rule would then refuse
every row; it contradicted `resolveZoned`'s documented "absent offset means
resolve through the zone"; and it protected `markers`/`placements` while
leaving `notes*.csv`, the irreplaceable file, on the lenient path.

**Canonicalise offset 0 to `+00:00`, never `Z`.** `inferEventTimezone`
deliberately does not count `Z` (`time.ts:196-211`, with a test) and
`exif.ts:369` already normalises `Z` → `+00:00`.

**Range-checked and rejected, never rolled over** — `month=13` is a problem,
not next January.

## Preserved rows apply to the new files too

**v5 never mentioned `PreservedRow`** for `markers.csv` or `placements.csv`.
That re-introduces the defect the 2026-07-30 gate fixed: a `markers.csv` row
with `at_month=13` would be dropped by the reader, and the writer writes only
rows that parsed, so **one Save and the marker is off disk**.

Both files get the full treatment `notes*.csv` and `people.csv` already have:

- A row that parses but cannot be interpreted becomes a `PreservedRow`
  (`csv.ts:152-180`), written back verbatim and reported.
- **`schema` is per-FILE in `event.csv`, `markers.csv` and `placements.csv`**,
  and per-ROW in `notes*.csv` and `people.csv`. The per-row argument is that
  those two merge by row-bind, so a row from an older copy lands among newer
  ones and must carry its own version. The other three neither glob nor
  row-bind, so it does not carry. A file declaring a newer version has **every
  row preserved verbatim** and one problem naming the file — refused, never
  dropped.
- Preserved rows carry their own unknown columns.
- **`markers.csv`'s preserved rows go at the end of the file** — a marker has
  no id (`schema.ts:283`), so a quarantined one cannot be reconnected to
  anything, and the bottom is where someone repairing the file will look.
- **`placements.csv`'s preserved rows are reported loudly**, because a
  placement is the only record of a correction somebody made by hand.

## `placements.csv`

```
item_id, at_year … at_offset_min, person, schema
```

**One row per item a person corrected.** Never one per photograph. It starts
empty and stays empty until hand-placement is built — `timeSource: 'manual'`
has **no producer anywhere in the codebase** today.

- **`item_id` is the relative path**, matching `Item.id` (`assemble.ts:267`).
  Join order: **exact path → unambiguous basename → report**. The basename
  fallback closes the documented reorg hole (`TODO.md`) that manual placements
  have always had, and an ambiguous basename is reported rather than guessed —
  the same rule as a name matching two people. The owner's folder is flat, so
  the two are identical there today.
- **A blank `at_*` block means "no time override"**, so a row can carry only a
  `person` fix.
- **An unknown `item_id` is reported and kept.** The photo may not be in this
  folder yet; deleting somebody's correction because they opened the wrong
  folder is the failure this project keeps legislating against.

**`person` is a NAME, not an id.** v5 never said which, and the two have
different costs. A name matches `notes*.csv`'s deliberate convention
(`people-csv.ts:1-14`) and keeps the file hand-editable — nobody should have to
type `google-pixel-8-pro`, a slug the UI never shows. It resolves through
`resolvePersonNames`, so aliases work.

**The rename self-heal must be extended.** `applyRename`
(`people-csv.ts:606-710`) rewrites `notes` only. Shipping placements with names
and not extending it would ship the alias half without the rewrite half, which
`CLAUDE.md` says "neither substitutes for the other."

**The roster check that makes it safe:**

**The rule:** a `person` in `placements.csv` must resolve to somebody the
roster names. If it does not, the placement is reported and the derived person
stands.

v4's version carried an arbitrary id into the item list, producing a manifest
its own validator refused (`schema.ts:730`) and leaving the photo in **no lane
at all** (`palette.ts:64-77` has no colour for an id not in `manifest.people`).
The roster constraint is what avoids that, and it is why placements are read
**after** `people.csv` — an ordering the review confirmed already holds
(`ingest.ts:466-471` → `:495`).

**Two consequences to handle, not discover:**

- The check must be against **derived ∪ roster**, matching what
  `validateManifest` checked (`schema.ts:729`), not against `people.csv` alone
  — otherwise correcting an item to a *derived* device person is refused.
- **Lane colours are NOT at risk — verified, do not add a guard for this.** An
  earlier draft worried that a correction emptying a derived lane would
  reshuffle every colour, and prescribed applying placements before colour
  assignment. Both halves were wrong. `assignLaneColors` is called only from
  the viewer and always on `manifest.people` (`Feed.tsx:82`, `App.tsx:1569`,
  `Swimlanes.tsx:129`, `UnplacedTray.tsx:31`, `IngestReport.tsx:71`,
  `Notes.tsx:244`, `CourseMap.tsx:132`), so there is no ordering choice to make.
  And the set cannot change: `assembleManifest` builds it as
  `sorted(seenPeople ∪ rosterIds)` (`assemble.ts:294-305`), and the roster check
  above confines a placement's target to somebody already in it.
  `tests/assemble.test.ts:341` pins a different thing — that *filtering* the
  list before the call reshuffles.

**Report redundant corrections.** "2 placements match the derived values — you
can delete them." A corrections file should tend toward holding only real
corrections rather than accumulating fossils as the derivation improves.
Nothing is deleted on the author's behalf.

## `event.csv` and `markers.csv`

`event.csv` is key/value: `title`, `timezone`, `range_from_*`, `range_to_*`,
`course_kind`, `course_src` | `course_url`, `course_person`, `schema`.

- Both-or-neither crop with `from < to` (`schema.ts:463`)
- `course_kind` plus exactly one of src/url; an illegal pair is reported
- **`course_url` failing the `https:` allowlist is a WARNING** (`schema.ts:577`)
  — refusing it once cost the crop, the markers and every manual placement
- Unknown keys preserved; duplicate keys last-wins **and reported**
- **A key this build KNOWS but cannot interpret is preserved too** —
  `range_from_day,32`, a `range_to_*` block missing one integer, a
  `course_kind` that is not one of the three. Unknown-key preservation does not
  cover these, and without this rule the reader refuses the key, the writer
  writes only what parsed, and **one Save puts the crop or the course off
  disk**. `event.csv` holds two of the five things CLAUDE.md names as not
  regenerable from the photographs, and `schema.ts:552-575` records what
  refusing exactly this field cost once: "the crop, every marker, the title,
  the timezone and every `timeSource: 'manual'` placement".
- **No `media_base`.** `manifest.media` is read nowhere in `src/` — a column
  that configures nothing is one somebody will fill in and expect to work.
  Unknown-key preservation means it can be added when remote media exists.

`markers.csv` is `label, year, month, day, hour, minute, tz, utc_offset_min,
distance_m, <unknown>, schema` — **notes' seven timestamp columns, unprefixed
and without `second`**, per the timestamp section above. (An earlier draft of
this line said `at_* (8)`, contradicting that section; built as the seven.)

- `Marker` has **no `id`** (`schema.ts:283`) — do not invent one. **This makes
  the file unmergeable between two people**, which must be stated rather than
  left to be discovered: two crew members' `markers.csv` files cannot be
  row-bound the way notes can.
- A marker needs **either** `at` **or** `distance_m` (`schema.ts:655`) — v5
  covered "both present" and never "neither".
- **An `atDistance`-only marker is silently dropped at render**
  (`schema.ts:275-283`: "the app has no distance axis to place it on").
  Hand-authorable and invisible is a trap; say so in the file's own header
  comment.

## The settings file

Key/value, uploadable and downloadable, **not one of the five**:

```
key,value
# --- the five data files ---
event_url,https://docs.google.com/spreadsheets/d/…/edit?usp=sharing
people_url,…
notes_url,…/dan;…/priya
markers_url,…
placements_url,…
github_repo,chendaniely/meanwhile-cm100-g
schema,1
```

- **CSV, not TOML or YAML**, because *"you can also dump that in a google
  drive"* — a TOML file cannot *be* a Sheet. No new dependency; every value is
  a string.
- **`#`-prefixed keys are comments.** **`;`-separated lists**, which
  `notes_url` needs because `notes*.csv` globs.
- **Unknown keys preserved** — what makes it growable.
- **It has a `schema` column**, like every other file in the set. v5 omitted it.
- `/edit?usp=sharing` URLs are rewritten to `…/export?format=csv`; export URLs
  and non-Sheets URLs pass through.
- **Not in the Save zip** — it holds link-shared URLs, which are bearer
  capabilities, and the zip is the artifact people pass around. Its own
  download button.

**Distinguishing it from `event.csv`, which v5 could not.** They share a
`key,value` header, and both preserve unknown keys, so swapping the settings
URL into `event_url` parses cleanly and reports nothing. Detection is therefore
by **key content**, not header: the settings file carries at least one `*_url`
key; `event.csv` carries `title` or `timezone`. A file matching both, or
neither, is reported.

**One URL can resolve the whole event**, since the settings file can itself be
a sheet — which makes it a bearer capability for every note, name and
timestamp. `localStorage` and a deliberately-passed file, **never** the page
fragment, where it would reach browser history and GA4's `page_location`.

## Prose is protected for one Sheets pass only — state it, do not "fix" it

`cell()` guards every cell (`csv.ts:338`), Sheets consumes the guard, so a note
beginning `=` exports bare and is **evaluated** on the second import.

**v5's proposed remedy was wrong** and must not be built: refusing `= + - @` at
the composer would refuse "- ran out of water", because `FORMULA_LEAD`
includes `-`. And the composer is not the only entry point meanwhile controls —
captions (`App.tsx:961`), names, `title`, and marker labels all are, while
hand-edited sheet cells are not.

So this is **recorded as an accepted limitation**, in the decision record:

**The entry for the decision record:** once Sheets is a leg of the loop, the
formula guard protects one pass. A cell beginning `=` that makes a second round
trip will be evaluated by Sheets. The mitigation is that meanwhile's own writer
re-guards on every Save, so a value that returns through meanwhile is
re-protected; a value that goes sheet → export → sheet without passing through
meanwhile is not.

## Markdown and multi-line notes — wanted, deliberately deferred

> "ideally we accept markdown formatted text and multi line text in the notes,
> to allow for dashes, but i don't think we need to account for that right now"

Deferred, and the reasoning is worth keeping because the obvious obstacle is
not the real one:

- **Multi-line text is already legal.** RFC 4180 permits newlines inside a
  quoted field and `parseCsv` handles them. The project *chooses* to normalise
  them to spaces on write — CLAUDE.md: they "break a line-based diff and any
  tool that assumes one record per line, precisely the audience a plain-text,
  hand-editable file exists to serve." That is a reversible preference, not a
  format limit.
- **The real obstacle is the dash.** A markdown bullet begins `- `, and
  `FORMULA_LEAD` (`csv.ts:69`) guards a leading `-`. The guard survives exactly
  one Sheets pass, so a bulleted note that makes a second round trip through a
  sheet arrives at the next reader unguarded. Markdown's most common construct
  is the one this loop protects least.

So markdown is not blocked by CSV. It is blocked by the same single-pass guard
limitation recorded above, and it should land together with whatever answers
that — not before.

v5 offered "normalise or exclude — say which." Excluding was executed and is
harmful:

```
same id, genuinely different extra
  excluded  -> 1 note; the second row's cell is LOST
  excluded  -> deleting "Cottonwood" also suppresses "Cathedral"
  canonical -> both correct
```

**Canonicalise, the way `fingerprintPreservedRow` (`notes.ts:1290-1311`)
already does** — skip blank keys, NFC, drop empty cells, sort by column name.
Today an *unreadable* row dedupes correctly and the same row made *readable*
does not; that asymmetry is the bug. ~6 lines.

**Field-wise merge must cover more than `written`.** Since `0a1cbe6`, identity
is `noteTimeIdentity` — the wall clock read in the note's own zone — so a row
carrying `tz` and a row inheriting it from the event fingerprint **identically**
while differing in the `tz` cell itself. The requirement stands: on a same-id,
same-fingerprint dedupe, a non-blank value beats a blank one whichever side it
is on. (An earlier draft justified this by a `tz` fold at `notes.ts:902`; that
fold was removed by the same commit, and `:902` is now `note.duration`. The
rule survives its stale explanation.)

**One consequence to budget:** canonicalising `extra` changes every fingerprint
that has one, and the fingerprint feeds `deriveNoteId` (`notes.ts:1155`). A
note already saved under a derived id would get a *different* id and appear
once as a new note — one round of the 2→3→4 growth this project has fought
twice. Keep `undefined → null` (not `[]`) so notes with no `extra` are
byte-unaffected, and confirm `tests/fixtures/csv-before-2026-07-30.ts` still
reads identically.

## Precedence, with notes carved out

**One source per file per session, chosen explicitly** — if the settings file
names a `markers_url`, the sheet is the source and a local `markers.csv` is
**reported as ignored**, the treatment `ignoredCandidate` (`ingest.ts:937`)
already gives a second manifest.

**`notes*.csv` is exempt and always merges.** v5 stated the rule globally,
which would have made a crew member's emailed `notes.csv` *ignored* when
`notes_url` was configured — killing the collaboration model that is the whole
reason notes are CSV. Notes row-bind from every source, always.

**A third ingest mode is needed.** Every carry-forward branches on
`'replace' | 'add'` (`App.tsx:451-539`). "Refresh from Sheets" is neither: as
`replace` it reverts unsaved work, as `add` it can never remove a row deleted
upstream. **No dirty-state tracking exists** — no `dirty` flag, no
`beforeunload` anywhere in `src/` — so "refuse to refresh while there is
unsaved work" is unbudgeted new machinery. Either budget it or define refresh
as replace-and-warn.

## Local discovery: four sites, and the failure is invisibility

v5 named one site and got the failure mode backwards. There is an **earlier
positive allowlist** at `folder.ts:64-71` (`walk`) and `:110-121`
(`filesFromInput`):

```ts
classify(name) || isTrackFile(name) || isManifestFile(name)
  || isNotesFile(name) || isPeopleFile(name)
```

So a `markers.csv` in the folder is **dropped at the picker and never reaches
ingest** — silently invisible, not an unplaced photo. And `FolderPicker.tsx:109`
sets `accept="…,.csv"`, so it can be selected in "Add files" with no feedback.

Change surface: `metadata.ts` (three new predicates) + `folder.ts` ×2 +
`ingest.ts`'s negation. Four sites.

## What replaces `validateManifest`

The function dies — one production caller (`ingest.ts:328`; `:27` is the
import), but **31 test invocations** across three files, including
`assemble.test.ts:220` whose comment calls it "the load-bearing assertion."

| Check | New home |
|---|---|
| `course.person` names a known person (`:629`) | `event.csv` reader |
| both `course.url` warnings (`:577`) | `event.csv` reader |
| `event.range.from < to` (`:463`) | `event.csv` reader |
| duplicate `person.id` (`:485`) | already in `parsePeopleCsv` (`people-csv.ts:228`) |
| marker needs `at` **or** `atDistance` (`:655`) | `markers.csv` reader |
| `timeSource`↔`at` coupling (`:743`) | placements reader |
| `items[].person` names a known person (`:730`) | placements reader |

**`SCHEMA_VERSION` survives only at `assemble.ts:308`**, stamped on an object
nothing serialises and nothing validates. v5's "not dead" was true and
misleading.

## `Person.color` needs a column — this is data loss, not an open question

`PEOPLE_HEADERS` (`people-csv.ts:26-34`) is
`id,name,role,clock_offset,also_known_as,pinned,schema` — **no `color`**.

**It is already lost today, not merely at risk.** `parsePeopleCsv` never reads
a colour (`people-csv.ts:236-278`), and `people.csv` wins over the manifest on
load (`ingest.ts:469`) — so on any folder with a `people.csv`, `person.color`
is gone at **load**, before any Save. And **nothing in `src/` ever writes it**:
the only references are reads at `palette.ts:69`, `:70`, `:108`, so it is
reachable today only by hand-editing `manifest.json`. Adding the column stops
an existing loss rather than preventing a new one.

Codec: accept `#rrggbb` only, report anything else, write blank unless
explicitly set. `palette.ts:69` and `:107` both treat any truthy value as an
override, so a malformed one removes a person from the palette *and* skews the
crowding warning.

## A prerequisite that is already DONE — do not re-derive or revert it

Editing `event.timezone` used to resurrect deleted notes and break blank-id
adoption, because `fingerprintNote` compared a *resolved instant* plus a `tz`
folded against the event zone. **Fixed on 2026-07-31 in `0a1cbe6`**, before
this design lands, because v6 makes the zone come from a possibly-absent,
possibly-remote file and would have multiplied the exposure.

Identity is now **the wall clock the row says, read in the note's own zone**
(`noteTimeIdentity`, `notes.ts:959-984`), so a note's instant may legitimately
move when the zone is edited while its identity does not. `App.tsx:390-392`
now documents exactly that. The `Date.parse` → `NaN` → `JSON.stringify` → `null`
collapse, which made every unreadable `at` dedupe against every other, is fixed
at `notes.ts:1096`.

**Nothing here is outstanding.** This section exists only so an implementer
reading a stale citation does not "fix" it a second time or revert it.

## Documents that must change in the same commit

- **`docs/superpowers/specs/2026-07-28-meanwhile-design.md:123`** — "the
  manifest is the entire interface between the two artifacts and the unit of
  sharing" — and `CLAUDE.md:1417`. Deleting the manifest **reverses a design
  record entry** and needs its own, plus the CLI-contract question re-answered:
  a future CLI would now import five codecs instead of one schema.
- **`README.md`** documents the three-file save at `:281`, `:322`, `:405`,
  `:700-706`.
- `EVENT.md` and `EVENT.example.md` — the symlink ritual and the working loop.

## Cost

**Not "about a week."** Four codecs, not three — v5 forgot the settings file
needs parse, format, UI, `localStorage` and URL rewriting. Prior comparable:
`notes.ts` (1,465 lines) + `people-csv.ts` (710) for **two** CSVs.

Plus: the network layer with content-type sniffing, the setup page, rewiring
974-line `ingest.ts` for five sources and five error channels, retiring a
validator with 31 test invocations, and the 14 test files building `Manifest`
or `SCHEMA_VERSION` literals.

**Ten days to a fortnight** is the honest range.

`importError` needs rewriting regardless: it is `string | null`
(`ingest.ts:189`) and every sentence attached to it asserts *total* failure —
"nothing from it was applied" — which is false once four of five files load.

## Migration

One-off script: read `manifest.json`, write `event.csv`, `markers.csv`, and a
`placements.csv` of items whose `timeSource` is `manual`; carry legacy
`notes[]` and `items[].note` into `notes.csv`; carry `person.color` into
`people.csv`. Throwaway. No installed base.

## Corrections carried forward — do not re-lose these

- `time_source` cannot distinguish naive from zoned (`metadata.ts:190`).
- A leading apostrophe is consumed by Sheets: **one pass**.
- `inferEventTimezone` deliberately does not count `Z` (`time.ts:196`).
- `timeSource: 'manual'` has **no producer anywhere**.
- The manifest never had a hard-refusal boundary to preserve.
- `pinLegacyRunners` has **two** call sites (`people-csv.ts:283`,
  `ingest.ts:467`) and keys on header presence, so regenerating headers from a
  canonical list would silently retire the migration.
- `IMG_1234.jpg` ends in a letter, so item ids sit outside the fill-handle
  hazard by construction.
