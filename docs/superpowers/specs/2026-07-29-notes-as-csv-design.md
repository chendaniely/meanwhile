# Notes as CSV — design

*2026-07-29*

## Why

The owner, after a session of using the app:

> "i think it'll be better if notes were in a separate file. it'll be much
> easier to either edit in the site, or offline in a spreadsheet program [...]
> at this point i forgot what the manifest file is for, but i think most people
> will care the most about the notes"

Forgetting what the manifest is for is the diagnosis, not a lapse. Split by
where its data comes from:

- **Derived** — `items[]`: ids, timestamps, GPS, dimensions, durations,
  `timeSource`. Thrown away and rebuilt from the files on every open. About
  95% of the file by volume.
- **Authored** — names, roles, clock offsets, the crop, hand-placed times,
  captions, notes. Irreplaceable if lost.

The manifest is a **cache of what was read**, with a thin seam of irreplaceable
authorship threaded through it. The part that matters is small and buried
inside the part that regenerates itself. Pulling the authored part out into
files a person can read is what this design does.

## What changes

| | Before | After |
|---|---|---|
| Notes | `manifest.notes[]` | `notes*.csv` (manifest no longer carries these on save) |
| Photo captions | `manifest.items[].note` | `notes*.csv`, `photo` column filled in (manifest no longer carries these on save) |
| People, roles, clock offsets | `manifest.people[]` | **edited** in `people.csv`, which wins on load |
| Everything else | `manifest.json` | unchanged |

**The manifest still carries `people[]`, and must** — `validateManifest`
requires it, so a manifest has to be usable on its own with no CSV beside it.
`manifestForSave()` strips `notes` and `items[].note` from what gets written,
but deliberately does **not** strip `people`: a saved `manifest.json` keeps a
full, redundant copy of the roster alongside `people.csv`. On load,
`people.csv` wins when both are present. So `people.csv` is where the roster
is *edited*, not the only place it's *stored* — unlike notes, which really
do move out of the manifest. This is a known asymmetry, not an oversight;
see `CLAUDE.md`'s decision record for the manifest.

The manifest's job becomes sayable in one line: **it describes the event and
caches what was read from the files, plus a redundant copy of the roster;
the CSVs hold what a person wrote and are where the roster and notes are
edited.**

### A caption IS a note

Decided first, because it collapses two concepts into one. A caption is a note
whose `photo` column points at an item. One file, one editor, one merge, one
thing to explain. `items[].note` disappears.

## The files

### `notes*.csv`

```csv
id,year,month,day,hour,minute,duration,tz,people,photo,author,text
n_k3f9x2,2026,7,25,15,45,,,Priya,,Dan,wrong turn on the ridge
n_p1a7m4,2026,7,25,15,53,,,Priya;Sam,PXL_20260725_215331309.jpg,Dan,the buckle
,2026,7,26,3,0,PT3H40M,,Sam,,Dan;Priya,asleep in the car
```

**Corrected, 2026-07-30 — five more columns, before real notes were
committed.** Four reviews of this format ran on the eve of the owner putting
one race's written record under version control, on the grounds that once
real notes are committed every choice becomes a migration carried forever.
The layout is now:

```csv
id,year,month,day,hour,minute,duration,tz,utc_offset_min,people,photo,author,text,written,deleted,schema
n_k3f9x2,2026,7,25,15,45,,America/Denver,-360,Priya,,Dan,wrong turn on the ridge,1753500000,,1
```

| New column | Meaning |
|---|---|
| `utc_offset_min` | The UTC offset in force at that instant, in whole minutes (`-360`). Written by the site. |
| `written` | Epoch seconds, when someone TYPED the note — a different fact from `at`. Machine-written, blank allowed. |
| `deleted` | `1` for a note deleted on purpose. The row stays in the file. |
| `schema` | The layout version of THIS ROW. Blank means "whatever the reader knows". Always the last column. |

Every one is an integer or an IANA name, per the governing constraint below.
The full reasoning — including why `schema` is per row rather than per file,
and why a `tz`/`utc_offset_min` pair beats either alone — is in `CLAUDE.md`
under "The format hardening, done BEFORE real notes were committed".

