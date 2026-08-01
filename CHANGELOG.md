# Changelog

Each release pairs what changed with the prompt that asked for it, quoted
verbatim from `PROMPTS.md`. meanwhile is written by Claude and directed by its
owner, and the record of who asked for what is part of the project rather than
a footnote to it — several of the decisions below reversed something Claude had
already built, and the reasons are worth keeping.

## Unreleased

### The settings file: five URLs, key/value, and a `#` for comments

`settings-csv.ts` reads and writes the file that says WHERE an event lives —
the URLs of the other five CSVs, plus anything else the site needs to remember.
It is not one of the five and is not in the Save zip: it describes where the
data lives rather than what it is, and it holds link-shared URLs, which are
bearer capabilities.

- **Comments and key order survive a round trip in place.** Treating a `#` key
  as an unknown one would sort the owner's section headings away from the keys
  they label, scrambling a hand-organised file.
- **`/edit?usp=sharing` URLs are rewritten** to `export?format=csv`; an export
  URL passes through, and a non-Sheets URL (a gist, a bucket) is left alone —
  the codec must not assume Google.
- **`keyValueCsvKind` tells a settings file from an `event.csv`.** Both are
  `key,value` and both preserve unknown keys, so pasting one URL into the
  other's slot would otherwise parse cleanly and report nothing. It keys on
  content: a settings file carries a `*_url`, an event carries `title` or
  `timezone`, and a file matching both or neither is reported.

Nothing imports it yet.

### Editing the event timezone no longer resurrects a deleted note, or duplicates one

> "yes fix the timezone/fingerprint bug"

`fingerprintNote` is the identity every id-stabilising mechanism around notes
is keyed on — `rowIdentity` (what gives a blank-`id` row the same id on a
second parse), the `identified` map that lets a blank-`id` row adopt an id an
existing row already has, and the tombstone fingerprints `ingest.ts` compares
a fresh read against. It took `event.timezone` as an input, and nothing
recomputes those caches when the zone is edited. Reproduced by execution
before anything was changed, from the timezone box alone:

```
change event.timezone  ->  a previously DELETED note RESURRECTS
change event.timezone  ->  blank-id adoption fails, producing a DUPLICATE note
```

Two independent couplings, and only one of them had any tension in it:

- The fingerprint folded `tz` away whenever it matched the event's zone, so a
  row carrying its own `tz` and `utc_offset_min` — every row the site writes,
  and one whose instant no later zone edit can move — changed identity while
  its instant did not move at all. Pure loss.
- A row carrying neither (the documented way to hand-add a note, and every row
  written before `tz` was always emitted) resolves through `event.timezone`, so
  editing the zone genuinely moves it. Its instant *should* change; its
  identity should not, because it is the same row in the same file saying the
  same thing.

**A note's identity is now the wall clock the row says, read in the note's own
zone** (`noteTimeIdentity`), and `tz` is gone from the fingerprint because the
zone is folded into that reading. This is the same argument the format
hardening made for writing `tz` into every row — the five integers are the
durable fact and the instant is derived — applied one seam earlier. Two things
ride along: the sub-minute remainder, because the five integers stop at the
minute and a legacy manifest's `at` does not; and a marker for which half of a
fall-back hour this is, because 01:30 MDT and 01:30 MST are the same five
integers an hour apart — the case `utc_offset_min` exists for — and collapsing
them would swallow one of two notes in silence.

Three other seams were tried against the reproduction and rejected on evidence
rather than taste: matching tombstones by `id` first (fixes neither failure —
the failing row's id is minted THROUGH the fingerprint, and adoption is content
matching with no id to fall back on), recomputing the tombstone fingerprints
when the zone changes (a tombstone holds an `at` resolved under the OLD zone,
so recomputing gives an instant the fresh re-parse never produces, and
`rowIdentity` holds no rows to recompute from at all), and dropping `tz` alone
while keeping the instant (fixes the first failure, leaves the second exactly
as it was).

### An unreadable timestamp is no longer an identity every other unreadable note shares

`Date.parse` returns `NaN` for an `at` this build cannot read, and
`JSON.stringify(NaN)` is `null` — so every unreadable timestamp landed in ONE
fingerprint slot and deduped against every other one, whatever it said.
Reachable through `legacyNoteToNote`, which copies an imported manifest's `at`
across without validating it. The raw string is kept instead. A zone this
runtime cannot resolve gets the same treatment, and additionally must not
throw: `Intl` rejects `MDT`, and this is called from the middle of a merge.

### The timestamp ladder is now `src/core/wallclock.ts`, shared by every CSV in the set

`manifest.json` is being replaced by a set of CSVs, and three of the new files
— `event.csv`, `markers.csv`, `placements.csv` — carry the same seven timestamp
columns `notes*.csv` does: `year, month, day, hour, minute, tz,
utc_offset_min`. They have to resolve a wall clock to the same instant it does,
or the same five integers mean different moments in different files with
nothing to notice it by.

`resolveZoned` already implemented the correct three-rung ladder — the row's
own offset, else the row's own zone, else the event's zone, with a
disagreement reported rather than guessed through — but it was private to
`notes.ts`. It is now `src/core/wallclock.ts`, along with `readCalendarParts`
(the five integers, range-checked, refused rather than rolled over),
`wallClockToInstant`, `readOffsetCell` and the `Resolved` type. Extracted
rather than exported in place: a `markers-csv.ts` importing `resolveZoned` from
`notes.ts` would say the rule belongs to notes, and it belongs to the format.

Every message these can produce takes a noun naming the kind of row, so a
`markers.csv` problem reads `marker "Cottonwood" has a utc_offset_min of…`
rather than calling it a note. The noun defaults to `note`, which is why this
is behaviour-preserving: the 918 tests that existed before it all pass with no
edit to a single expected string, and `tests/fixtures/csv-before-2026-07-30.ts`
still reads to the same instants, ids and text.

The column names are deliberately NOT parameterised. A prefix would give
`utc_offset_min` two spellings across the file set — the one column somebody
hand-repairing a row has to find — `wallClockToInstant` builds a naive
timestamp ending `:00` so there is nowhere for a `second` to go, and these are
times a person types, where minute precision is the right precision.

### `event.csv`, as a codec — nothing reads it yet

The second step of replacing `manifest.json` with a set of CSVs. `event.csv`
carries the event itself: its title, its timezone, the crop, and how the course
is supplied. `src/core/event-csv.ts` is a pure `parseEventCsv` /
`formatEventCsv` pair with 52 tests, and **nothing imports it** — `ingest.ts`,
`App.tsx` and the save path are untouched, so the site still keeps all of this
in `manifest.json`. Wiring is a later step.

Two columns, `key` and `value`, one setting per row, rather than the single
wide row every other file in the set would imply. There is exactly one event,
and a wide file would put twenty-odd headers side by side and make somebody
scroll horizontally to find `timezone`; a new setting also appends a row rather
than a column, so a hand-added key lands somewhere obvious.

The crop is the same seven timestamp columns `notes*.csv` uses, twice, prefixed
`range_from_` and `range_to_`, resolved through the `wallclock.ts` ladder above
with a noun of `event` so a problem names this file rather than `notes.csv`.

The rule the module exists for: **a key this build knows the name of but cannot
interpret is preserved, not just an unknown one.** A `range_from_day` of 32, a
`range_to_` block missing an integer, a `course_kind` that is not one of the
three — each is reported and written straight back out, because the alternative
is that the reader drops it, the writer only writes what parsed, and one Save
puts the crop or the course off disk. That is the same failure
`src/core/schema.ts` already records for `course.url`, whose cost it names as
the crop, every marker, the title, the timezone and every `timeSource: 'manual'`
placement. The crop is preserved as a pair, since `event.range` is two instants
or it is nothing and preserving only the broken end would take the good one
with it.

Also: unknown keys round-trip including blank ones; a duplicated key takes the
last value and says so, because silently picking one is how an edit disappears;
`schema` is per file here rather than per row, since `event.csv` is not
row-bound; a missing header row is reported and read as data, because in a
two-column key/value file the header is the one line that can be mistaken for a
setting; a `course_url` failing the `https:` allowlist stays a warning, via the
same `course-url.ts` the manifest validator uses; and there is no `media_base`
key, because `manifest.media` is read nowhere in `src/` and a key that
configures nothing is one somebody fills in and expects to work.

