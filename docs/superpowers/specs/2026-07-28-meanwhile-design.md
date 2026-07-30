# meanwhile — design

**Date:** 2026-07-28
**Status:** approved; M0-M1 implemented
**Owner:** Daniel Chen (@chendaniely)
**Revised:** 2026-07-28 (session 2) — see §12 for what changed and why

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

## 11. Open questions

1. Is the site public from day one, or private until the crew has seen it?
2. Multi-day and multi-event: one manifest per event, or a collection?
   *(Assumed one file is enough until told otherwise.)*
3. License.

## 12. Session 2 revisions (2026-07-28)

The design above stands except where noted here. Sections 3.2, 6, and 9 are
superseded by this one.

### 12.1 The CLI is deferred; v1 is viewer-only

§3.2 described an ingest CLI shipping alongside the viewer. Since only the
local-folder path matters right now, v1 ships **the viewer alone**: one
artifact, no install, no schema-drift risk yet.

`src/core/` is still written to be imported by a CLI unchanged — that is
exactly why deferring costs nothing — and `tests/core-purity.test.ts`
enforces it mechanically. The CLI arrives when bucket upload or
exiftool-grade video metadata is actually needed.

Two consequences, accepted knowingly:

- **Video timestamps must be parsed in the browser** (§12.3).
- **v1 cannot send the crew a link.** Sharing needs media at stable URLs,
  which is the deferred upload step. v1 is local authoring: point the site at
  a folder and look at the timeline.

### 12.2 `course` is a union, and the spine is built LAST

§5 assumed a GPX. The owner may only have a Strava URL at first, so `course`
becomes:

```ts
{ kind: 'gpx', src }          // full spine
{ kind: 'strava-embed', url } // opaque iframe, presentational only
{ kind: 'strava-link', url }  // hyperlink only
undefined                     // no course; time axis only
```

Verified: **a bare Strava activity URL is not embeddable.** The embed URL is
`.../activities/{ID}/embed/{CODE}` and `{CODE}` comes from Strava's share
dialog — it cannot be derived. The embed is an opaque iframe that cannot sync
to our cursor. Neither Strava path yields position-at-time; only a GPX does.

This sets the **build order**. Swimlanes on a time axis, the feed, and the
moment grid need no course data at all, so they come first and the spine
comes last — where it *lights up* the elevation backdrop, distance axis, map,
and automatic clock alignment without reworking anything. Missing course data
hides features rather than breaking them.

### 12.3 `timeSource` per item

New required field on every item, ordered most to least trustworthy: `gps`,
`exif-offset`, `qt-offset`, `exif-naive`, `filename`, `mvhd`, `manual`,
`none`. Two things depend on it.

**It marks confidence.** A timeline that is confidently wrong is worse than
one with visible gaps, and the worst offender is Apple's `mvhd`
creation_time: nominally UTC, but Apple writes *local* time there with no
zone, so trusting it shifts clips by hours with no error. Prefer
`com.apple.quicktime.creationdate`, which carries a real UTC offset.

**It gates clock correction.** Only device-clock sources get `clockOffset`
applied. A GPS timestamp came from satellites; a manual placement came from
the author. Correcting either would introduce the very error the offset
exists to remove.

Relatedly, `item.at` is the time **as recorded**, never corrected. Correction
happens at render time (§8), so adjusting one person's clock is a one-line
manifest edit rather than a rewrite of every item they shot.

### 12.4 Media with no usable timestamp: an unplaced tray

`timeSource: 'none'`, no `at`. Visible in a holding area, draggable onto the
timeline, which writes `at` and flips the source to `manual`. Chosen over
dropping (silent loss) and over inferring from file order (confidently
wrong).

### 12.5 Scale, and video

**Target: 8 people, ~2k files.** People are nearly free; files are what cost,
and swimlanes are free at any scale because they render binned marks rather
than images. Built in from the start because retrofitting is painful: blob-URL
revocation on scroll-out, `createImageBitmap(file, {resizeWidth})` to decode
downscaled off-thread, and `IntersectionObserver` lazy loading. Deferred:
windowed rendering (needed past ~5k) and generated thumbnails.

**Video is lots and mostly short.** It renders as a point on the timeline with
a poster frame, one clip playing at a time. `duration` is in the schema so
spans become possible later without a migration.

**HEIC** is readable but not displayable: iPhones shoot it by default and no
browser but Safari can decode it. Metadata parses fine (HEIC is ISOBMFF, the
same walker as MP4), so the item is still placed correctly — the tile shows a
placeholder.

### 12.6 Aesthetic: the brand's dark ramp

The owner's `_brand.yml` already contains a dark ramp, so "its own identity"
and "share the brand" were never in tension. No light theme.

Two values are derived rather than taken from the brand, because the brand's
own colors fail WCAG AA on `#171512`: links use `#4E8FBF` (5.3:1) instead of
`#236192` (2.8:1), and danger text uses `#D98BA3` instead of `#9A4665`
(3.0:1). Orange `#F26522` passes unchanged at 5.9:1 and is the cursor.

Atkinson Hyperlegible is self-hosted (~56KB) so the app shell itself makes
zero external requests. **Corrected post-M10:** the course view's map tiles
(OpenTopoMap, Esri/ArcGIS, OSM, and optionally Thunderforest) are external
and load unconditionally on every render — see the "no map library" rule's
reversal in `CLAUDE.md`. The optional Strava embed iframe is external too,
though it is click-to-load.
