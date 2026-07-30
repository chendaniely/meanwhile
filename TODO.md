# TODO

Ideas and items deliberately deferred. Completed items are struck through in
place, with a short note of when and what happened, so the reasoning that
justified deferring them stays attached to the note that it's done — see the
basemap-tiles entry below for the pattern. Nothing gets moved to a separate
file; see `TODO-completed.md` for why.

## Deferred from the 2026-07-28 design session

- **Google Drive folder adapter** — Drive is the right *collection point* for
  crew media, but v1 ingests from a local folder. Adding this means OAuth in
  the CLI.
- **Bucket upload from the CLI** — the step that turns a local manifest into a
  shareable one by pushing media somewhere with stable URLs and rewriting
  `media.base`. Cloudflare R2 is the likely target (zero egress).
- **FIT file support** — binary format, needs a parser dependency. GPX and TCX
  are XML and parse without one, so they come first.
- ~~**Basemap tiles** under the course polyline.~~ **Done 2026-07-29.** The
  original reasoning was that the spine makes a tile-free SVG map sufficient,
  and tiles are a garnish with a real dependency cost. The owner reversed it
  for a mountain trail race, where a bare polyline shows no ridges, valleys or
  switchbacks. Leaflet plus keyless raster sources — OpenTopoMap, Esri imagery,
  Esri hillshade, OSM.
- **EXIF write-back** of corrected timestamps into copies of the media, so the
  correction travels with the file into any tool. Deferred, not rejected —
  it has genuine archival appeal. Must never touch originals.
- **Per-uploader clock adjustment** — each person aligns their own lane and
  exports a snippet to merge. Rejected for v1 because it needs a real
  contribution and merge workflow; central adjustment is enough for one
  author.
