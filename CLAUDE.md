# CLAUDE.md — working rules and context for `meanwhile`

## STATUS: M0-M8 and M10 done. The course view exists.

As of 2026-07-29 you can point the site at a folder and at a GPX/TCX and look
at the race. **286 tests pass** (`make check`).

**Built:** scaffold, brand tokens, `tests/core-purity.test.ts`, `Makefile`.
Kernel: `schema.ts`, `time.ts`, `bytes.ts`, `exif.ts`, `isobmff.ts`,
`metadata.ts`, `assemble.ts`, `palette.ts`, `window.ts`, `state.ts`,
`course.ts`. Viewer: folder/file picking, ingest report, manifest export, the
media pipeline, the two-handle time window with density histogram, the feed,
the swimlanes with a moment strip, the lightbox, the unplaced tray, and the
**course view** — Leaflet map with terrain basemaps, elevation/HR/cadence/pace
charts, and a shared distance focus linking the two. Plus
`scripts/inspect-media.ts` (`make inspect DIR=...`).

**Not built:** in-viewer notes/captions, automatic clock alignment (blocked —
needs a timed track, see below), Strava embed rendering, Pages deploy.

**Do not describe anything as implemented unless it is in the "Built" list.**
Check before you cite.

## START HERE

Remaining work: **M9** (in-viewer notes) and **M11** (Strava embed fallback,
GitHub Pages deploy with a `VITE_THUNDERFOREST_KEY` secret). Open questions
still unanswered: whether the repo is public from day one, and the license.


---

## What this is

A friend ran a 100-mile ultramarathon. The runner, the crew, and friends all
took photos and video, and those files now sit in four separate phones and
four separate cloud accounts.

What is lost is **simultaneity** — nobody can see that while the runner was
climbing at 2am, one crew member was asleep in a car and another was boiling
water at the next aid station.

**meanwhile assembles many people's media onto one shared timeline so you can
see what everyone was doing in relation to everyone else.**

The ultra is the first event, not the only one. Weddings, trips, and
conferences share the shape. Keep everything general except the course spine,
which is explicitly optional.

Full design: `docs/superpowers/specs/2026-07-28-meanwhile-design.md`.
Verbatim prompt history: `PROMPTS.md`.

---

## Decision record

Each entry says what was decided, why, and **what would have to change to
reverse it** — so a future session can re-open a decision without
re-deriving it.

### The site is a renderer, not a locker

Public static site on GitHub Pages that ships **zero media and zero event
data**. It loads a `manifest.json` and draws views. No backend, nothing
stored server-side.

*This came from the owner, not from Claude,* and it is the architectural
core. It solves privacy almost for free: your friends' photos never touch
this repo, and whoever controls the media host controls access.

**Reversing it** means adopting a backend, storage, and auth — a service
rather than a weekend project.

### One artifact for now: the viewer. The CLI is deferred. *(revised session 2)*

Session 1 chose to build a viewer **and** an ingest CLI. Session 2 revisited
this given that only the local-folder path matters right now, and **deferred
the CLI**: one artifact, no install, and no schema-drift risk yet.

`src/core/` is still written to be imported by a CLI unchanged — that is
precisely why deferring costs nothing. The purity test enforces it
mechanically. The CLI arrives when bucket upload or exiftool-grade video
metadata is actually needed, and `src/core/schema.ts` remains the single
source of truth both would import.

