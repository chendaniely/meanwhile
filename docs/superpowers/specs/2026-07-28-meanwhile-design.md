# meanwhile — design

**Date:** 2026-07-28
**Status:** approved in brainstorming; not yet implemented
**Owner:** Daniel Chen (@chendaniely)

---

## 1. The problem

A friend ran a 100-mile ultramarathon. The runner, the crew, and friends
along the course all took photos and video. Those files now sit in four
separate phones and four separate cloud accounts, each an isolated,
chronological pile.

What is lost in that arrangement is **simultaneity**. Nobody can see that
while the runner was grinding up a climb at 2am, one crew member was asleep
in a car and another was boiling water at the next aid station. The
individual streams each tell a thin story; laid side by side on one clock,
they tell the race.

**meanwhile assembles many people's media onto one shared timeline so you
can see what everyone was doing in relation to everyone else.**

The ultra is the first real event, not the only intended one. Weddings,
trips, and conferences have the same shape. Nothing in the design may be
race-specific except where explicitly noted as optional (the course spine).

## 2. Name

`meanwhile`. Chosen over `sightlines`, `splitscreen`, `crosscut`,
`eyelines`, and `lightbox`. It is the caption you would write under every
lane — "meanwhile, at mile 62" — so the name states the feature in one
ordinary, warm word, and it generalizes past the race.

## 3. Shape of the system

Two artifacts sharing one pure kernel.

```
meanwhile/
  src/core/       pure TypeScript kernel. Schema + validation, clock-offset
                  math, grouping, timeline binning, the course spine.
                  No DOM, no Node APIs, no React. Relative imports only.
  src/viewer/     the site: React + Vite. Static, public, GitHub Pages.
  src/cli/        the ingest tool: TypeScript on Node, run via tsx.
  tests/          including core-purity.test.ts
```

### 3.1 The viewer

A **static public site on GitHub Pages**. It ships no media and no event
data — it is a renderer, not a locker. It has no backend and stores nothing
server-side. It loads a manifest and draws the views.

Two media modes:

- **Local mode (authoring).** You grant a folder via the File System Access
  API (`showDirectoryPicker`), with `<input type="file" webkitdirectory>` as
  the fallback. The page reads the files directly off disk and renders them
  as blob URLs. **Nothing leaves the machine** — a public site running a
  completely private session. Desktop only; see §7.
- **Remote mode (sharing).** The manifest carries URLs and the crew opens it
  on their phones.

### 3.2 The CLI

Runs locally on Node. Handles the ingest work a browser is bad at: shelling
out to `exiftool` when available for video metadata, pulling from a Google
Drive folder, and pushing media to a bucket. It writes `manifest.json`.

The CLI is TypeScript rather than Python **specifically so it imports
`src/core/` directly** instead of reimplementing the schema and parsing. See
§4.1.

### 3.3 The pure kernel

`src/core/` is shared by both artifacts and is where all the real logic
lives. It must stay free of React, Node, and browser globals, enforced by
`tests/core-purity.test.ts`. This is the same architecture that works well
in `color-combinations` and is deliberate, not incidental.

## 4. The manifest

`manifest.json` is **the entire interface between the two artifacts** and the
unit of sharing. It is hand-editable JSON so a name or a comment can be
fixed in a text editor with no build step.

```json
{
  "schema": 1,
  "event": {
    "title": "Cascade Crest 100",
    "timezone": "America/Los_Angeles"
  },
  "media": { "base": "https://media.example.com/cascade/" },
  "course": { "src": "sam-cascade-crest.gpx", "person": "sam" },
  "people": [
    { "id": "sam", "name": "Sam", "role": "runner", "clockOffset": "PT0S" },
    { "id": "dan", "name": "Dan", "role": "crew",   "clockOffset": "-PT47S" }
  ],
  "markers": [
    { "atDistance": 41.0, "label": "Hyak aid station" },
    { "at": "2026-08-22T12:38:00Z", "label": "Sunrise" }
  ],
  "items": [
    {
      "id": "a1f",
      "person": "sam",
      "at": "2026-08-22T13:12:04Z",
      "type": "photo",
      "src": "sam/IMG_4417.jpg",
      "gps": [47.39, -121.39],
      "note": "legs are gone but the sun is up"
    }
  ]
}
```

