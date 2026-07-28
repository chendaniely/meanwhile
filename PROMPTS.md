# PROMPTS.md

Append-only log of the owner's prompts (verbatim, typos and all) and the
decisions they made. Someone should be able to re-create this project from
this file.

---

## Session 1 — 2026-07-28 — naming and design

Conducted in the `color-combinations` working directory before this repo
existed; the whole session was brainstorming, no code was written.

> i have a project idea. first let's come up with a github repo name /
> project name: i want to be able to take a photo feed from multiple people
> (like a google shared photo drive) and i want to be able to showcase a
> timeline of events that show different people's perspective over a time /
> event.

> specifically: my friend ran an ultra maratphon. i want to put together his
> photos, videos, mine, the crew. and be able to see over time what
> different people where doign / experiencing in relation to everyone else

**Naming round 1.** Offered `splitscreen`, `sightlines`, `parallax`,
`crewline`. Owner asked to clarify rather than pick.

> i'm liking sightlines and splitscreen. let's think of some more ideas

**Naming round 2.** Offered three families — optics/vantage (`eyelines`,
`viewfinder`, `vantages`, `parallax`), editing/simultaneity (`meanwhile`,
`crosscut`, `multicam`, `elsewhere`), and darkroom objects (`lightbox`,
`contactsheet`, `hindsight`), plus race-flavored options (`aidstation`,
`milemarker`, `pacenotes`, `crewline`).

**DECISION — name:** `meanwhile`. Owner selected it alone from the
shortlist, dropping `sightlines` and `splitscreen`.

---

**Media source.** Asked how photos/videos get in: local folder → static
build, live Google Photos/Drive read, or an upload backend.

> i want it to read a google photos / drive album, but also be able to point
> to a local folder.

**DECISION — pluggable sources.** Both, behind one adapter interface. This
prompted research that killed the Google Photos API path (see
`docs/superpowers/specs/` §7).

---

**Primary view.** Offered swimlane timeline, merged tagged feed, timeline +
synced map, and a "moment" grid, with ASCII previews of each.

> i like the swimlane, one merged feed tagged, and the timeline. is there a
> way to goggle those views? we can even have the moment grid in there as
> well

**DECISION — all four views, toggleable.** Established the core insight that
they are four projections of one state object with a shared cursor, so the
toggle is cheap and the cursor survives switching.

---

**Sharing and hosting.** Offered private build, unlisted link + bucket,
password-protected deploy, or fully public.

> i want the site to run on github. but maybe have a way to create / upload
> a metadata file that points to photos and comments that the site will
> render. so it's a public site, that we can have it work to render local /
> remote files. "media in a bucket" can also be a shared google photos album

**DECISION — the site is a renderer, not a locker.** Public static site on
GitHub Pages, ships zero media. A manifest ("metadata file") points at media
that may be local or remote. This is the architectural core of the project
and came from the owner, not from Claude.

---

> clockoffset should be able to be adjusted by person / uploader and saved
> in metadata of the file.

Asked whether "metadata of the file" meant the manifest or the media files'
own EXIF, and whether adjustment was central or per-uploader.

**DECISION — manifest, adjusted centrally by the event author.** One file,
one editor, no merge story. EXIF write-back deferred to `TODO.md`.

---

> for google photos. do you think it's easier to copy images to a google
> drive foler? i know the manual way is to download the album and then use
> that downloaded folder as a local drive input

Researched and answered **no** — Photos→Drive auto-sync died in 2019 and the
remaining desktop path is being removed through mid-2026, so "copy to Drive"
means download-then-re-upload. The owner's instinct (download the album, use
it as a local folder) was correct and is the supported path.

> okay so i can download the google photos album as a zip. put it in a local
> folder and then point the site to that folder

**DECISION — confirmed ingest path.** Noted the nuance that a public site
cannot read a typed path; it reads a *granted* folder via the File System
Access API. Also established that local mode is fully offline — nothing
leaves the machine.

---

**Collapse the CLI?** Proposed deleting the CLI entirely and letting the
site do all ingest in-browser (one artifact, no install).

**DECISION — keep both site and CLI.** Owner chose robustness over
simplicity: exiftool-grade video metadata, Drive pulls, bucket uploads. This
makes schema drift the project's main design risk, addressed by a single
shared `src/core/schema.ts`.

---

> another thing i'd like to do is be able to adjust the timeline from a line
> to somethign that takes a gpx / strava file. this way we can have a map /
> elevation profile in the view as well

