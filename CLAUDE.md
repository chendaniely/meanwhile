# CLAUDE.md — working rules and context for `meanwhile`

## STATUS: M0-M11 done. Notes and people now live in CSV, not the manifest.

As of 2026-07-30 you can point the site at a folder — with photos, an
optional GPX/TCX, and optional `notes*.csv`/`people.csv` files — and look at
the race. **766 tests pass** (`make check`).

**Built:** scaffold, brand tokens, `tests/core-purity.test.ts`, `Makefile`.
Kernel: `schema.ts`, `time.ts`, `bytes.ts`, `exif.ts`, `isobmff.ts`,
`metadata.ts`, `assemble.ts`, `palette.ts`, `window.ts`, `state.ts`,
`course.ts`, `csv.ts`, `notes.ts`, `people-csv.ts`, `timeline.ts`. Viewer: folder/file
picking, ingest report, the media pipeline, the two-handle time window with
density histogram, the feed, the swimlanes with a moment strip and notes in
the lanes, the lightbox, the unplaced tray, and the **course view** — Leaflet map with
terrain basemaps, elevation/HR/cadence/pace charts, and a shared distance
focus linking the two. Plus `scripts/inspect-media.ts` (`make inspect
DIR=...`), and two doc guards that gate `make check`:
`scripts/check-test-count.mjs` and `scripts/check-owner-quotes.mjs`
(`make check-quotes`).

Also built: in-viewer notes and captions, people renaming and the runner
role, and the Strava link/embed fallback. The Pages workflow is committed at
`.github/workflows/pages.yml`, and the deployed build carries Google
Analytics gated to which of the three views is open and nothing else
(`src/viewer/analytics.ts#trackView`, `make dev` sends none of it — see
"Analytics learns the view, and nothing else"). Notes, photo captions, and
the people roster now read from and write to `notes*.csv` and `people.csv`
rather than the manifest — several people's files merge by row-binding, every
file is editable by hand in a spreadsheet, and **Save** downloads one zip of
`notes.csv`, `people.csv`, and `manifest.json` (a store-only ZIP writer,
`src/viewer/media/zip.ts`, no dependency), named with the event and the
moment of saving (`filenameForSave()` in `src/viewer/App.tsx`, pinned by
`tests/save-filename.test.ts`). Both CSVs carry a per-row `schema`
version, a range-checked timestamp, and — for notes — `tz`/`utc_offset_min`,
`written` and `deleted`; see "The format hardening" in the decision record.
`EVENT.md` is the per-copy, gitignored pointer to where one owner's copy of
the site keeps that event's data (a separate private repo, see below);
`EVENT.example.md` is the committed template everyone else starts from.

**Not built:** automatic clock alignment (no longer blocked — the owner
supplied a real timed activity export on 2026-07-29 and it parses; the
estimator itself was simply never written, see `TODO.md`), reading a saved
zip back in (only writing one exists — see `TODO.md`), aid stations, and
everything else in `TODO.md`.

**Do not describe anything as implemented unless it is in the "Built" list.**
Check before you cite.

## START HERE

**M0-M11 are done.** What is left is not a milestone but a short list of
loose ends — most blocked on the outside world, one no longer blocked but
simply not yet written:

- **Automatic clock alignment** — no longer blocked, just unwritten. This
  waited on a *timed* track, because the first export was a route export with
  no timestamps to align against; the owner supplied a real activity export on
  2026-07-29 and it parses. No estimator has been written yet.
- ~~**Turning on GitHub Pages**~~ **Done.** *Settings → Pages → Source →
  GitHub Actions* is flipped, the `Pages` workflow deploys successfully, and
  the site is live at https://chendaniely.github.io/meanwhile/ (verified:
  `gh api repos/chendaniely/meanwhile/pages` reports `build_type: workflow`;
  the URL returns HTTP 200).
