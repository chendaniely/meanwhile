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
- **Basemap tiles** under the course polyline. The spine makes a tile-free SVG
  map sufficient for v1; tiles are a garnish with a real dependency cost.
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

## Open design questions

Tracked in `CLAUDE.md` under "Open questions for the owner" — to be resolved
with the owner before implementation starts. The two most likely to change the
data model:

- **Media with no usable timestamp** — drop, park in an "unplaced" tray, or
  infer from file order?
- **Video as a span, not a point** — a 4-minute clip occupies an interval on
  the timeline, and nothing in the current swimlane design accounts for that.

## Housekeeping

- Choose a license.
- Decide the aesthetic (shared with `color-combinations`, or its own).
- `Makefile` and `CHANGELOG.md` once there is anything to build or release.
