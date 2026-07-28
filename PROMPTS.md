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