- **The license** — deferred with a constraint. See the decision record.
- **Aid stations**, and the rest of `TODO.md`.


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
time axis and the feed need no GPX at all. The GPX later *lights up* the
elevation backdrop and the map without reworking anything already built. (The
"moment grid" and "automatic clock alignment" that the original design
expected to fall out of this were never built — see "Three views, one
cursor" and the STATUS section above.)

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

Every item records where its timestamp came from: `manual`, `exif-offset`,
`qt-offset`, `exif-naive`, `qt-naive`, `gps`, `filename`, `mvhd`, `none` —
ordered most to least trustworthy (`TIME_SOURCE_RANK` in
`src/core/schema.ts`). Note `gps` sits below every shutter source, not above
— see "GPS time is NOT the shutter time — verified, do not re-order" below
before touching this order. Two things depend on it:

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

That validator is an external tool the dataviz skill provides — there is no
`scripts/validate_palette.js` in this repository. Re-running the check means
invoking the skill's validator against the eight hues in `LANE_COLORS`, mode
dark, surface `#171512`.

Three rules that must not be broken:

1. **Color follows the person, never their position.** Hiding a lane must not
   repaint the others, so assignment keys off the manifest's people list.
   **This is a calling convention, not something the function enforces.**
   `assignLaneColors()` assigns by slot index over whatever array it is
   handed, so passing it a *filtered* list silently repaints everyone — pass
   the full `manifest.people` and filter afterwards. All seven current call
   sites do. `tests/assemble.test.ts` pins the real behavior, including the
   case where removing one person does change another's color.
2. **Never invent a ninth hue.** Person nine gets a neutral gray and the UI
   says so. A generated hue silently breaks every guarantee above.
3. **Adjacent-pair safety is not all-pairs safety.** Lanes, feed, and grid
   only put neighbors together, so adjacent is the right test and it passes.
   **The map is different** — any two dots can land side by side, and under
   `--pairs all` this palette fails past three people (worst pair ΔE 1.6
   under deuteranopia). **Map dots carry the person's name, but only as a
   hover tooltip** (`CourseMap.tsx`, `.bindTooltip(name, { direction: 'top'
   })`, no `permanent`) — it shows one name at a time, on the dot the pointer
   is over. A permanent, always-on label was the original intent, but the
   dots are one per PHOTOGRAPH, not one per person: with 200+ photos in view,
   permanent labels would overlap into an unreadable mess. **This leaves a
   real, unresolved gap**: colour alone distinguishes two adjacent dots until
   you hover one of them. See `TODO.md` for the standard fix (a second visual
   channel that scales, such as per-person marker shape) — it is an open
   decision for the owner, not yet built.

### The course line is CASED, and the colour is measured *(M10)*

The owner: *"the orange line on the orange topo map is barely visible."*
Correct, and measurable. Sampling `#F26522` against real tiles:

| Basemap | share of tile below 3:1 |
|---|---|
| OpenTopoMap | **87.6%** |
| Esri satellite | **99.4%** |

**No single colour fixes this**, which is the important part — white disappears
on the pale topo map (99.9% failing), dark disappears on dark satellite
imagery (53% failing). Map imagery is arbitrary, so contrast against it cannot
be solved by choosing a hue.

The fix is a **casing**: a dark stroke under a lighter core, so the line's
silhouette carries both a light and a dark edge and one of them always
contrasts. With a `#171512` casing at weight 7, the most saturated
brand-consistent core that clears 3:1 across both basemaps is **`#F7A37A`**
(brand orange mixed 40% toward white) at weight 3 — 0.0% of either tile below
3:1, worst case 3.89 on topo and 4.28 on satellite.

Method: fetch a tile covering the course, compute the WCAG contrast ratio per
pixel against the candidate, and take the share below 3:1 — the worst patch is
what matters, not the average, because a line is unreadable wherever it
crosses that patch. **If the colour changes, re-measure. Do not eyeball it.**

Photo dots and the runner marker carry the same dark ring for the same reason.

### The map wheel zooms, deliberately *(M10)*

The conventional choice is to require ctrl/⌘ so the page can scroll past the
map. Reversed at the owner's request: *"an app like this is mostly going to be
used with only a mouse/trackpad."* Exploring the course IS the reason to be
here, so putting the primary interaction behind a modifier gets it backwards.
Keyboard zoom remains for accessibility.

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

### Long-lived object URLs all come from MediaStore *(M4)*

`URL.createObjectURL` pins its blob until `revokeObjectURL` is called.
Nothing collects it — not GC, not removing the `<img>`. One per tile while
scrolling 2,000 files and the tab grows until it dies. So
`src/viewer/media/store.ts` is the only place that hands an object URL to
anything on screen, and `tests/media-store.test.ts` fails if any URL it
creates is not revoked.

Two other call sites create one too, but neither is a copy of this risk:
`decodeVideoPoster` in `src/viewer/media/thumbnails.ts` creates a URL to feed
a `<video>` element for one frame grab and revokes it in a `finally` block
before returning, and the Save-button handler in `App.tsx` creates a URL for
the downloaded zip, clicks the anchor, and revokes it immediately after —
both create and revoke within the one function call that needs the URL, so
neither ever hands a live one to a component or holds it past that call.

- **Thumbnails are refcounted and byte-budgeted.** Never evicted while a tile
  shows one (revoking under a live `<img>` blanks it); kept after release
  until the budget bites, because scrolling back up should not re-decode.
- **Originals are revoked the moment the last holder lets go.** One
  multi-gigabyte clip pinned in memory is a different order of problem.
- **No TILE is ever handed an `<img>` at full size.** A 12MP photo decodes
  to ~48MB of RGBA regardless of file size; fifty is 2.4GB. The lightbox is
  the deliberate exception — it shows ONE photograph, and handing it the
  original is why full-size opens feel instant (see "Why display is fast").
  The rule is about the many, not the one.
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
- **Only one video plays at a time, by construction rather than by tracked
  state.** Playback only happens in the lightbox (`Lightbox.tsx`), and the
  lightbox shows exactly one item — so two clips playing at once cannot
  arise, and nothing has to enforce it. `MediaContext` used to track which
  clip was playing; it no longer needs to, and no longer does.

### One state object, three projections *(M5, M7)*

`src/core/state.ts` holds `{ view, cursor, range, visible }` and nothing else.
Switching view changes `view` alone, which is what makes the cursor survive
the switch — that shared cursor is the difference between goggles and three
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

### Scroll tracking: measure, do not trust observer order *(UI pass)*

> "sometimes when i'm scrolling with the note screen open the time is jumping
> like crazy sometimes is jumping between hours and minutes"

The feed's scroll-spy reported the **first intersecting entry** from an
`IntersectionObserver` over a thin band. **The `entries` array is not ordered
by position on the page.** Scroll quickly and several moments cross the band
between callbacks, so "the first one" is arbitrary among them — on a folder
spanning days that reads as the time jumping by hours.

The observer is now used only for what it is good at, knowing cheaply which
sections are on screen; the choice among those is made by **measuring against
the centre line of the viewport**, which is also the rule the owner asked for.
Distance is to the centre LINE, not to a section's midpoint, so a grid taller
than the screen still wins. Only the few visible sections are measured, and it
is throttled to an animation frame. A `scroll` listener is needed as well as
the observer: scrolling *within* one long moment fires no intersection events.

### Everything is 24-hour, including the inputs *(UI pass)*

`time.ts` sets `hourCycle: 'h23'` everywhere. The one exception was
`<input type="datetime-local">`, which Chrome renders in the **browser's**
locale and which **ignores the element's `lang`** — so a US machine showed
`3:45 PM` in the middle of an otherwise 24-hour app.

Replaced with a plain text field in `YYYY-MM-DD HH:MM`, validated as you type.
The native picker is worth less here than consistency: the value is normally
pre-filled from the cursor, so what is left is editing minutes. A 12/24-hour
setting is in `TODO.md`, deferred by the owner.

### The timeline's bounds include NOTES, not just photos *(UI pass)*

Found by writing a note after the last photograph and watching it vanish.
`bounds` came from `fullSpan(placement.placed)` — photos only — and
`clampWindow` clamps every requested crop to it, so a note outside the
photographic span could not be shown **at any window setting**. Widening did
nothing, which looked like the crop being broken.

A note is an event on the timeline, so it belongs in the timeline's extent.
Related: the `range` memo read `view.range` without depending on it, so the
crop only refreshed when something else happened to change.

**Notes still follow the crop like photos do** — but a note that lands outside
it says so, with a "Show it" action. Writing something and watching it
disappear is the one outcome worth spending UI on.

### Leaflet's stacking beats anything under z-index 1000 *(UI pass)*

The note dock was `z-index: 50` and opened UNDERNEATH the map on the course
page. Leaflet's own panes and controls run up to 1000, so anything meant to
float over a map has to clear that. The dock is 1200.

### One action, one name, one control *(consistency pass)*

> [...] "save manifest" but the expanded event settings has "export
> manifest.json" i perfer the simplier term, but it needs to be consistent.
> [...]

Two controls for one action, under two names. The rules that came out of
auditing every user-visible string:

- **One control per action.** Opening, adding and saving all live in the top
  bar. The reference panel has buttons of its own — rename, the runner-role
  toggle, the unplaced tray's disclosure and "Copy the list", a note's jump
  and delete — but the rule is not "no buttons in the report," it is that
  none of them duplicates a top-bar action. A second control for the SAME
  action is a second name waiting to happen.
- **The verb carries the meaning, not the location.** "Open" always replaces
  what is loaded; "Add" always merges into it. The empty state therefore says
  *Open folder* / *Choose files* — both replace, because there is nothing to
  add to — and the loaded state says *Open folder* / *Add files*.
- **One word per concept in the UI.** The crop is a "time window" everywhere;
  `range` is the internal field name and had leaked into labels.

**Audit it, do not eyeball it.** Strip comments, extract every JSX text node
and `label`/`title`/`placeholder`/`aria-label`, and read the list. Two passes
of that found the duplicate export, three phrasings of one instruction, and
fifteen orphaned CSS selectors left behind by refactors.

### Stacking is a named scale, not a number that worked *(consistency pass)*

`--mw-z-content` / `-rail` / `-header` / `-float` / `-modal`, defined at the
top of `src/viewer/App.css` (not `tokens.css`, despite the rest of the scale
living there), and
anything that floats picks from them. Ad-hoc values are how the note dock —
raised to 1200 to clear Leaflet's 1000 — ended up floating **over the
lightbox**, which was on 100. The dock is also hidden outright while the
lightbox is open, because a floating button over a full-screen photograph is
noise whichever layer it is on.

### Nothing persistent may sit after the content *(UI pass)*

> "after i upload 200+ images all the things on the bottom of the site are
> really hard to notice"

The diagnosis is structural, not cosmetic. The feed is **unbounded** — 2,000
files is the stated target — and the export button, the people list, the
unplaced tray and the note composer were all rendered *after* it. At 231 files
that is a few thousand pixels down. Anything that must stay reachable cannot
be positioned behind a region that grows without limit.

The rule, in priority order by how often a thing is used:

1. **Constant, must never be hunted for** → the sticky top bar. Event name,
   Open folder, Add files, Save.
2. **Used while reading** → within reach of the view it belongs to. The note
   composer is a persistent dock, in the same corner in every view — see "The
   note dock is app chrome, not a feature of one view" below.
3. **Reference, read once per folder** → a collapsed `<details>` panel ABOVE
   the views, costing one line with a digest (`231 placed · 1 unplaced · 4
   people`). Settings, ingest report, unplaced tray, the notes list.

`Notes.tsx` exports the composer and the list **separately** for exactly this
reason: writing is constant and reading back is reference, so they belong in
different places. Keeping them one component is what dragged the composer
below two thousand photographs.

### The moment strip must not change the page's height *(UI pass)*

> "[...] also the ux in swimlanes is really janky. [...] the page is jumping
> all over the place because the rows where the images are are expanding in
> height [...]"

The strip's tiles wrapped, so a person with eight photographs made a row four
lines tall and one with none made it a single line. Scrubbing therefore
resized the page continuously and everything below it bounced — **including
the photographs you were reaching for**, which is what made it unusable rather
than merely ugly.

A row is now a fixed height that scrolls sideways, so the strip is exactly as
tall as there are people, whatever the cursor is on. Measured across a full
sweep: strip 150px and page 1279px at every position. **Any change here must
preserve that** — check the height at several scrub positions, not just that
it looks right at one.

### Hovering previews, clicking PINS *(UI pass)*

> "[...] we need a way to better work with the overover on the swimlane. it's
> a bit to sensitive [...] find a balance between clicking to lock the
> location but also ease of scrolling through the timeline"

Hover alone cannot work: the photographs are below the track, so reaching for
one means crossing the track, which moved the moment before you arrived. The
scrub not being cleared on pointer-leave (M7) was half the fix; the other half
is that **clicking pins it**. A pinned strip holds still while you reach.

**The click is a TOGGLE**, at the owner's suggestion: the gesture that pinned
it releases it. So there are two ways out — the chip, or the lanes again — and
they drive one state rather than being two modes. The chip is a readout as
much as a button: `following` / `pinned`, `aria-pressed`, lit only when
pinned, because the normal case needs no attention and the pinned one has to
explain why the strip has stopped moving. Escape releases it too — except
while the lightbox is open, where Escape closes the lightbox first and
leaves the pin alone (`Swimlanes.tsx` guards with `if (!locked ||
lightboxOpen) return`). Without that guard, `keydown` reaches `document`
before the lightbox's own `window` listener, so closing the lightbox with
Escape would also silently unpin the strip underneath — destroying a pin
the user set on purpose, in what is the common case since the lightbox is
opened from the lanes.

**The wheel zooms the crop**, anchored on the pointer like a map, so you zoom
into what you are looking at rather than the middle. It writes the SHARED
range, which is why the slider at the top follows — one crop, not one per
view. Bound with `passive: false` on the element: React registers `onWheel`
passively at the root, so `preventDefault` there is ignored and the page
scrolls out from under the zoom.

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

> "just looking at when tehre are photos and events are not useful"

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
  **it creates** that is not revoked. Scoped deliberately:
  `tests/media-store.test.ts` mocks `thumbnails.ts` wholesale, so the URLs
  `decodeThumbnail`/`decodeVideoPoster` create are outside what it can see —
  see "Long-lived object URLs all come from MediaStore" above for why those
  two are not a copy of this risk.

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
2. **Create a resource with `useMemo`, dispose it somewhere else.** Two
   shapes were tried here and BOTH broke — this is the bug that made every
   tile read "this browser cannot display this file":
   - Create in `useMemo`, dispose in an effect cleanup. StrictMode runs
     effect cleanups on MOUNT too, so the cleanup disposes the store the
     `useMemo` had just created, before anything gets to use it.
   - Create in `useMemo`, and dispose the previous instance inside the same
     factory. StrictMode double-invokes memo factories, so the second
     invocation disposes what the first invocation had just made.
   The fix: create AND dispose in the SAME effect, keyed on the input, so
   both halves are guaranteed to act on the same instance whatever order
   React runs them in. See `useMediaStore` in
   `src/viewer/media/useMediaStore.ts`, not `App.tsx` — it was extracted
   from `App` precisely so this lifecycle could be tested in isolation.

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

### The course view shows the COURSE, not the crop *(real timed GPX)*

Reported as "it looks like it got cut off or isn't rendering half the 100mile
race". The import was fine — 121,077 points, 104.8 mi, 20,419 ft, 33h38m,
parsed in 546ms. The charts were **filtering the track to the visible time
window**, which comes from where the PHOTOGRAPHS cluster. Two test photos two
minutes apart cropped a thirty-three-hour race to two minutes of it.

**The window's job is to filter media. The course is not media** — it is the
thing the media happened along, and you cannot judge where a photograph sits
in a race without the whole shape of it. The charts now always plot the full
course and draw the window as a shaded band instead.

Note this only appeared with a TIMED track: an untimed one plots against
distance and was never filtered, so the bug arrived with the good file.

### The note dock is app chrome, not a feature of one view *(owner)*

> "for the note in the bottom right corner that's floating. i think the swim
> lane page shoudl have that too. it should just be a persistant part across
> all pages/tabs so the UI is consitant"

It began in the feed only, then the course, with an inline composer under the
lanes — three placements and two shapes for one action. It is now in every
view, in the same corner. Writing a note is something done WHILE reading, so
it belongs to the app rather than to whichever page happens to be open.

### Interpolating a time from the photographs — the ONE place it is allowed

> "sometimes as the runner, you rememer moments from the elevation / course.
> especially if there are no photos in that area from yourself/crew/pacer"

`estimateInstant()` turns a point on the course into a time, so you can point
at a climb you remember and write about it. **This is interpolation, which
this file otherwise forbids**, so the distinction has to be exact:

| | Forbidden case | This case |
|---|---|---|
| Anchors | race start and finish | two photographs |
| Apart | a hundred miles | usually minutes |
| Claim | constant pace over a whole ultra | constant pace between two pictures |

Three rules keep it honest, and none may be dropped:

1. **It never extrapolates.** Outside the span the photographs cover it
   returns null. Beyond the last observation there is nothing to interpolate
   between, and a number there would be invention.
2. **It reports its own slack.** `gapSeconds` is the time between the two
   anchors — the honest error bar — and the UI marks a wide one.
3. **It admits ambiguity.** Distance is NOT a function of time on an
   out-and-back or a lollipop: the runner passes mile 40 twice. Anchors are
   walked in TIME order, every bracketing pass is a candidate, and the cursor
   picks between them.

On the owner's real data the photographs sit at 0, 31–32, 72, 107, 132 and
168 km — the crew-accessible aid stations — so the long gaps between them are
precisely where this is needed. Verified against the real folder: pointing at
16.83 km gave 05:33 local, which is 52.4% of the way between the 0 km photo at
11:30Z and the 32.1 km photo at 13:31Z, to the minute.

**CLICK, never a button that appears on hover.** The first attempt put a "Note
here" button beside the readout while hovering. Moving the pointer towards it
left the plot, which cleared the focus, which removed the button — you had to
chase it, so it could not be used at all. Clicking the course *is* the gesture
now, in both the map and the profile, and a permanent line of text says so.

The result is fed through the SHARED CURSOR rather than a private channel: the
click moves the cursor and the composer picks it up as its default, the same
as scrubbing the lanes or scrolling the feed. That keeps one entry point for
writing a note rather than one per view.

When neither the track nor the photographs can date the point, that is said
rather than guessed.

### Placing media ON the course: time first, GPS only as a fallback *(M10)*

`anchorItems()` gives each item a distance along the course, which is what
lets scrolling the feed drive the map. The precedence is not arbitrary, and
the owner named the reason:

> "sometimes the phone GPS gets points all wrong and weird. and for videos
> (especially videos taken on an action cam) there may not be GPS coordinates"

1. **Time**, when the track is timed. Every item has a timestamp — that is the
   spine of this whole app — so this places an action-cam clip with no GPS
   receiver at all, and every Android video that carries no location.
2. **GPS**, only when the track has NO times. That is a real case, not a
   degenerate one: a Strava route export has none. Here GPS is a measurement
   rather than a guess, which is the only reason it is acceptable.

Clock error is a constant offset, correctable once per device via
`clockOffset`. GPS error is per-shot and not correctable at all, so the clock
wins whenever both exist.

`ON_COURSE_TOLERANCE_M` (750m) rejects items too far off the line. This is
load-bearing on real data: a cluster of the owner's photos sits **19.3 km**
from the course — a hotel, not the race — and without the threshold each one
would pin a marker to a mountain nobody visited.

Disagreement between the two sources is signal, not noise: an item whose GPS
is far from where the track says the runner was at that moment is evidence of
a clock offset, which is the basis of automatic alignment.

### Notes are first-class, and independent of any file *(M9, extended)*

> "i'd like to be able to provide a comment at any arbitrary time ... either
> because we forgot to take a photo or it was something that we remembered
> happening during some point of time"

Every other annotation hangs off an item, so before this anything nobody
photographed could not be recorded at all — and an ultra is mostly those
things. `Manifest.notes` is a separate array of `{ id, at, until?, text,
person? }`.

Three decisions worth keeping:

- **A note's time is AUTHORED, so `clockOffset` never applies.** Same rule as
  `timeSource: 'manual'`: the offset corrects a device's clock, and a person
  typing "3am" is not a device. `placeNotes()` in `window.ts` does no
  correction at all, and a test pins that.
- **`person` is optional and does real work.** With one, the note sits in that
  person's lane — which is what lets a note EXPLAIN A GAP. Six empty hours is
  the story of the night section, and "asleep at Cottonwood" is the caption
  that gap never had. (This was true of the *design* from M9 on but not of
  the *code* until much later — see "Notes in the swimlanes" below.)
- **`until` makes it a span**, because crewing is mostly spans: waiting,
  driving, sleeping, boiling water. A span ending before it starts is
  degraded to a moment rather than refused at render, and refused at
  validation.

**The cursor is the default time** for a new note, which is the whole
ergonomic trick: scrub to 3am in the lanes, and the compose box is already at
3am. Typing a timestamp is the fallback, not the path.

**Scrolling the feed moves that same cursor** — the feed was the one view not
taking part in "one cursor, three projections", so you could scrub in the lanes
and flip to the feed but not the reverse. Its scroll-spy fires once per moment
crossed rather than per scroll event, so this does not churn the URL.

Notes are carried across a re-ingest **wholesale**, not merged per item, since
they belong to no file. `existingNotes` in `ingest.ts` exists for exactly
that; without it a re-read of the folder silently dropped every one.

**The shape described above is now the legacy one.** *(notes-as-csv)* Live
notes are `core/notes.ts`'s `Note` — `people: string[]` and `author:
string[]` instead of a single `person`, and a `duration` instead of `until`
— read from and written to `notes*.csv`, not `Manifest.notes`. The validator
still accepts `Manifest.notes` and `items[].note` so an old manifest keeps
loading, and `migrateLegacyNotes()` in `ingest.ts` converts them into the new
shape at ingest time; the writer never emits either field again
(`manifestForSave()`, see below). Everything else on this page still holds:
notes are still first class, the cursor is still the default time for a new
one, and `people` still exists to explain a gap in someone's lane. See the
three sections below for what changed and why.

**And `Note` has grown since** *(2026-07-30)*: `written` (epoch seconds, when
someone typed it), `deleted` (a tombstone that stays in the file), and a `tz`
that is now always written alongside a `utc_offset_min` column. See "The
format hardening" below.

### Notes in the swimlanes — this file said it was built; it was not *(bugfix)*

> "what i did notice is when i create a note i do not see it in the
> swimlane"

`Swimlanes.tsx` had **no reference to notes at all** until this fix — the
"person is optional and does real work" bullet above described the intended
UI, not shipped code, and nothing near it in the source would have
contradicted the claim during an eight-pass documentation audit. Notes
rendered in exactly two places: `Feed.tsx`, and the notes list in
`Notes.tsx`. Built now, in `Swimlanes.tsx`:

- **A note whose `people` list is non-empty draws in EACH of those people's
  lanes**, at its time, in that person's own lane colour — this is what
  actually lets a note explain a gap, making the bullet above true.
- **A note with an empty `people` list — or names that match nobody on the
  roster — is event-level** and gets its own row, pinned ABOVE every person
  lane, labelled "Notes" and coloured with `OVERFLOW_COLOR` from
  `palette.ts` (the same neutral already reserved for a ninth person)
  rather than an invented hue.
- **A note with a `duration` draws as a SPAN** — a bar from its start
  across its length — not a point, reading `PlacedNote.until`
  (`core/window.ts`).
- **The row is omitted entirely when there are no notes in the window**, so
  a folder with none does not carry an empty strip.
- Captions (`note.photo` set) are excluded via `excludingCaptions`, the
  same filter `Feed`'s caller applies — a caption already has a mark, on
  its photo, so a lane mark too would say it twice.
- A note mark's size is not scaled by a count the way a photo mark's is —
  a note carries no count, it is one authored event — so the "never
  thinner than a quarter of the lane" rule for photo marks does not apply
  literally. What it protects (presence must not read as absence) is kept
  a different way: a fixed minimum footprint, a small glyph for a point
  and a CSS-floored width for a span.
- Clicking a note mark moves the shared cursor to the note's OWN time —
  `onCursor(placedNote.instant)`, not the pixel clicked — via
  `stopPropagation` so the track underneath does not also fire and scrub to
  an approximate position.

See `tests/swimlanes-notes.test.tsx`.

### `notes*.csv`: the timestamp is five integers, not one string *(notes-as-csv)*

> "i want to make sure the underlying data is safe from corruption"

> "most likely it'll be the same date, but different times and the user might
> just click drag/copy paste the date. while they are filling out times."

**No format survives a spreadsheet except a plain integer.** Excel rewrites
anything that LOOKS like a date or a time the moment the file is saved:
`2026-07-25` becomes `7/25/26`; `15:45` becomes `3:45 PM` or the fraction
`0.65625`. An earlier draft split date from time as two combined columns,
which only made the corruption *recoverable* — the column name says what a
bare number means, so a person could repair it by hand. Recoverable is
weaker than safe. `year`, `month`, `day`, `hour`, `minute` as five bare
integers are never reformatted at all, because nothing about `25` or `45`
looks like a date to a spreadsheet — there is nothing left to repair.

The ergonomic reason that started the split survives underneath the
stronger one: most nights produce one date and many times, so
`year`/`month`/`day` drag-fill down a column of rows as one block, and only
`hour`/`minute` differ per row.

**The composer still shows one time box** (`YYYY-MM-DD HH:MM`); the split
into five integers happens on write, in `noteToRow()`
(`src/core/notes.ts`). Five separate inputs would slow down the path this
feature exists to make fast — the UI shape and the file shape are allowed to
differ, and here they should.

**`duration` is an ISO-8601 duration** (`PT3H40M`), not an end timestamp and
not a bare count of minutes — two reasons that stack. An end timestamp would
need its own year/month/day, because a 33-hour race crosses midnight and 31
July crosses a month; a duration has no boundary cases at all. And ISO-8601
means **the unit travels with the value**: `duration_minutes` puts the unit
in a header a copied cell leaves behind, and this is the same convention
`clockOffset` already uses, so the project has one convention for "how long"
rather than two. The cost, accepted: a duration cannot be summed or sorted
in a spreadsheet.

`rowToNote()` reads two earlier, cheaper layouts — a combined `date`+`time`
pair, and a single `at` — as **legacy formats on read only** (also a
zero-padded string, an Excel serial date, and a day fraction), so a file
that predates this change is repaired the next time it is saved rather than
rejected. `TODO.md` records the one further step that *was* considered and
deferred: splitting `duration`'s END the same way (ten integer columns
total instead of five plus a duration), judged too high a price for a case
the duration column already handles cleanly.

**Reversing either decision** means re-deriving both the corruption argument
and the boundary-crossing argument — they are independent, but both point
the same way, and no cheaper column layout survived contact with a
spreadsheet during design.

### The format hardening, done BEFORE real notes were committed *(2026-07-30)*

Four reviewers examined `notes*.csv` and `people.csv` specifically because the
owner was about to put one race's written record under version control, and
**once real notes are committed, every choice becomes a migration carried
forever.** Everything below shipped in one commit for that reason. The
governing constraint did not move: *no format survives a spreadsheet except a
plain integer*, so every column added here is an integer or an IANA name.

**Final columns.**
`notes*.csv`: `id, year, month, day, hour, minute, duration, tz,
utc_offset_min, people, photo, author, text, written, deleted` then any
column you added, then `schema`.
`people.csv`: `id, name, role, clock_offset, also_known_as`, then any column
you added, then `schema`.

**A per-row `schema` integer, and the check, in both files.** Blank means
"the version this reader knows", so a hand-added row needs nothing typed. A
row declaring a version *newer* than this build is refused with a legible
problem naming the file — mirroring `validateManifest` refusing an unknown
manifest `schema` outright rather than rendering a guess. **Per row, not per
file, and that is deliberate:** these files merge by row-bind, so a row from
someone's older copy lands among newer rows and must carry its own version;
`tz` already set that precedent. **The check shipped WITH the column** — a
marker older builds ignore buys nothing retroactively, and the check is the
part that expires.

**`people.csv` now keeps unknown columns**, which `notes*.csv` had from the
start via `Note.extra`. A roster carrying `pronouns` lost it on the next
save. This landed first, because a build without it deletes a `schema`
column from `people.csv` on save — erasing the very marker above. Held as
`PeopleExtra` beside `Person[]`, not on `Person`: `schema.ts` is the one
notion of a person and the manifest has no business carrying a spreadsheet's
spare columns.

**`tz` is now ALWAYS written, and `utc_offset_min` joins it.** Blanking `tz`
when it matched the event looked free — the row would pick the zone up again
on read. It is not: change `event.timezone` afterwards and every note
silently MOVES while the zoned-EXIF photographs beside them stay put, with
nothing on the row to say which zone was meant. **Unfixable retroactively**,
which is the whole reason this shipped now.

Both are needed and neither substitutes for the other. A zone NAME cannot
express the repeated hour at a fall-back transition — 01:30 MDT and 01:30 MST
are the same five integers, an hour apart, and a zone-only read silently
returns the earlier one every time. An OFFSET alone loses which zone the
writer meant. Each row carrying its own offset is what makes a race crossing
a DST boundary exact. **On read the offset determines the instant; the zone
is for display and date math.** Disagreement is reported, never guessed
through — and "agreement" is deliberately *not* `zoneOffsetMinutes` of the
naive time read in the zone, because at a fall-back hour both offsets are
correct answers; the test is whether the instant the offset produces really
IS that wall clock in that zone.

The offset is **integer minutes** (`-360`), not `-06:00`, for the
spreadsheet-safety reason above, and it is computed from the INSTANT at write
time rather than remembered — an instant has exactly one offset in a zone,
even inside the repeated hour, so nothing extra is stored and the round trip
is exact.

**The zone is inferred from EXIF, never from GPS.** `inferEventTimezone`
(`core/time.ts`) takes the modal `OffsetTimeOriginal` across the media —
already parsed, and a measurement of where the event was rather than of where
the laptop is. Falls back to the browser's zone when nothing carries one;
keeps the browser's zone when it already has that offset (a real IANA zone
knows its own DST rules, a bare offset does not); otherwise returns
`Etc/GMT±N`, which says exactly what is known and nothing that is not. Note
`Etc/GMT+6` is UTC−06:00 — the sign is inverted, per POSIX. **Do not add a
GPS→timezone lookup**: it needs a boundary database this project's dependency
budget will not carry. Inference runs only when a folder is OPENED
(`IngestOptions.inferTimezone`), never on "Add files", so it cannot silently
revert a zone the author typed by hand.

`Intl.supportedValuesOf('timeZone')` contains neither `UTC` nor any
`Etc/GMT±N`, though `Intl.DateTimeFormat` resolves both — so `TimezoneField`
asks `Intl` whether a zone works rather than checking list membership, and
carries a link to the IANA table beside it.

**The five integers are range-checked, and REJECTED rather than rolled over.**
Verified silently accepted before this: `year=26`→1926, `year=226`,
`month=13`→next January, `month=0`→previous December, `day=32`→next month,
`day=30` in February→2 March, `hour=24`→tomorrow, `hour=25`, `minute=60`→+1h,
`minute=99`, and non-integers (`45.7` truncated, `12.5`, `1e1`). Each one then
**rewrote itself on the next save**, so the file stopped saying what its
author typed and nothing ever reported it. These are exactly what a drag-fill
or a fat finger produces, and a rolled-over value places a note *confidently
in the wrong place* — worse, by this project's standing rule, than a visible
gap. The legacy `date`/`time` columns go through the same check, so the two
shapes cannot disagree about what is readable.

**`deleted`**, an integer flag, because deleting a note only removed it
locally and any other copy resurrected it on merge with nothing recording
that the removal was intentional. A deleted row **stays in the file** and
wins over a live row with the same id, in either file order. Tombstones are
split out of the note list once, in `ingestFolder`; everything downstream
sees live notes only and the save path is the one place that sees them again.
**Every deletion made before this column existed is unrecorded forever**,
which is why it landed now.

**`written`**, epoch seconds, machine-written, blank allowed. `at` is when the
thing happened; `written` is when someone typed it — "at the time" versus
"remembered two years later" is the difference between a log and a memoir,
and it cannot be reconstructed later. Excluded from `fingerprintNote`, along
with `deleted`: both are facts about the row rather than about what the note
says, and including either breaks a real case (a legacy manifest note
deduping against its own migrated copy; a tombstone matching the live row it
cancels).

**NFC everywhere.** `José` composed and `José` decomposed are visually
identical and unequal as strings; `resolvePersonNames` matched neither
against the other, verified in both directions. `formatCsv` normalises every
cell it writes, and `nameKey` (`people-csv.ts`) is the ONE fold every name
comparison goes through — `PersonPicker` included, so two parts of the app
cannot disagree about whether a name is already on the list.

**Blank-`id` rows now adopt an existing id.** Merging a saved copy of
`notes.csv` (ids filled in) with a pristine copy whose rows are still
blank-`id` grew **2 → 3 → 4 → 5 → 6 notes over five rounds**: `rowIdentity`
only stabilises an id within one session, and the ided row had already
claimed its slot. `dedupeNotes` now pre-scans for content that already
carries an id, so a blank row of the same content takes that id and the pair
collapses on the normal same-id-same-content path — order-independent, so it
works whichever file is read first. It does **not** collapse two blank-id
rows against each other; that case still goes through `rowIdentity` and its
deliberately-not-reused rule, so two rows someone typed once stay two notes.

**`mintNoteId` never ends in a digit.** Excel's fill handle increments a
trailing number when a cell is dragged, so `n_abc12` becomes `n_abc13`,
`n_abc14` — inventing ids for notes that do not exist. The base-36 mint ended
in a digit 27.8% of the time (10 of 36 base-36 characters are digits;
measured at 27.79% over 2M samples, matching the 10/36 theoretical rate).

**Migration is the part that matters, and it is pinned to a frozen fixture.**
`tests/fixtures/csv-before-2026-07-30.ts` holds `notes.csv` and `people.csv`
byte-for-byte as they were written before any of this, and the suite asserts
they still produce the same instants, ids and text — then that saving them
repairs the shape while saying the same thing. **Do not regenerate it:** a
test that rebuilds its own input cannot catch a reader and a writer drifting
together.

### Refusing to READ a row is not permission to DELETE it *(pre-release gate)*

The `schema` column shipped so a row written by a newer build would be
refused rather than misread. Executed end to end, refusing it also **erased**
it: the reader dropped the row, the writer only ever wrote the rows that
parsed, and one Save later the row was off disk. The message it printed —
*"update the site, or clear the schema cell"* — described a repair for data
that no longer existed. It was reachable with no future schema at all: an
unreadable date, a blank text cell or a bad duration did the same, in both
`notes*.csv` and `people.csv`, where losing a roster row loses that person's
`clock_offset` and therefore moves every photo they took.

**A row this build cannot interpret now survives the round trip verbatim.**
`PreservedRow` (`src/core/csv.ts`) carries the raw cells, the file and the
line; `mergeNotes` and `parsePeopleCsv` collect them; `noteRowsForSave` and
`formatPeopleCsv` write them back. Three things that are not incidental:

- **A preserved note keeps its place in time**, sorted by a deliberately
  loose reading of its own cells (`day` 32 rolls into August, which is wrong
  as a date and right as a sort key). A file is read in order, and a row
  quarantined at the bottom is one nobody reconnects to the hour it belongs
  to. A row with nothing to date it by goes last, after everything datable.
  A preserved ROSTER row goes after the roster instead — a roster has no
  chronology, and the bottom is where someone repairing the file will look.
- **It is not a note.** Preserved rows never enter the `Note[]` list, so
  nothing shows them, places them on a lane, or counts them in the digest.
- **Its own columns come too.** `preservedHeaders` adds them, because a newer
  build is exactly the thing likely to have added a column, and dropping it
  would defeat the preservation.

**"Verbatim" means the cells, not the bytes.** Four things are NOT
byte-identical across a read-and-save, all verified by execution rather than
by reading the code — an earlier version of this section claimed only the
first and was wrong three ways:

1. **Unicode normalisation.** `cell()` in `src/core/csv.ts` runs `nfc()` over
   every cell it writes — data, header names, `Note.extra`, preserved rows
   alike — so a decomposed `José` comes back composed.
2. **Surplus fields beyond the header are dropped.** `parseCsv` fills a row
   only through `headers.forEach`, so a row with ten cells under an
   eight-column header loses the last two. Admitted in `csv.ts` (~line 135)
   and, until now, nowhere else.
3. **A cell under a BLANK header name is dropped** — but only when nothing
   except a preserved row carries that column. `preservedHeaders`
   (`csv.ts:166`) skips `key === ''`; `noteHeadersFor` and `formatPeopleCsv`
   do not, so a readable row keeps it.
4. **Known-but-absent columns are ADDED, blank.** `noteHeadersFor` always
   emits the full `NOTE_HEADERS` list, so a file that never had
   `utc_offset_min` comes back with it — blank on preserved rows, filled on
   readable ones. Same for `people.csv`'s `role`/`clock_offset`/
   `also_known_as`.

Below the level worth calling exceptions, but real and also measured: a BOM
is added even when the input had none, CRLF becomes LF, needless quoting is
dropped, columns are reordered into canonical order (unknown ones last,
before `schema`), header names are trimmed, and duplicate header names
collapse to the last one. None of these lose a cell's content.

**One that DOES lose content, and is a genuine bug rather than a formatting
difference:** `unguard()` strips a leading apostrophe unconditionally, so a
cell a person typed as `'twas a long night` — or a name like `'Bama` — parses
to the text without it, on the FIRST read, and saves that way. This
contradicts the formula-guard bullet below, whose "the round trip is
invisible to a person" holds only for files meanwhile itself wrote. Not fixed
here; see `TODO.md`.

The fallback considered and not taken was refusing to save at all. Preserving
is strictly better: it needs no decision from the author and cannot strand a
session's writing behind a broken row. **Save still refuses rather than
writing something wrong** in one case — a note whose timezone this build
cannot resolve — and that failure is now a sentence in the error callout
rather than a dead button (see below).

### `notes*.csv` and `people.csv` are hostile-input-safe, on purpose *(notes-as-csv)*

These files are meant to be handed between people and opened in whatever
spreadsheet program they have, so `src/core/csv.ts` treats every cell as
something a stranger typed, not as trusted output from this app:

- **Formula injection.** A cell starting `=`, `+`, `-` or `@` is executed as
  a formula by Excel and Sheets the moment the file is opened. `formatCsv`
  writes a leading apostrophe on any such cell; `parseCsv` strips it back off
  on read, so the round trip is invisible to a person but the live formula
  never reaches their spreadsheet. **The strip is unconditional, which costs
  a real apostrophe** in a file meanwhile did not write: `'twas` reads as
  `twas`. Round-trip-stable for our own output, lossy once on someone else's
  — see the round-trip exceptions above and `TODO.md`. **Reversing this** means accepting that
  anyone who receives a `notes.csv` — which is the entire point of the file
  — can have arbitrary formulas run in their spreadsheet by whoever wrote a
  note.
- **The UTF-8 byte-order mark.** `formatCsv` writes one; `parseCsv` accepts a
  file with or without it. Without it, Excel on Windows misreads UTF-8 as
  Windows-1252 — and notes are exactly where apostrophes, em dashes and
  emoji turn up. **Reversing this** breaks non-ASCII text for precisely the
  audience — a runner's crew, editing by hand — this format exists to serve.
- **Newlines in `text`** are legal inside a quoted CSV field but break a diff
  and confuse naive tooling, so the composer replaces them with a space on
  write and the reader normalises any it finds on read. A note is a
  sentence. **Reversing this** means a note can carry an embedded line break,
  which is fine for a spreadsheet program but breaks a line-based diff and
  any tool that assumes one record per line — precisely the audience a
  plain-text, hand-editable file exists to serve.

### A zone ABBREVIATION is not a zone, and a save must never fail in silence *(pre-release gate)*

`MDT` is the obvious thing for a person to type into `notes.csv`'s `tz`
column, and `Intl` throws on it. The five-integer path always resolved
through the zone and so refused it; the legacy `at` path did not, so the row
loaded cleanly and `noteToRow` then threw a bare `RangeError` **inside the
Save click handler** — no file, no message, and the whole session's writing
still only in a tab. Both halves are fixed and both are needed: the reader
refuses such a row (it becomes a preserved row, above), and `saveEvent`
turns anything that still throws into words in the error callout.

**The check is "can this be resolved", never "does it look like an
abbreviation".** `EST`, `MST`, `CST` and `PST` are real tzdata names or ICU
aliases for them and resolve perfectly well; refusing by shape would reject
four working zones. `MDT` and `PDT` do not resolve. `zoneOffsetMinutes`
returning null is the whole test.

### "Add files" must not revert what only this session knows *(pre-release gate)*

Notes and timezone inference were already gated on `mode === 'replace'`. The
**roster was not**, and neither were the crop, the course reference or the
markers — those three were restored only from an imported `manifest.json`.
So the documented workflow (open a folder, rename a device to a person, then
"Add files" to drop in the GPX) reverted the roster to the unsaved
`people.csv` on disk. Losing the name was the smaller half: the
`also_known_as` alias went with it, so every note the rename had rewritten to
the new name then matched **nobody**, and setting a Strava link and adding a
track discarded the link.

`sessionPeople`, `existingRange`, `existingCourse` and `existingMarkers` are
passed only on "Add files", exactly like `sessionNotes`. The roster is a
**merge, not a replacement** (`mergeSessionPeople`): the session wins per id,
and ids only the file has are still added, so a `people.csv` dropped in
mid-session still introduces the people it names. When the two disagree the
report says so — "Save to write them to people.csv" — rather than choosing
in silence.

### A broken manifest at the top must not hand the folder to a deeper one *(pre-release gate)*

`shallowestFirst` exists so a `manifest.json` that came along inside
somebody's subfolder cannot replace the folder's own. A **malformed**
shallowest candidate fell straight through it: the loop reported the parse
error and carried on, so `{ not json` at the root gave `sub/manifest.json`
the event name, timezone, crop, course and whole roster — the exact
substitution the ordering was added to prevent. The only trace was an
`importError` naming a *different* file from the one in use, which reads as
"nothing was applied" while something very much was.

Reported, not refused — the deeper manifest is still used, since the author
may well have meant it. What changed is that the substitution is named:
which file could not be read, which one stood in for it, and what came from
it. Nothing is said when the broken manifest was the only one, because
`importError` is then the whole story.

### A rename can hand the old name to somebody else *(pre-release gate)*

p1 is "Bob"; p2 is "Rob" who also answers to "Bob". While both claim the key,
`resolvePersonNames` refuses to guess and a note saying "Bob" resolves to
neither — correct, and visible. Rename p1 to "Robert" and the contest is
over: "Bob" belongs to p2 alone, so every note that meant p1 silently moves
into p2's lane, caused by nothing anyone wrote.

**Reported, not refused.** Refusing would trap someone in a name they cannot
leave because a second row happens to list it as an alias, and the ambiguity
is not of their making. `RenameResult.reassigned` names both sides and how
many notes move; `App.tsx` appends it to the same problems callout, which is
where something the app DID rather than guessed at belongs.

### Merging `notes*.csv` needs no version control *(notes-as-csv)*

> "i think it'll be okay if we end up making it look like 2 comments at the
> same time. that's okay. when we visualize it it'll show up one after the
> other."

The owner initially proposed the datetime as each note's identity. Three
things killed it: a spreadsheet silently reformats an ISO timestamp on save,
changing every row's key at once; two people can write at the same second;
and editing a note's time changes its key, so a merge sees an edit as a
delete plus an insert.

**`id` is opaque and stable; `at` is ordinary data instead.** That makes
merging **row-bind, dedupe by `id`, sort by `at`** — `mergeNotes()` in
`src/core/notes.ts` — with no conflict resolution, no locking, and no merge
UI, because ids are globally unique in practice:

- The site mints an id for every note it creates (`mintNoteId()`).
- **A hand-added row leaves `id` blank**; the site mints one on load and
  writes it back on the next save.
- **A duplicated id** — the signature of a copied row, e.g. two crew members'
  copies of `notes.csv` both landing back in the folder — gets one side
  re-minted, decided by comparing a content fingerprint: the same id with
  the same content is one note seen twice (deduped silently); the same id
  with different content is a genuine collision (the newer side re-minted,
  both kept).

Two people editing copies of the same note at the same moment therefore
produce two notes at that instant, shown one after the other in the feed —
accepted, not an error, per the quote above.

**Reversing this** — going back to a human-meaningful key, or adding real
conflict resolution — throws away the property that makes several people's
files mergeable with a plain row-bind: nothing prompts, nothing locks, and
nothing needs a server. It also reopens exactly the three problems that
killed the datetime-as-key design in the first place.

### Media with no usable timestamp goes to an unplaced tray *(session 2)*

`timeSource: 'none'`, no `at`. Visible in a holding area (`UnplacedTray.tsx`),
grouped by person with a thumbnail, the file path, and a copyable list — so
the next step is asking whoever sent it for the original. **Hand-placing an
item onto the timeline from the tray is not built**: the schema has
`timeSource: 'manual'` and re-ingest preserves a manual placement once one
exists (see "Ingest conventions"), but nothing in the viewer can ever
produce one — there is no drag-and-drop, and the tray is read-only. See
`TODO.md`. Chosen over dropping the file (silent loss) and over inferring a
time from file order (confidently wrong).

### The manifest is the contract

Hand-editable JSON, versioned (`"schema": 1`), carrying the event, the
derived items, markers, and the course. It is both the interface between the
two artifacts and the unit of sharing.

**It is NOT fully regenerable from the photos, and saying otherwise has
already caused harm.** *(format review, 2026-07-30)* The natural framing —
"the CSVs are irreplaceable, the manifest is derived, so only the CSVs need
version control" — is false, and a reviewer verified exactly what a re-ingest
does not reproduce:

- **every `timeSource: 'manual'` placement** — the only thing anchoring a
  photo with no usable timestamp, and carried forward solely via the manifest
  itself;
- **`event.range`** — the crop, which is authoring intent; absent, ingest
  recomputes a *different* answer from `densestWindow()`;
- **`markers[]`** — hand-typed aid stations; nothing regenerates them;
- **`course`** — including a `strava-embed` URL whose share code cannot be
  derived from anything;
- **`event.title` / `event.timezone`**, and `person.color`.

So `manifest.json` belongs under version control **alongside** the CSVs, not
treated as scratch — but not in THIS repo. It belongs in the event's own
private data repo (see `EVENT.md`; the owner's is
`chendaniely/meanwhile-cm100-g`), the same place `notes.csv` and
`people.csv` are committed. In the public `meanwhile` renderer repo this file
is cloned from, `manifest.json` is gitignored exactly like the CSVs — see
"Public from day one?" below — so `git add manifest.json` here would be a
mistake, not the point being made. It is *partly* derived, which is a
different claim from derived, and the difference is somebody's crop and
every photo they placed by hand.

Related and verified in the same review: **a folder reorganisation orphans
every manual placement**, because carried-forward items are matched by `id`
and `id` is the relative path. Notes survive a reorg — they join photos by
basename — which is precisely why pulling them out of the manifest was right.

**Notes and the people roster are no longer what it carries for authorship.**
*(notes-as-csv)* Authored prose now lives in `notes*.csv`; the roster —
names, roles, `clockOffset` — lives in `people.csv`. The validator still
**accepts** a manifest with the old `notes[]` and `items[].note` fields, so
an old file keeps loading; `manifestForSave()` in
`src/viewer/media/ingest.ts` is what stops the *writer* emitting them again,
so a manifest migrates itself the first time it is saved after being opened.

**One asymmetry, not yet closed:** `manifestForSave()` strips `notes` and
`items[].note` but does **not** strip `people` — a saved `manifest.json`
still carries the full roster, `clockOffset` included, redundantly alongside
`people.csv`. Nothing is silently lost: on load, `people.csv` wins when both
are present (`peopleFromCsv ?? imported?.people ?? opts.existingPeople` in
`ingestFolder()`). But the roster today lives in two files instead of one,
unlike notes, which the design's own "What changes" table says should not be
true. Worth closing the same way notes were closed, if picked up.

`items[].src` **resolves late**: an absolute URL is used as-is; a relative
path resolves against `media.base` *or* against a locally granted folder, at
render time. So Drive, a bucket, Google Photos links, and a local folder are
indistinguishable to the viewer, and the hosting question is answered
per-event rather than once forever.

### Three views, one cursor

`src/core/state.ts` defines `ViewName = 'feed' | 'lanes' | 'course'` — merged
feed (the default: `INITIAL_STATE.view` and App.tsx's `available[0]`
fallback both pick it), swimlanes, and course. **Three projections of one
state object**, not three separate features. There is no separate map view: the
map lives inside the course view, alongside the elevation/HR/cadence/pace
charts. The moment grid from the original design (pick a time, see what
everyone captured right then) is not built — see `TODO.md`/README's "Still
missing".

```ts
{ view: ViewName, cursor: Instant | null, range: TimeWindow | null, visible: ReadonlySet<PersonId> | null }
```

(`zoom` and a pluggable `time`/`distance` `axis` were in the original design;
neither exists in `AppState` as built.)

The owner asked to "goggle" between them. The cursor **survives every
switch**, and lives in the URL (`#t=...&view=course`) so any moment is a
textable link.

Design notes that matter: in the swimlanes, **gaps are the point** — the
six-hour hole in the runner's lane is the story of the night section. The
feed is the phone view and the one the crew will actually open.

### The course spine (GPX)

Optional, and the highest-value idea in the design. A pure, dependency-free
`src/core/course.ts` mapping between time, distance, elevation, and lat/lon.

The original design expected it to pay for itself four times: a pluggable
time/distance axis, the elevation profile as the swimlanes' backdrop, a
tile-free SVG map, and automatic clock alignment. **Two of those four
shipped, two did not.** The elevation profile backdrop is built. The map is
built too, but not tile-free — it is Leaflet with raster terrain basemaps, a
deliberate reversal of the original "no map library" call (see the
dependency budget). The pluggable time/distance axis was never added to
`AppState` (see "Three views, one cursor"). Automatic clock alignment was
never written either: `anchorItems()` (see "Placing media ON the course"
above) can now *detect* disagreement
between a photo's GPS and where the track says the runner was, which is the
raw material an estimator would use, but no estimator exists — see "Not
built" above and `TODO.md`.

### Clock alignment is central, in `people.csv` *(revised, notes-as-csv)*

`clockOffset` is per person, adjusted **centrally by the event author** —
chosen over per-uploader adjustment, which would require a contribution and
merge workflow. It now lives in `people.csv`'s `clock_offset` column (an
ISO-8601 duration, e.g. `-PT4S`) — the same spreadsheet-editable file that
carries names and roles — rather than being reachable only by hand-editing
JSON. See the asymmetry noted under "The manifest is the contract": today
`manifest.json` still carries a redundant copy too.