`instantPartsInZone` moved from `notes.ts` into `wallclock.ts` alongside it.
The read half of the format was already shared; keeping the write half private
to one file is how one file's midnight gets written as the other's 24:00.

No owner prompt is quoted here because there was none to quote — this step was
specified in a task brief rather than asked for directly, and inventing a
quotation would poison the source `scripts/check-owner-quotes.mjs` checks
against.

### `markers.csv`, as a codec — nothing reads it yet

The third step of replacing `manifest.json` with a set of CSVs.
`src/core/markers-csv.ts` is a pure `parseMarkersCsv` / `formatMarkersCsv` pair
with 59 tests, and **nothing imports it** — `ingest.ts`, `App.tsx` and the save
path are untouched, so the site still keeps markers in `manifest.json`. Wiring
is a later step.

The columns are `label`, then `notes*.csv`'s seven timestamp columns
unprefixed — `year, month, day, hour, minute, tz, utc_offset_min` — then
`distance_m`, then any column somebody else added, then `schema`. The
timestamp goes through the `wallclock.ts` ladder above with a noun of `marker`,
so a problem reads `marker "Cottonwood" has a month of 13` and sends its author
to this file rather than to `notes.csv`.

**A marker has no id, and two consequences follow that are worth writing down
rather than leaving to be discovered.** `Marker` in `schema.ts` is `{ label,
at?, atDistance? }`; nothing in the project mints or carries an identifier for
one, so a column here would be invented on write and churned on every save.
So: `markers.csv` cannot be merged between two people, because row-binding two
crew members' copies would produce every aid station twice and nothing could
tell that from a genuine second pass through the same aid station on an
out-and-back — this file has one author, and it does not glob the way
`notes*.csv` does. And `schema` is per file rather than per row, the same call
`event.csv` makes: the per-row argument is that a row-bound file lands a row
from somebody's older copy among newer rows, and nothing lands here from
anywhere else.

**An `atDistance`-only marker is invisible in the app, and the reader now says
so.** `markerLines` in `Swimlanes.tsx` draws markers on the time axis and drops
one with no `at`, because nothing converts metres along the course into a time
yet. A hand-authorable file whose most obvious use silently does nothing is a
trap, so this is reported as a warning — once for the whole file, since the
reason is a fact about the build rather than about any one row. The marker is
returned and written back either way. The warning goes when the spine learns to
convert distance to time, and not before.

The rule the module exists for, the same one `event.csv` was built around: a
row this build cannot interpret is reported AND written back verbatim. A month
of 13, a `tz` of `MDT` that `Intl` cannot resolve, a `distance_m` that is not a
number, a row with no label, a row giving neither a time nor a distance — each
becomes a `PreservedRow`, because the alternative is that the reader drops it,
the writer only writes what parsed, and one Save puts an aid station off disk.
They are written at the END of the file, which is where `people.csv` puts
preserved rows and not where `notes*.csv` does: a refused note is slotted back
into its place in time because a notes file is read in chronological order,
whereas a marker has no identity to reconnect and the bottom is simply where
somebody repairing the file will look.

Two smaller decisions, both about `distance_m`. A blank cell means absent and
`0` means zero, because the start line is a real marker at a real distance and
a falsy check drops it silently. And a cell that is not a number preserves the
row rather than reading as zero: `Number('about 5k')` is `NaN`, which is
`typeof 'number'` and so passes `validateManifest`'s only check on the field —
and `JSON.stringify` then writes it as `null`, which the same validator refuses
on the next open, taking the whole manifest with it.

Every one of the 59 tests was checked by breaking the production code and
confirming it fails: 49 mutations, and each test proven to be killed by at
least one of them.

No owner prompt is quoted here, for the same reason as the two entries above.

### `placements.csv`, as a codec and an apply function — nothing reads it yet

The fourth step of replacing `manifest.json` with a set of CSVs.
`src/core/placements-csv.ts` is a pure `parsePlacementsCsv` /
`formatPlacementsCsv` pair plus `applyPlacements`, with 73 tests, and **nothing
imports it** — `ingest.ts`, `App.tsx` and the save path are untouched. Wiring is
a later step.

**A placement is a correction, not a record**, and that is the whole design.
`assembleManifest` re-derives every item from the files on disk on every open,
so a `placements.csv` row exists only where somebody disagreed with what it
worked out. It starts empty and stays empty: a folder of 231 photographs nobody
has argued with produces a file with no rows in it. Two facts cannot be
re-derived from a file that does not carry them, and this is where they go:

- **A hand-placed time** (`timeSource: 'manual'` plus an `at`), which today
  survives a re-ingest only through `AssembleOptions.existingItems` — i.e. only
  while a previous `manifest.json` is around to carry it.
- **A corrected `person`**, which nothing carries at all today: device grouping
  is re-derived every open, so a correction is destroyed in silence. That half
  is the reason the file is worth having now rather than later.

The columns are `item_id`, then `notes*.csv`'s seven timestamp columns
unprefixed — `year, month, day, hour, minute, tz, utc_offset_min` — then
`person`, then any column somebody else added, then `schema`. The timestamp goes
through the `wallclock.ts` ladder with a noun of `placement`, so a problem reads
`placement "priya/PXL_20260722_161300.jpg" has a month of 13` and sends its
author to this file rather than to `notes.csv`. `schema` is per file, the same
call `event.csv` and `markers.csv` make: this file neither globs nor row-binds,
so a version declared anywhere in it is a statement about the file.

**The join closes a hole this project had already written down.** An item's id
is its path relative to the folder root, which is what makes it stable across
re-ingests — and what makes it move the moment somebody reorganises the folder.
CLAUDE.md records the consequence: a reorganisation orphans every manual
placement, while notes survive one precisely because they join photographs by
BASENAME. `applyPlacements` joins the same way and under the same condition:
exact `item_id` first, then an unambiguous basename, then a report. **An
ambiguous basename is refused, never guessed** — two phones both produce
`PXL_20260822_131204.jpg`, and attaching somebody's hand-placed time to the
wrong photograph is worse than leaving the row unapplied. The successful
fallback is reported too, because a correction landing on a file the row does
not name should not happen quietly. An `item_id` matching nothing at all is
reported and the row survives: the photograph may simply not be in the folder
that happens to be open, and deleting somebody's correction because they opened
the wrong folder is the failure this project keeps legislating against.

**`person` is a NAME, not an id**, resolved through `resolvePersonNames` so
aliases work — rename that device to "Priya" and a file still saying "Google
Pixel 8 Pro" keeps resolving. The candidate set is the roster UNION every person
the items were derived onto, which is exactly the set `assembleManifest` puts in
`manifest.people` and exactly the set `validateManifest` checks `items[].person`
against. The roster alone would be too narrow — correcting a photograph onto a
device lane `people.csv` has never been told about is an ordinary thing to want,
and that lane's label is what the swimlanes show. A name that resolves to
nobody, or to more than one person, leaves the DERIVED person standing and says
so; carrying it through as an id produces a manifest `validateManifest` refuses
outright and a photograph with no lane colour at all, since `assignLaneColors`
has no entry for an id that is not in `manifest.people`.

**A correction that changes nothing is reported and never deleted.** A
corrections file should tend towards holding only real corrections rather than
accumulating fossils as the derivation improves, but which fossils are worth
keeping is the author's call. One detail worth stating: a row whose instant
matches an item's EXIF is NOT redundant, because applying it flips `timeSource`
to `manual` and that stops the person's `clockOffset` being applied — deleting
such a row would move the photograph.

And the rule the whole family of modules exists for: a row this build cannot
interpret is reported AND written back verbatim. A month of 13, a `tz` of `MDT`
that `Intl` cannot resolve, a row with no `item_id`, a row giving neither a time
nor a person — each becomes a `PreservedRow`, written at the END of the file
where `people.csv` and `markers.csv` put theirs. It matters more here than
anywhere else in the set: a placement is the only record of a decision somebody
made by hand, and no file on disk can re-derive it.

Every one of the 73 tests was checked by breaking the production code and
confirming it fails: 52 mutations, every mutation killing at least one test and
every test killed by at least one mutation.

No owner prompt is quoted here, for the same reason as the three entries above.

## 0.4.0 — 2026-07-30 — a role says what someone was, and a course URL has to earn its link

### A role is free text; a new `pinned` column decides whose lane goes on top

> "ok i've updated the roles now. feel free to use sentence / title case when
> displaying"