### 4.1 Schema drift is the main risk

Two codebases must agree on this file or the CLI writes manifests the viewer
silently misreads. Mitigations, all required:

- `src/core/schema.ts` is the **single source of truth**, imported by both
  the viewer and the CLI. A schema change therefore breaks both builds at
  once rather than one of them at runtime.
- Shared fixtures test the round trip: CLI writes → core validates → viewer
  reads.
- The manifest carries `"schema": 1` and the viewer refuses versions it does
  not understand, with a legible error rather than a broken render.

### 4.2 `src` resolves late

`items[].src` is either an absolute URL (used as-is) or a relative path.
Relative paths resolve against `media.base` **or** against the locally
granted folder, decided at render time.

This is the design's key flexibility: a Drive folder, an R2 bucket,
harvested Google Photos links, and a folder on the laptop are all
indistinguishable to the viewer. **The media-hosting question is answered
per-event, not once forever.**

## 5. The course spine

Optional, and the most valuable optional thing in the project. Given a GPX
(or TCX) track from the runner's watch:

```ts
parseGpx(xml) → Course
course.atTime(t)     → { distance, elevation, lat, lon }
course.atDistance(d) → { time, elevation, lat, lon }
```

A pure kernel module with no dependencies — GPX is just
`<trkpt lat lon><ele><time>`. Four capabilities fall out of it:

1. **A pluggable axis.** The cursor stays canonically a *time*; the axis
   chooses how to project it. Switching to distance re-spaces the lanes by
   mile, so photos visibly bunch at aid stations and thin out on climbs. It
   is a scale composition, not a second timeline.
2. **The elevation profile as the swimlanes' backdrop.** Lanes of photos
   sitting on the course profile, with a 3,000-foot climb at 2am where every
   lane goes silent. This is the signature image of the product.
3. **A map that needs no tiles.** The course draws as an SVG polyline with
   people plotted on it — zero dependencies, zero external requests. Basemap
   tiles are an optional later garnish, not a prerequisite.
4. **Automatic clock alignment.** The watch is GPS-synced, so the track is
   authoritative time. For any photo carrying GPS, locate that point on the
   track, read the track's time there, and the difference *is* that device's
   `clockOffset` — computed rather than eyeballed.

Markers may be given in distance (`atDistance`) or wall-clock (`at`); the
spine converts between them so markers land correctly on both axes.

## 6. The views

One state object, four projections:

```ts
{ cursor: Time, visible: Set<PersonId>, zoom, view, axis: 'time' | 'distance' }
```

Switching view changes only `view`. **The cursor survives every switch** —
scrub to 06:12 in the swimlanes, flip to the moment grid, and you are
looking at 06:12. That shared cursor is what makes the toggle feel like
goggles rather than four separate pages.

- **Swimlanes** (default) — one lane per person on a shared clock, over the
  elevation profile. Density blocks show where someone was shooting.
  **Gaps are the point:** the six-hour hole in the runner's lane while three
  crew lanes are busy *is* the story of the night section. Markers draw as
  vertical lines through every lane.
- **Feed** — the same items interleaved into one chronological scroll,
  tagged by person. This is the phone view, and the one the crew will
  actually open.
- **Moment grid** — everything captured within ±N minutes of the cursor, as
  a grid. The shareable one.
- **Map** — positions at the cursor on the course polyline. Auto-enables
  when GPS coverage clears a threshold and hides itself otherwise, so it is
  never a broken empty box.

**Cursor state lives in the URL** (`#t=2026-08-22T13:12Z&view=grid`), so any
moment is a link you can text to someone. This falls out of the state design
for free and is likely the feature people use most.

## 7. Ingest: what works and what does not

Each of these was verified during design, not assumed. They are recorded
because they are the kind of constraint that gets re-litigated later.

### Google Photos — export, do not integrate

The Photos Library API **cannot read an album your friends populated**. As of
March 31, 2025 Google removed the `photoslibrary.readonly` and `.sharing`
scopes; apps may only touch media they themselves uploaded. The only
remaining path is the session-based Picker API, which is a per-person
interactive step rather than a pollable feed.

Direct `lh3.googleusercontent.com` links *do* work for hotlinking and accept
size parameters, but harvesting them is manual per photo, they are
undocumented and can rotate, and turning off sharing kills all of them at
once. Usable as a host if that is what you have; not something to build a
pipeline on.