The owner's phrase was "saved in metadata of the file," which was ambiguous
between the manifest and the media's own EXIF; they confirmed the manifest —
and now, more specifically, the spreadsheet-editable roster file that stands
in for hand-editing the manifest's JSON. **EXIF write-back is deferred, not
rejected** — worth re-asking, since it has real archival appeal.

### A file from someone else is the threat model *(security review, 2026-07-30)*

Four independent security reviews ran before real notes existed. The one that
mattered found its findings by asking a single question: **the collaboration
model is that people email each other files, so what does a hostile or merely
careless file do?** That is the trust boundary — not a network attacker, who
has nothing to attack, since there is no server and no account.

What it found, all reproduced by execution:

- **A person's name reached Leaflet as HTML.** `bindTooltip(name)` with a
  string assigns `innerHTML`, so a `people.csv` name of `<img src=x
  onerror=…>` executed — in a page holding File System Access handles to
  somebody's whole photo folder. Names now go in as DOM nodes. The same file
  already did this correctly for the thumbnail tooltip; the reasoning existed
  and had not been applied to the first one.
- **One row could silently destroy someone else's note.** Ids are not secret —
  everyone holding `notes.csv` has them — so a `deleted=1` row naming another
  person's id erased it with `problems: []`, and the next Save wrote the
  tombstone over the original text. Deletion must still propagate; that was
  itself a bug fixed earlier. What was wrong was the silence.