`Person.role` was a four-value enum — `runner`, `crew`, `friend`, `other` —
checked by both `validateManifest` and `parsePeopleCsv`. The owner typed real
roles into `people.csv` (`crew chief`, `runner`, `pacer`) and two of the three
were refused to `undefined` with a problem reported; **executing one Save then
wrote both cells blank.** That is CLAUDE.md's own "Refusing to READ a row is
not permission to DELETE it", violated at a cell rather than a row.

The enum bought nothing to set against that, measured rather than assumed:
`crew`, `friend` and `other` had zero reads anywhere in the repository outside
the check itself, and the report's runner toggle could only ever produce
`runner` or no role at all.

It had lasted because `runner` was quietly doing a second job — deciding whose
lane pinned to the top — and a field cannot be both free text and a switch.
The owner split it:

> "we should then add a column in the people csv that just indicates if that
> person should be pinned. then the roles don't matter and we can deal with
> that later. we just care about who gets pinned"

- **`role` is any string, kept exactly as typed**, and carries no behaviour
  anywhere. `ROLES` — the constant that enforced the enum — is **deleted**.
  It was first renamed `SUGGESTED_ROLES` and left in place as a documented
  vocabulary, then removed before release once it was clear nothing in `src/`
  read it: a list of role strings that no code consults is a check waiting to
  be re-promoted, and the examples belong in the docs instead.
- **`Person.pinned`, and a `pinned` column in `people.csv`** holding the
  integer `1` — never `TRUE`, because a spreadsheet rewrites anything that
  looks like a yes/no and leaves a bare number alone.
- **Any number of people can be pinned**, which is the point rather than an
  edge case:

  > "ok we can generalize "runner" in the future and allow more roles. for
  > example if i want to use this same system for a wedding we'd have more
  > roles to highlight or add"

  `orderPeople` moves them all to the front in roster order, where it used to
  move the first `role === 'runner'` and silently ignore the rest. The
  `N people have role "runner"; only the first will be pinned` warning is
  deleted — it described a loss that no longer happens — and `App.tsx` no
  longer clears anybody else's flag when you pin someone.
- **Roles are displayed in sentence case** by one function, `displayRole`:
  `crew chief` → `Crew chief`, never `Crew Chief`, and `DJI operator` is left
  alone rather than becoming `Dji operator`. Shown beside the name in the
  ingest report and in each lane label, separately from the pin, because they
  are now two different facts. There is no role input in the app: that is what
  `people.csv` is for.
- **Existing files migrate themselves.** A `people.csv` or `manifest.json`
  with no `pinned` anywhere derives it once from `role: runner`
  (case-insensitively) and writes a real column on the next Save. The
  derivation is keyed on whether the FILE mentions pinning at all, never on
  the row, so unpinning somebody deliberately is not undone by their own role
  cell.

Both items below came out of one question the owner asked about the note
composer — whether letting people type free text anywhere was a risk:

> "maybe we can do some text validation when a user uses the web interface to
> write a note so ' = @ and other symbols are warned that they are not allowed
> before save. not too much i can do if they hand type it in there. but the
> website is isolated from those errors. are there any security risks that
> might happen becuase i have provided a way for random people to put in plain
> text input?"

The answer to the literal question is no: the CSV layer already guards a
formula on write and every note renders as text, so `=` and `@` are safe
where a note lands and are ordinary prose besides — "mile 60 = the wall".
Warning about them would refuse valid writing to fix nothing. What the
question turned up was two problems in the fields nobody was typing into.

> "yes do it in the order you've ranked them. nobody is using this app now. so
> hard specing a version doesn't matter too much righ tnow"

### `course.url` was an unvalidated URL sink

`validateManifest` checked `course.url` was a non-empty string and nothing
else, and `CourseFallback` handed it straight to `<a href>` and, for a
`strava-embed`, to an `<iframe src>` with no host allowlist. A
`manifest.json` — the file this project's whole collaboration model consists
of emailing to people — could therefore put an arbitrary address into either
sink, on a page holding File System Access handles to the owner's entire
photo folder.

What that actually got you, verified by execution against React 19.2.8
(see the correction below, which is where this account was arrived at):
`data:text/html,…` in the `<iframe src>`, rendering attacker markup in an
opaque origin — UI spoofing and phishing inside meanwhile's own page; any
`https://` host framed inside the page; and `http://`. Not script execution:
React sanitises `javascript:` in both sinks.

Now: **a link must be a plain `https://` address, and an embed must
additionally be on strava.com or www.strava.com.** A link merely offers to
leave the page; a frame fetches on the reader's behalf and puts someone
else's document inside it, so only the frame gets a host allowlist. Not an
allowlist of sites to *visit* — a Garmin or COROS activity URL is a
reasonable thing to link to.

One copy of the rule, `src/core/course-url.ts`, imported by both the
validator and the component; a second copy is how the weaker of two checks
ends up being the one that decides. It is hand-rolled rather than
`new URL(...)` because `URL` is a banned global in `tests/core-purity.test.ts`
— the same answer as XML in `course.ts` and CSV in `csv.ts` — and it is
therefore deliberately stricter than a browser's parser: no userinfo
(`https://www.strava.com@evil.test/` has a host of `evil.test`), no non-ASCII
host, and no whitespace, control character or backslash anywhere, since
browsers delete tabs and newlines from a URL before resolving it.

Both layers are needed and the second is not belt-and-braces: the
event-settings box builds a course reference without going near the
validator. A refused URL says so where the link or the embed would have been,
rather than leaving a gap that reads as a bug in meanwhile.

Proved by breaking it eleven ways, each run against the suite: drop the
control-character refusal, allow `@` in the authority, accept `http:`,
suffix-match the embed host instead of matching it exactly, make each guard
return everything, disable each validator branch, put `course.url` back in
the `href` and back in the `src`, and refuse in silence. Every one was
caught. A test never seen to fail is not known to work, and this repository
has shipped several that assert nothing.

#### Corrected before release: it was not an XSS, and the first fix lost data

> "let's go and make sure the spec and everything is solid. we're making this
> ready for a real case example. let's make sure this foundation is solid
> before buildin it into and causing tech debt"

An independent pre-release review said do not ship, and found two things.

**The severity was overstated when first written, in four files and the
prompt log — this section is what corrected it, and the heading above has
been rewritten to match rather than left contradicting it.**
React 19.2.8 — the version this ships — sanitises `javascript:` in both
`href` and `iframe src`, in the development and production bundles, rewriting
it to a throwing stub. Verified by execution rather than by reading a
changelog. So this was never same-origin script execution and it is not
another Leaflet tooltip XSS. What WAS reachable, measured the same way:
`data:text/html` in the `<iframe src>`, rendering attacker markup in an
opaque origin — UI spoofing and phishing inside meanwhile's own page, not
theft of the photo-folder handles; any `https://` host framed inside the
page; and `http://`. Every one of those passed through React untouched.

The guard stays, and still refuses `javascript:`. React's sanitiser covers
exactly one scheme and none of the three problems above; sanitising URLs is
not React's job; and a security property resting on a framework's
implementation detail is one dependency bump from vanishing with nothing here
to notice. The behaviour is now pinned both ways — that React does sanitise
`javascript:`, so nobody rewrites the false claim, and that it sanitises
nothing else, so nobody deletes the guard as redundant.

**Refusing the manifest destroyed data, and that was our own doing.** Making a
bad `course.url` a validation ERROR meant one scheme-less paste —
`strava.com/activities/123`, the ordinary thing to type — refused the whole
`manifest.json` on the next **Open folder**, taking `event.range`, every
marker, the title, the timezone and **every hand-placed photograph** with it:
exactly the list `CLAUDE.md` names as not regenerable from the photos. It also
broke files that already worked, since an `http://` course URL loaded before.

It is a warning now. The manifest loads, the URL is kept verbatim — refusing
to act on a value is not permission to delete it — and the reader declines to
render it. Two things make that real: `validateManifest`'s warnings had never
been read by anything in the viewer, and are now routed into the same problems
callout as everything else; and the event-settings box normalises a
scheme-less paste to `https://` **when the edit is committed** — see the
correction below, because the first version of this did it on every keystroke
and made typing worse than not normalising at all. A scheme that is already
there is never rewritten — silently upgrading `http://` would change where
the author said to go.