The cost of this choice, accepted knowingly: **video timestamps must now be
parsed in the browser**, which is the riskiest code in the build (see "The
video trap"). And **v1 cannot send the crew a link** — sharing needs media at
stable URLs, which is the deferred upload step.

The CLI language question (TypeScript vs Python) is therefore moot until the
CLI exists. If it is ever written in Python, the answer must include how the
two stay in sync: a JSON Schema contract plus round-trip fixtures on both
sides.

### The course spine is built LAST, and that is deliberate *(session 2)*

Everything except the spine works with **zero course data** — swimlanes on a
time axis, feed, and moment grid need no GPX at all. The GPX later *lights
up* the elevation backdrop, distance axis, map, and automatic clock alignment
without reworking anything already built.

So `course` is a union, and missing data hides features rather than breaking
them:

```ts
{ kind: 'gpx', src }          // full spine
{ kind: 'strava-embed', url } // opaque iframe, presentational only
{ kind: 'strava-link', url }  // hyperlink only
undefined                     // no course; time axis only
```

**A bare Strava activity URL is not embeddable.** The embed URL is
`.../activities/{ID}/embed/{CODE}` and `{CODE}` comes from Strava's share
dialog — it cannot be derived. An embed is an opaque iframe that cannot sync
to our cursor. Only a GPX yields position-at-time.

### `timeSource` is recorded per item *(session 2)*

Every item records where its timestamp came from: `gps`, `exif-offset`,
`qt-offset`, `exif-naive`, `filename`, `mvhd`, `manual`, `none` — ordered
most to least trustworthy. Two things depend on it:

1. The UI shows how much to trust a placement. **A timeline that is
   confidently wrong is worse than one with visible gaps.**
2. **Only device-clock sources get `clockOffset` applied.** A GPS timestamp
   came from satellites; a manual placement came from the author. Correcting
   those would introduce the very error the offset exists to remove. Enforced
   by `appliesClockOffset()` in `src/core/time.ts`.

`item.at` is always the time **as recorded**, never corrected. Correction
happens at render time, so adjusting one person's clock is a one-line
manifest edit rather than a rewrite of every item they shot.

### GPS time is NOT the shutter time — verified, do not re-order *(M3)*

The single most important correction so far, found only by running against
231 real files from the race. It is counter-intuitive enough that a future
session will be tempted to "fix" it back. Do not.

EXIF `GPSDateStamp`/`GPSTimeStamp` comes from satellites, so it looks like the
most authoritative timestamp available. It is not: **it timestamps the GPS
FIX, not the shutter.** Measured across 134 real photos that had both:

| | shutter minus GPS |
|---|---|
| median | **11 s** |
| p90 | 76 s |
| p99 | 399 s |
| worst | **919 s** (15 minutes) |
| within 2s | only 27 of 134 |

And the error is **non-uniform**, so photos taken seconds apart collapse onto
one instant. Before the fix, 27 distinct instants had collisions and up to
**seven different photos shared a single second** — destroying exactly the
relative ordering this app exists to show. A wrong timezone shifts everything
equally and preserves order; a stale fix does not. For a simultaneity app,
uniform error is far cheaper than non-uniform error.

Also decisive: **all 134 GPS-bearing photos also had a zoned shutter time,
and zero photos had GPS only.** Preferring GPS made 134 photos worse and
helped none.

So `gps` ranks BELOW the shutter sources. Its two remaining jobs:

1. Fallback when a file has no EXIF date at all.
2. **The clock-offset estimator for M10.** Note the right estimator is
   `min(shutter − gps)` across many photos, not the mean: fix staleness is
   one-sided (a fix always precedes the shutter), so the minimum is the
   freshest fix and therefore the true clock error. On this dataset the min
   was 0, correctly indicating an accurate camera clock.

Result on the real folder: `gps` 134 → 0, collisions 27 → 2, and the two
remaining are a duplicated file and a genuine 461ms burst that EXIF can only
record to the second.

Keep `isDeviceClock()` (provenance) separate from `TIME_SOURCE_RANK`
(accuracy). GPS is ranked low but is still *not* the device clock, so
`clockOffset` must not be applied to it.

### Metadata extraction gotchas *(learned building M2)*

Things a future session will otherwise rediscover the hard way:

- **`moov` is often at the END of a phone video.** Its size is unknown until
  recording stops. "Read the first megabyte and parse" therefore works on
  some clips and silently fails on others. Use `locateBox()` in
  `isobmff.ts` — it hops top-level box headers 16 bytes at a time, so
  finding `moov` in a 4GB file costs about three range reads.
- **`meta` is a FullBox in ISO BMFF but a plain container in some QuickTime
  writers.** Guessing wrong makes every child unreadable. `metaChildrenStart()`
  sniffs which layout it is.
- **In `ilst`, a box's four "type" bytes are an integer index into `keys`,
  not a 4CC.**
- **`filename` outranks `mvhd` on purpose.** Android filenames are honestly
  local wall-clock and resolve correctly through `event.timezone`; `mvhd` may
  be local time mislabelled as UTC and resolves to the wrong hour.
- **Pixel `PXL_` filenames are UTC, not local.** Confirmed three ways against
  real files: against a duplicate whose naive EXIF read six hours earlier in a
  UTC-6 zone, against `mvhd` minus clip duration, and against a zoned shutter
  time matching to the second. They also carry **milliseconds**
  (`HHMMSSmmm`) — a trailing-digit guard that forgets this rejects every
  Pixel name, which is how 15 real videos ended up on the `mvhd` fallback.
- **Android writes `mvhd` at the END of recording** (start + duration + ~2s),
  on both Samsung and Pixel. The filename records the start, which is what a
  timeline wants. Another reason `filename` outranks `mvhd`.
- **WhatsApp names (`IMG-20260822-WA0001`) carry a date but no time.**
  Also refused — midnight is not where the photo was taken.
- **Node's type-stripping cannot handle TS parameter properties or `enum`.**
  `scripts/` and anything it imports must avoid both, or `make inspect`
  breaks.

### Lane colors are validated, not chosen *(M3)*

`src/core/palette.ts` holds eight fixed hues. They are not a taste decision —
they were run through the dataviz skill's validator against this app's exact
surface (`#171512`) and pass the lightness band, chroma floor, CVD
separation, normal-vision floor, and contrast checks.

```
node scripts/validate_palette.js "<the eight>" --mode dark --surface "#171512"
```

Three rules that must not be broken:

1. **Color follows the person, never their position.** Hiding a lane must not
   repaint the others, so assignment keys off the manifest's people list.
2. **Never invent a ninth hue.** Person nine gets a neutral gray and the UI
   says so. A generated hue silently breaks every guarantee above.
3. **Adjacent-pair safety is not all-pairs safety.** Lanes, feed, and grid
   only put neighbors together, so adjacent is the right test and it passes.
   **The map is different** — any two dots can land side by side, and under
   `--pairs all` this palette fails past three people (worst pair ΔE 1.6
   under deuteranopia). **Map dots must carry the person's name as a direct
   label.** That is the secondary encoding that makes the map legible; it is
   not optional polish. Do not discover this again at M10.

### Identifying people in a FLAT folder *(M3, corrected against real data)*

The design assumed each person hands over a folder. **The real folder was a
Google Photos album download: one flat directory, three phones mixed
together** — so folder-based grouping produced a single useless person called
"Unsorted" holding all 231 files. That is the shape media actually arrives in.

Grouping now falls back to the **device**, using three signals, strongest
first. The order matters and was corrected against real data:

1. **EXIF Make/Model.** Clean for photos: Pixel 8 Pro / Galaxy Z Flip 4 /
   Pixel 9a separated exactly.
2. **The filename convention** (`filenameFamily`). Load-bearing, because
   **Android videos carry no device metadata at all** — 25 real clips had
   none. Phones name files distinctively and that survives when metadata does
   not.
3. **Proximity in time**, only among devices sharing a convention.

**Proximity was tried as the primary signal and is not good enough.** Two
people standing together shoot at the same moments, so it put all eight
Samsung-named clips on the Pixel's lane. They keep their own filenames
though, which is why the convention has to outrank the clock.

A convention no known device produces becomes **its own person** — the DJI
action camera nobody took stills with is genuinely a fourth lane.

Folders still win when they exist: the author put them there on purpose.

Result on the real folder: 1 useless lane → 4 correct ones, with 17 of 231
files resting on the weakest signal and the report saying so.

### Every object URL in the app comes from MediaStore *(M4)*

`URL.createObjectURL` pins its blob until `revokeObjectURL` is called.
Nothing collects it — not GC, not removing the `<img>`. One per tile while
scrolling 2,000 files and the tab grows until it dies. So
`src/viewer/media/store.ts` is the ONLY place that creates or revokes them,
and `tests/media-store.test.ts` fails if any URL is created and not revoked.

- **Thumbnails are refcounted and byte-budgeted.** Never evicted while a tile
  shows one (revoking under a live `<img>` blanks it); kept after release
  until the budget bites, because scrolling back up should not re-decode.
- **Originals are revoked the moment the last holder lets go.** One
  multi-gigabyte clip pinned in memory is a different order of problem.
- **Nothing is ever handed to an `<img>` at full size.** A 12MP photo decodes
  to ~48MB of RGBA regardless of file size; fifty is 2.4GB.
  `createImageBitmap(file, { resizeWidth })` resizes DURING decode on a worker
  thread, so the full-size buffer never exists on the main thread. Call
  `.close()` right after drawing — GC is far too late at 2,000 files.
- **`imageOrientation: 'from-image'`** applies EXIF rotation during decode.
  Tile aspect ratios must account for orientations 5–8 swapping width and
  height, or every portrait photo reserves a landscape box.
- **Video posters seek ~0.15s in, not to 0.** The first frame of a phone
  recording is usually black or mid-autoexposure. A codec the browser cannot
  handle never fires `seeked`, so the wait needs a timeout, not just events.
- **Once a seek is requested, ONLY `seeked` may report success.** Setting
  `currentTime` updates the property immediately while the seek is still in
  flight, and Chrome drops `readyState` back to 1 meanwhile because it is
  re-buffering. A second ready-signal (`canplay` after `loadeddata`) that
  re-checks "are we there yet" therefore reads a readyState that is
  momentarily too low and declares a perfectly good clip unplayable. This
  broke every video thumbnail once; `tests/video-poster.test.ts` drives a
  fake element through that exact sequence.
- **Only one video plays at a time**, tracked in `MediaContext`.

### One state object, four projections *(M5, M7)*

`src/core/state.ts` holds `{ view, cursor, range, visible }` and nothing else.
Switching view changes `view` alone, which is what makes the cursor survive
the switch — that shared cursor is the difference between goggles and four
separate pages.

It is mirrored into the URL hash, so any moment is a link. Two details that
matter:

- **The URL is written in an EFFECT, never inside the state updater.** An
  impure updater is exactly what React double-invokes to catch, and this
  project has already paid for that lesson once.
- **`replaceState`, not `pushState`.** Scrubbing a cursor would otherwise
  stack hundreds of history entries and make the back button useless.

`visible: null` means everyone, which is deliberately distinct from an empty
set meaning every lane hidden. `who=` in a URL is the latter.

### Swimlanes: the gaps are the encoding *(M7)*

Lanes are binned by **screen position**, not by fixed clock intervals, so a
gap you can see is a gap in the data at whatever zoom you are at. Fixed bins
would leave pixel-level gaps to the accident of where a boundary fell.

- **An empty lane is drawn, never omitted.** Someone asleep in a car for six
  hours is the point, not an absence of data.
- **`longestGap` is measured from the window edges**, not between the first
  and last item — otherwise someone who shot twice at the start and then
  stopped would report no gap at all.
- **A mark is never thinner than a quarter of the lane.** Presence must not
  be mistakable for absence, so a single photo reads as clearly as a burst.
- **D3 is used for tick placement only.** `scaleTime().ticks()` knows that
  every three hours beats every 2.8 hours. Nothing else goes through it.

**The lanes alone are not enough**, and the owner was right to say so:

> "just looking at when there are photos and events are not useful"

Marks on a track say activity happened without saying what it was, which is
most of the value. So `MomentStrip` sits underneath, showing the actual
photographs for whatever the cursor is on, **one row per lane and aligned
with the lane above** — the simultaneity claim made visible rather than
argued for. A person with nothing in the window gets a row saying "nothing",
because that absence is as much the story as the pictures.

Two details that make it usable rather than merely correct:

- **The scrub is NOT cleared when the pointer leaves the track.** The photos
  are below it; you have to be able to move down to them without the thing
  you were looking at vanishing on the way.
- **The window scales with the zoom** (`momentRadius`). A fixed radius fails
  at both ends: five minutes is invisible across two days, half an hour
  swallows everything when zoomed into one climb.

### Verifying in a browser: the tab must be VISIBLE

Chrome pauses `requestAnimationFrame` **and IntersectionObserver delivery**
for tabs whose `document.visibilityState` is `hidden` — which is what an
automation tab is whenever the Chrome window is not frontmost.

Everything lazy therefore appears broken: tiles never load, nothing decodes,
`MediaStore.stats()` shows zero. It looks exactly like a bug in the loading
code, and an hour was lost to that. **Check `document.visibilityState`
first.** Screenshots still work on a hidden tab, which makes it more
confusing, not less.

### Read as little of each file as possible *(measured)*

Ingest reads **metadata only**, and the sizes are chosen against the format,
not guessed:

- **JPEG: 128KB.** EXIF sits in an APP1 segment right after the two-byte SOI,
  and that segment's length field is 16-bit — so EXIF cannot exceed ~64KB
  however large the photo.
- **HEIC: 256KB head, then a second read of exactly the EXIF extent.** The
  item table is at the head but `iloc` can point the payload anywhere, so
  "read a big head and hope" is both wasteful and unreliable.
- **Video: `locateBox` hops top-level headers 16 bytes at a time**, then reads
  just the `moov` box. `moov` sits at 100% into every phone recording checked.

This was 4MB per photo until it was measured. On the real 2GB folder:

| | before | after |
|---|---|---|
| bytes read | 518 MB (25.5%) | **26.6 MB (1.3%)** |
| wall time | 409 ms | **101 ms** |

Every file resolved to the same time from the same source, verified by diff.

### Why display is fast, for the same reason *(measured)*

- **Thumbnails**: `createImageBitmap(file, { resizeWidth })` decodes AND
  resizes in one step on a worker thread, so the full-size buffer never
  exists on the main thread. A 4080x3072 photo is ~47MB decoded; the 480px
  thumbnail is ~41KB as a blob and ~0.6MB decoded. 60x smaller as bytes,
  80x smaller in memory.
- **Lightbox and video**: `URL.createObjectURL(file)` is **O(1)** — it
  registers a reference, it does not copy. Measured in Chrome: 1MB blob
  0.14ms, 50MB 0.55ms, 500MB 0.25ms. The differences are noise. The browser
  then reads from disk with its own native pipeline, which is why full-size
  photos open instantly and video scrubs.
- **The cost of that**: an object URL pins its blob until revoked. That is
  the whole reason `MediaStore` exists and why its test fails on any URL
  created and not revoked.

The user-facing version of all this is in `README.md` under "Why it's fast".
Keep the two in step — the numbers are measured, not estimated, so if the
read sizes change, re-measure rather than adjusting the prose.

### Two StrictMode hazards, both found the hard way

React runs every effect mount → cleanup → mount in development. Two patterns
that look right and are not:

1. **Observe in a ref callback, disconnect in a `useEffect(..., [])`
   cleanup.** The cleanup fires on mount and disconnects immediately, and the
   empty effect body has nothing to re-observe with. Use React 19's
   ref-callback cleanup instead, so attach and detach cannot drift apart.
   See `src/viewer/hooks/useInView.ts`.
2. **Create a resource with `useMemo`, dispose it in an effect cleanup.** The
   cleanup disposes the instance that was just created and is about to be
   used. Dispose the OUTGOING one when the new one is made instead. See the
   `MediaStore` construction in `App.tsx`.

### The time window *(built after the owner asked for it)*

> "i may not want to see all the photos listed in the timeline, and give me
> the ability to zoom into a certain part of the race"

`event.range` in the manifest, because cropping is authoring intent and must
survive export. Absent means "work it out": from the course when there is
one, otherwise `densestWindow()` — the cluster holding the most items, which
for a race folder is the race.

On the real folder that turns 46.6 days and 230 items into 47 hours and 142,
automatically.

**The histogram behind the handles is load-bearing, not decoration.** Across a
mostly-empty span there is no other way to see where the photos are.

**The chips are multi-select toggles.** Picking several spans them all, so
the pre-race night plus the race is two clicks. The result is a union SPAN,
because a range is contiguous by definition — so picking two non-adjacent
stretches necessarily sweeps up whatever sits between them. That is handled
by SHOWING it: a swept-up cluster gets a dashed "included" chip rather than
looking unselected while its photos are on screen. Never let a control lie
about what is visible.

**Two scales, and this is the part that was got wrong first.** Drawn linearly
over the whole folder, the single 42-day gap ate 90% of the track: handles
crowded into the last few pixels, one pixel was about seven hours, and
zooming *within* the race was impossible. So the slider covers an **extent**
— normally just what you are looking at — and a row of **cluster chips**
jumps between the stretches the data actually forms. "Whole folder" widens
the extent when you need to reach outside.

**The field is `range`, not `window`.** The core-purity test refuses
`window` because it shadows a host global — and it was right to: the first
wiring had `{placement && bounds && window && ...}`, which tested the
browser's always-truthy `window` object instead of the value.

### Ingest conventions *(M3)*

- **The top-level folder name is the person**, when subfolders exist at all.
  Otherwise group by device, above.
- **An item's id is its relative path.** Stable across re-ingests, which is
  what lets captions and hand-placed times survive re-reading the bytes. A
  counter or a content hash would lose them on any rename or re-save.
- **Re-ingest preserves author work, not stale metadata.** Names, clock
  offsets, notes, and `timeSource: 'manual'` placements carry over; an
  automatic timestamp is always re-read from the file.
- **`event.timezone` is not cosmetic.** It is what turns a naive camera
  timestamp into an instant, so changing it moves items in and out of the
  unplaced tray.

### Media with no usable timestamp goes to an unplaced tray *(session 2)*

`timeSource: 'none'`, no `at`. Visible in a holding area, draggable onto the
timeline, which writes `at` and flips the source to `manual`. Chosen over
dropping (silent loss) and over inferring from file order (confidently
wrong).

### The manifest is the contract

Hand-editable JSON, versioned (`"schema": 1`), carrying people, timestamps,
markers, notes, and media references. It is both the interface between the
two artifacts and the unit of sharing.

`items[].src` **resolves late**: an absolute URL is used as-is; a relative
path resolves against `media.base` *or* against a locally granted folder, at
render time. So Drive, a bucket, Google Photos links, and a local folder are
indistinguishable to the viewer, and the hosting question is answered
per-event rather than once forever.

### Four views, one cursor

Swimlanes (default), merged feed, moment grid, and map — **four projections
of one state object**, not four features:

```ts
{ cursor: Time, visible: Set<PersonId>, zoom, view, axis: 'time' | 'distance' }
```

The owner asked to "goggle" between them. The cursor **survives every
switch**, and lives in the URL (`#t=...&view=grid`) so any moment is a
textable link.

Design notes that matter: in the swimlanes, **gaps are the point** — the
six-hour hole in the runner's lane is the story of the night section. The
feed is the phone view and the one the crew will actually open.

### The course spine (GPX)

Optional, and the highest-value idea in the design. A pure, dependency-free
`src/core/course.ts` mapping between time, distance, elevation, and lat/lon.

It pays for itself four times: a pluggable time/distance axis; the elevation
profile as the swimlanes' backdrop; a **tile-free SVG map** (which is why the
map is in v1 rather than deferred); and **automatic clock alignment** —
match a photo's GPS to the GPS-synced track and the time difference *is* that
device's clock offset.

