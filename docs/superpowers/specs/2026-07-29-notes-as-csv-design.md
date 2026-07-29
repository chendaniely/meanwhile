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
| Notes | `manifest.notes[]` | `notes*.csv` |
| Photo captions | `manifest.items[].note` | `notes*.csv`, `photo` column filled in |
| People, roles, clock offsets | `manifest.people[]` | `people.csv` |
| Everything else | `manifest.json` | unchanged |

The manifest's job becomes sayable in one line: **it describes the event and
caches what was read from the files; the CSVs hold what a person wrote.**

### A caption IS a note

Decided first, because it collapses two concepts into one. A caption is a note
whose `photo` column points at an item. One file, one editor, one merge, one
thing to explain. `items[].note` disappears.

## The files

### `notes*.csv`

```csv
id,date,time,until_date,until_time,tz,people,photo,author,text
n_k3f9x2,2026-07-25,15:45,,,,Priya,,Dan,wrong turn on the ridge
n_p1a7m4,2026-07-25,15:53,,,,Priya;Sam,PXL_20260725_215331309.jpg,Dan,the buckle
,2026-07-26,03:00,,06:40,,Sam,,Dan;Priya,asleep in the car
```

| Column | Meaning |
|---|---|
| `id` | Opaque, stable, machine-written. **May be blank** — see below. |
| `date` | `YYYY-MM-DD`. Required. |
| `time` | `HH:MM`, 24-hour. Required. Together these place the note in the timeline. |
| `until_date` | End of a span. **Blank means the same day as `date`** — only needed when something crosses midnight. |
| `until_time` | End of a span. Blank for a moment. |
| `tz` | IANA zone, e.g. `America/Denver`. **Blank means the event's timezone**, which is the normal case. |
| `people` | Who it is **about**. Semicolon-separated names. |
| `photo` | Item this is a caption for. Blank for a standalone note. |
| `author` | Who **wrote** it. Semicolon-separated names, same as `people`. |
| `text` | The note. Free text — see below. |

**Matched by header name, not column position**, so anyone may reorder columns
or insert their own. **Unknown columns are preserved on write** — if someone
adds `tags`, it survives the round trip. Losing a column someone typed into
would be the same class of failure as losing a note.

#### Why the date and the time are separate columns

> "most likely it'll be the same date, but different times and the user might
> just click drag/copy paste the date. while they are filling out times."

That ergonomic reason is real, and there is a stronger technical one.

**No format is safe from a spreadsheet except plain integers.** `2026-07-25`
alone in a cell is still a date to Excel, so splitting does not prevent
mangling. What splitting does is make mangling **recoverable**: Excel rewrites
a date as a serial number (`45861`) and a time as a fraction of a day
(`0.65625`). In one combined column a bare number is ambiguous. In separate
columns **the column says which it is**, so the worst case converts back
exactly.

Fully splitting into `YYYY,MM,DD,HH,MM` would be the only truly mangle-proof
option, since integers are never reformatted. It costs ten cells per note once
`until` is included, and the file stops being readable at a glance. Deferred
rather than rejected — the reader should be written so that adding those
columns later is additive.

#### `tz` is an IANA name, not an offset

An offset like `-06:00` is simpler but wrong on either side of a daylight-saving
change, and it says nothing about where the note was written. A zone name
resolves correctly whatever the date. Blank is the normal case and means the
event's timezone, so the column costs no typing until a note genuinely comes
from somewhere else — a crew member in a different zone, or an event that
crosses one.

Keeping it also makes the notes file **self-contained**: times stay
unambiguous when it is read without the manifest beside it.

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
samsung-sm-f721w,Sam,,PT-4S
```

`id` is machine-written and matches the grouping key ingest derives from the
device. `name` is what appears everywhere in the UI and what `notes*.csv`
refers to. `role` is `runner` or blank. `clock_offset` is an ISO-8601 duration.

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

**Strict on write, forgiving on read.** The site writes `YYYY-MM-DD` and
`HH:MM`. For `date` it accepts:

- `2026-07-25`
- `7/25/26` and `7/25/2026` — what a US-locale Excel writes back
- `25/07/2026` — and elsewhere
- a bare integer, read as an Excel serial date

For `time` it accepts `15:45`, `15:45:00`, `3:45 PM`, and a bare fraction read
as a portion of a day. **A combined `at` column is still accepted** for files
written before this change, and is split on read.

This is not indulgence. A spreadsheet **will** reformat dates, and a format
that breaks when it does is not a spreadsheet format. Same principle for
`people` (names matched case-insensitively; an unknown name is kept verbatim
and reported) and `photo` (full relative path, or a bare filename when it
matches exactly one item).

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
| When | `date` + `time` | Split on write; the field stays one box. |
| Until (optional) | `until_date` + `until_time` | `until_date` written only when it differs from `date`. |
| Whose | `people` | **Now multi-select.** See below. |
| Written by | `author` | **New**, also multi-select. See below. |
| — | `tz` | Written only when it differs from the event's timezone. |
| — | `photo` | Filled only when captioning from the lightbox. |
| — | `id` | Minted at creation. Never shown. |

**The composer keeps one box for a time**, not two. `YYYY-MM-DD HH:MM` is what
a person types in one go; splitting it into two inputs would slow down the very
path this feature exists to make fast. The split is a property of the file, and
the file is where drag-fill happens.

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
- Every accepted date and time format parses to the same instant, including
  Excel serial dates and day fractions.
- A blank `until_date` with a filled `until_time` means the same day; a span
  crossing midnight needs both and works.
- A blank `tz` resolves through the event's timezone; a filled one overrides it.
- Text containing commas, quotes, semicolons and newlines survives a round trip.
- A note beginning `=`, `+`, `-` or `@` is written escaped and read back
  unescaped.
- A file written with a BOM and one without both read correctly.
- A legacy combined `at` column is split on read.
- Blank ids are minted; duplicated ids are re-minted; existing ids survive.
- Row-binding three files yields the union, sorted by `at`.
- Unknown columns survive a round trip.
- A malformed row is reported, and the rest of the file still loads.
- An old manifest with `notes[]` and `items[].note` migrates to a notes file.
- Names in `people` match case-insensitively; unknown names are preserved.
