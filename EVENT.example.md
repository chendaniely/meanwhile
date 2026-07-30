# EVENT.md — where this copy's data lives

Copy this file to `EVENT.md` and fill it in. **`EVENT.md` is gitignored**, so
what you write stays on your machine and never ships with the app.

meanwhile is a renderer: it holds no event of its own. This file is how one
person's copy remembers which event they are working on and where its written
record is kept, without any of that leaking into the app everyone else clones.

`README.md` and `CLAUDE.md` both point here. If the file is absent, nothing
breaks — the app has no idea it exists, and you just open a folder as usual.

---

## The event

**Name:** <the event, as it appears in the site's title field>
**When:** <dates>
**Timezone:** <IANA zone, e.g. America/Los_Angeles>

## The written record

The part nobody can recreate — notes, the roster, and the manifest — lives in
its own repo, separate from the photographs.

**Repo:** <git URL>
**Cloned to:** <local path>
**Visibility:** <private / public — and note that notes carry real names>

Files it holds:

| | |
|---|---|
| `notes.csv` | What people wrote down |
| `people.csv` | Who was there, their roles, clock offsets, aliases |
| `manifest.json` | What the site derived from the photos |
| `*.gpx` / `*.tcx` | The track, if you keep it under version control |

## The photographs

**Folder:** <local path — this is the folder you open in the site>

Media stays here and is never committed anywhere. The site reads it off your
disk; nothing is uploaded.

## Working on it

Symlink the record into the photo folder so editing either place is one edit:

```sh
cd <photo folder>
ln -s <record repo>/notes.csv .
ln -s <record repo>/people.csv .
ln -s <record repo>/manifest.json .
```

Then: open the photo folder in the site → write notes → **Save** → unpack the
downloaded zip over the repo → commit.

## Anything else worth remembering

<Clock offsets you worked out, whose phone is whose, which files arrived
stripped of their timestamps, decisions you do not want to rediscover.>