**Two user-visible strings were lying.** The link read "Open the activity on
Strava" whatever the URL was, with `target="_blank"` so the address bar never
corrected it — an emailed manifest could render a Strava-labelled link to
`https://evil.test/login`. It names the host the URL parses to now (not
necessarily the host dialled — see the IPv4 note below). And an embed refused
for its HOST also printed "a plain activity URL cannot be embedded", which is
false of a URL containing `/embed/`; each refusal explains only itself.

Eleven more mutations, ten caught. The eleventh — dropping a redundant early
return in the URL normaliser — was confirmed an equivalent mutant by
differential execution over 504 inputs, and the line is kept with a comment
saying so.

#### Corrected again: the usability additions were the shipping blockers

A second independent review passed the security work — 2,717 differential
inputs against the WHATWG parser found no way past the embed allowlist — and
returned do-not-ship on the two conveniences added around it.

**The URL box normalised on every keystroke.** It was a controlled input whose
`onChange` wrote through the normaliser and fed the result back into the
field, so typing `https://www.strava.com/activities/123` by hand ended at
`https://https://www.strava.com/activities/123` — refused by the guard, no
link rendered, and saved to `manifest.json` that way. Pasting worked and
typing did not, the exact inverse of what normalising was for. Backspacing
could not recover either: it converges on `https://h` and never reaches empty,
so "clear the box to remove the course" was unreachable.

**This is a class this project has already paid for**, recorded under "A
rename is TOTAL, and committed — never per-keystroke" — nineteen renames and
an alias list holding every prefix of a name. Fixed the way that entry says,
reusing its precedent rather than inventing a second one: the field holds a
draft, committed on blur or Enter, Escape reverts, and Escape deliberately
does not call `.blur()` (which would fire the commit handler against the
stale draft and commit the edit it was meant to abandon). Normalisation
happens at commit.

The tests could not have caught it: they exercised the normaliser as a pure
function and never mounted the box. There is now a test that types character
by character.

**A correct manifest raised a false alarm.** Routing every validator warning
into the problems callout surfaced one that fires unconditionally for every
Strava course — "no time-and-distance data" — so the commonest workflow there
is (paste a link, Save, Open) reported a problem on a file with nothing wrong,
in a callout whose wording is about unreadable rows and deleted notes, and
which `CourseFallback` already explains properly on the page where it
matters. A warning that fires on an ordinary correct configuration trains
people to ignore the channel. It is gone at the source, so everything
`warnings` still carries describes something actually wrong — which makes
routing them wholesale correct by construction rather than by filtering on
their wording. Manifest advisories are also ordered last now, behind anything
reporting a loss.

**And normalisation no longer promotes words into links.** `none`, `n/a`,
`TBD` and `-` became `https://none` and rendered as anchors reading "Open the
activity on none". A dot is now required before anything is prefixed;
everything else is stored verbatim and refused at render with an explanation,
which is what happened before normalisation existed and was better.

Three smaller corrections: a comment said React's sanitiser misses "two" real
problems immediately after listing three; the claim that refusing non-ASCII
hosts makes `hostOf` "a statement about what will actually be contacted" is
false for numeric IPv4 forms (`0x7f.1` and `2130706433` both dial 127.0.0.1 —
not a bypass, since neither can equal strava.com, but a label/destination
mismatch now that the host is shown as link text, and corrected rather than
papered over with an IPv4 canonicaliser); and a mutation count in `TODO.md`
had gone stale the same day it was written.

#### Follow-ups after the review passed

The scoped review returned ship; these are the four small things it found on
the way, plus three gaps recorded rather than fixed.

**The box could show a stale draft over the stored value.** Its resync effect
watches `value`, so it only runs when `value` CHANGES — and a commit that
normalises back to the value already stored changes nothing. The box then kept
the un-normalised text for good, and because its "has this been edited" test
compares draft against value, every later focusout re-fired the commit: four
commits for two edits. Never lossy, but the field misreported what Save would
write, which is the class this control was rewritten to close. It now resyncs
to what was actually stored — `updateCourse` returns that, so there is still
one normaliser rather than a second copy in the component.

**The "has this been edited" test turned out to be load-bearing and
untested.** The same box shows a GPX course's filename, so with a track loaded
it holds `route.gpx` — which contains a dot, and therefore normalises to
`https://route.gpx`. Without that test, tabbing through the field with no edit
at all replaced the whole GPX course with a Strava link. Removing it passed
all 869 tests; there is now one that fails.

**The Escape test did not guard the trap it named.** It asserted that Escape
must not blur — the trap that makes the commit handler read the abandoned
draft — but never focused the field, so planting the bug was a no-op in the
test environment and passed the entire suite. It focuses first now, and the
planted bug fails it.

**A corrected claim had survived in the decision record.** `CLAUDE.md` still
said the link text "names the ACTUAL host", which the module comment already
documents as false for numeric IPv4 forms — and it said it in the paragraph
reasoning about phishing, where the caveat matters most. This is the "fixed in
one place while copies survive" pattern `CLAUDE.md` names as its own recurring
failure, so the fix was to grep for the meaning and check every hit: five
sites carried it, in four files, and all five now say "the host the URL parses
to".

Recorded in `TODO.md` and deliberately not fixed: the IPv4 label/destination
class in full (22 of 41 accepted hosts differ, and `010.010.010.010` dials
8.8.8.8 while `0300.0250.0.1` dials 192.168.0.1 — neither can equal
strava.com, so the embed allowlist is untouched); the fact that a field
labelled "Strava activity (optional)" displays a GPX path at all, and that a
deliberate edit to it discards the track reference; and that a rename's
reassignment report is appended after ingest and so sorts behind the manifest
advisory that ingest deliberately puts last.

### A leading apostrophe someone else typed is no longer eaten

`unguard()` stripped one leading `'` from every cell — right for a file
meanwhile wrote, wrong for one it did not. A note reading `'twas a long
night`, or a person named `'Bama`, lost the apostrophe on the first read and
saved without it, silently and unrecoverably. Open in `TODO.md` since the
0.3.1 gate found it.

It is now the exact inverse of the guard: strip the `'` **if and only if the
remainder matches `FORMULA_LEAD`** — the same question the writer asked when
it decided to add one. Testing the whole remainder rather than just the next
character is the part that matters: a cell written `'  =evil` is ours, and a
next-character check sees a space, keeps the apostrophe, and hands a live
formula back to the spreadsheet.

No migration was needed, and the old `TODO.md` entry had already proved why
without following it through: a file meanwhile wrote carries `''twas`, not
`'twas`, so it reads identically before and after. Only somebody else's file
reads differently, and it now reads correctly.

Broken four ways to prove the tests hold it: revert `unguard` to the old
unconditional strip (4 failures), narrow it to a next-character test (10),
make it never strip at all (20), and give `FORMULA_LEAD` a `/g` flag so its
`lastIndex` carries between calls (13).

The frozen migration fixture, `tests/fixtures/csv-before-2026-07-30.ts`, was
checked and not touched: no cell in it begins with an apostrophe, so it reads
identically either way.

One round-trip difference this introduces, found by the same pre-release
review and now written down in `CLAUDE.md` beside the other four: a foreign
`'twas` reads as `'twas` and is written back as `''twas`. The content is
identical — that is the promise — and the file gains one character, once,
because the writer must guard anything a spreadsheet could run. Stable from
the second write onward.

## 0.3.1 — 2026-07-30 — the gate turned on itself, then on its own guards

### The analytics leak is shut

> "ok the page changes based on browser history events is disabled"

The one part of it the code could not reach. `send_page_view: false` and a
fragment-free `page_location` stopped everything meanwhile sends itself, but
GA4's enhanced measurement fires its own page view on every `replaceState` —
and the app rewrites the address on every cursor move — carrying `t=`, a
timestamp read from a photograph, and `who=`, people's names. It is a
property-level toggle in the Google Analytics console, so no change here could
close it. Now off.

Worth keeping in mind: nothing in this repo can see that setting, so no test
guards it. If the property is recreated or the toggle flipped back, the leak
returns silently.

### The pre-release gate, run five times

> "can you dispatch some secutiry and privacy independent subagents to review?"

The same review that produced 0.3.0, turned on the release itself and then —
this is the part worth keeping — **turned on its own previous pass**, four
times over. Each pass's findings were, largely, things the pass before it
introduced or missed while fixing that pass's findings: one sentence about
what this app fetches was rewritten by every one of the five. Every item
below was reproduced by execution before it was fixed, and every fix was then
broken again to confirm a test catches it.

**And then on the guards themselves (`f08e3d2`)**

