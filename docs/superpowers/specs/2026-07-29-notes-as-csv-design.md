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
id,at,until,people,photo,author,text
n_k3f9x2,2026-07-25T15:45:00-06:00,,Priya,,Dan,wrong turn on the ridge
n_p1a7m4,2026-07-25T15:53:00-06:00,,Priya;Sam,PXL_20260725_215331309.jpg,Dan,the buckle
,2026-07-26T03:00:00-06:00,2026-07-26T06:40:00-06:00,Sam,,Dan;Priya,asleep in the car
```

| Column | Meaning |
|---|---|
| `id` | Opaque, stable, machine-written. **May be blank** — see below. |
| `at` | When it happened. Required. This is what puts the note inline in the timeline. |
| `until` | End of a span. Blank for a moment. Crewing is mostly spans: waiting, driving, sleeping. |
| `people` | Who it is **about**. Semicolon-separated names. |
| `photo` | Item this is a caption for. Blank for a standalone note. |
| `author` | Who **wrote** it. Semicolon-separated names, same as `people`. |
| `text` | The note. |

**Matched by header name, not column position**, so anyone may reorder columns
or insert their own. **Unknown columns are preserved on write** — if someone
adds `tags`, it survives the round trip. Losing a column someone typed into
would be the same class of failure as losing a note.

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

**Strict on write, forgiving on read.** The site writes ISO-8601 with the
event's UTC offset. It accepts:

- ISO-8601 with an offset, and without one (resolved through `event.timezone`)
- `2026-07-25 15:45` and `2026-07-25 15:45:00`
- `7/25/26 15:45` and `7/25/2026 3:45 PM` — what a US-locale Excel writes back
- Excel serial numbers (`45861.65625`)

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
| What happened | `text` | — |
| When | `at` | — |
| Until (optional) | `until` | — |
| Whose | `people` | **Now multi-select.** See below. |
| Written by | `author` | **New**, also multi-select. See below. |
| — | `photo` | Filled only when captioning from the lightbox. |
| — | `id` | Minted at creation. Never shown. |

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
- Every accepted datetime format parses to the same instant.
- Blank ids are minted; duplicated ids are re-minted; existing ids survive.
- Row-binding three files yields the union, sorted by `at`.
- Unknown columns survive a round trip.
- A malformed row is reported, and the rest of the file still loads.
- An old manifest with `notes[]` and `items[].note` migrates to a notes file.
- Names in `people` match case-insensitively; unknown names are preserved.