### Clock alignment is central, in the manifest

`clockOffset` is per person, stored in the manifest, adjusted **centrally by
the event author**. Chosen over per-uploader adjustment, which would require
a contribution and merge workflow.

The owner's phrase was "saved in metadata of the file," which was ambiguous
between the manifest and the media's own EXIF; they confirmed the manifest.
**EXIF write-back is deferred, not rejected** — worth re-asking, since it has
real archival appeal.

---

## Verified external constraints — DO NOT re-derive or assume around these

These were researched during design on 2026-07-28. They are the kind of thing
a future session will be tempted to assume works. It does not.

| Thing | Reality |
|---|---|
| **Google Photos Library API** | **Cannot read an album your friends populated.** The `photoslibrary.readonly` and `.sharing` scopes were removed 2025-03-31; apps may only touch media they uploaded. Only the session-based Picker API remains. |
| **Google Photos direct links** | `lh3.googleusercontent.com` URLs do hotlink and accept size params, but harvesting is manual per photo, they are undocumented, they rotate, and disabling sharing kills all of them. |
| **Google Photos download** | Use the album's **"Download all" ZIP**. Right-click-save from the web viewer returns a re-encoded copy with metadata stripped — a silent timeline-breaker. |
| **Google Photos EXIF/GPS** | **Survives shared albums by default.** "Remove geo location" is opt-in and off unless deliberately enabled. |
| **Photos → Drive copy** | No real path. Auto-sync died July 2019; the Drive desktop app stops accepting new backup folders 2026-06-15 and stops syncing existing ones 2026-08-10. Only "Upload from Drive" *into* Photos survives. Drive is a **collection point**, not a waystation. |
| **Strava GPX vs TCX** | **A GPX carries NO heart rate and NO cadence** — per Strava's own docs it has GPS, elevation, time, and power only from a real power meter. **TCX has heart rate, cadence and watts**, via `https://www.strava.com/activities/{ID}/export_tcx`. Both are XML, so both parse without a dependency. Ask for TCX. `Export Original` is a binary FIT and stays deferred. Pace and grade are in neither and are derived. |
| **Strava API** | **Forbidden for this use case.** The agreement (2024-11-11) bars third-party apps from displaying a user's activity data to anyone other than that user — exactly what meanwhile does. Plus $11.99/mo for Standard tier from June 2026. **Take a GPX export instead**, which also works for Garmin/COROS/any watch. |
| **Strava GPX export** | **May contain NO `<time>` elements whatsoever.** The owner's real file is 120,909 points of lat/lon/ele and not one timestamp — a *route* export rather than an *activity* export, though the extension, the `creator="StravaGPX"` attribute and the filename are identical. Always check before assuming a track is timed. `Course.timed` carries the answer. |
| **Interpolating missing times** | **Forbidden.** Spreading a known start and finish evenly over an untimed course puts the runner's marker confidently in the wrong place for most of a hundred-miler, whose pace varies several-fold between the first climb and 4am. An absent feature is honest; a fabricated one corrupts the simultaneity the app exists to show. |
| **Real track sizes** | 120k points is normal, not pathological. `Math.min(...array)` **throws `RangeError`** at that length — every argument becomes a stack slot. Accumulate in a loop. Polylines and SVG paths need `simplify()` (Ramer–Douglas–Peucker) before rendering; uniform decimation rounds off the switchbacks that make a mountain course recognisable. |
| **`showDirectoryPicker()`** | Chrome/Edge/Opera only. **Not Safari on macOS or iOS. Not Firefox.** `<input type="file" webkitdirectory>` is the fallback. Hence: local mode is for desktop authoring, remote URLs are the shareable artifact for phones. |
| **Strava embeds** *(v2)* | Embed URL is `.../activities/{ID}/embed/{CODE}`. `{CODE}` comes from Strava's share dialog and **cannot be derived from an activity URL.** The embed is an opaque iframe — it cannot sync to our cursor and yields no position-at-time. |
| **Apple `mvhd` timestamps** *(v2)* | MP4/MOV `mvhd` creation_time is nominally UTC, but **Apple writes LOCAL time there with no zone.** Trusting it shifts clips by hours with no error. Prefer `com.apple.quicktime.creationdate`, which carries a real UTC offset. |
| **HEIC** *(v2)* | iPhones shoot it by default and **no browser but Safari can decode it.** Metadata is readable (HEIC is ISOBMFF, same walker as MP4), so the item still gets placed — but the image will not render and needs a placeholder tile. |

