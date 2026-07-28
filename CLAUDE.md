# CLAUDE.md — working rules and context for `meanwhile`

## STATUS: DESIGN ONLY. NO CODE EXISTS YET.

As of 2026-07-28 this repo contains documentation and nothing else. There is
no `src/`, no `package.json`, no build, no tests. **Do not describe any part
of this system as implemented, and do not assume any file below exists** —
every path in this document is a plan, not a fact. Check before you cite.

## START HERE: what the owner wants from the next session

The owner ended the design session with this instruction:

> i will restart in a new session and i want you to ask me questions about
> the decisions made, and we may need to make changes

**So the next session opens by interrogating the design, not by writing
code.** Work through "Open questions" at the bottom of this file, and treat
every decision in the record below as re-openable. The owner has already
overruled Claude's recommendation once (keeping the CLI), so do not present
these as settled.

Do not start implementing until the owner says to.

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

### Two artifacts, one shared kernel

A viewer (React + Vite) and an ingest CLI (TypeScript on Node), both
importing a pure `src/core/`.

Claude proposed collapsing the CLI into the site (browser-side EXIF parsing,
one artifact, no install). **The owner chose to keep both**, for
exiftool-grade video metadata, Drive pulls, and bucket uploads.

Consequence: **schema drift is now the project's main design risk.** The
mitigation is non-negotiable — `src/core/schema.ts` is the single source of
truth imported by *both*, so a schema change breaks both builds at once
instead of one at runtime.

The CLI is TypeScript rather than Python **only** so it can share that kernel.
If the owner would rather read Python, that trade is worth re-opening — but
the answer must then include how the two stay in sync (a JSON Schema
contract plus round-trip fixtures on both sides).

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

**The data-quality rule** — the highest-leverage sentence in the README:

> **AirDrop or Drive. Never iMessage or WhatsApp.** Those recompress and strip
> EXIF, and a photo with no timestamp has no lane to sit in.

---

## Architecture rules

- `src/core/` is a **pure TypeScript kernel**: schema and validation, clock
  math, grouping, timeline binning, the course spine. Only relative imports
  of other core files; no React, no Node APIs, no browser globals. To be
  enforced by `tests/core-purity.test.ts` — never weaken that test.
- Both the viewer and the CLI import `src/core/schema.ts`. Neither may define
  its own notion of the manifest.
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

Nothing is installed yet. The intended runtime set is small — react,
react-dom, and `d3-scale`/`d3-time` for the axis. Dev: vite, typescript,
vitest, @vitejs/plugin-react, tsx, and types.

GPX and TCX are XML and must be parsed without a new dependency. FIT is
binary and would need one, which is why it is deferred.

**Justify every addition in this file before installing it.**

## The documentation contract

This project is **vibe-coded**: the owner does not read
JavaScript/HTML/CSS, and Claude is the only maintainer. **Wrong documentation
is worse than no documentation.** Any change affecting setup, commands,
structure, or behavior MUST update the affected docs in the SAME commit:

- `README.md` — what it is plus complete setup/run/deploy instructions,
  written for a non-JS reader. Never document a command that does not work.
- `Makefile` — must always match reality; every target works. *(Not yet
  created — there is nothing to run.)*
- `PROMPTS.md` — append-only log of the owner's prompts (**verbatim**) and
  the decisions made. Every session, append.
- `TODO.md` — anything deliberately deferred.
- `TODO-completed.md` — move items here when done, with the commit hash.
- `CHANGELOG.md` — on every release, pair what changed with the owner's
  guiding prompt(s), quoted verbatim from `PROMPTS.md`. The point is to show
  the project is human-guided, not blindly vibe-coded. Keep that framing.
- The spec in `docs/superpowers/specs/` — update if the design changes.

## Aesthetic

**Undecided — ask.** The owner's `color-combinations` project uses a "Washi &
Ink" japandi palette with their brand colors (NYC orange `#F26522` sparingly,
blue `#236192` for links, warm neutrals). Whether meanwhile shares that
identity or gets its own has not been discussed.

Worth raising: this app is mostly a dark canvas behind photographs, and
photos generally want a neutral, recessive chrome that does not compete with
them.

---

## Open questions for the owner

Ask these. Do not answer them unilaterally.

1. **Public from day one?** The site is public by design, but the *manifest*
   for your friend's race is a separate choice. Public repo with a private
   manifest, or keep the whole thing unlisted until the crew has seen it?
2. **Does `role` do anything?** Is runner/crew/friend just a label, or does
   the runner's lane get pinned to the top, styled differently, treated as
   the spine's owner?
3. **Media with no usable timestamp.** Some files will arrive stripped. Drop
   them, park them in an "unplaced" tray for manual placement, or guess from
   file order? This needs an answer before the data model is fixed.
4. **Scope of an event.** One manifest per event. Does a multi-day event, or
   a series (training runs leading up to the race), need a collection
   concept, or is one file always enough?
5. **Who writes the notes, and when?** Per-item `note` is in the schema, but
   the workflow is undefined — do you write captions while assembling, or do
   the crew annotate their own photos somehow?
6. **Aesthetic** — shared identity with `color-combinations`, or its own?
7. **CLI language** — TypeScript for kernel-sharing, or Python for
   legibility? (See the decision record for the cost of switching.)
8. **Video.** How much of the media is video, and how long? It changes the
   swimlane design substantially — a 4-minute clip is a *span* on the
   timeline, not a point, and nothing in the current design accounts for
   that.
9. **Rough scale.** How many files total, and how many people? A few hundred
   and four people is a very different renderer from twenty thousand.