| Column | Meaning |
|---|---|
| `id` | Opaque, stable, machine-written. **May be blank** — see below. |
| `year` `month` `day` | Whole numbers. `2026,7,25`. Not zero-padded; padding is lost anyway and means nothing. |
| `hour` `minute` | Whole numbers, 24-hour. `15,45`. Midnight is `0,0`. |
| `duration` | ISO-8601, e.g. `PT3H40M`. Blank for a moment rather than a span. |
| `tz` | IANA zone, e.g. `America/Denver`. **Blank means the event's timezone**, which is the normal case. |
| `people` | Who it is **about**. Semicolon-separated names. |
| `photo` | Item this is a caption for. Blank for a standalone note. |
| `author` | Who **wrote** it. Semicolon-separated names, same as `people`. |
| `text` | The note. Free text — see below. |

**Matched by header name, not column position**, so anyone may reorder columns
or insert their own. **Unknown columns are preserved on write** — if someone
adds `tags`, it survives the round trip. Losing a column someone typed into
would be the same class of failure as losing a note.

#### Why the timestamp is five integers

> "i want to make sure the underlying data is safe from corruption"

**No format survives a spreadsheet except plain integers.** `2026-07-25` in a
cell is still a date to Excel, which rewrites it to `7/25/26` on save, or to
the serial number `45861`. `15:45` becomes `3:45 PM` or the fraction
`0.65625`. Splitting date from time makes that *recoverable* — the column says
what a bare number means — but recoverable is weaker than safe.

Integers are simply never reformatted. Nothing in `year,month,day,hour,minute`
can be corrupted, so nothing has to be repaired.

The ergonomic reason that started this survives intact:

> "most likely it'll be the same date, but different times and the user might
> just click drag/copy paste the date. while they are filling out times."

You drag `year`, `month` and `day` down the sheet and type the hours and
minutes — which is now three columns of dragging instead of one, but they are
adjacent and drag as a block.

**The composer still shows one time box.** `YYYY-MM-DD HH:MM` is what a person
types in one go; five inputs would slow down the path this feature exists to
make fast. The split is a property of the file, and the file is where
drag-filling happens.

#### `duration` rather than an end time

An end *timestamp* would need its own year, month and day, because a 33-hour
race crosses midnight and 31 July crosses a month. A duration has no boundary
cases at all — one column, and midnight stops being special.

ISO-8601 (`PT3H40M`, `PT20M`) rather than a number of minutes, because **the
unit travels with the value**. `duration_minutes` puts the unit in a header
that a copied cell leaves behind. It is also what `clockOffset` already uses,
so the project has one convention for "how long" rather than two. Excel leaves
it alone for the same reason it leaves the id alone: it is neither a number nor
a date.

The cost, accepted: you cannot sum or sort durations in a spreadsheet.

#### `tz` is an IANA name, not an offset

An offset like `-06:00` is simpler but wrong on either side of a daylight-saving
change, and it says nothing about where the note was written. A zone name
resolves correctly whatever the date. Blank is the normal case and means the
event's timezone, so the column costs no typing until a note genuinely comes
from somewhere else — a crew member in a different zone, or an event that
crosses one.

Keeping it also makes the notes file **self-contained**: times stay
unambiguous when it is read without the manifest beside it.

**Corrected, 2026-07-30 — BOTH, and `tz` is never blank.** Two things above
turned out to be wrong.

*"Blank is the normal case"* was a false economy. The row would indeed pick
the event's zone up again on read — until `event.timezone` is changed, at
which point every note silently MOVES while the zoned-EXIF photographs beside
them stay exactly where they are, and nothing on the row records which zone
was meant. That is unfixable after the fact, so `tz` is now written on every
row.

*"An offset ... is wrong on either side of a daylight-saving change"* is true
of an offset stated once for a whole event, which is what this paragraph was
arguing against. It is not true of an offset stated per row, which is what
`utc_offset_min` is — and a per-row offset is the only thing that can express
the repeated hour at a fall-back transition. `2026,11,1,1,30` in
`America/Denver` is two instants an hour apart, and a zone name alone silently
picks the earlier one every time.