- **A `manifest.json` in ANY subfolder replaced the event.** Last file in path
  order won, so a contributor zipping their working folder in could swap the
  title, timezone, crop, course and roster — including a `clockOffset` that
  moves every photograph. Shallowest path now wins, and every ignored
  candidate is named.

**The rule this leaves: a merge that discards or overrides anything must say
so.** An id-keyed merge with no conflict resolution is the right design — it
is what lets several people's files combine with no locking and no server —
but it is only safe while every silent outcome is made loud. `noteProblems`
is that channel, and it now carries tombstone removals, ignored manifests and
rosters, and track-file trouble as well as unreadable rows.

Two related hardenings, same reasoning: the formula guard now looks past
leading whitespace (TAB and CR are stripped by Excel before it evaluates, so
`\t=cmd|…` was executing from an unknown column that round-tripped
unguarded), and a re-minted note id is derived from content rather than
random, so a duplicated row converges instead of cloning on every merge —
measured 2→3→4→5→6 before, 2 every round after.

### A rename is TOTAL, and committed — never per-keystroke *(format review)*

The first version of the alias join above wired the rename input's `onChange`
straight to `applyRename`, so it ran **once per keystroke**. An independent
format review reproduced the result: renaming "Google Pixel 8 Pro" to "Priya"
performed about nineteen renames, leaving `also_known_as` holding every
prefix along the way — `["GOOGLE PIXEL 8 PR", …, "GO", "G", "P", "Pr"]` — so
that `G` and `P` then resolved to that person.