> "let's also do passes on the guards themselves and make sure we do an
> analysis of the actual guards. treat it like you don't really trust the
> guards at all"

The gate had grown two mechanical guards and was reading their output as
evidence they worked. Two failures already argued otherwise: pass 1's quote
checker found nine bad quotes and was never committed — it lived in a scratch
directory and vanished with the agent — and its committed successor was real,
green, and half-blind, checking `> ` blockquotes but not the inline `*"…"*`
form where all four surviving bad citations were. So every pass now plants a
violation of each guard, confirms it is caught, reverts, and asks what the
guard silently permits. A check that is not committed is not a check; a guard
never shown to fail is not known to work. Recorded as a standing rule in
`CLAUDE.md`.

**Data loss, found by running the gate (`71333d3`)**

- **Save erased every row this build refused to READ.** A `notes.csv` row
  carrying a `schema` this build doesn't know, or a day of 32, was reported at
  load and then silently absent from the next file Save wrote — so the advice
  it printed described a repair for data one button press had already
  destroyed. Refused rows are now kept verbatim and written back: a note keeps
  its place in time, a roster row goes after the roster, and its own columns
  come with it. Losing a roster row was worse than losing text: it takes that
  person's clock offset, which moves every photograph they took.
- **"Add files" reverted an in-session rename**, orphaning every note the
  rename had rewritten. It also dropped the crop, the course link and the
  markers.
- **Save threw and did nothing on an unrecognised timezone.** Typing `MDT` —
  the obvious thing to type — produced no file and no message. It is a
  sentence in the error callout now.
- A malformed `manifest.json` handed the folder to a deeper one with nothing
  said; a rename could give a contested name away.

**Tests that were passing without testing anything (`23d309b`)**

Found by deleting production code and watching the suite stay green.
`deriveNoteId` could be replaced by a **constant** with all 178 relevant tests
still passing — which is exactly the bug that caused the note-cloning growth
in 0.3.0. Also uncovered: `locateBox`'s 64-bit branch, and the Android GPS
fallback that is the only place a Pixel clip's position can come from. One
test certified a dead end — a leap second parsed into a value nothing
downstream could resolve, so the item failed to place in silence. Neither a
usable value nor a visible gap, which is the one outcome this project refuses.

**Documentation accuracy (`d1753b4`, then corrected below)**

Owner quotes re-checked against `PROMPTS.md`, comments corrected against the
code they describe, and a `Makefile` message that printed empty values fixed.

**Pass 2: what pass 1 got wrong**

- **The privacy claim was inverted into a false one.** Pass 1 rewrote README
  and CLAUDE.md to say map tiles load "only on the Course view … not on Feed
  or Swimlanes". That is false, and the text it replaced was true. `CourseMap`
  has **two** mount sites — pass 1 checked the import, found one, and stopped.
  The course rail mounts a second map on Feed and Swimlanes, so **once a track
  is in the folder, tiles load on every view**. Six places now agree, and
  CLAUDE.md records the second mount site by name so this stops flipping — it
  had flipped three times. (Pass 3 found that sentence *nearly* right and
  narrowed it once more — see below.)
- **Preserved rows reintroduced unbounded merge growth**: two files carrying
  the same refused row grew 2 → 3 → 4 → 5 → 6 over five rounds — the exact
  signature of the clone bug 0.3.0 fixed. Deduped by content fingerprint, and
  pinned by a five-round test.
- **A preserved row sorted by the wrong clock.** Its position was computed
  from wall-clock cells read as UTC, ignoring the row's own zone: the same row
  sorted first in Denver and last in Tokyo, up to ±14h out of place. That
  defeats the one thing preservation promises beyond not-deleting — that a
  refused row keeps its place in time.
- **The round-trip guarantee was understated three ways.** Saving a file also
  drops fields past the header, drops a cell under a blank header name, and
  adds known-but-absent columns. All four exceptions are now listed. A fifth
  was found and is a genuine bug: a leading apostrophe someone else typed
  (`'twas`) is eaten on the first read. Recorded in `TODO.md` rather than
  patched, because the fix needs a migration story.
- **Two comments pass 1 "corrected" were themselves wrong**, and re-deriving
  the second found a real rendering bug: with Relief on, the hillshade raised
  the map's zoom ceiling to 19 while the topo basemap stopped at 17, so
  **topo blanked entirely at z18–19** — bare hillshade, no contours, no
  trails, no labels — and the `maxNativeZoom` line meant to prevent that was
  unreachable. Fixed.
- **The quote audit missed a whole quoting convention.** Pass 1 checked `> `
  blockquotes; CLAUDE.md also quotes inline. Four bad citations survived,
  including one **spliced together from two different prompts** with the
  owner's typos silently normalised. Fixed to the real text, typos intact; the
  two that were never logged are appended to `PROMPTS.md` as a labelled
  recovery entry. The checker now covers both conventions, catches splices and
  silent typo corrections, and runs as part of `make check` — pass 1's lived
  in a scratch directory and was never wired to anything, which is the other
  reason it missed this.
- A roster message read `"Bob" is now "Bob"` when only a clock offset changed.

**Pass 3: the privacy sentence, and two invariants nothing was holding**

Run against pass 2 the same way pass 2 was run against pass 1.

- **A sentence about map tiles was false exactly where a user reads it.** The
  panel shown for a Strava link told people "the map tiles on this page load
  from other servers automatically" — but that panel only renders when there
  is *no* track, and every map in the app needs one, so no tile is fetched
  there at all. Its replacement said "nothing on it reaches another server
  except the Strava iframe" — which was itself false on the deployed build,
  and pass 4 had to walk the absolute back a third time. (See below; the copy
  that ships now names the analytics tag rather than denying it.)
- **Tiles: two gates, not one.** Pass 2's "every view" missed that Feed and
  Swimlanes also need a time range, which pass 3 said "does not exist until a
  photo is placed or a note is written". Half right: a note is not enough
  either, which pass 4 corrected to a placed *photograph* — see below. A
  folder holding a track and nothing else gets tiles on the Course view
  alone. Corrected in all six places, along with
  "four external hosts unconditionally" — at most two are fetched at a time,
  the chosen basemap plus the optional hillshade, and Thunderforest needs a
  build key it does not have by default.
- **Pass 2's own dedupe had two invariants no test held.** Breaking the
  per-file tally lost a row that someone had genuinely typed twice — and every
  existing test stayed green, because they all happened to read the file with
  more copies first. Relaxing the tie-break rewrote the order of rows nobody
  touched. Both are pinned now, each proved by making the change and watching
  exactly one test fail.
- **`TODO.md` listed a shipped behaviour among the fixes not taken.** Doubling
  our own formula guard on write is not an option to weigh: it already ships,
  and it cannot reach the bug described, which is a first read of a file
  meanwhile never wrote. The bug itself was re-verified and stays open.
- The design spec still carried the old two-app wording of the data-quality
  rule, which README and CLAUDE.md had already been fixed to share verbatim.

**Pass 4: the sentence that has now been wrong three times, and four
canonicalisations nothing was holding**

- **The privacy sentence flipped a third time, and this time it contradicted
  itself.** Pass 3's rewrite opened "nothing else on this page reaches another
  server" and then, one clause later, named the analytics tag as something it
  fetches. Both halves cannot be true, and it is the absolute that is false:
  `make build` puts a googletagmanager.com script in `dist/index.html`, and
  the published site is the only place a manifest someone sent you is ever
  read. The panel now says what waits for your click and what does not,
  without an absolute to walk back. **The component had no test at all** —
  which is why one sentence could be wrong three passes running — so it has
  one now, asserting the substance that keeps breaking rather than the
  wording: that it draws nothing when there IS a track, that no Strava iframe
  is fetched before the click, and that the copy accounts for the analytics
  tag instead of denying it.
- **Four more invariants nothing was holding, all in the same function.**
  Pass 2's preserved-row fingerprint canonicalises four things, each called
  load-bearing in its own docstring, and only one was pinned. Removing any of
  the other three — the column-order sort, NFC on a cell, NFC on a column name
  — or the blank-header skip cloned a preserved row 1 → 2 with the entire
  suite green: the unbounded merge growth 0.3.0 and pass 2 each fixed once,
  reachable from a column drag, a hand-typed accent, or a stray comma. Each
  now has a test, and each was proved by making the mutation and watching
  exactly that one test fail. A docstring calling a line load-bearing is not
  the same as a test pinning it.