**The data-quality rule** — the highest-leverage sentence in the README:

> **AirDrop or Drive. Never iMessage or WhatsApp.** Those recompress and strip
> EXIF, and a photo with no timestamp has no lane to sit in.

---

## Architecture rules

- `src/core/` is a **pure TypeScript kernel**: schema and validation, clock
  math, grouping, timeline binning, the course spine. Only relative imports
  of other core files; no React, no Node APIs, no browser globals. Enforced
  by `tests/core-purity.test.ts` — **never weaken that test.** It has been
  verified to fail on both a package import and a DOM global.
  - Two consequences it already forces: GPX parsing cannot use `DOMParser`,
    and metadata extraction takes an `ArrayBuffer`, never a `File` or `Blob`.
    Turning a file into bytes is the viewer's job.
  - `TextDecoder`, `Intl`, and `Date` are allowed: ECMAScript/WHATWG globals
    present identically in Node and browsers, not DOM APIs.
- Nothing outside `src/core/schema.ts` may define its own notion of the
  manifest.
- The viewer reads ONLY a validated, schema-versioned manifest. It refuses
  unknown `schema` values with a legible error rather than a broken render.
- App state is one serializable object, and the parts that matter are
  reflected in the URL.
- All D3 usage stays confined to scale/axis math (`d3-scale`, `d3-time`).
- **Media never goes in git.** Four people across a 24-hour race is many GB of
  video, and git history retains every byte forever even after a delete.