**The supported path:** use the album's **"Download all"** ZIP, unzip it, and
point local mode at the folder. Do *not* right-click-save from the web
viewer — that yields a re-encoded copy with metadata stripped, which
silently breaks the timeline.

EXIF and GPS **survive shared albums by default**; "Remove geo location" is
opt-in and off unless deliberately enabled.

### Google Photos → Google Drive — not a shortcut

There is no real copy path anymore. Auto-sync died in July 2019, and the
Drive desktop app stops accepting new backup folders on 2026-06-15 and stops
syncing existing ones on 2026-08-10. The only surviving integration runs the
wrong way ("Upload from Drive" *into* Photos). Routing through Drive means
download-then-re-upload — strictly more work than downloading alone.

Drive's real role is as a **collection point**, not a waystation: ask the
crew to drop originals into a shared Drive folder rather than to share a
Photos album.

### Strava — export, never the API

Strava's API agreement (effective 2024-11-11) **prohibits third-party apps
from displaying a user's activity data to anyone other than that user.** That
clause alone forbids meanwhile's entire purpose. Standard-tier developers
additionally need an $11.99/mo Strava subscription as of June 2026, plus
design-conformance requirements.

A **GPX the athlete exports himself is his own file, not API data** — no
agreement, no fee, no restriction. This also makes the feature independent of
Strava: Garmin, COROS, or the watch directly all work the same way.

### Local folders — desktop only

`showDirectoryPicker()` is Chrome/Edge/Opera. Safari does not support it on
macOS **or** iOS; Firefox does not either. `<input type="file"
webkitdirectory>` is the broad fallback.

This produces a natural and acceptable split: **local mode is for authoring**
on a desktop while assembling the event; **remote URLs are the shareable
artifact** the crew opens on phones. Nobody was going to select an 8GB folder
on an iPhone regardless.

### The data-quality rule

The single highest-leverage instruction to give contributors, and it belongs
in the README:

> **AirDrop or Drive. Never iMessage or WhatsApp.** Those recompress and
> strip EXIF, and a photo with no timestamp has no lane to sit in.

## 8. Clock alignment

Four devices disagree by seconds to minutes, and a point-to-point course can
cross a timezone. Without correction the timeline is subtly and
unfalsifiably wrong.

- `clockOffset` is **per person**, stored in the manifest.
- It is adjusted **centrally by the event author** — one file, one editor, no
  merge story. (Explicitly chosen over per-uploader adjustment, which would
  require a contribution and merge workflow.)
- Where the course spine and photo GPS exist, the offset is **computed
  automatically** (§5.4). Manual nudging — drag a lane until a known shared
  moment lines up, then re-export — is the fallback for GPS-less photos.
- Writing corrections back into the media files' own EXIF was considered and
  **deferred** to `TODO.md`.

## 9. Scope

### v1

- Local folder ingest (covers the Google Photos download path)
- Manifest load and export; `schema: 1` with version refusal
- Swimlanes, feed, moment grid, **and map** (the spine makes it tile-free)
- Course spine: GPX and TCX
- Elevation profile backdrop; time/distance axis toggle
- Markers, per-item notes
- Central clock alignment, automatic where GPS allows
- URL-encoded cursor state

### Deferred (see `TODO.md`)

- Google Drive folder adapter
- Bucket upload from the CLI
- FIT files (binary; needs a parser dependency)
- Basemap tiles under the course polyline
- EXIF write-back of corrected timestamps
- Per-person GPX tracks (schema should not preclude it)
- Per-uploader clock adjustment with a merge workflow

## 10. Non-goals

No backend. No user accounts. No media stored in git — four people across a
24-hour race is many GB of video, and git history would retain every byte
forever even after a delete. No runtime dependency on the Google Photos or
Strava APIs. No state-management library, no router.

## 11. Open questions for the next session

Deliberately unresolved; see `CLAUDE.md` §"Open questions" for the full list
with context.

1. Is the site public from day one, or private until the crew has seen it?
2. Does "role" (runner/crew/friend) carry any behavior, or is it a label?
3. What is the fallback lane for media with no usable timestamp?
4. Multi-day and multi-event: one manifest per event, or a collection?
5. Who writes the `note` comments, and when in the workflow?