Worse, backspacing through empty rewrote the note's people entry to `""`, and
`applyRename`'s own `previousName !== ''` guard then made `renamed` false
**forever after**, so it never healed. The note's link to that person was
destroyed and written out blank on the next save. Corrupting a permanent
record on the most ordinary interaction there is.

Three rules came out of it, and none may be relaxed:

1. **A rename is a committed action** — blur or Enter, never a keystroke.
   Escape reverts. (Note the trap found while testing this: calling `.blur()`
   inside the Escape handler fires `onBlur` → commit, which React's batching
   means reads the STALE draft — so Escape committed the very edit it was
   meant to abandon. Do not blur on Escape.)
2. **A rename is total or refused, never half-applied.** It is refused when
   the new name is blank, contains `;` (the list delimiter — there is no
   escape), or is already claimed by another person's name or alias. That
   last one matters more than it looks: without it, renaming Alice to "Bob"
   produced two people called Bob and `resolvePersonNames` then resolved
   "Bob" to NEITHER, orphaning both notes — including the one that never
   involved Alice.
3. **A broken join is loud.** An alias table is only safe if a join that
   fails says so. Unresolved note names are reported at ingest and drawn in
   the event-level row; a `photo` matching nothing is reported, not just an
   ambiguous one.

`also_known_as` is cleaned on read, on write and on rename: an alias equal to
the person's own name is dropped, and duplicates are folded
case-insensitively, so the column cannot grow without bound.

