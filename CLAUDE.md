# CLAUDE.md — working rules and context for `meanwhile`

## STATUS: M0 + M1 done. Kernel exists; no views yet.

As of 2026-07-28 the repo builds, tests, and serves an empty shell.

**Built:** Vite + React + TS scaffold, brand tokens, `tests/core-purity.test.ts`,
`Makefile`, and the kernel so far — `schema.ts`, `time.ts`, `bytes.ts`,
`exif.ts`, `isobmff.ts`, `metadata.ts`. Plus `scripts/inspect-media.ts`
(`make inspect DIR=...`), which runs the real extraction over a real folder.
114 tests pass.

**Not built:** every view, folder ingest in the browser, the course spine.
`src/viewer/App.tsx` is a shell with an empty state.

**Do not describe anything below as implemented unless it is in the "Built"
list.** Check before you cite.

## START HERE: the plan

The v1 plan is 12 milestones, M0-M11, each independently verifiable. The full
plan with per-milestone verification criteria is in the session plan file; the
milestone list also lives in the task list. Current position: **M3 (browser
folder ingest) is next.**

Build order is not arbitrary — see "The course spine is built LAST" below.

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
- **Pixel `PXL_` filenames are UTC, not local**, so `parseFilenameTime()`
  refuses them. Pixel files carry full EXIF anyway, so nothing is lost.
- **WhatsApp names (`IMG-20260822-WA0001`) carry a date but no time.**
  Also refused — midnight is not where the photo was taken.
- **Node's type-stripping cannot handle TS parameter properties or `enum`.**
  `scripts/` and anything it imports must avoid both, or `make inspect`
  breaks.

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
| **Strava API** | **Forbidden for this use case.** The agreement (2024-11-11) bars third-party apps from displaying a user's activity data to anyone other than that user — exactly what meanwhile does. Plus $11.99/mo for Standard tier from June 2026. **Take a GPX export instead**, which also works for Garmin/COROS/any watch. |
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
page). No CSS framework. No map library or tile provider (the course spine
makes an SVG polyline sufficient). No runtime dependency on the Google Photos
or Strava APIs.

## Dependency budget

**Justify every addition in this file before installing it.**

Installed and why:

| Package | Why |
|---|---|
| `react`, `react-dom` | the viewer |
| `d3-scale`, `d3-time` | axis tick math only — no D3 selections, no D3 DOM |
| `vite`, `@vitejs/plugin-react`, `typescript`, `vitest` | build and test |
| `@types/react`, `@types/react-dom`, `@types/d3-*` | types for the above |
| `@types/node` | **dev-only, and confined to `tsconfig.node.json`.** The test suite reads files off disk and `vite.config.ts` reads `process.env`. `tsconfig.app.json` sets `"types": []` so it cannot leak into `src/` — that line is load-bearing. |

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
