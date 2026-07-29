# TODO

Ideas and items deliberately deferred. Move to `TODO-completed.md` with a
commit hash when done.

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

## Housekeeping

- Choose a license.
- `CHANGELOG.md` once there is a release to describe.

- **Automatic clock alignment.** Match a photo's GPS position to the point on
  the track with the same coordinates; the difference between the photo's
  timestamp and the track's is that device's `clockOffset`. **Needs a timed
  track**, so it is blocked until an activity export turns up — the route
  export we have has no timestamps to compare against.
- **A pace chart without a timed track.** Grade against distance already works
  and is the useful part of a course profile; pace is genuinely impossible
  without times and is simply not drawn.
- **Photo dots on the map when the track is untimed.** They already plot by
  their own GPS, but there is no cursor linking them to a position on the
  course, so clicking one cannot scrub anything.

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