### Renaming a person is non-destructive: `also_known_as` is the join *(person-aliases)*

> "i need a way (possibly in the site interface itself) to connect the notes
> and people datasets, where the author in notes is the new display alias
> for the name in people. [...] i am essentially asking for a non
> destructive way to rename people ids that are displayed."

`Person.id` was already stable across a rename (`renamePerson` in `App.tsx`
only ever touched `name`) — but `notes*.csv` stores `people`/`author` as
NAMES, not ids, on purpose: an id column would defeat the entire reason
notes are CSV — a plain spreadsheet, editable by hand, with nothing in it a
person editing by hand has to look up. So renaming "Google Pixel 8 Pro" to
"Priya" silently orphaned every note already written under the old name:
the note survived, but its link to that person broke, and the old string
showed up as an unrecognised name.

`people.csv` gained a fifth column, **`also_known_as`** — a `;`-separated
list, the exact convention `people`/`author` already use in `notes*.csv`
(`splitList`). Two functions in `core/people-csv.ts` do the actual work,
both pure and both exported for direct testing:

- **`resolvePersonNames`** now matches a note's names against a person's
  current `name` **or** any `also_known_as` entry, case-insensitively. This
  is what makes the join survive a rename in a file the app does not
  control — a crew member's own untouched copy of `notes.csv`, or a name
  typed by hand later.