## Deliberate YAGNI — do NOT add these "helpfully"

No backend. No user accounts. No state-management library. No router (single
page). No CSS framework. No runtime dependency on the Google Photos or Strava
APIs.

~~No map library or tile provider.~~ **Reversed 2026-07-29 by the owner**, who
asked to "re-create bits of the strava/garmin interface" and then said: *"i like
maplibre/leaflet ... for a mountain trail race, if there are tiles in
openstreetmap that can overlay to make the terrain nicer, please add those in;
i'm less worried about large external dependencies (we need the maps)."* The
original reasoning was that the course spine makes a bare SVG polyline
sufficient. That is true for *where the line goes* and false for *where the line
is* — a naked polyline of a mountain race shows no ridges, no valleys, no
switchbacks, and no aid-station roads, so it cannot answer the question the map
exists to answer. See the dependency budget for what was chosen and why.

## Dependency budget

**Justify every addition in this file before installing it.**

Installed and why:

| Package | Why |
|---|---|
| `react`, `react-dom` | the viewer |
| `d3-scale`, `d3-time` | axis tick math only — no D3 selections, no D3 DOM |
| `vite`, `@vitejs/plugin-react`, `typescript`, `vitest` | build and test |
| `@types/react`, `@types/react-dom`, `@types/d3-*` | types for the above |
| `jsdom` | **dev-only.** React lifecycle bugs can only be caught by mounting — the store was fine in isolation, its lifecycle was not, and that shipped a screen where every photo read "cannot display this file". See `tests/media-store-lifecycle.test.tsx`. Vitest still defaults to the `node` environment; files opt in with a `// @vitest-environment jsdom` docblock. |
| `@types/node` | **dev-only, and confined to `tsconfig.node.json`.** The test suite reads files off disk and `vite.config.ts` reads `process.env`. `tsconfig.app.json` sets `"types": []` so it cannot leak into `src/` — that line is load-bearing. |
| `leaflet`, `@types/leaflet` | **The map.** Chosen over MapLibre: MapLibre renders vector tiles, and every hosted vector-tile source worth using needs an API key, so it would have made the map *fail closed* without one. Leaflet draws raster tiles, and raster terrain sources exist that need no key at all — so the map works the instant you open the page. It is also ~42KB gzipped against MapLibre's ~200KB. **`leaflet` is the only viewer-side runtime dependency that touches the network**, and only for tiles. It stays out of `src/core/` — the purity test enforces that. |

