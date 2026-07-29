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