**DECISION — the course spine.** The best idea in the session. Research
established that the **Strava API is forbidden** for this use case (its
agreement bars showing a user's activity data to anyone but that user), so
the project takes a **GPX export** instead — which also makes it work with
Garmin, COROS, or any watch.

The spine pays for itself four times: pluggable time/distance axis,
elevation profile as the swimlane backdrop, a **tile-free SVG map** (which
moved the map from v1.1 back into v1), and **automatic clock alignment** from
photo GPS matched against the GPS-synced track.

---

> this is a separate project. let's do a few things. first clone the repo
> into the ~/git/hub/ git@github.com:chendaniely/meanwhile.git repo. then
> move all the specs and files in there. create a CLAUDE.md file that specs
> out this project and give yourself all the context you need for this
> project and history of decisions. i will restart in a new session and i
> want you to ask me questions about the decisions made, and we may need to
> make changes

**DECISION — set up the repo, defer implementation.** Spec, CLAUDE.md,
PROMPTS.md, TODO.md, README committed. Next session opens by interrogating
the decisions above rather than writing code.

---

## Session 2 — 2026-07-28 — interrogating the design, then first code

> ok. let's start this project. let's built it with an existing project i
> want to implmeent. but the data and website will be separate (e.g., the
> website will be on github, data will exist locally). i want to build this
> around for my friend's 100mile ultra marathon. i'm looking to point to his
> strava, so we can get the course map, where is is on the map at a givien
> time, but also the elevation profile. then we have the photos and videos
> from different people/sources

Flagged that the **Strava API cannot be used** (agreement bars showing an
athlete's data to anyone but that athlete) and asked what the friend can
actually hand over.

> i want to build it with accepting either a GPX or strava URL. eventually
> the GPX will be given to me, but for now i might only have the strava URL.

Researched Strava embeds: the embed URL is
`.../activities/{ID}/embed/{CODE}`, and `{CODE}` comes from the share dialog
— it **cannot be derived from a plain activity URL**. An embed is also an
opaque iframe that cannot sync to our cursor. So neither Strava path yields
position-at-time; only a GPX export does.

**DECISION — `course` is a union.** `gpx` | `strava-embed` | `strava-link` |
absent. Only `gpx` produces a spine; the others are presentational and the
spine-dependent features hide themselves. **This set the build order:**
everything except the spine works with zero course data, so the spine is
built last and the GPX lights it up later with no rework.

---

**Scale.** Asked how many people and files.

> how hard would it to scale from 4 people to 8 people with lazy loading? to
> more?

Answered that people are nearly free (a layout and color question, capped
around 8 by categorical-color distinguishability) and files are what cost:
swimlanes are free at any scale because they render binned marks, while the
feed and grid render real images. Named the two local-mode traps — blob URLs
must be *revoked* on scroll-out, and a 12MP photo decodes to ~48MB so the
grid must decode downscaled.

**DECISION — design for 8 people / ~2k files.** Lazy loading, blob-URL
lifecycle, and downscale-on-decode built in from the start (~1 extra day,
painful to retrofit). Windowing and thumbnail generation stay deferred.

---

**Video.**

> Lots of video, mostly short

**DECISION — video is first-class, but a point on the timeline.** `duration`
lives in the schema so spans are possible later. This plus viewer-only ingest
means parsing video timestamps in the browser, which is the riskiest piece of
the build: Apple writes `mvhd` creation_time in *local* time with no zone, so
trusting it silently shifts clips by hours.

---

**Media with no usable timestamp.** Offered drop / unplaced tray / infer from
file order.

**DECISION — unplaced tray**, with manual placement writing `at` back into
the manifest. Nothing is silently lost, and nothing is confidently wrong.

---

**Two artifacts or one?** Re-opened the Session 1 decision to keep the CLI,
given that only the local-folder path matters right now.

**DECISION — viewer only in v1; CLI deferred.** One artifact, no install, and
no schema-drift risk yet. `src/core/` is still written to be imported by a
CLI unchanged, which is why deferring it costs nothing. The CLI arrives when
bucket upload or exiftool-grade metadata is actually needed.

*Consequence, stated plainly:* v1 cannot send the crew a link. Sharing needs
media at stable URLs, which is the deferred upload step.

---

**Role.**

**DECISION — `role` carries behavior.** The runner's lane is pinned to the
top, styled distinctly, and owns the course spine.

---

**Notes.**

**DECISION — written in-viewer, exported back to the manifest.** Click an
item, type a caption, "Export manifest" writes it out. No backend; you
re-save the JSON.

---

**Aesthetic.** Offered its own dark identity, the `color-combinations`
palette, or a hybrid.

> i have a brand.yml file i use on my chendaniely.github.io website:
> https://github.com/chendaniely/chendaniely.github.io/blob/main/_brand.yml
> is this what you mean by option #2?

Fetched it. The question dissolved: that `_brand.yml` **already contains a
dark ramp** (`dark-base #171512`, `dark-surface #232019`, `dark-border
#2E2B26`), so "its own dark identity" and "share the brand" were never in
tension.

**DECISION — the brand's dark ramp, permanently.** No light theme. Two
derived values were required because the brand's own colors fail WCAG AA on
the dark ground: links use a lightened blue (`#4E8FBF`, 5.3:1) rather than
`#236192` (2.8:1), and danger text uses `#D98BA3` rather than `#9A4665`.
Orange passes unchanged at 5.9:1 and becomes the cursor. Atkinson
Hyperlegible is **self-hosted** so the site makes zero external requests.

---

**Implemented this session:** M0 (scaffold, brand tokens, core-purity test,
Makefile) and M1 (`src/core/schema.ts`, `src/core/time.ts`, 44 tests).