**Not installed, deliberately:**

- **No EXIF library.** We need a narrow slice (DateTimeOriginal,
  OffsetTimeOriginal, GPS, orientation) and the ISOBMFF walker for video has
  no good tiny dependency anyway. A focused TIFF/IFD walker is ~250 lines and
  keeps `core/` dependency-free. *Escape hatch:* `exifr` is the pre-approved
  fallback if this bogs down — but justify it here first.
- **No XML parser.** GPX and TCX are XML, but `DOMParser` is a browser global
  and `core/` must run under Node too. `course.ts` hand-rolls a small scanner.
  This is why a future CLI gets GPX support for free.

FIT is binary and would need a real dependency, which is why it is deferred.

## The documentation contract

This project is **vibe-coded**: the owner does not read
JavaScript/HTML/CSS, and Claude is the only maintainer. **Wrong documentation
is worse than no documentation.** Any change affecting setup, commands,
structure, or behavior MUST update the affected docs in the SAME commit:

- `README.md` — what it is plus complete setup/run/deploy instructions,
  written for a non-JS reader. Never document a command that does not work.
- `Makefile` — must always match reality; every target works. Run
  `make help` to see them. A Makefile that lies is worse than none.
- `PROMPTS.md` — append-only log of the owner's prompts (**verbatim**) and
  the decisions made. Every session, append.