- **The tile claim was still wrong for a note-only folder.** Four places said
  tiles reach Feed and Swimlanes "as soon as anything is placed on the
  timeline". A note is placed on the timeline; the tabs need a placed
  *photograph*. One place — the README — had it right, and the other four now
  say what it says.
- The data repository quoted a parser output that had changed under it,
  dropping exactly the "the row is kept" reassurance pass 1 added — so the
  prose around it read as silent loss.

**Pass 5: the guards, taken at their word and then tested**

The first pass run under the new rule, and it found the README making a
promise the tooling does not keep plus three guards that could be walked
past.

- **The README told a non-JS reader that `package.json` "enforces" the Node
  floor. It does not.** npm's `engines` field is advisory: on Node v25.8.2
  with the floor set to `>=99.0.0`, `npm install` prints `npm warn
  EBADENGINE` and then installs, exit 0. Nothing anywhere checked the running
  version, so the promised stop never came and `make inspect` failed later
  with `Unknown file extension ".ts"` instead. The README now says npm only
  warns, and the check sits where the requirement actually is: `make inspect`
  runs `scripts/require-node.mjs` first and refuses in plain English.
  **`engine-strict=true` was measured and rejected** — it enforces every
  package's engines, not ours, and 19 installed packages declare ranges with
  gaps (`^20.19.0 || ^22.12.0 || >=24.0.0`), so a Node that clears this
  project's own floor would be refused an install by a transitive
  dependency's opinion. The 22.18 floor belongs to one optional command; the
  site builds and runs below it.
- **The copy guard on the privacy sentence was aimed at six words, not at the
  claim.** It required one of three nouns near one of three verbs, so a
  differently-worded falsehood — "no analytics or anything else is ever sent
  anywhere from this page" — passed all five tests in the file. It now tests
  the property instead: a clause may deny outbound contact only if it names
  what the denial is limited to, tiles or the local `make dev` build. Proved
  by putting that exact sentence back into the component and watching the
  guard fail.
- **The owner-quote checker only ever read `CLAUDE.md`.** `CHANGELOG.md`
  quotes a prompt for every release (24 citations), and `README.md`, `TODO.md`
  and `docs/` quote too — none of it checked. Widened to every tracked
  markdown file except `PROMPTS.md`, and it immediately found **an unsourced
  quotation in `TODO.md`**: the 12/24-hour clock deferral was written as a
  direct quote and attributed explicitly, and no prompt in the log contains
  it. Withdrawn to a paraphrase rather than tidying the log to fit. The 24
  `CHANGELOG.md` citations all check out. (Narrowing the scan to blockquotes
  that open with a quotation mark was tried, and rejected: measured across
  every file it silently drops a real citation that opens with an elision
  marker.)
- **The test-count check could be satisfied without being true, two ways.**
  It read `numPassedTests`, which excludes skipped tests — so `.skip` plus a
  decrement in `CLAUDE.md` passed while the coverage vanished. And it matched
  only the *first* `**N tests pass**`, so a second, stale copy could sit there
  forever. It now refuses any skipped or todo test outright, and requires
  exactly one such line.
- `package-lock.json` said `0.1.0` while `package.json` said `0.3.0`, three
  releases stale, because npm only rewrites it on install. `make release`
  checks both copies of the version in the lockfile now.
- The README's `make inspect` sample was hand-written and omitted the header
  row, the rule and the summary the real command prints. Replaced with real
  output.

## 0.3.0 — 2026-07-30 — hardened before it carries anything irreversible

### Security: a file from someone else was the way in

> "can you dispatch some secutiry and privacy independent subagents to review?"

Four independent reviews, run before any real notes existed. The trust
boundary here is not a network attacker — there is no server and no account —
it is that **people email each other CSV files**. Everything below was
reproduced by execution, not theorised.

- **A person's name could run script.** The map labelled each photo dot by
  handing Leaflet a string, which it assigns with `innerHTML` — so a name of
  `<img src=x onerror=…>` executed, in a page holding handles to your entire
  photo folder. Names now go in as text nodes.
- **One row in someone's file could silently delete your note.** Note ids
  aren't secret, so a `deleted=1` row naming yours erased it with no warning,
  and the next Save wrote the tombstone over the text. Deletion still
  propagates — that is the point of it — but it now says which file deleted
  what, and quotes the note it removed.
- **A `manifest.json` in any subfolder replaced your event.** A contributor
  zipping their own working folder in could swap the title, timezone, crop,
  course and roster, including a clock offset that moves every photograph.
  The one closest to the top now wins, and anything ignored is named.
- **A spreadsheet formula could hide in an unknown column.** The guard missed
  a leading tab or carriage return, which Excel strips before evaluating.
- **A copied row cloned itself on every merge** — 2, 3, 4, 5, 6 notes over
  five rounds. Now stable at 2.
- **A malformed track could freeze the tab.** An unclosed tag made the parser
  quadratic: 3 seconds on a 100KB file, minutes on a megabyte. Now 4ms.
- Coordinates off the planet are refused rather than plotted.

Verified clean, so it is on record: **nothing sensitive has ever been in
either repository** — every object, reachable and unreachable, in both — and
no photograph, its EXIF, its GPS or its bytes can reach the network, because
no network call exists in the kernel at all.

### Analytics learns the view, and nothing else

> "i don't think i need view-usage. maybe the only tab info that is useful is
> which view are people looking at, but i don't need to track time/people
> information at all."

The app's URL fragment carries a photo-derived timestamp and the ids of
whichever people are shown or hidden — the whole point of "any moment is a
shareable link" — and it must never reach Google. Two mechanisms would have
sent it there: GA4's default `page_location` is `location.href` (fragment
included), and `useAppState` calls `history.replaceState` on every cursor
change, which GA4's "enhanced measurement" listens for.

`googleAnalytics()` in `vite.config.ts` now sets `send_page_view: false` and
sends exactly one `page_view` itself, addressed at `location.origin +
location.pathname` — no fragment, by construction. A new
`src/viewer/analytics.ts#trackView` is the only other thing the app tells
Google: one `view_change` event, `{ view }` only, fired from `App.tsx` on a
genuine view change and never on a cursor scrub or a lane toggle. `make dev`
still sends nothing at all.

**This does not fully close the gap.** GA4's enhanced measurement can fire
its own automatic `page_view` on `replaceState` independent of
`send_page_view`, reading the live URL — fragment included — at that moment.
No code change reaches that; it is a per-stream toggle in the GA4 console —
recorded in `TODO.md`. See CLAUDE.md's "Analytics learns the view, and
nothing else" and its "Verified external constraints" table, and `TODO.md`'s
deploy-and-process section for the action item.

6 new tests, each verified by breaking the production code and confirming
the corresponding test failed before restoring it.

### The CSV format, hardened before it carries anything irreversible

> "yes we should write the tz, sometimes we can infer it from the gps of the
> photo, but we should be able to either infer the tz and allow user to
> modify if needed. we should use a standard tz format and provide links for
> users to easily search/find the tz to use. i'm okay with using UTC offsets"

> "you're right, the merge model will make it hard, so let's just go with the
> data version column value"

The owner created a private repo to hold one race's written record
permanently. Four reviewers examined `notes*.csv` and `people.csv` first,
because once real notes are committed every choice becomes a migration
carried forever. Nothing here changes what the files are for; it changes what
they can no longer lose.

**Both files carry a per-row `schema` version, and the check that reads it.**
Blank means "the version this reader knows", so a hand-added row needs
nothing typed; a row from a newer build is refused by name instead of being
half-understood. Per row rather than per file because these files merge by
row-bind — a row from someone's older copy lands among newer rows and has to
carry its own version.

**`people.csv` keeps columns it does not understand**, which `notes*.csv`
already did. A roster carrying `pronouns` lost it on the next save; a build
without this fix would have deleted the `schema` column itself.

**Every note now records its timezone AND its UTC offset.** `tz` used to be
blanked whenever it matched the event, which looked free and was not: change
the event's timezone afterwards and every note silently moved while the
photographs beside them stayed put, with nothing on the row to say what was
meant. The offset — plain integer minutes, `-360` — is what tells the two
01:30s of a fall-back night apart, which a zone name alone cannot do. The
event's own zone is now guessed from the offsets the photographs themselves
recorded rather than from the browser's clock, and the Timezone field says
which one it landed on with a link to look one up.