So both are carried. On read the offset determines the instant and the zone is
for display and date math; a genuine disagreement between them is reported
rather than resolved by guessing. The offset is **integer minutes**, not
`-06:00`, for the same spreadsheet-safety reason as the timestamp itself.

#### `text` is free input, and is treated as hostile

The last column is whatever someone typed, which raises three separate
problems.

**Newlines.** Legal inside a quoted CSV field, but they break naive tooling and
make the file unreadable in a diff. The composer replaces newlines with a
space on write; the reader accepts a quoted multi-line field and normalises it
the same way. A note is a sentence.

**Quotes, commas and semicolons.** Handled by RFC 4180 quoting: fields
containing them are wrapped in double quotes, and embedded quotes are doubled.
`people` and `author` are semicolon-separated precisely so a comma in a name
never needs escaping.

**Formula injection.** A cell beginning `=`, `+`, `-` or `@` is executed as a
formula when the file is opened in Excel or Sheets. These files are meant to be
passed between people, so this is a live risk rather than a theoretical one.
Any cell starting with those characters is written with a leading apostrophe,
which spreadsheets strip on display and which the reader removes.

#### Encoding

Written as **UTF-8 with a byte-order mark**. Without the BOM, Excel on Windows
misreads UTF-8, and notes are exactly where apostrophes, em dashes and emoji
turn up. The reader accepts the file with or without one.

### `people.csv`

```csv
id,name,role,clock_offset
google-pixel-8-pro,Priya,runner,
samsung-sm-f721w,Sam,,-PT4S
```

`id` is machine-written and matches the grouping key ingest derives from the
device. `name` is what appears everywhere in the UI and what `notes*.csv`
refers to. `role` is one of `runner`, `crew`, `friend`, `other`, or blank
(`ROLES` in `schema.ts`). `clock_offset` is an ISO-8601 duration.

**Corrected, 2026-07-30 — a `schema` column, and unknown columns are kept.**
`people.csv` gained the same per-row `schema` version `notes*.csv` did, and —
the fix that had to land first — it now preserves columns it does not
understand, exactly as `notes*.csv` always has via `Note.extra`. A roster
carrying `pronouns` lost it on every save; worse, a build without this would
have deleted the `schema` column itself on the next save, erasing the very
marker the version check depends on. They are held as `PeopleExtra` beside
`Person[]` rather than on `Person`, because `schema.ts` is the one notion of
what a person is and the manifest has no business carrying a spreadsheet's
spare columns.

**Corrected, people/notes alias join:** `PEOPLE_HEADERS` gained a fifth
column, `also_known_as` — a `;`-separated list, same convention as
`people`/`author` above:

```csv
id,name,role,clock_offset,also_known_as
google-pixel-8-pro,Priya,runner,,Google Pixel 8 Pro
samsung-sm-f721w,Sam,,-PT4S,
```

This is the fix for a gap the design above didn't anticipate: `name` is
mutable (the whole point of "rename each lane to whoever was carrying it"),
but `notes*.csv` refers to people by NAME, not `id` — deliberately, since an
id column would defeat the "hand-editable spreadsheet" property this whole
design exists for. A bare rename therefore orphaned every note already
written under the old name. `also_known_as` is the join that survives it:
`resolvePersonNames` (`core/people-csv.ts`) matches a note's `people`/
`author` entries against a person's current `name` **or** any entry here,
case-insensitively, and `applyRename` (same file) is what populates it —
pushing the previous name on, and rewriting already-loaded notes to the
current name — every time the site's own rename control is used. See
CLAUDE.md's notes-as-csv / clock-alignment sections for the full record,
including the chosen behaviour when a rename collides with another person's
existing name or alias (skip the alias and the rewrite rather than guess,
mirroring the `resolveNotePhotos` "never guessed at" rule above).

`displayName` (also `core/people-csv.ts`) is the corresponding read-side
fallback — `name`, then the first `also_known_as` entry, then the same
device-slug prettifier a never-renamed lane already used — so a hand-added
roster row with only an alias still labels its lane instead of showing
blank.

## Identity, and why merging needs no version control

**`id` is opaque and stable; `at` is ordinary data.** The owner initially
proposed the datetime as the primary key. Three problems killed it:

1. Spreadsheets silently reformat ISO timestamps on save, so the key changes
   for every row in the file at once.
2. Two people can write at the same second.
3. Editing a note's time changes its key, so a merge sees one edit as a delete
   plus an insert.

The cost of an id column is that a human might have to type one — so they
never do:

- The site writes an id for every note it creates.
- **A hand-added row leaves `id` blank**; the site mints one on load and writes
  it back on the next save.
- A **duplicated** id — the signature of a copied row — gets one side re-minted,
  because a duplicate is unambiguously a copy rather than an edit.

That makes ids globally unique in practice, which is what makes merging
trivial: **row-bind, dedupe by id, sort by `at`.** No conflict resolution, no
locking, no version control.

Two people who edited a copy of the same note produce two notes at the same
time. That is accepted, not an error:

> "i think it'll be okay if we end up making it look like 2 comments at the
> same time. that's okay. when we visualize it it'll show up one after the
> other."

## Reading: forgiving

Any file matching `notes*.csv` is a notes file — `notes.csv`,
`notes-priya.csv`, `notes_dan.csv` — which picks up the intended files without
sweeping in an unrelated spreadsheet.

**Corrected, 2026-07-30 — forgiving about SHAPE, strict about VALUE.** A
number that cannot be a real date or time is now refused with a per-row
problem rather than rolled over: `month` 13, `day` 32, `hour` 24, `minute` 60,
a two-digit year, a fractional minute. Every one of those was silently
accepted before, and every one then rewrote itself on the next save — so the
file stopped saying what its author typed and nothing reported it. They are
exactly what a drag-fill or a fat finger produces. A row from a `schema`
version this build does not know is refused the same way. Reading legacy
SHAPES, below, is unchanged.

**Strict on write, forgiving on read.** The site writes plain integers. It
accepts, because a file may have been written by hand or by an older version:

- integers, the normal case
- zero-padded strings — `07` for July
- a combined `date` column (`2026-07-25`, `7/25/26`, or an Excel serial
  number) and a combined `time` column (`15:45`, `3:45 PM`, or a day fraction)
- a combined ISO `at` column, as written before this change

Each is split into the five integer columns on read and written back that way,
so a file repairs itself the first time it is saved.

`duration` accepts an ISO-8601 duration, and a bare number read as minutes.

A row that cannot be read is **reported in the ingest report, never dropped
silently** — consistent with the unplaced-media tray.

## Writing: one download

Saving produces a **single zip** of the metadata files: `notes.csv`,
`people.csv`, `manifest.json`. One artefact to hand to someone.

Implementation note for the dependency budget: this needs a ZIP **writer**
only. A store-only (uncompressed) zip is about sixty lines — local file
headers, a central directory, and CRC-32 — and CSVs are small enough that
compression is pointless. **No dependency.** Consistent with the project
hand-rolling EXIF, ISOBMFF and GPX parsing for the same reason.

Import stays loose files, so no zip *reader* is needed: you unzip, edit in a
spreadsheet, and drop the CSVs back in the folder.

## The composer must write exactly these columns

> "we should make sure that in the UI the note button is also matching this set
> of specs, so when it is used to create a note it is writing the corret
> information to the correct file."

The note dock is the only way most people will ever create a note, so the
mapping is part of the format, not an implementation detail:

| Composer field | Column | Change needed |
|---|---|---|
| What happened | `text` | Newlines become spaces on write. |
| When | `year` `month` `day` `hour` `minute` | Split on write; the field stays one box. |
| Until (optional) | `duration` | Entered as an end time, stored as ISO-8601 elapsed. |
| Whose | `people` | **Now multi-select.** See below. |
| Written by | `author` | **New**, also multi-select. See below. |
| — | `tz` | Written only when it differs from the event's timezone. |
| — | `photo` | Filled only when captioning from the lightbox. |
| — | `id` | Minted at creation. Never shown. |

**The composer keeps one box for a time**, and keeps asking for an end time
rather than a duration, because "until 6:40" is how a person remembers a nap.
The conversion to five integers and an elapsed duration happens on write. The
UI shape and the file shape are allowed to differ, and here they should.