- `TODO.md` — anything deliberately deferred.
- `TODO-completed.md` — move items here when done, with the commit hash.
- `CHANGELOG.md` — on every release, pair what changed with the owner's
  guiding prompt(s), quoted verbatim from `PROMPTS.md`. The point is to show
  the project is human-guided, not blindly vibe-coded. Keep that framing.
- The spec in `docs/superpowers/specs/` — update if the design changes.

## Aesthetic — RESOLVED *(session 2)*

meanwhile runs permanently on the **dark ramp of the owner's `_brand.yml`**
(github.com/chendaniely/chendaniely.github.io). That file already contains a
dark ramp, so "its own identity" and "share the brand" were never in tension.

**There is no light theme**, and adding one means re-deriving every contrast
pair. Tokens live in `src/viewer/styles/tokens.css`.

Two values are **derived, not from the brand**, because the brand's own
colors fail WCAG AA on the dark ground. Do not "fix" these back:

| Token | Value | Why not the brand value |
|---|---|---|
| `--mw-link` | `#4E8FBF` (5.3:1) | brand `#236192` is **2.8:1** on `#171512` — unreadable |
| `--mw-danger` | `#D98BA3` (7.2:1) | brand `#9A4665` is **3.0:1** |

Orange `#F26522` passes unchanged at 5.9:1 and is the cursor accent.
`--mw-fg-faint` is 4.1:1 and is **borders and decoration only, never text**.