**Impossible dates are refused rather than quietly corrected.** `month` 13,
`day` 32, `hour` 24, a year of `26`, a minute of `45.7` — a drag-fill or a
slip of the finger produces all of these, every one was silently accepted,
and every one then rewrote itself on the next save, so the file stopped
saying what its author typed and nothing reported it.

**A deleted note stays in the file, marked deleted.** Deleting one used to
remove it from memory and nowhere else, so anybody else's older copy brought
it back on the next merge with nothing recording that the removal was
deliberate. Every deletion made before this column existed is unrecorded
forever, which is why it landed now rather than later.

**Notes record when they were written**, not only when the thing happened —
"at the time" versus "remembered two years later" is the difference between a
log and a memoir, and it cannot be reconstructed afterwards.

Two joins that silently failed now hold: names written in different Unicode
normalisation forms match (`José` and `José` are visually identical and were
not equal), and merging a saved copy of `notes.csv` with a pristine one no
longer grows the note count — it used to, measured at 2 → 3 → 4 → 5 → 6 over
five rounds before this fix; the same merge now holds at 2 every round.
Minted ids never end in a digit, because a spreadsheet's fill handle
increments a trailing number when a row is dragged.

Migration is pinned to a frozen copy of both files as they were written
before any of this, asserted to produce the same instants, ids and text —
then to repair themselves into the new shape on the first save without losing
a thing.

### `EVENT.md` — a per-copy pointer to where an event's data lives

> "let's create a separate file that the readme and claude reads that points
> to the git backed repo. this way you have the context of where this current
> project's git repo is, but it's not fully baked into the context if other
> people want to use it"

meanwhile is a renderer and holds no event of its own, but one person's copy
needs to remember which event they are on and where its written record is
kept — the data repo's URL, the local photo folder, clock offsets worked out
by hand. Putting that in `README.md` or `CLAUDE.md` directly would bake one
owner's private data repo into the app everyone else clones.

`EVENT.md` is gitignored and holds the real answers; `EVENT.example.md` is the
committed template everyone else starts from. Nothing about the app depends on
either file — absent, the app has no idea it exists, and you just open a
folder as usual.

### A rename can no longer corrupt the record

> "i need a way (possibly in the site interface itself) to connect the notes
> and people datasets, where the author in notes is the new display alias
> for the name in people. [...] i am essentially asking for a non
> destructive way to rename people ids that are displayed. assume in the
> future i might have multiple of the same device so we need to maeksure the
> id in people are unique so the rename can happen with a join or something"

An independent format review, run before real data went into version control,
found the rename input firing once per KEYSTROKE. Renaming "Google Pixel 8
Pro" to "Priya" ran about nineteen renames, filling `also_known_as` with every
prefix along the way so that `G` and `P` resolved to that person — and
backspacing through empty wrote `""` into the note's people list, after which
a guard in the rename itself meant it never healed. The note's link to that
person was destroyed permanently, on the most ordinary interaction there is.

A rename is now a committed action (blur or Enter, Escape reverts) and is
total or refused — refused on a blank name, on a `;` (the list delimiter,
which has no escape), and on a name another person already claims. That last
case was its own silent corruption: renaming Alice to "Bob" produced two
people called Bob, and "Bob" then resolved to neither, orphaning both notes
including the one that never involved Alice.

`notes*.csv` refers to people by name, not id, so renaming a lane from a
device slug ("Google Pixel 8 Pro") to a person ("Priya") used to orphan every
note already written under the old name too. `people.csv` gains a fifth
column, `also_known_as`; renaming now pushes the OLD name onto it and
rewrites every already-loaded note to the new name, and `resolvePersonNames`
matches a note's `people`/`author` against a person's current name OR any
recorded alias — so an untouched crew member's copy of `notes.csv`, or a note
nobody has re-saved yet, keeps resolving after a rename. Display everywhere
now falls back `name` → first alias → the device-slug prettifier, in one
function, rather than showing blank for a hand-added roster row that only has
an alias.

The two collisions are handled differently, deliberately, because they are not
the same failure: claiming a name someone else already has is refused outright
(above); but a rename whose OLD name is itself already claimed by someone
else still proceeds — the id gets its new name — while skipping the alias and
the note rewrite, rather than guessing which of the two people a note under
that shared old name actually meant. That mirrors the project's existing rule
for an ambiguous photo-caption match.

Broken joins are now loud rather than silent: unresolved note names are
reported at ingest and drawn in the event-level row, and a `photo` matching no
file at all is reported, not just an ambiguous one. Aliases are cleaned on
read, write and rename, so the column cannot grow without bound.

## 0.2.0 — 2026-07-30 — notes in CSV, an audited codebase, and a live site

Everything below shipped between 0.1.0 and this release. The headline is that
notes and the people roster moved out of `manifest.json` into spreadsheet-
editable CSV, that the whole codebase went through six passes of
documentation and comment auditing, and that the site now deploys to GitHub
Pages.

### The site goes live, and is measured

> "i think we should also be pushing these up to github, with releases, tags,
> and changelogs updates. i want to be able to test this on github actions +
> github pages."

Published to GitHub Pages from `main`. The deployed page loads Google
Analytics; `make dev` does not, because local mode reads private photographs
off your own disk and the promise that nothing leaves the machine has to keep
meaning something for the person it protects. The README and CLAUDE.md now
enumerate every external request the page makes rather than claiming there
are none.

### Notes now appear in the swimlanes

> "what i did notice is when i create a note i do not see it in the swimlane"