- **`applyRename`** is what `App.tsx`'s `renamePerson` now calls. It (1)
  sets the new `name`; (2) pushes the PREVIOUS name onto that person's
  `also_known_as` (no duplicates, skipped if blank or unchanged); and (3)
  rewrites that exact old name to the new one, case-insensitively, in every
  already-loaded note's `people`/`author` lists, so `notes.csv` self-heals
  to current names on the next Save instead of freezing on the device slug
  forever. **Both (2) and (3) are kept, on purpose** — (2) is the fix for
  files the app has not read yet, (3) is the fix for what is already in
  memory, and neither substitutes for the other.

**Display name resolution has one fallback chain, in one function.** The
owner: *"shoudl note that the "name" shoudl be the default display name, the
fallback is the "also_known-as" value to display on the site"* `displayName(person)` in
`core/people-csv.ts` is `name` → first `also_known_as` entry →
`displayNameFor(id)` (the same device-slug prettifier `assembleManifest`
already used for a never-renamed lane) — so a hand-added roster row that
carries only an alias still labels its lane rather than showing blank.
Every place a person's name renders (swimlanes, feed, note list, moment
strip, map, the roster editor's own rename input, `PersonPicker`, the
legacy-note migrators in `ingest.ts`) reads through this one function now,
never `person.name` directly — the fallback must not scatter, or it drifts
out of step between views the way the notes/people split itself once did.

**Two people must never resolve to the same id via a shared name.** The
owner asked for this explicitly, foreseeing future same-device duplicates:
*"we need to maeksure the id in people are unique so the rename can happen
with a join."* Two decisions follow:

1. **On a colliding rename, the alias and the note rewrite are both
   skipped** — the rename to the new name still always happens.
   `applyRename` checks whether the OLD name already matches a DIFFERENT
   person's current name or alias before recording anything; if it does,
   aliasing it would make that other person's identity ambiguous too, and
   rewriting notes under a name two people share cannot tell which one a
   given note meant. A collision degrades to "not auto-healed," never to a
   silently stolen identity.
2. **`resolvePersonNames` itself never guesses.** If a hand-edited
   `people.csv` — outside the site's own guard — still lets two people share
   a name or alias, that key resolves to NEITHER id; the name is reported as
   unrecognised instead of picked arbitrarily. This mirrors `resolveNotePhotos`'s
   existing "ambiguous match is reported as a problem instead of guessed at"
   rule for a `photo` filename matching more than one item — the same
   principle, applied to identity instead of a file path.

**`PersonId` was already flexible enough for future same-device splitting —
verified, not changed.** The owner: *"assume in the future i might have
multiple of the same device so we need to maeksure the id in people are
unique so the rename can happen with a join or something"*, and separately
*"we can pin this later on, but just make sure thigns are flexiable enough to
handle multiple peopel with same devices"*.
`deviceIdOf` (`core/metadata.ts`) still derives an id purely from
make+model, so two physically identical phones collide into one id today —
splitting them (e.g. minting `google-pixel-8-pro-2` for a second one) is
explicitly NOT built here, per the owner's own "pin this later" above.
What was checked instead: nothing downstream treats `PersonId` as anything
but an opaque string key (`Map`/`Set` keys throughout `state.ts`,
`palette.ts`, `window.ts`; sorted lexically, never parsed, in
`assembleManifest`). A future numeric suffix therefore needs no migration —
existing ids keep their exact spelling, since a suffix would only ever be
minted for a NEW colliding device, never retrofitted onto one already in
use.

### Analytics learns the view, and nothing else *(2026-07-30)*

> "i don't think i need view-usage. maybe the only tab info that is useful is
> which view are people looking at, but i don't need to track time/people
> information at all."

`src/core/state.ts#toHash` puts a photo-derived timestamp (`t=`) and the ids
of whichever people are shown or hidden (`who=`) straight into the URL
fragment, because that is what makes any moment a shareable link. That
fragment must never reach Google, and two separate mechanisms would have sent
it there under the plugin's original naive `gtag('config', ID)`:

1. **The initial `page_view`.** GA4's default `page_location` is
   `location.href`, fragment included.
2. **`useAppState` calls `history.replaceState` on every cursor change** —
   continuously, while scrubbing — and GA4's "enhanced measurement" fires its
   own automatic `page_view` on `pushState`/`replaceState`/`hashchange`.

`googleAnalytics()` in `vite.config.ts` now sets
`send_page_view: false` on the `config` call and sends exactly one
`page_view` itself, with `page_location: location.origin + location.pathname`
— which cannot contain a fragment, by construction, regardless of what
gtag's own default fragment-handling does. `src/viewer/analytics.ts#trackView`
is the only other thing this app tells Google: one custom `view_change` event
per genuine view change (wired in `App.tsx` as
`useEffect(() => trackView(view.view), [view.view])`, deliberately depending
on `view.view` alone and not on the `AppState` object, so a cursor scrub or a
`who=` toggle — which land on that same object — cannot retrigger it), and
its payload is `{ view }`, a bare three-value enum, never the `AppState` it
was read from.

**This does not fully close the gap, and the code cannot close the rest of
it.** GA4's enhanced measurement is a property-level toggle
("Page changes based on browser history events"), independent of
`send_page_view` and independent of the `page_location` passed to `config` —
verified against Google's own docs and independent write-ups, not against a
live property. If it is on for this property, it still fires its own
`page_view` on every `replaceState`, reading `page_location` fresh from
`location.href` at that moment — fragment included. Turning it off is
**Admin → Data Streams → this stream → Enhanced measurement (gear icon) →
"Page changes based on browser history events" → off**, in the GA4 console.
That is the owner's action; no `vite.config.ts` change can reach it. See the
"Verified external constraints" table below for the same fact, kept there so
a future session does not have to re-derive it either.

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
| **GA4 `send_page_view: false`** *(2026-07-30)* | **Does not disable "enhanced measurement"'s automatic history-based `page_view`.** That listener fires its own `page_view` on `pushState`/`replaceState`/`hashchange` regardless of the `config` call's `send_page_view` or `page_location` parameters, reading `location.href` fresh each time. Since `useAppState` calls `replaceState` on every cursor change, this — not anything `vite.config.ts` can set — is what would still leak the URL fragment (`t=`, `who=`) to Google if enhanced measurement is on for this property. Disabling it is a per-stream toggle in the GA4 console ("Page changes based on browser history events"), not a `gtag()` parameter. Verified against Google's documentation and independent write-ups; not probed against a live property. |

**The data-quality rule** — the highest-leverage sentence in the README:

> **AirDrop, a shared Drive/Dropbox folder, or a Google Photos album.
> Never iMessage, WhatsApp, Messenger, Instagram, or Slack.**