Atkinson Hyperlegible is **self-hosted** (`src/viewer/fonts/`, SIL OFL, ~56KB)
so the site makes zero external requests. The only external request meanwhile
ever makes is an optional Strava embed iframe.

## Scale target *(session 2)*

**8 people, ~2k files.** People are nearly free — a layout and color
question, capped near 8 by categorical-color distinguishability. Files are
what cost, and swimlanes are free at any scale because they render binned
marks rather than images.

Built in from the start because retrofitting them is painful:

- **Blob URLs must be revoked** on scroll-out. Local mode creates one per
  file; without revocation memory grows until the tab dies.
- **Decode downscaled.** A 12MP photo decodes to ~48MB; fifty on screen is
  2.4GB. `createImageBitmap(file, {resizeWidth})` off-thread is the fix.
- Lazy loading via `IntersectionObserver`.

Deferred: windowed rendering (needed past ~5k files) and CLI-generated
thumbnails. Both additive.

---

## Open questions for the owner

Ask these. Do not answer them unilaterally.

1. **Public from day one?** The site is public by design, but the *manifest*
   for your friend's race is a separate choice. Public repo with a private
   manifest, or keep the whole thing unlisted until the crew has seen it?
2. **Scope of an event.** One manifest per event. Does a multi-day event, or
   a series (training runs leading up to the race), need a collection
   concept, or is one file always enough? *(Assumed: one file is enough.
   YAGNI until told otherwise.)*
3. **License.** Still unchosen.

### Answered in session 2 — do not re-ask

`role` carries behavior (runner pinned top, owns the spine) · no-timestamp
media goes to an unplaced tray · notes are written in-viewer and exported ·
aesthetic is the brand's dark ramp · CLI is deferred so its language is moot ·
lots of short video, treated as points with `duration` in the schema · 8
people / ~2k files.