- **Per-person GPX tracks** — v1 has one course track. The schema should not
  preclude several (crew tracks, a pacer's track).
- **Google Photos Picker API importer** — the only remaining API path, and a
  per-person interactive step. Would write into the same manifest rather than
  becoming a real adapter. Low priority; the ZIP download covers it.

## Deferred in session 2 (2026-07-28)

- **The ingest CLI itself.** v1 is viewer-only. The CLI returns when bucket
  upload or exiftool-grade video metadata is actually needed. `src/core/` is
  already written to be imported by it unchanged, and
  `tests/core-purity.test.ts` keeps it that way.
- **Sharing.** Follows directly from the above: v1 is local authoring only.
  Sending the crew a link needs media at stable URLs.
- **Video as a span, not a point.** Clips render as points with a poster
  frame. `duration` is already in the schema, so spans need no migration —
  only lane rendering.
- **Windowed rendering** in the feed and grid. Lazy loading covers ~2k files;
  past ~5k you need to render only visible rows.
- **Generated thumbnails.** Needs the CLI. Until then the viewer decodes
  downscaled with `createImageBitmap`.
- **Lane grouping / collapsing** (all crew as one expandable lane). Useful
  past ~8 people, which is also where categorical color stops being
  distinguishable.
- **A light theme.** Deliberately not built. Adding one means re-deriving
  every contrast pair in `tokens.css`.
- **HEIC display.** Metadata parses, but no browser except Safari can decode
  the image; the tile shows a placeholder. Decoding would mean a WASM
  dependency, which the budget does not currently justify.

## Found while verifying against real race files (2026-07-28)

- **Sub-second ordering.** EXIF `DateTimeOriginal` has one-second resolution,
  so a burst lands on one instant — two real photos 461ms apart shared a
  timestamp. `SubSecTimeOriginal` (tag 0x9291) would break the tie. Cheap, and
  it matters for ordering within a burst.
- **Duplicate detection.** The real folder contained
  `20260724_184945.jpg` and `20260724_184945(0).jpg` — the same photo twice.
  Both currently become items. Worth flagging, if not auto-merging.
- **A better `mvhd` estimate.** Android writes it at the END of recording, so
  `mvhd − duration` would recover the start. Not generalized because Apple's
  `mvhd` means something else again; the filename covers Android today.

## Deploy and process (2026-07-30)

- **Enable GitHub Pages** — *the owner's click, not Claude's.* Settings →
  Pages → Source → **GitHub Actions**. Everything else is done: `main` is
  pushed, `v0.2.0` is tagged, and the workflow's build job passes on GitHub's
  runners (install, typecheck, 504 tests, count guard, build). The deploy step
  fails on exactly one thing and names it: Pages is not enabled, so
  `actions/deploy-pages` 404s. Re-run the workflow after flipping it.
- **Restore commit signing, if wanted.** The original root commit was
  GPG-signed; `git filter-repo` strips signatures, so the rewritten history
  and everything since is unsigned.
- **Google Analytics is build-only** (`googleAnalytics()` in
  `vite.config.ts`, `apply: 'build'`). If a consent banner is ever needed —
  EU visitors, say — it belongs here, and note the project has no cookie
  banner today.

## Housekeeping

- ~~`CHANGELOG.md` once there is a release to describe.~~ **Struck
  2026-07-30**: `CHANGELOG.md` exists and has carried every session's changes
  since M11 — the doc contract makes it mandatory, not optional. This line
  was stale from before the file existed.

- **Hand-placing an item from the unplaced tray onto the timeline.** Found
  during a documentation-accuracy pass: several docs described this as
  built ("draggable onto the timeline, which writes `at` and flips the
  source to `manual`"), but it never was — `UnplacedTray.tsx` is read-only,
  and there is no `draggable`, `onDragStart`, or `onDrop` anywhere in
  `src/viewer/`. The groundwork is already in place and makes this cheap
  when picked up: `timeSource: 'manual'` exists in the schema, and
  `ingest.ts` already preserves a manual placement across re-ingest. Only
  the UI — a drop target on the swimlanes/feed, or an explicit "set time"
  control — is missing.

- **Automatic clock alignment.** Match a photo's GPS position to the point on
  the track with the same coordinates; the difference between the photo's
  timestamp and the track's is that device's `clockOffset`. **No longer
  blocked.** This waited on a timed track, because the first export we had was
  a *route* export with no timestamps to compare against; the owner supplied a
  real activity export on 2026-07-29 (121k points, timestamps present) and it
  parses. What is missing is the estimator itself. When writing it, note that
  the right statistic is `min(shutter − gps)` across many photos rather than
  the mean: a GPS fix always precedes the shutter, so the error is one-sided
  and the minimum is the freshest fix — see CLAUDE.md's "GPS time is NOT the
  shutter time".
- **A pace chart without a timed track.** Grade against distance already works
  and is the useful part of a course profile; pace is genuinely impossible
  without times and is simply not drawn.
- **Photo dots on the map when the track is untimed.** They already plot by
  their own GPS, but there is no cursor linking them to a position on the
  course, so clicking one cannot scrub anything.
- **Map dots need a second visual channel beyond colour.** Found during a
  documentation-accuracy pass: `CLAUDE.md`, `palette.ts`, and `CourseMap.tsx`
  all claimed dots "must carry the person's name as a direct label" as the
  fix for the palette failing past three people under the all-pairs test
  (worst pair ΔE 1.6 under deuteranopia). What's actually implemented is a
  hover-only Leaflet tooltip (`bindTooltip`, no `permanent`) — it shows one
  name at a time, on whichever dot the pointer is over. A permanent label
  can't just be turned on: these dots are one per photograph, and the real
  folder has 200+ in view at once, so permanent labels would overlap into
  noise. **The gap is real and open**: two adjacent dots are colour-only
  until you hover one. The standard fix is a second channel that scales with
  dot count rather than a label — e.g. a distinct marker shape per person,
  layered under the same colour — but that is a design decision for the
  owner, not made here.

## Aid stations on the course

> "for ultra races, i'd like the map to also tag where the aid stations are,
> and whether those are AS that are crew accessible. i'm not sure how best to
> get that information into the app, and then save the results (since this is
> a static site)"

**Worth doing, and probably the highest-value annotation this app could
have** — because an aid station is exactly where the crew's lanes and the
runner's lane meet. "Crew boiling water at Cottonwood while the runner is two
hours out on the climb" is the simultaneity claim in its most concrete form,
and a crew-accessible flag is what separates the aid stations that generate
photographs from the ones that do not.

### Saving it is already solved

The owner flagged this as the hard part. It is not: **the manifest is the
answer**, and it is the same answer as notes, clock offsets, and hand-placed
timestamps. The site stays a renderer; the author's work lives in the file
they export and re-load. Nothing server-side, consistent with the whole
architecture.

`Marker { label, at?, atDistance? }` **already exists in `schema.ts` and is
already validated** — it is just never rendered. So this is mostly wiring,
plus one schema addition:

```ts
interface Marker {
  label: string;
  at?: string;          // wall-clock
  atDistance?: number;  // metres along the course
  crew?: boolean;       // NEW: crew-accessible
  kind?: 'aid' | 'start' | 'finish' | 'note';   // NEW
}
```

Adding optional fields is a compatible change and needs no schema version
bump. Re-ingest must preserve markers the same way it preserves names and
captions — they are author work, not metadata read from a file.

### Getting it in: three routes, cheapest first

1. **Type the mile numbers.** Races publish aid stations as a table — "Mile
   40.2, Cottonwood, crew access" — and `atDistance()` already converts
   metres along the course into a lat/lon. So the most common published
   format needs **no GPS at all**, and `Marker.atDistance` exists for exactly
   this. Note the unit mismatch to handle: race tables are in miles, the
   schema is in metres.
2. **Read GPX `<wpt>` elements.** Organiser-provided course files often carry
   named waypoints, and `course.ts` currently parses only `<trkpt>` — adding
   `<wpt>` is a few lines in the same scanner and would populate the whole
   list for free. **The owner's Strava export has zero `<wpt>`**, so this
   helps for an organiser's file, not for this one.
3. **Click the map or the elevation profile** to drop one, name it, tick
   "crew accessible". Needed anyway as the correction path for 1 and 2.

### Design notes for whoever picks this up

- **Aid stations belong on the elevation profile as much as the map.** "The
  climb between mile 40 and mile 52" is how an ultra is actually discussed,
  and the profile is where that reads.
- **Crew-accessible needs a non-colour encoding** — a different marker shape
  or a label — for the same reason map dots carry names. Do not encode it as
  colour alone.
- **They make the swimlanes legible.** Vertical rules at each aid station
  turn the lanes from "when people shot" into "who was where, when", which is
  the closest thing to a headline this app has.
- An aid station visited twice on a lollipop course is two markers at two
  distances with one label. Do not assume labels are unique.

- **A 12/24-hour clock setting.** Everything is 24-hour today, which the owner
  asked for explicitly: *"we could have a setting somewhere to toggle the time,
  but for now let's keep it 24-hour."* It would belong in the manifest's
  `event`, so a shared link reads the way its author meant it to. Note that
  `<input type="datetime-local">` cannot be made to follow it — Chrome formats
  that control from the browser's locale and ignores `lang` — which is why the
  note fields are plain text.

## The license — deferred, with a constraint *(2026-07-29)*

The owner: *"let's hold off on the license now. i want to protect it from
commercial use."*

**Deferring is not neutral, and here it happens to do what was asked.** A
public repository with no LICENSE file is **all rights reserved**: nobody may
use, copy, modify or redistribute it. GitHub's terms add only the right to
view and to fork *within* GitHub. So commercial use is already barred — but so
is a friend legitimately running their own copy, which is probably not
intended long term.

When it is picked up, the thing to know first: **a non-commercial restriction
is not open source.** It fails the OSI definition and the FSF's, so the repo
should not be described as either, and some people's employers forbid
contributing to such projects.

The options that actually fit "no commercial use":

| | Notes |
|---|---|
| **PolyForm Noncommercial 1.0.0** | Purpose-built for software, plainly drafted, and the one to reach for. Permits any noncommercial use including by nonprofits and schools. |
| **PolyForm Strict / Small Business** | Same family, different lines drawn. Worth a look if "noncommercial" turns out to be the wrong cut. |
| **CC BY-NC-SA 4.0** | Creative Commons explicitly advise against using their licences for software; it has no patent or warranty language. Avoid. |
| **Dual: AGPL + a commercial licence** | Keeps it genuinely open source while making a closed commercial fork impractical. More administration, and the owner has to be willing to grant the second licence. |

Worth deciding before anyone else is invited to contribute, because
relicensing later needs every contributor's agreement.

## Telling two people apart when they carry the same phone *(parked 2026-07-29)*

> "in larger events or events where people have the same device, is there a way
> to see from a photo if it's different people using the same make+model of
> phone?"

**Not reliably, and the honest move is to say so rather than guess.** Grouping
by device works today only because the three phones happen to differ.

| Signal | Separates two identical phones? |
|---|---|
| `BodySerialNumber` (EXIF 0xA431) | Would be definitive — **phones do not write it.** Cameras do. |
| iPhone `IMG_1234` counters | **Yes, well.** Each phone has its own counter, so two occupy non-overlapping ranges. Useless on Android, whose filenames are timestamps. |
| `Software` (EXIF 0x0131) | Sometimes — only when the two are on different OS or camera-app builds. Free to read; not read today. |
| Clock offset | Sometimes. Every phone drifts differently, and per-person `clockOffset` already exists. Subtle, and needs many photos. |
| Sensor noise, PRNU | Genuinely identifies a physical unit; it is what forensics uses. Needs hundreds of full-size decodes. Out of scope. |

What to build instead, in order:

1. **Warn rather than merge.** When two people could be sharing a make and
   model, the ingest report should say the lane is uncertain. Silently
   collapsing two people into one lane is the failure this project cares most
   about avoiding.
2. **Bulk reassign.** Select a stretch of photos and give them to a person.
   This is the reliable fix and it needs no cleverness.
3. **Read `Software`** as an extra grouping signal — cheap, occasionally
   decisive, never harmful.

Folders remain the reliable separator, and the roster — names people are
addressed by, so notes can reference a person rather than a phone — is
deliberate metadata. Its edit surface is `people.csv`; `manifest.json` still
carries a redundant copy, and `people.csv` wins when both are present (see
CLAUDE.md's "The manifest is the contract").

## An import/export wizard *(raised 2026-07-29, during the notes-as-CSV build)*

> "i feel like we'd need a wizard screen at the start to handle how everythign
> gets read into the site. separate files, zip files, location to local media
> folders, and having metadata files in a git repo (potentially a Github PAT
> that has only 1 repo write access so saves can happen directly into the repo)"

Right, and the need is created by this very change: once metadata lives in
several files that can arrive several ways, "point at a folder" stops being the
whole story. The routes to support:

1. **A folder** — what exists today.
2. **Loose files** — exists today, and now includes `notes*.csv` and
   `people.csv`.
3. **A zip** — we will be *writing* one after this change, so reading one back
   closes the loop. Needs an inflater: `DecompressionStream('deflate-raw')` is
   in every current browser, so still no dependency.
4. **A metadata repo over HTTP** — already has its own spec pending. Read-only
   is easy: `raw.githubusercontent.com` sends permissive CORS.
5. **Media separately from metadata**, since metadata is small and text and
   media is neither. This is the piece that would finally make a shared link
   work.

### On the GitHub PAT — worth doing, with eyes open

Writing back to a repo from a static site needs a credential in the browser,
and there is no way around that without a backend. The honest trade-offs:

- **A fine-grained PAT scoped to one repository with `contents: write`** is the
  right shape, and GitHub supports exactly that. It is what makes "save goes
  straight into the repo" possible with no server.
- **It is a bearer token sitting in browser storage.** meanwhile loads no
  third-party scripts, which removes the usual XSS route, but the token is
  still readable by anything that does run in the page, and it survives until
  it is revoked. It should be entered by the user, never logged, never put in
  a URL, and easy to clear.
- **The better long-term shape is GitHub's OAuth device flow**, which needs
  only a client id — no secret and no backend — and yields a revocable
  short-lived token instead of a long-lived PAT. More work; strictly safer.
- Whichever is used, saving must still produce a downloadable zip, because a
  token is optional and the site has to work without one.

## Full `YYYY,MM,DD,HH,MM` splitting, both ends of a span *(deferred, notes-as-CSV)*

`notes*.csv` already splits a note's own start time into five plain integers
(`year,month,day,hour,minute`) because that is the one shape a spreadsheet
cannot silently reformat — see `CLAUDE.md`'s decision record for the full
argument. The genuinely mangle-proof version of a *span* would split the END
the same way too: ten integer columns per note instead of five plus a
`duration`. **Considered and deferred** — ten columns was judged too high a
price for what one ISO-8601 `duration` column (`PT3H40M`) already does
cleanly, with none of the boundary cases an end timestamp would reintroduce
(a duration doesn't care that a race crosses midnight or that 31 July
crosses a month). Revisit only if `duration` itself turns out to get
mangled by a spreadsheet in practice — nothing in testing so far suggests it
does, and it is neither a number nor a date to Excel, which is exactly why
it was chosen.