Those apps recompress photos and strip EXIF, and a photo with no timestamp has
no lane to sit in. (Quoted verbatim from `README.md` — if you shorten it here,
you have created a second wording of the project's most-repeated rule.)

---

## How work gets executed

**Plans are executed subagent-driven, always.** Do not offer the choice.

> "i feel like you should save this in a global state, it should always be
> subagent driven"

A fresh agent per task, reviewed between tasks. It is why plans in
`docs/superpowers/plans/` spell out the interfaces between tasks: each
implementer sees only their own task and has to learn neighbouring names and
types from the plan rather than from context they do not have.

### Reviews are LOOPED, and never trust a comment *(2026-07-30)*

> "we do a series of bug and documentation loop passes where we use subagents
> to do independent reviews of the code, comments, and documentaiton. never
> assume the comments and docs are correct, confirm it. we will run multiple
> sub agents each doing multiple loop passes until everythign is resolved"

**One careful pass is not enough, and that is measured rather than assumed.**
Eight passes over this repo found discrepancies every time. The first six
found roughly 145 — see PROMPTS.md and CHANGELOG.md, written immediately
after that session, which is the more reliable count; an earlier version of
this line gave an exact-looking six-way breakdown that summed to 160 and was
never reconciled against that record. A seventh and eighth pass on
2026-07-30 found roughly 20 more and exactly 3 more (the eighth pass's own
count: four findings, one already fixed, three real). **Every** pass found
errors introduced by the previous pass's own fixes, including a false claim
written by the pass that was correcting false claims. Keep looping until a
pass returns clean.

How to run one:

- **Several subagents per pass, on DISJOINT files**, so they run in parallel
  without racing each other's commits. Say explicitly which files each owns.
- **A finding is real only when verified against the code.** Require agents to
  report DISPUTED with evidence rather than fixing on suspicion — a
  meaningful fraction of findings each pass are themselves wrong, and one
  agent disputing a correction I had asked for was right to.
- **For any test that claims to guard something, break the production code and
  confirm the test fails.** Tests that assert nothing are this repo's most
  common defect: `it('only ever requests one seek')` asserted only that a
  promise resolved.
- **The recurring failure is a claim fixed in one place while copies survive.**
  After correcting one, grep the whole repo for its MEANING, not its wording —
  then check each hit in context. Two of five hits for "a few kilobytes" were
  about a different subject, and "correcting" them would have added two errors
  while fixing three.
- **Prefer a mechanical guard to fixing drift again.**
  `scripts/check-test-count.mjs` retired a number that had gone stale four
  times; it now gates `make check` and CI.
  `scripts/check-owner-quotes.mjs` does the same for every owner quote in
  this file, against `PROMPTS.md`, and gates `make check` too. It catches
  three things by hand-checking is bad at: a quote with no source, a quote
  **spliced** from two prompts, and a typo silently tidied up.
- **A guard that lives in a scratch directory is not a guard.** The first
  version of the quote checker was written, run once, and never committed —
  so the next pass had nothing to run and four bad quotes survived. If a
  check is worth writing during a review, it is worth wiring into
  `make check` in the same commit.
- **Audit every convention, not the first one you find.** That same checker
  validated `> ` blockquotes only. This file quotes the owner **two** ways —
  blockquote and inline `*"…"*` — and every one of the four bad quotes was
  in the style nobody checked.
- **Audit surface, not just claims.** Each pass tends to re-read whatever the
  last pass named. The two categories that stayed unexamined longest were the
  highest-yield: claims that can be EXECUTED (every documented CSV row,
  duration and command actually run — this is how `PT-4S`, silently rejected
  by `parseDuration`, was found), and imperative `must`/`never` rules with
  nothing enforcing them.

### The review is a PRE-RELEASE GATE — it runs before anything is pushed

> "let's do a multi subagent review of the docs, bugs, tests, and comments.
> loop through that process until all issues are resolved. we'll treat this as
> a process that happens before we release anything. once we're happy with
> this we can push the release live"

The order is **work → gate → release → push**. Not push-then-review, which is
what happened for 0.3.0 and is why this is written down.

Five reviewers, **disjoint scopes so they cannot converge on the same easy
observations**, run in parallel and all starting from *assume it is wrong*:

1. `src/core/` comments against the code
2. `src/viewer/` comments **and every user-visible string**
3. `tests/` — does each test assert what its name claims, and does it BITE
4. A free-hand bug hunt in whatever shipped most recently
5. Prose docs across both repos, including the data repo

Then fix, then loop. **Keep looping until a pass returns clean** — across
eight passes on this repo, every single pass found errors introduced by the
previous pass's own fixes, including one written by the pass that was
correcting false claims.

Two rules that make the gate worth running rather than ceremonial:

- **A finding is real only when verified against the code.** Require agents to
  report DISPUTED with evidence rather than fixing on suspicion; a meaningful
  fraction of findings each pass are themselves wrong, and one agent refusing
  four of my own instructions with `git log -S` evidence was right to.
- **For any test claiming to guard something, break the production code and
  confirm the test fails.** A green suite proves nothing about a test that
  asserts nothing, and this repo has shipped several.

### Releases are semantic, and the changelog is written as you go

> "let's make sure going forward we are doing semantic releases, updating the
> changelog"

Every shippable change gets a version. Write into the `## Unreleased` section
in the same commit as the work — reconstructing it later from `git log` loses
exactly the reasoning the file exists to keep. `make release VERSION=x.y.z`
refuses unless the changelog, `package.json` and a clean tree agree.

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
- All D3 usage stays confined to scale/axis math (`d3-scale`).
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
| `d3-scale` | axis tick math only (`scaleTime` in `Swimlanes.tsx`) — no D3 selections, no D3 DOM. `d3-time` was installed alongside it but never imported anywhere in `src/`, `tests/`, or `scripts/`; removed 2026-07-29 rather than left to rot as an unused dependency. |
| `vite`, `@vitejs/plugin-react`, `typescript`, `vitest` | build and test |
| `@types/react`, `@types/react-dom`, `@types/d3-scale` | types for the above |
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
- **No CSV library**, for `notes*.csv`/`people.csv`. RFC 4180 plus the
  formula-guard and BOM handling a real-world file needs is `src/core/csv.ts`,
  well under 200 lines, and dependency-free the same way `course.ts` is.
- **No ZIP library**, for the `notes.csv` + `people.csv` + `manifest.json`
  download. Only a **writer** is needed — import stays loose files, so
  nothing has to inflate anything — and a store-only (uncompressed) ZIP is
  local file headers, a central directory, and CRC-32: under 90 lines,
  `src/viewer/media/zip.ts`. **The payload is not "a few kilobytes of
  CSV"** — `notes.csv` and `people.csv` are, but `manifest.json`
  (pretty-printed at 2 spaces — see `saveEvent` in `App.tsx`) scales with
  item count and dominates: measured against the fields `assemble.ts`
  actually populates (`id`, `person`, `type`, `src`, `at`, `timeSource`,
  `width`, `height`, `orientation`, `bytes`, and `gps` on roughly half of
  photos), that's about **350 bytes per item**, so ~80KB at the real
  folder's 231 items and ~680KB at the project's 2,000-file target. The
  conclusion is unaffected — compression would still be the largest thing
  in the project for a payload this size, and store-only is still correct
  — only the size claim was wrong.

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
- `TODO.md` — anything deliberately deferred. **Completed items are struck
  through in place**, with a short note of when and what happened, right
  next to the reasoning that justified deferring them in the first place —
  see the basemap-tiles entry for the pattern. Nothing gets moved to a
  separate file.
- `TODO-completed.md` — a stub. The contract used to say completed items
  move here with a commit hash; in practice they never have, they get struck
  through inline in `TODO.md` instead, which keeps the surrounding context
  attached. This file stays as a pointer so a search for "completed" still
  finds the answer.
- `CHANGELOG.md` — pair what changed with the owner's guiding prompt(s),
  quoted verbatim from `PROMPTS.md`. The point is to show the project is
  human-guided, not blindly vibe-coded. Keep that framing.

  **Write into the unreleased entry as you go, not at release time.** The
  0.1.0 entry was drafted at M11 and was stale two commits later; anything
  reconstructed afterwards from `git log` loses exactly the reasoning the file
  exists to keep.
- The spec in `docs/superpowers/specs/` — update if the design changes.

### Releases: three things that must agree

`CHANGELOG.md`, the `version` in `package.json`, and the git tag. **`make
release VERSION=x.y.z` refuses unless they do** — no changelog entry, a
mismatched version, a dirty tree or an existing tag all stop it, and it runs
`make check` before tagging. It deliberately fixes nothing up: a tag pointing
at a version the changelog does not describe is worse than no tag.

Tags are `vX.Y.Z`; the changelog heading is `## X.Y.Z — YYYY-MM-DD — title`.
The target only tags. Pushing stays a deliberate act:

```sh
make release VERSION=0.1.0
git push origin main && git push origin v0.1.0
```

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
| `--mw-link` | `#4E8FBF` (5.21:1) | brand `#236192` is **2.8:1** on `#171512` — unreadable |
| `--mw-danger` | `#D98BA3` (7.09:1) | brand `#9A4665` is **3.0:1** |

Orange `#F26522` passes unchanged at 5.78:1 and is the cursor accent (`--mw-accent`).
`--mw-fg-faint` is **3.98:1** — below the 4.5:1 AA threshold for body text —
so it is **borders and decoration only, never text**; six text uses that
depended on it were moved to `--mw-fg-muted` (8.34:1) for exactly this
reason. `--mw-fg`, the primary text color, is 16.88:1. (Figures recomputed
against the shipped tokens in `src/viewer/styles/tokens.css`; re-measure
rather than trust these if the tokens change.)

Atkinson Hyperlegible is **self-hosted** (`src/viewer/fonts/`, SIL OFL, 52,380
bytes across four files, measured)
so no font is fetched from a third party. That does NOT mean the page makes
no external requests — three things do:

1. **Map tiles** (OpenTopoMap, Esri/ArcGIS, OSM, and optionally Thunderforest
   — see `src/viewer/map/basemaps.ts`), loaded unconditionally on **every
   view** once a track is loaded, not just the course view.

   **`CourseMap` has TWO mount sites, and this claim has now flipped three
   times because people check the import and stop.** `App.tsx` mounts it
   directly under `view.view === 'course'`; `CourseRail.tsx` mounts it a
   second time, and `App.tsx` mounts *that* under `view.view !== 'course'`
   — i.e. exactly Feed and Swimlanes. `CourseMap`'s basemap effect builds
   the tile layer unconditionally; its `compact` prop gates a className and
   one block of chrome, **not the tiles**. So the honest sentence is "once a
   track is in the folder, map tiles load on every view", and the tempting
   one ("only on the Course view") is false. Before editing this paragraph
   again, grep for `CourseMap` and check every MOUNT site, not just the
   import.
2. **Google Analytics**, on the DEPLOYED site only — `googleAnalytics()` in
   `vite.config.ts` is `apply: 'build'`, so `make dev` loads no tag at all.
   That split is deliberate: local mode reads somebody's private photographs
   off their own disk, and the README promises nothing leaves the machine.
   The published page does contact `googletagmanager.com`, and Google sees
   each visitor's IP. What it is TOLD is deliberately narrow — see
   "Analytics learns the view, and nothing else" below.
3. **The Strava embed** iframe, which is external but click-to-load.

Keep this list honest. A claim that this app phones nobody is the kind of
thing a reader will believe and act on.

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

1. ~~**Public from day one?**~~ **Answered 2026-07-29: public repo, private
   manifest.** The renderer (**this** repo, `meanwhile`) is published; inside
   it, photographs, `manifest.json` and the track never enter git and stay on
   the author's disk. `.gitignore` enforces it — verified with `git
   check-ignore -v manifest.json notes.csv people.csv` — and a
   pre-publication audit confirmed nothing sensitive is tracked or in
   history. This is not in tension with "`manifest.json` belongs under
   version control" above: that sentence is about a SEPARATE, private
   per-event data repo (see `EVENT.md`), not this one.
2. **Scope of an event.** One manifest per event. Does a multi-day event, or
   a series (training runs leading up to the race), need a collection
   concept, or is one file always enough? *(Assumed: one file is enough.
   YAGNI until told otherwise.)*
3. **License.** Deferred 2026-07-29 **with a constraint**: the owner wants to
   bar commercial use. Note that a public repo with no LICENSE is already all
   rights reserved, and that a non-commercial restriction is not open source.
   Options and trade-offs are written up in `TODO.md` — do not re-derive them.

### Answered in session 2 — do not re-ask

`role` carries behavior (runner pinned top, owns the spine) · no-timestamp
media goes to an unplaced tray · notes are written in-viewer and exported ·
aesthetic is the brand's dark ramp · CLI is deferred so its language is moot ·
lots of short video, treated as points with `duration` in the schema · 8
people / ~2k files.