`Swimlanes.tsx` had no reference to notes at all — CLAUDE.md had described
this as built since M9 ("`person` is optional and does real work... the note
sits in that person's lane"), and the six-pass documentation audit below
still missed it, because the claim had no code near it to contradict.

- A note whose `people` list is non-empty now draws in EACH of those
  people's lanes, at its time, in that person's own lane colour — so it can
  actually explain a gap, e.g. "asleep at Cottonwood" sitting in the
  six-hour hole it names.
- A note with nobody named (or nobody the roster recognises) is
  event-level: its own row, pinned above every person lane, coloured with
  the palette's existing neutral rather than an invented ninth hue.
- A note with a `duration` draws as a span, not a point.
- The row is omitted entirely when a folder has no notes.
- A caption (`note.photo` set) is excluded the same way `Feed`'s caller
  already excludes it, so it does not appear a second time as a lane mark.
- Clicking a note mark moves the shared cursor to the note's own time, not
  the pixel clicked.

### A documentation audit, looped six times — and the bugs it turned up

> "I want you to take another thorough pass-through all of the comments and the
> documentation. you now assume the comments and the functions that it is
> commenting sync up. I want you to review the comments and confirm that the
> code does what the comment is saying. same with the larger pieces of
> documentation. I want you to keep looping through this process until you find
> no more discrepancies in the documentation and comments"

About 145 inaccuracies fixed across comments, prose, test names and
user-facing strings. Most were stale claims, but a comment is a claim about
behaviour, so checking them turned up real defects — these are the ones that
change what the app does:

- **Escape no longer unpins the moment strip while the lightbox is open.** It
  closed the lightbox *and* released the pin, undoing the pin you had just set
  so the strip would hold still while you reached for a photo. Escape had also
  never worked at all: the handler sat on a `role="presentation"` element that
  could not receive focus.
- **The feed no longer hides a note when no photograph shares its window.**
  Notes were filtered by time but the empty-state check counted only media, so
  a note alone in the window was discarded — the one failure this project
  treats as worth spending UI on.
- **Five CSS custom properties were used in fourteen places and defined
  nowhere**, silently collapsing `border-radius` to zero and dropping the notes
  panel's margin entirely.
- **Six labels moved off the faintest text colour.** At 3.98:1 it fails WCAG AA
  for body text, and the token's own rule said it was never for text a reader
  needs — including the "nothing" label in the moment strip and the explanation
  shown on a photo the browser cannot decode.
- **The sticky course rail no longer tucks under the header**, which is now
  measured at runtime rather than assumed.
- **`notes.csv` and `people.csv` are git-ignored**, along with the zip that
  Save produces and every media extension ingest accepts. They hold names and
  prose, and `.gitignore`'s first line promises event data never reaches git.
  Nothing had been committed; the gap is closed.
- **`d3-time` is gone** — installed and justified in the dependency budget,
  imported nowhere.

The most consequential documentation fix has no user-visible effect and is the
reason for the rest: several comments still said GPS timestamps are
authoritative. They are not — GPS records the satellite fix, not the shutter,
lagging a median 11 seconds and up to 919, unevenly enough to scramble the
order of photographs taken moments apart. That correction cost 231 real files
to establish, and five surviving copies of the old claim were sitting where a
future session would read them first.

### Notes and the people roster move out of the manifest

> "i think it'll be better if notes were in a separate file. it'll be much
> easier to either edit in the site, or offline in a spreadsheet program [...]
> at this point i forgot what the manifest file is for, but i think most people
> will care the most about the notes"

Forgetting what the manifest was for was the diagnosis, not a lapse. Notes and
photo captions now live in `notes*.csv`; names, roles and clock offsets live
in `people.csv`. The manifest keeps everything derived — items, GPS,
`timeSource` — and stops carrying the small, irreplaceable slice a person
actually typed. A caption collapsed into a note whose `photo` column names the
item: one file, one editor, one merge. Saving now downloads one zip of
`notes.csv`, `people.csv` and `manifest.json`, built by a hand-rolled,
store-only ZIP writer — no dependency. A photo with a note now shows a small
chat glyph on its tile, which is the discoverability fix: a caption used to be
invisible until the lightbox was open.

### Safe from corruption in a spreadsheet

> "i want to make sure the underlying data is safe from corruption"

No format survives a spreadsheet except a plain integer — Excel rewrites
`2026-07-25` to `7/25/26` and `15:45` to a day fraction the moment the file is
saved. A note's timestamp is therefore five bare integers
(`year,month,day,hour,minute`), which look like nothing a spreadsheet
"corrects." A span is an ISO-8601 duration (`PT3H40M`) rather than an end
timestamp or a bare number of minutes, so the unit travels with the value and
a race crossing midnight needs no extra column. The composer still shows one
time box — the split is a property of the file, not the UI. Every cell that
could execute as a formula (`=`, `+`, `-`, `@`) is written with a guarding
apostrophe, and the file is written UTF-8 with a byte-order mark so Excel on
Windows does not mangle the apostrophes and emoji notes are full of.

### Merging needs no version control

> "i think it'll be okay if we end up making it look like 2 comments at the
> same time. that's okay. when we visualize it it'll show up one after the
> other."

`id` is opaque and stable; the timestamp is ordinary data, not an identity —
a spreadsheet reformats ISO dates on save, two people can write at the same
second, and retiming a note would otherwise look like a delete plus an
insert to anything trying to merge two files. So merging several people's
`notes*.csv` files is **row-bind, dedupe by id, sort by time**: no locking, no
conflict resolution, no merge UI. A blank `id` is minted on load; a duplicated
`id` — the signature of a copied row — gets one side re-minted. Two people
editing copies of the same note at once produce two notes at that instant,
shown one after the other, exactly as asked for.

### The composer writes exactly what the format defines

> "we should make sure that in the UI the note button is also matching this
> set of specs, so when it is used to create a note it is writing the corret
> information to the correct file."

> "i guess you can have multiple authors as well. i can imagine multiple
> people writing down an experience all at the same time."

`Whose` and the new `Written by` are both searchable multi-selects, backed by
the same `people`/`author` columns and the same parsing rule. A "you are…"
picker in the top bar — kept in the browser's local storage, never the
manifest, since it describes the laptop rather than the event — pre-fills
`Written by` on every new note without ever blocking one from being written.

### Fixed before merge

The whole-branch review found that the pieces, each correct alone, leaked data
where they met. Everything below was caught by review or by end-to-end testing
rather than by the suite, and each now has a test.

- **"Add files" destroyed every note and caption written in the session.**
  The composer had been moved off the manifest, which silently disconnected the
  mechanism that carried notes across a re-ingest. A two-click path, advertised
  in the README, with nothing on disk yet to recover from.
- **Unknown CSV columns were dropped on save** — and because the merge
  fingerprint includes them, the note then *duplicated* on the next load.
- **A person in `people.csv` who owned no media was silently deleted from it**,
  which is what adding a crew member to the roster looks like.
- **An invalid `role` corrupted `manifest.json`** so it failed its own
  validator, losing the crop, the course reference, markers and every
  hand-placed time on the next open.
- **A hand-typed row with a blank `id` had no stable identity across reads**,
  which produced three separate bugs — a duplicate on "Add files", a deleted
  note resurrecting, and an edited-then-deleted note resurrecting. Fixed at the
  cause with a session-scoped row-to-id map rather than a fourth patch.
- **Notes could be invisible on load**, because the default time window was
  computed from photo clusters and ignored notes entirely.

## 0.1.0 — 2026-07-29 — first working viewer

Point the site at a folder of photographs and look at the race. Nothing is
uploaded; the site ships no media and no event data.

### The shape of it

> "let's built it with an existing project i want to implmeent. but the data
> and website will be separate (e.g., the website will be on github, data will
> exist locally)"

A static renderer, not a locker. It reads files off your disk with the File
System Access API and draws views; a `manifest.json` you export carries the
authoring work. There is no backend and nothing stored server-side, which is
what makes the privacy question answer itself.

### Reading the files

Ingest reads **metadata only** — 128KB of a JPEG, a couple of range reads of a
video — so a 2GB folder costs 26.6MB and about 100ms. EXIF and ISO base media
are parsed by hand rather than with a dependency.

The most important correction came from the owner's real 231 files: **GPS time
is not shutter time.** It timestamps the satellite fix, which is stale by a
median 11 seconds and up to 15 minutes, and non-uniformly — so photographs
taken seconds apart collapsed onto one instant. Ranking it below the shutter
sources took colliding instants from 27 to 2.

The same folder killed the assumption that people hand over one folder each:
it was a flat Google Photos download of three phones, so people are identified
by device — EXIF make and model, then the filename convention, then proximity
in time.

### Looking at it

> "i may not want to see all the photos listed in the timeline, and give me the
> ability to zoom into a certain part of the race"

A two-handle time window over a density histogram, with cluster chips for the
stretches the data actually forms. On the real folder that turns 46.6 days and
230 items into 47 hours and 142, automatically.

> "i like the swim lanes. i feel like as we hover over all the images around
> that time should pop up or something. just looking at when tehre are photos
> and events are not useful"

Right, and it changed the design: marks on a track say *when* without saying
*what*. The swimlanes gained a strip of the actual photographs underneath, one
row per person and aligned with the lane above — the simultaneity claim shown
rather than argued.

### The course

> "i'd like to make sure we are able to also display all the other running
> stats. i almost do want to re-create bits of the strava/garmin interface"

GPX and TCX parse into a course spine: a Leaflet map on real terrain, and
stacked one-measure-per-chart statistics. The owner's own export then taught us
the case the design had not imagined — **120,909 points and not one
timestamp**, a route rather than an activity. Untimed tracks became a supported
mode rather than a parse failure, and meanwhile does not invent the missing
times.

> "sometimes as the runner, you rememer moments from the elevation / course.
> especially if there are no photos in that area"

Clicking the course writes a note there, timed from the track when it has one
and interpolated between the surrounding photographs when it does not.

### Writing things down

> "i'd like to be able to provide a comment at any arbitrary time [...] either
> because we forgot to take a photo or it was something that we remembered
> happening during some point of time"

Notes are first-class and belong to no file. They can span time, can belong to
one person — which is what lets a note explain a six-hour gap in someone's lane
— and interleave with the photographs in the feed.

### Getting the interface out of the way

> "after i upload 200+ images all the things on the bottom of the site are
> really hard to notice"

Structural, not cosmetic: the feed is unbounded, and the export button, people
list, unplaced tray and note composer all rendered *after* it. Things are now
placed by how often they are used — a sticky top bar for what must always be
reachable, the note composer floating within reach of whatever you are
reading, and the reference material collapsed above the views.

> "the click on the swim lane is a toggle"

Hovering the lanes previews a moment; clicking pins it so the strip holds
still while you reach for a photograph, and clicking again lets go. The wheel
zooms the time window. The moment strip is a fixed height, because tiles that
wrapped made the page bounce as you scrubbed — including the photographs you
were reaching for.

> "loop through the site to make sure everythign is consistant and no
> conflicts"

One action, one name, one control. "Save manifest" and "Export manifest.json"
were the same thing twice; the verb now carries the meaning, so *Open* always
replaces and *Add* always merges. Stacking became a named scale after the note
dock was found floating over the lightbox.

### Getting it back

Export `manifest.json`, drop it back in the folder next time, and names, roles,
captions, the crop and hand-placed times all return. Automatic timestamps are
always re-read from the files, because those are facts about the bytes.