### `people` and `author` are both searchable multi-selects

`Whose` is a single `<select>` today. Both columns now hold any number of
names, so both get the same **searchable multi-select** — the control pattern
the owner asked for on the timezone field, on the same grounds: a list you
filter by typing beats a list you scroll.

Making them the same type rather than one singular and one plural is
deliberate. Two columns, one control, one parsing rule, one sentence to
explain. And multiple authors is a real case:

> "i guess you can have multiple authors as well. i can imagine multiple people
> writing down an experience all at the same time."

Choosing nobody in `people` means the note belongs to the event rather than to
a person — what the old "Everyone" option meant.

### `author` comes from a "you are…" setting, and never blocks writing

The site has never known who is using it. It gets a **"you are…" picker** —
which also takes more than one name, for two people working side by side —
defaulting to **unset**:

- Unset, you can still write notes; they are saved with `author` blank.
- On save, if any note has a blank author, it asks once and stamps them all.
- Set it, and every note you write is stamped as you go. The composer shows
  the field pre-filled, so a note someone else contributed can be re-attributed
  without changing the setting.

Kept in the browser's local storage, **not in the manifest** — it is a fact
about who is at this laptop, not about the event, and would be wrong the moment
the file is handed to someone else. This is the only thing the site persists
locally, and it holds no event data.

### Captions come from the lightbox

The caption field in the lightbox writes a note row with `photo` set to the
item's id, rather than writing `items[].note` in the manifest. Same file, same
merge, same round trip as every other note.

## Display

Three requirements, from the owner:

1. **Notes appear inline in the timeline at their time**, prefixed with the
   time exactly as photographs are labelled. The feed already interleaves them;
   this is a matter of matching the label treatment.
2. **A photo with a comment shows a small chat symbol** on its tile.
3. Hovering that symbol shows the comment; opening the photo shows it too.

The chat symbol is the discoverability fix: today a caption is invisible until
the lightbox is open, so nobody knows one exists.

## Migration

Old manifests keep working. On load, `manifest.notes[]` and `items[].note` are
read as before and folded into the in-memory note list. On save they are
written to `notes.csv` and **omitted** from the manifest. No schema version
bump is needed to *read* an old file; the writer simply stops emitting two
fields.

An author who never presses save loses nothing, and one who does gets the new
layout without being asked.

## Out of scope

- **Pointing at a remote metadata repo.** The owner's idea — *"we can store a
  separate repo with the metadata and this app has an option to point to a repo
  of metadata to populate"* — is a natural follow-on and gets its own spec. It
  depends on these formats existing. The constraint that will shape it: a
  static site can **read** from a repo but cannot write back, so saving means
  downloading and committing yourself.
- **Telling two people apart when they carry the same phone model.** Parked in
  `TODO.md` with what was researched.
- **A `km` column.** The course converts time to position, so storing it would
  duplicate something derivable and could contradict the time column.

## Testing

- `notes.csv` round-trips: write, read, and get identical notes back.
- The five integer columns parse to the right instant through `tz`, and
  through the event timezone when `tz` is blank.
- Legacy shapes are accepted and repaired on save: zero-padded numbers, a
  combined `date`/`time` pair, an Excel serial date, a day fraction, and a
  single ISO `at` column.
- `duration` round-trips as ISO-8601; a bare number is read as minutes; a
  blank means a moment.
- A span crossing midnight, a month end and a year end all resolve correctly —
  the cases an end-timestamp would have needed extra columns for.
- Text containing commas, quotes, semicolons and newlines survives a round
  trip, with newlines collapsed to spaces.
- A note beginning `=`, `+`, `-` or `@` is written escaped and read back
  unescaped.
- A file written with a BOM and one without both read correctly.
- Unknown columns survive a round trip.
- A malformed row is reported, and the rest of the file still loads.
- Blank ids are minted; duplicated ids are re-minted; existing ids survive.
- Row-binding three files yields the union, sorted by time.
- Names in `people` match case-insensitively; unknown names are preserved.
- An old manifest with `notes[]` and `items[].note` migrates to a notes file.
- Names in `people` match case-insensitively; unknown names are preserved.
