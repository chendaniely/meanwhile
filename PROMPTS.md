# PROMPTS.md

Append-only log of the owner's prompts (verbatim, typos and all) and the
decisions they made. Someone should be able to re-create this project from
this file.

*Verbatim except for one thing: names that identify other people are
redacted, and marked where they were. This repo is public; their photos and
their names are not the project's to publish.*

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

**Implemented:** M0 (scaffold, brand tokens, core-purity test, Makefile),
M1 (`schema.ts`, `time.ts`), M2 (`exif.ts`, `isobmff.ts`, `metadata.ts`,
`make inspect`), M3 (folder ingest, `assemble.ts`, `palette.ts`, the ingest
report, manifest export).

---

**Verification against real files.** The owner supplied the actual race
folder — 231 files, 2.0GB, from a Samsung, a Pixel, and a DJI action cam.

> ok i have the ~/Desktop/manifest.json file and the folder i picked is the
> "~/Desktop/<the race folder>" directory

This found a **serious bug that synthetic fixtures could never have caught**,
which is exactly what the "Both" answer on fixtures was for.

meanwhile ranked GPS time as the most trustworthy source, on the reasoning
that it comes from satellites and so is immune to a wrong camera clock. That
reasoning is correct and the conclusion was still wrong: **GPS timestamps the
FIX, not the shutter.** Across the 134 real photos carrying both, the shutter
ran a median 11s later, p90 76s, worst 919s. Worse, the lag is non-uniform,
so photos seconds apart collapsed onto one instant — 27 colliding instants,
with up to seven distinct photos sharing a single second. That destroys
relative ordering, which is the entire point of the app.

Decisive detail: every one of those 134 photos *also* had a zoned shutter
time, and no photo had GPS only. Preferring GPS made 134 photos worse and
helped none.

**DECISION — the shutter outranks GPS.** GPS keeps two jobs: a fallback when
there is no EXIF date, and the clock-offset estimator for M10 — where the
right statistic is `min(shutter − gps)`, not the mean, because fix staleness
is one-sided.

Two smaller fixes fell out of the same run: Pixel filenames are UTC and carry
milliseconds (a trailing-digit guard was rejecting all of them, pushing 15
videos onto the unreliable `mvhd` fallback), and Android writes `mvhd` at the
*end* of recording on both Samsung and Pixel.

Result: `gps` 134 → 0, `mvhd` 15 → 0, collisions 27 → 2 — and the two
survivors are a duplicated file and a real 461ms burst that EXIF can only
record to the second.

---

> for the final UI. i think i also want a 2-sided slider that let's me crop
> the time window. i have uploaded a lot of photos way before the event when
> we were planning, and also a few photos after the race when we were all
> together. when i point it to a folder, i may not want to see all the photos
> listed in the timeline, and give me the ability to zoom into a certain part
> of the race (if there are a lot of concurrent photos) and also maybe i only
> want to look at photos during the race (so nothing outside of a time window
> i care about -- in this case the window is determined by the gpx file +/- 10
> minutes)

**DECISION — a two-handle time window, with a density histogram behind it.**
The real folder proves the need: it spans from 10 June to 26 July while the
race itself is about two days. Stored as `event.range` in the manifest,
because cropping is authoring intent and must survive export. Defaults to the
GPX span ±10 minutes when a course exists, otherwise to the densest cluster —
which on the real folder finds the race by itself, cutting 230 items across
46.6 days down to 142 across 47 hours.

> okay that sounds good. let's go for it. 8 can always adjust later

**Built, and the first attempt was wrong in an instructive way.** Drawn
linearly across the whole folder, the single 42-day gap ate 90% of the track:
the handles crowded into the last few pixels and one pixel was about seven
hours, so the owner's second use case — zooming *within* the race — was
impossible. Fixed by giving the slider an **extent** that is normally just the
part being looked at, plus **cluster chips** that jump between the stretches
the data actually forms.

> i think the only smaller change we can make is when we are selecting the
> dates above the slider, we can use those as a multi select so we can
> potentially pick multiple days to span over, but that's all

**DECISION — chips are toggles.** The range becomes the union span of what is
chosen. Since a range is contiguous, picking two non-adjacent stretches
sweeps up whatever sits between them; rather than hide that, a swept-up
cluster gets a dashed "included" chip. A control must not lie about what is
on screen.

The core-purity test also earned its keep here: it refused the field name
`window` for shadowing a host global, and the first wiring did indeed contain
`{placement && bounds && window && ...}` — testing the browser's
always-truthy `window` object rather than the value. Renamed to `range`.

---

> i like the swim lanes. i feel like as we hover over all the images around
> that time should pop up or something. just looking at when tehre are photos
> and events are not useful

**DECISION — the photographs go under the lanes.** A correct critique: marks
on a track tell you *when* without telling you *what*, and "what" is most of
the value. `MomentStrip` shows the media for whatever the cursor is on, one
row per lane and aligned with the lane above, so "Sam was on the climb while
Dan was at the aid station" is seen rather than inferred. Empty rows say
"nothing" rather than being dropped, because the absence is the story.

This also folded the moment grid (M8) into the swimlanes rather than leaving
it a separate view — better than the original design, which would have made
you switch views to answer "what was happening here".

---

> should note on the front page that if everything is 1 folder, it will break
> down by device. should also note not to use whatsapp images or anything that
> removes the EXIF data from photos (provide more examples if needed)

Added to the README and to the in-app empty state. The list of offenders was
widened beyond WhatsApp: iMessage, Messenger, Instagram, Slack, Discord, and
"right-click → save" out of the Google Photos web viewer, which silently
returns a re-encoded copy with the metadata stripped.

---

> we should write a test to make sure those images looking broken doesn't
> happen

`tests/media-store-lifecycle.test.tsx` mounts the store under StrictMode,
which is the only way to catch the class of bug that caused it (an effect
disposing what a double-invoked memo had just created). Verified to fail —
4 of 5 tests — with the bug reinstated.

---

> before we push to github let's make sure there's no private information in
> the project and git commit history. before we do gpx, are we able to pass in
> a strava url for you to read the pace, heartrate, cadence, elevation
> information? i can export you the gpx from strava, but i'm not sure i'll have
> their running stats in it.

Audit done: no media, manifest or track file was ever committed; no keys, no
activity IDs. The friend's name was redacted from all thirteen commits with
`git filter-repo`.

On the Strava URL: **no.** The API is contractually barred from this use case
(displaying an athlete's data to anyone but that athlete), and an activity URL
is not embeddable without a share token that cannot be derived from it. The
owner's instinct about the stats was right, and documented: a GPX carries GPS,
elevation and time; **a TCX carries heart rate and cadence.**

---

> we can implment the GPX, but i'd like to make sure we are able to also
> display all the other running stats. i almost do want to re-create bits of
> the strava/garmin interface where we can zoom in to parts of the map and able
> to link the overover as a reference on where the person is during the race

**DECISION — M10, the course spine.** `src/core/course.ts` parses both GPX and
TCX with a hand-rolled XML scan (`DOMParser` is a browser global and core must
run under Node too), and derives what neither format stores: pace and grade.

Stats are stacked one-measure-per-chart sharing an x-axis, **not** overlaid on
twin y-axes. Two arbitrary scales on one plot make their crossings look like
findings; they are an artefact of the scaling.

---

> i like maplibre/leaflet, that can work for most things, but for a mountain
> trail race, if there are tiles in openstreetmap that can overlay to make the
> terrain nicer, please add those in; i'm less worried about large external
> dependencies (we need the maps), as long as we can render the site using
> github pages we're good

**DECISION — this reverses "no map library or tile provider" in CLAUDE.md.**
Leaflet over MapLibre: MapLibre draws vector tiles and every hosted vector
source worth using needs a key, so the map would fail closed without one.
Leaflet draws raster tiles, and keyless raster terrain exists — so the map
works the instant the page opens. It is also ~42KB gzipped against ~200KB.

Default basemap is OpenTopoMap (contours and hillshading already baked in),
with Esri satellite, plain OSM, and a hillshade overlay. All four verified by
hand to return tiles with no key.

---

> i'm okay with providing an API key if its free. i can set that up as a local
> enviornment variable and as a github actions secret

Wired up as `VITE_THUNDERFOREST_KEY`, which adds Thunderforest Outdoors to the
basemap list when set and changes nothing when it isn't. **With the caveat
stated plainly:** this is a static site, so Vite inlines the key into the
published JavaScript at build time. An Actions secret keeps it out of the
repository, not out of the page. That is normal for client-side maps, and the
protection that actually works is an HTTP-referrer restriction on the key.

---

> i do have a gpx file, just without all the running stats parts

**The single most useful sentence of the session, and an understatement.** The
real file has 120,909 points of latitude, longitude and elevation and **zero
`<time>` elements** — a Strava *route* export, not an activity export. It is a
course, not a run.

**DECISION — untimed tracks are a supported mode, not a broken file.**
`Course.timed` says which kind you have. Untimed keeps the map, the elevation
profile, distance and climb, and switches the charts' x-axis from time to
distance; it loses the moving marker, pace, and automatic clock alignment.

**meanwhile does not interpolate the missing times.** Spreading the known start
and finish evenly over the course would put the marker confidently in the wrong
place for most of a hundred-miler, whose pace varies several-fold. A missing
feature is honest; a fabricated one corrupts exactly what the app exists to
show.

Three real bugs fell out of using the actual file, none of which synthetic
fixtures would have found:

- `Math.min(...samples.map(...))` throws `RangeError` at 120k points — every
  argument becomes a stack slot. Replaced with single-pass accumulation.
- A 120k-point polyline is more path data than the browser will move. Added
  Ramer–Douglas–Peucker simplification: 120,909 → 2,016 points in 25ms, with
  the switchbacks intact (uniform decimation would have rounded them off).
- The view tabs were gated on a time range that only photos produce, so a GPX
  with no photos yet — exactly this situation — could not be viewed at all.

---

> the line is not alined to where the mouse is on the elevation profile. and
> i'd like the point on the map to move along as i move along the elevation
> plot. likewise, i'd like the elevation line to move as i hover over parts of
> the course on the map

Two things, both right.

The misalignment was real: the crosshair was positioned as a percentage of the
**whole** row and then nudged right by a hard-coded label width, so it only
met the pointer at one point on the axis. The row is now a real CSS grid and
the crosshair sits in an overlay covering exactly the plot column, both driven
by one `--chart-label` variable. Measured after the fix: pointer at clientX
790, crosshair at 790.

**DECISION — the two views link through DISTANCE, not time.** Distance is the
only quantity an untimed course has, so metres is what crosses the component
boundary; a timed course converts at the edges. The map's course also got an
invisible 18px-wide hit line under the visible 3px one, because pixel-hunting a
thin line across a switchbacking mountain course is miserable.

---

> okay let's just continue with the milestone apps

**M9 completed.** The kernel already preserved captions, renames and manual
placements across a re-ingest; three user-facing pieces were missing. People
are now renamable in place — the report had been *instructing* the author to
rename devices while offering no control, which is worse than saying nothing.
The runner badge became a toggle, since `role` carries behaviour. Captions
are written in the lightbox.

The real gap was the round trip: export wrote a manifest nothing could read
back, so closing the tab lost the work. Dropping the exported `manifest.json`
into the folder now restores names, roles, captions, the crop and hand-placed
times — while automatic timestamps are always re-read, because those are facts
about the bytes and a stale copy would be worse than none.

---

> i'd like to be able to provide a comment at any arbitrary time. in this case,
> when the runner is running or when the crew is setting things up, we can
> still provide comments about something that has happened if it is not
> directly associated with a photo. either because we forgot to take a photo or
> it was something that we remembered happening during some point of time.

**DECISION — notes become first-class, independent of any file.** Until now
every annotation hung off an item, so anything nobody photographed could not
be recorded at all, and an ultra is mostly those things.

`Manifest.notes` holds `{ id, at, until?, text, person? }`. Three choices
carry weight: a note's time is **authored, so `clockOffset` never applies** to
it (same rule as a hand-placed photo — an author is not a device); `person` is
optional and puts the note in that lane, which is what lets one **explain a
gap**, since six empty hours is the story of the night section; and `until`
makes it a span, because crewing is mostly spans — waiting, driving, sleeping.

**The cursor is the default time.** Scrub to 3am, and the compose box is
already at 3am. Typing a timestamp is the fallback, not the path.

Notes interleave with the photographs in the feed rather than living in their
own list, because the feed's whole job is reading the event in the order it
happened.


---

> how easy is it to put in a arbitrary note in the timeline view instead of the
> swim Lane view?

It already worked — the composer was in every view and its time field is
editable — but the feed never set a cursor, so the field started blank. Fixed
by making the feed's scroll-spy move the shared cursor, which also closed a
real hole: the feed was the one view not taking part in "one cursor, four
projections", so you could scrub in the lanes and flip to the feed but not the
reverse. The spy had also been attached only when a GPX was loaded.

---

> i thienk there's a few UI things we need to fix up. after i upload 200+
> images all the things on the bottom of the site are really hard to notice.
> let's think about the UI and UX a bit mroe and see what needs to move around.
> i also feel like a few items like saving and loading a manifest file should be
> in a top menu bar or something. and adding a note should be more towards the
> top in the swim lane view, and should float in the feed view

**DECISION — nothing persistent may sit after the content.** The problem is
structural: the feed is unbounded, and the export button, people list,
unplaced tray and note composer were all rendered after it.

Placement now follows how often a thing is used. Constant → sticky top bar
(event name, Open folder, Add files, Save manifest). Used while reading → next
to the view it serves: the composer is inline under the lanes and **floats
over the feed**. Reference → a collapsed panel above the views with a one-line
digest, holding settings, the ingest report, the unplaced tray and the notes
list.

`Notes.tsx` was split into a composer and a list, because writing is constant
and reading back is reference — one component forced both into the same place.


---

> i like how you ahve the photos geo tagged on the map. let's make it so we can
> see them on hover/click. since we have photos as relative time references, we
> should be able to extrapolate locations on the course between photos to put in
> a note (this makes it easy to put in a note somewhere, we can always adjust
> specific times later) but sometimes as the runner, you rememer moments from
> the elevation / course. especially if there are no photos in that area from
> yourself/crew/pacer.

Two things. Map dots now show the photograph itself on hover, built as DOM
rather than an HTML string because the caption comes from a folder name and a
filename is not a place to trust. Thumbnails are taken from the same refcounted
store as everywhere else and handed back when the layer is rebuilt.

**DECISION — `estimateInstant()`, the one sanctioned interpolation.** Pointing
at a place on the course gives a time, interpolated between the photographs on
either side, so a climb nobody photographed can still be annotated. The earlier
refusal to interpolate stands and is a different case: that was start-to-finish
across a whole hundred-miler, this is between two pictures usually minutes
apart. It never extrapolates past the outermost photograph, reports the gap
between its anchors as an error bar, and handles an out-and-back where the same
distance happens twice by walking anchors in time order and letting the cursor
choose.

On the real folder the photographs cluster at 0, 31, 72, 107, 132 and 168 km —
the crew-accessible aid stations — so the gaps between them are exactly where
this earns its place.


---

> it's really hard to create a note when using the map. when i mouse over the
> actaul map i see the elevation and note here. but as soon as i move away to
> try to click the note disappears. [...] maybe just have a note somewhere that
> says "click to add note" and it'll pre-populate the note on the bottom right
> [...] this will limit the entry points and splits in the website.

A correct diagnosis of a classic trap: the button only existed while hovering,
and moving the pointer towards it left the element, cleared the focus and
removed the button. Anything you have to chase is broken.

**DECISION — clicking the course IS the gesture**, on the map and on the
elevation profile alike, with a permanent line of text saying so rather than
a control that appears and vanishes. It resolves to a time from the track when
the track is timed and from the surrounding photographs when it is not, then
moves the shared cursor and opens the one composer in the corner. One entry
point, as asked.


---

> on the course page, when i click the note popup is BELOW the map and plots.
> it should be above. also the ux in swimlanes is really janky. [...] the page
> is jumping all over the place because the rows where the images are are
> expanding in height [...] we need a way to better work with the overover on
> the swimlane. it's a bit to sensitive [...] find a balance between clicking to
> lock the location but also ease of scrolling through the timeline

Three fixes. The dock was `z-index: 50` and Leaflet's panes and controls run to
1000, so the composer opened under the map; it is 1200 now.

The bouncing was the moment strip's tiles wrapping — eight photographs made a
row four lines tall, none made it one — so scrubbing resized the page and
everything below it moved, including the photographs being reached for. Rows
are a fixed height that scrolls sideways: measured at 150px strip and 1279px
page across a full sweep.

**DECISION — hover previews, click pins.** Hover alone cannot work when the
photographs sit below the track, because reaching for one means crossing the
track. Clicking pins the moment so the strip holds still; the state is named
on screen, since a strip that has quietly stopped following the pointer just
looks broken.


---

> i like the button that sigals if it's pinned or not. let's build on that ui a
> bit more. the click on the swim lane is a toggle. so if i were to click again,
> the button will also turn 'off' and it's in follow mode again. this way
> there's 2 ways of getting the same behaviour

Done. The chip became a real two-state control — `following` / `pinned`, with
`aria-pressed` — and the lanes toggle the same state rather than latching it.
Lit only when pinned: the normal case needs no attention, and the pinned one
has to explain why the strip stopped moving.

---

> i'd also like the scroll wheel to zoom in/out of the swim lane, which then
> also modifies the filter range on the top

Anchored on the pointer, like the map, so you zoom into what you are looking at
rather than the middle. It writes the shared range, so the slider at the top
follows for free — there is one crop, not one per view. The listener is bound
with `passive: false` directly on the element, because React registers
`onWheel` passively at the root and `preventDefault` is ignored there.


---

> let's finish up this milestone we can come back to this later

**M11.** The Strava fallback renders at last: a link or an embed now earns the
Course tab and says plainly what a URL cannot carry — no position-at-time, no
elevation, no clock alignment. **The embed is click-to-load**, because it is
the only external request meanwhile ever makes: whoever pasted the URL
consented to it, but whoever they later send the manifest to did not, and
loading it unasked would hand their IP address to Strava before they had
decided to look.

`.github/workflows/pages.yml` builds and deploys on push to `main`, gated on
the tests and the type-check. README gained a publishing section, including
the caveat that a build-time map key is inlined into the published JavaScript
and must be restricted by HTTP referrer rather than kept secret.

Asked the two open questions. **Public repo with a private manifest** — a
pre-publication audit confirmed no media, manifest or track is tracked or in
history, and no personal strings survive anywhere in the repository.

> "let's hold off on the license now. i want to protect it from commercial use"

Deferred, and recorded with the part that is easy to get wrong: a public repo
with **no** LICENSE is already all rights reserved, so commercial use is barred
today — but so is a friend legitimately running their own copy. And a
non-commercial restriction is not open source under either the OSI or FSF
definitions, which matters before anyone is invited to contribute. Options
written up in `TODO.md`.


---

> i uploaded a gpx but it looks liek it got cut off or isn't rendering half the
> 100mile race, is there a limit to the file import?

No limit — the real activity export parses completely: 121,077 points, 104.8
miles, 20,419 ft, 33h38m, heart rate and cadence, in 546ms. The charts were
cropping the track to the visible TIME WINDOW, which is derived from where the
photographs cluster, so a race whose crew shot at six aid stations showed only
the slice around them.

**DECISION — the course view always plots the whole course**, with the window
drawn as a shaded band rather than enforced. The window filters media; the
course is the thing the media happened along. The bug only appeared with a
timed track, because an untimed one plots against distance and was never
filtered.

---

> for the note in the bottom right corner that's floating. i think the swim lane
> page shoudl have that too. it should just be a persistant part across all
> pages/tabs so the UI is consitant

Right — it had drifted into three placements and two shapes for one action.
The dock is now in every view, same corner, and the inline composer under the
lanes is gone.


---

> loop through the site to make sure everythign is consistant and no conflicts.
> [...] "save manifest" but the expanded event settings has "export
> manifest.json" i perfer the simplier term, but it needs to be consistent.
> [...] let's keep doing passes until you find no more irregularities

Six passes, auditing rather than eyeballing — strip comments, extract every
JSX text node and label/title/placeholder/aria-label, and read the list.

Found and fixed: the duplicate export control under two names (the report now
has no buttons; the top bar owns opening, adding and saving); "Open a folder"
vs "Open folder" and "Pick files instead" vs "Add files", resolved by making
the VERB carry the meaning — "Open" always replaces, "Add" always merges;
three phrasings of "click the course to add a note"; "range" leaking into
labels for what the docs call the time window; **the note dock floating over
the lightbox**, because it had been raised to clear Leaflet and passed the
modal; "Clear" in the swimlanes not releasing the pin, leaving a cleared
cursor that was still pinned; and fifteen orphaned CSS selectors left by
earlier refactors.

Stacking is now a named scale rather than numbers that happened to work.

---

> in larger events or events where people have the same device, is there a way
> to see from a photo if it's different people using the same make+model of
> phone?

**Parked, not solved.** Nothing today reliably tells two identical phones
apart — phones do not write `BodySerialNumber`, iPhone filename counters
separate units well but Android's timestamp filenames do not, `Software`
build strings occasionally help, and sensor-fingerprinting (PRNU) is real but
out of scope. Recorded in `TODO.md` with what was actually researched. The
actionable part is not detection but honesty: warn when two people might
share a lane instead of silently merging them, then bulk reassign.

---

> i think it'll be better if notes were in a separate file. it'll be much
> easier to either edit in the site, or offline in a spreadsheet program [...]
> at this point i forgot what the manifest file is for, but i think most people
> will care the most about the notes

Forgetting what the manifest is for was the diagnosis, not a lapse.

**DECISION — split the manifest by where its data comes from.** `items[]` is
derived — thrown away and rebuilt from the files on every open, about 95% of
the file by volume. Names, roles, clock offsets and notes are authored and
irreplaceable if lost. The authored slice moves out into `notes*.csv` and
`people.csv`; the manifest becomes a cache of what was read, with nothing left
in it a person actually typed. A caption collapses into a note whose `photo`
column names the item — one file, one editor, one merge, one thing to
explain.

Identity is an opaque, blank-allowed `id` rather than the datetime the owner
first proposed — a spreadsheet reformats a date on save, two people can write
at the same second, and retiming a note would read as a delete plus an insert.
That is what makes merging need no version control at all: row-bind, dedupe by
`id`, sort by time.

> "i think it'll be okay if we end up making it look like 2 comments at the
> same time. that's okay. when we visualize it it'll show up one after the
> other."

Two people editing copies of the same note at once is accepted, not an error —
the merged, time-sorted list already shows it correctly.

> "we can store a separate repo with the metadata and this app has an option
> to point to a repo of metadata to populate"

A natural follow-on, parked for its own spec: it depends on these file formats
existing first. The constraint that will shape it — a static site can *read*
from a repo but cannot write back to it, so saving still means downloading and
committing yourself.

---

> we should make sure that in the UI the note button is also matching this set
> of specs, so when it is used to create a note it is writing the corret
> information to the correct file.

Right — the note dock is the only way most people will ever create a note, so
the field-to-column mapping is part of the format, not an implementation
detail left to chance. `Whose` becomes a searchable multi-select, since
`people` is plural now — the same control the timezone picker already uses,
on the same grounds. And a caption written from the lightbox writes a row with
`photo` set, instead of `items[].note`.

> i guess you can have multiple authors as well. i can imagine multiple people
> writing down an experience all at the same time.

**DECISION — `author` becomes multi-valued too, the same shape as `people`.**
Two columns, one control, one parsing rule, one sentence to explain, rather
than one singular and one plural. This is also where "who is writing" gets
settled: a "you are…" picker, defaulting to unset, that never blocks a note
from being written — kept in the browser's local storage rather than the
manifest, because it describes who is at this laptop, not the event, and
would be wrong the moment the folder is handed to someone else.

---

> most likely it'll be the same date, but different times and the user might
> just click drag/copy paste the date. while they are filling out times.

Split date from time so the ergonomics work: drag `year`, `month` and `day`
down a column of rows, then type each row's own hour and minute.

> i want to make sure the underlying data is safe from corruption

**DECISION — go further than a date/time split: five plain integers.**
Splitting only made a spreadsheet's corruption *recoverable* — the column
name says what a bare number means. Nothing about `25` or `45` looks like a
date to Excel, so a note's timestamp (`year,month,day,hour,minute`) is never
rewritten in the first place, and nothing has to be repaired. A span is an
ISO-8601 duration (`PT3H40M`) rather than an end timestamp, because a
33-hour race crossing midnight and 31 July crossing a month would otherwise
need their own year/month/day — a duration has no boundary cases at all, and
it is the same convention `clockOffset` already uses. The composer still
shows one time box; the split is a property of the file, not the UI.

---

> i feel like we'd need a wizard screen at the start to handle how everythign
> gets read into the site. separate files, zip files, location to local media
> folders, and having metadata files in a git repo (potentially a Github PAT
> that has only 1 repo write access so saves can happen directly into the
> repo)

Right, and the need is created by this very change: once metadata lives in
several files that can arrive several ways, "point at a folder" stops being
the whole story. Recorded in `TODO.md` with the five routes to support and
the GitHub PAT trade-offs — a fine-grained, single-repo token is the right
shape and needs no backend, but it is a bearer token sitting in browser
storage; the device flow is the safer long-term answer, and saving must work
with no token at all either way.


---

> when you are done with all these tasks. review your work. then do a series of
> loops and passes to make sure all bugs and issues have been fixed. we want to
> remove all tech debt before continuing to add new features

Ten tasks were each implemented and reviewed in isolation, then reviewed again
as a whole branch. **The whole-branch review is where the real bugs were**, and
the reason is structural: every one of them lived at a seam between two pieces
that were individually correct. The worst — "Add files" destroying every note
written in the session — was a regression against behaviour the old code had
and had commented on, created by a later task removing the mechanism's only
caller.

A pattern worth recording: three separate bugs traced to one root cause, that a
hand-typed row with a blank `id` gets a fresh random id on every read. After the
second patch it was clear the shape was wrong, and the fix became a
session-scoped row-to-id map so the id is stable — at which point every
existing id-based mechanism worked unchanged. Patching the third symptom would
have been the cheaper-looking move and the wrong one.

Two things caught by testing the built app rather than by the suite: notes could
be invisible on load, because the default time window was computed from photo
clusters and ignored notes; and a comment left behind by a fix claimed two
guards were dead code when a counterexample showed they were load-bearing. In a
project whose rule is that wrong documentation is worse than none, a comment
inviting a future session to delete a working guard is the more dangerous of
the two.


---

> I want you to take another thorough pass-through all of the comments and the
> documentation. you now assume the comments and the functions that it is
> commenting sync up. I want you to review the comments and confirm that the
> code does what the comment is saying. same with the larger pieces of
> documentation. I want you to keep looping through this process until you find
> no more discrepancies in the documentation and comments

Six passes, ~145 discrepancies, 19 commits. The instruction to *loop* rather
than audit once is what made it work, for a reason worth recording: **every
pass found errors introduced by the previous pass's fixes.** Never many, never
zero. A false "the header is 71px" claim where none had existed; a lying test
name created by the very pass that removed lying test names; and one case where
this file's author asserted in a commit message that a claim was "genuinely
correct" after checking the phrase's context instead of the thing it described.

**The dominant defect was a claim fixed in one place while copies survived
elsewhere**, and it recurred in all six passes. "GPS time is authoritative" —
the single claim this project has spent the most effort disproving — was found
and fixed five separate times, the last on the `gpsInstant` field itself, which
is precisely where a future session would read before touching the ranking.
"Automatic clock alignment" was corrected in two files, then found in three
more, then two more after that. The lesson is mechanical: after correcting a
claim, grep the whole repo for its meaning, not its wording, and check every
hit. That instinct was right in general and wrong once in particular: "a few
kilobytes" had seven hits, not five, and two of them — `zip.ts` and CLAUDE.md's
dependency budget — were waved through as describing a different subject (the
CSV payload, not the metadata read) on the strength of the surrounding
sentence rather than the quantity itself. Both were also wrong: the zip's
third file, `manifest.json`, is pretty-printed and scales with item count
(~350 bytes/item), dominating the CSV at roughly 80KB for 231 items and 680KB
for 2,000 — nowhere near "a few kilobytes." A later pass (`faa5e3f`) caught
both.

**An audit of comments turns up real bugs, because a comment is a claim about
behaviour.** Five CSS custom properties were used at fourteen sites and defined
nowhere, silently collapsing `border-radius` to 0. `notes.csv` and `people.csv`
— the files this branch introduced to hold people's names and prose — were not
git-ignored, under a `.gitignore` whose first line promises event data is never
committed. Escape closed the lightbox *and* silently unpinned the moment strip,
undoing the pin the user had set so the strip would hold still. The feed
discarded a note whenever no photograph shared its window, which is the "write
something and watch it vanish" failure this project singles out as the one
worth spending UI on. None of these would have been found by reading the code
for correctness; they were found by asking whether a sentence was true.

**The most useful technique was breaking the code to prove a test bites.**
Several tests named an invariant they never asserted — deleting the production
guard left them green. The fix is not to rename the test but to add the
assertion and then verify by removing the guard and watching it fail.

The loop was stopped deliberately rather than at zero. By pass six the claim
families were converging — fifteen of seventeen fully propagated, none
reopened — but each pass had also been auditing roughly the surface the
previous pass named, so a pass that found nothing would have meant the search
had stopped, not that the repository was clean.


---

> what i did notice is when i create a note i do not see it in the swimlane

True: `Swimlanes.tsx` had no reference to notes at all. CLAUDE.md's "Notes are
first-class" section had said, since M9, that a note with a `person` sits in
that person's lane so it can explain a gap — and the six-pass documentation
audit just above this entry checked the file's claims against the code and
still missed it, because the claim had no code near it to contradict: it lived
in `Swimlanes.tsx`'s absence, not in a comment sitting next to a wrong
implementation. The audit's method — read a claim, find the code, check they
agree — has no answer for a claim whose code was never written.

Built: a note whose `people` list is non-empty draws in each of those people's
lanes, at its time, in that person's own lane colour; a note with nobody named
(or nobody the roster recognises) gets its own event-level row pinned above
every person lane, coloured with the palette's existing neutral rather than an
invented ninth hue; a note with a `duration` draws as a span, not a point; the
row disappears entirely when a folder has no notes; and a caption is excluded
the same way `Feed`'s caller already excludes it, so it does not appear twice.
Clicking a mark moves the shared cursor to the note's own time, not the pixel
clicked. See `tests/swimlanes-notes.test.tsx` and CLAUDE.md's "Notes in the
swimlanes" entry.


---

> push everything! make it live. let's make sure going forward we are doing
> semantic releases, updating the changelog. and we do a series of bug and
> documentation loop passes where we use subagents to do independent reviews
> of the code, comments, and documentaiton. never assume the comments and docs
> are correct, confirm it. we will run multiple sub agents each doing multiple
> loop passes until everythign is resolved. document things as needed in TODO
> and other prompts/claude files to save context and memory

Pushed. The remote had held a single commit since the start; local history had
been rewritten by `git filter-repo` and so shared no hashes with it, which
made a force push necessary. Worth recording why that was safe rather than
merely convenient: the remote commit's file tree was **byte-identical** to the
local root, with the same author, committer, message and both dates. The only
difference was a GPG signature, which `filter-repo` strips. Nothing private
was ever on the remote — the redaction had touched later commits that were
never pushed. Checking that before forcing was the whole job; "force push"
and "safe" are not usually the same sentence.

CI is green on GitHub's runners — install, typecheck, 504 tests, the
test-count guard, build. The deploy step fails on one thing only, and says so:
Pages has to be enabled in repository settings, which is the owner's click.

Analytics went in **build-only**, following the owner's own phrasing ("when we
push and deploy"). `make dev` loads no tag at all. That is a privacy decision
rather than a performance one: local mode reads a folder of somebody's private
photographs off their own disk, and the README's promise that nothing leaves
the machine has to keep meaning something for exactly that person. The claims
that were made false by adding it — "zero external requests" in CLAUDE.md and
`fonts.css`, "nothing leaves your computer" in the README — were corrected in
the same commit. Adding a tracker and leaving a privacy promise standing would
have been the precise failure the eight-pass audit existed to remove.

The loop-review and semantic-release expectations are now standing process in
CLAUDE.md's "How work gets executed" rather than a thing to re-derive.


---

> i need a way (possibly in the site interface itself) to connect the notes
> and people datasets, where the author in notes is the new display alias
> for the name in people. [...] i am essentially asking for a non
> destructive way to rename people ids that are displayed. assume in the
> future i might have multiple of the same device so we need to maeksure the
> id in people are unique so the rename can happen with a join or something

> shoudl note that the "name" shoudl be the default display name, the
> fallback is the "also_known-as" value to display on the site

> we can pin this later on, but just make sure thigns are flexiable enough to
> handle multiple peopel with same devices

`Person.id` was already stable across a rename — `renamePerson` in `App.tsx`
only ever wrote `name`. The actual break was one layer over: `notes*.csv`
stores `people`/`author` as names, not ids, on purpose (an id column would
defeat the entire "hand-editable spreadsheet" reason notes are CSV), so
renaming a device slug to a person's real name silently orphaned every note
already written under the old name — the note survived, its link to that
person did not.

`people.csv` gained a fifth column, `also_known_as`, same `;`-separated
convention `people`/`author` already use. `applyRename` (new,
`core/people-csv.ts`, pure and unit-tested with plain `Person[]`/`Note[]`)
sets the new name, pushes the old one onto `also_known_as`, and rewrites
that old name to the new one in every already-loaded note — the alias
covers a file the app has not read yet, the rewrite covers what is already
in memory, and neither substitutes for the other. `resolvePersonNames`
matches a note's names against a person's current name OR any alias now,
which is the read side of the same join. Display got one fallback chain in
one function, `displayName` — `name` → first alias → the existing
device-slug prettifier — used everywhere a person's name renders instead of
`person.name` scattered across nine call sites.

For the collision question: on a rename that would collide with a different
person's existing name or alias, the alias and the note rewrite are both
skipped (the rename to the new name still happens) — recording the alias
anyway would make the OTHER person ambiguous too, and rewriting notes under
a name two people share cannot tell which one was meant. `resolvePersonNames`
itself also never guesses: a name/alias claimed by two different people
(possible via a hand-edited `people.csv`, outside the site's own guard)
resolves to neither id, mirroring the existing rule for an ambiguous
photo-caption filename match. For future same-device duplicates: checked,
not built — `PersonId` is already an opaque string key everywhere
downstream (map keys, lexical sort, never parsed), so a numeric suffix like
`google-pixel-8-pro-2` can be minted for a future second device without
touching the spelling of any id already in use. `deviceIdOf` itself still
collides two identical phones into one id today, unchanged, per the owner's
own "we can pin this later."

16 new tests in `tests/people-csv.test.ts` (10 → 26), each confirmed to fail
against a deliberately broken production line before being restored. 520
tests pass.

---

## Session: the CSV format, hardened before it carries anything irreversible (2026-07-30)

Context: the owner created a private repo to hold one race's written record
permanently under version control, and four reviewers examined `notes*.csv`
and `people.csv` first — because once real notes are committed, every choice
becomes a migration carried forever.

> "yes we should write the tz, sometimes we can infer it from the gps of the
> photo, but we should be able to either infer the tz and allow user to
> modify if needed. we should use a standard tz format and provide links for
> users to easily search/find the tz to use. i'm okay with using UTC offsets"

> "you're right, the merge model will make it hard, so let's just go with the
> data version column value"

### What was decided

**The timezone: infer it, show it, let it be changed — and write BOTH forms.**
The inference reads the media's own `OffsetTimeOriginal`, which the app
already parses, rather than a GPS→timezone lookup — that needs a boundary
database this project's dependency budget will not carry, and EXIF is both
free and more accurate about what the camera meant. The modal offset wins, so
a stray photo from the drive home cannot move the event. The browser's zone is
kept when it already agrees (a real IANA zone knows its own DST rules); an
`Etc/GMT±N` is used when it does not, because that says exactly what is known
— an offset — and nothing that is not. Inference runs only when a folder is
OPENED, never on "Add files", so it cannot silently revert a zone the author
typed. `TimezoneField` carries a link to the IANA table beside it.

The owner's "i'm okay with using UTC offsets" is taken as *both*, not
*instead*: `tz` is an IANA name and `utc_offset_min` is plain integer minutes.
Neither is sufficient alone. A zone name cannot express the repeated hour at a
fall-back transition — 01:30 MDT and 01:30 MST are the same five integers, an
hour apart. An offset alone loses which zone the writer meant. `tz` is now
written on EVERY row, reversing the original design's "blank means the event's
zone": that looked free, but changing `event.timezone` afterwards moved every
note silently while the zoned-EXIF photographs stayed put, with nothing on the
row to reconstruct what was meant. Unfixable retroactively — the reason this
shipped before real notes existed rather than after.

**The version marker: per ROW, not per file.** The second quote settles it.
These files merge by row-bind, so a row from someone's older copy lands among
newer rows and must carry its own version; a file-level marker would claim one
version for rows that came from several files. `tz` already set that
precedent. The CHECK shipped with the column, not after it: a marker older
builds ignore buys nothing retroactively, and refusing a row from a newer
build is the part that expires.

### What the reviews found, and what was done

- `people.csv` lost any column it did not understand — verified against a
  roster carrying `pronouns`. Fixed FIRST, because a build without it deletes
  the `schema` column itself on the next save.
- Impossible dates were silently accepted and then rewrote themselves on the
  next save: `year=26`→1926, `month=13`→next January, `day=32`→next month,
  `day=30` in February→2 March, `hour=24`→tomorrow, `minute=60`→+1h, plus
  non-integers. Now refused per row with a legible problem. A note placed
  confidently in the wrong place is worse than a visible gap.
- Deleting a note only removed it locally, so any other copy resurrected it on
  merge. A `deleted` tombstone now stays in the file and wins over a live row.
  Every deletion made before the column existed is unrecorded forever.
- Nothing recorded when a note was TYPED, as opposed to when the thing
  happened. `written`, epoch seconds, machine-written.
- `José` written NFC did not match the same name written NFD, in both
  directions. Normalised on write and on both sides of every name comparison.
- Merging a saved `notes.csv` with a pristine blank-id copy grew 2 → 3 → 4 →
  5 → 6 notes over five rounds. A blank-id row now adopts an id that already
  exists for the same content, order-independently.
- `mintNoteId` ended in a digit 26.9% of the time, and Excel's fill handle
  increments a trailing number when a row is dragged. Forced to a letter.

Migration is pinned to `tests/fixtures/csv-before-2026-07-30.ts`, a frozen
byte-for-byte copy of both files as they were written before any of this —
deliberately not regenerated, because a test that rebuilds its own input
cannot catch a reader and a writer drifting together.

93 new tests (550 → 643). Every change was verified by breaking the production
line and confirming the relevant test failed before restoring it — 21
mutations plus one more, all of which failed as required.

---

## Recovered prompts (2026-07-30, found by a documentation-accuracy audit)

This log is append-only, so these are logged here rather than inserted where
they were actually said. A documentation-accuracy pass found four owner
prompts quoted verbatim in `CHANGELOG.md`, `TODO.md`, a design spec, and a
commit message, with no matching entry anywhere in this file — programmatic
comparison of every other quoted prompt against its source found no other
gaps. The citing text is the source for the exact wording below; nothing here
is reconstructed from memory.

**Cited at `CHANGELOG.md`'s "The site goes live, and is measured"** (pushing
to GitHub with releases, tags and a changelog):

> "i think we should also be pushing these up to github, with releases, tags,
> and changelogs updates. i want to be able to test this on github actions +
> github pages."

**Cited at `TODO.md`'s "Aid stations on the course"** (crew-accessible aid
stations):

> "for ultra races, i'd like the map to also tag where the aid stations are,
> and whether those are AS that are crew accessible. i'm not sure how best to
> get that information into the app, and then save the results (since this is
> a static site)"

**Cited at `docs/superpowers/specs/2026-07-30-github-metadata-sync-design.md`**
(the PAT / password credential store, and per-crew-member tokens):

> "let's built it around a PAT i can save it in my password credential store.
> and gather files from them. if the crew member DOES have a github account, i
> can add them to the repo and they can use their own PAT?"

**Cited at the commit introducing `EVENT.md`** (`7c7da2e`, a per-copy pointer
to where an event's data lives):

> "let's create a separate file that the readme and claude reads that points
> to the git backed repo. this way you have the context of where this current
> project's git repo is, but it's not fully baked into the context if other
> people want to use it"

---

## Session: analytics learns the view, and nothing else (2026-07-30)

Context: Google Analytics on the published site was previously wired with a
plain `gtag('config', ID)`, which by GA4 default sends `location.href` —
fragment included — as the page's address. The app's URL fragment carries a
photo-derived cursor timestamp and the ids of whichever people are toggled
on or off, which must never reach Google.

> "i don't think i need view-usage. maybe the only tab info that is useful is
> which view are people looking at, but i don't need to track time/people
> information at all."

### What was decided

`vite.config.ts`'s `googleAnalytics()` now sets `send_page_view: false` on
the `config` call and sends exactly one `page_view` itself, addressed at
`location.origin + location.pathname` — never the fragment, regardless of
what gtag's own default fragment-handling turns out to be. A new module,
`src/viewer/analytics.ts`, exports `trackView(view)`, which no-ops when
`window.gtag` is absent (the entire `make dev` experience) and otherwise
sends one `view_change` event carrying `{ view }` and nothing else. It is
wired into `App.tsx` as `useEffect(() => trackView(view.view), [view.view])`
— depending on `view.view` alone, not on the shared `AppState` object, is
what stops a cursor scrub or a `who=` toggle from retriggering it.

**Verified, not assumed: `send_page_view: false` does not fully close the
gap.** GA4's "enhanced measurement" independently fires its own automatic
`page_view` on `pushState`/`replaceState`/`hashchange`, reading the live URL
at that moment, regardless of the `config` call's parameters. Since
`useAppState` calls `replaceState` on every cursor change, this remains a
real leak if enhanced measurement is on for this property — closing it is a
one-time toggle in the GA4 console ("Page changes based on browser history
events" → off), not something `vite.config.ts` can reach. Recorded in
CLAUDE.md's "Verified external constraints" table and as an action item in
`TODO.md`, rather than claimed as solved.

6 new tests (643 → 649 before the concurrent CourseMap tooltip fix landed on
top), each verified by breaking the production code and confirming the
corresponding test failed before restoring it.


---

> can you dispatch some secutiry and privacy independent subagents to review?

Four reviews, on four trust boundaries: what leaves the machine, the running
application, credentials and repo history, and files arriving from other
people. Splitting them that way mattered — each found things the others could
not have, and the split was chosen so they would not converge on the same easy
observations.

**The finding that justified the exercise came from asking the right question
rather than from scanning for the usual list.** This app has no server and no
accounts, so the classic web threat model is nearly empty. What it does have
is a collaboration model where people email each other CSV files. Asked "what
does a hostile or careless file do?", the answers were immediate: a person's
name reached Leaflet as HTML and executed; one row could silently delete
somebody else's note and the next save would overwrite the text; a
`manifest.json` in any subfolder replaced the whole event, which is likelier
by accident than by malice.

The XSS is worth recording precisely, because the reasoning to prevent it was
already in the file. Fifteen lines below the vulnerable call, the thumbnail
tooltip is built as DOM nodes under a comment saying Leaflet "would happily
render markup in it — a filename is not a place to trust." Correct, and simply
not applied to the tooltip above it. Knowing a rule is not the same as having
applied it everywhere it holds, which is an argument for review by someone who
did not write the code.

Two things the reviews corrected in work done earlier the same day. The
analytics fix being built at that moment was **insufficient** and would have
shipped believing otherwise: `send_page_view: false` does not suppress GA4's
enhanced measurement, which fires on every history change and re-reads the
full address — and the app rewrites history on every cursor move. And the
GitHub sync design's crew tier **cannot be built as specified**, because
fine-grained tokens cannot be minted by outside collaborators; the fallback
would be a classic token granting access to every private repo they own,
strictly worse than the shared token the design rejected. That was a
confident design decision resting on an unchecked assumption about GitHub,
found before any code existed.

Also on record, verified rather than assumed: nothing sensitive has ever been
in either repository — every object, reachable and unreachable, in both — and
no photograph, its EXIF, its GPS or its bytes can reach the network, because
no network call exists in the kernel at all.


---

> i want you to make sure that docs and comments when reading and reviewing
> them should never be trusted, always confirm the docs and comments. having
> said that. let's do a multi subagent review of the docs, bugs, tests, and
> comments. loop through that process until all issues are resolved. we'll
> treat this as a process that happens before we release anything. once we're
> happy with this we can push the release live

The instruction that turns the review from something done when it occurs to
someone into a **gate**: work, then gate, then release, then push. Written up
in CLAUDE.md rather than left as a habit, because the previous release did it
in the wrong order — 0.3.0 was pushed and then reviewed, which is only
tolerable because nothing found afterwards was serious.

"Never trust a comment" is stronger than scepticism and is meant literally.
The evidence for it is this project's own history: a header comment that
stated the time-source ranking exactly backwards, in the same file whose
decision record warns a future session will be tempted to reverse it; a
comment claiming two guards were dead code when an experiment proved them
load-bearing; and a claim that `manifest.json` could be regenerated from the
photographs, which was false and would have cost the crop, the markers and
every hand-placed photo had anyone acted on it.

The failure mode this guards against is specific to a vibe-coded project. The
owner does not read JavaScript, so a wrong comment is undetectable to them,
and CLAUDE.md is loaded as context by every future session — which makes a
wrong decision-record entry an *instruction* rather than a cosmetic defect.


---

## Recovered prompts — logged late, found by the doc-accuracy pre-release gate

This file is append-only and nothing above this heading has been edited or
reordered. The pre-release documentation-accuracy gate flagged six owner
quotes in CLAUDE.md that a programmatic verbatim check against this file
could not confirm; running that check to completion turned up three more of
the same kind. Six of the nine turned out to be CLAUDE.md paraphrasing, or
silently correcting a typo, or inventing a framing sentence around a real
quote — CLAUDE.md itself was fixed for those, since inventing a matching log
entry here would misrepresent what was actually said. The three below were
genuinely said and genuinely never logged — the gap was in this file, not in
CLAUDE.md — so they are appended here now, verbatim, in the order CLAUDE.md
already cites them.

> sometimes when i'm scrolling with the note screen open the time is jumping
> like crazy sometimes is jumping between hours and minutes

> i feel like you should save this in a global state, it should always be
> subagent driven

> sometimes the phone GPS gets points all wrong and weird. and for videos
> (especially videos taken on an action cam) there may not be GPS coordinates


---

## Recovered prompts — two more, found by widening the quote check to CLAUDE.md's inline-italic convention (2026-07-30)

Append-only, as ever: nothing above this heading has been edited, reordered
or reworded. The recovery section immediately above was produced by a check
that read only CLAUDE.md's `> ` blockquotes. CLAUDE.md has a **second**
convention for owner quotes — the inline italic form `*"…"*` — and that
check never looked at it, so four more unverified quotes survived the pass
that was supposed to catch exactly this. Widening the check
(`scripts/check-owner-quotes.mjs`, run by `make check-quotes` and `make
check`) found them. Two were CLAUDE.md's own doing — a typo silently tidied
up, and one quote spliced together out of two separate prompts — and were
fixed in CLAUDE.md rather than by inventing entries here. The two below are
the opposite case: genuinely said by the owner, genuinely never logged.

**These two are reconstructed, not captured — the one exception in this
file.** Every other prompt here is the owner's text as typed. The wording
below is copied from CLAUDE.md's citation of it, because no log entry was
ever made. Both decisions were made at the owner's instruction and the
substance is not in doubt, but the exact phrasing is not guaranteed to be
verbatim, and no source survives to check it against. Nothing else in this
file carries that caveat; do not let this precedent spread.

**Cited at CLAUDE.md's "The course line is CASED, and the colour is
measured"** — the observation that started it, which led to measuring WCAG
contrast per pixel against real basemap tiles and casing the course line
rather than re-picking its hue:

> "the orange line on the orange topo map is barely visible."

**Cited at CLAUDE.md's "The map wheel zooms, deliberately"** — the reason
for reversing the conventional requirement that the map's wheel zoom be held
behind ctrl/⌘:

> "an app like this is mostly going to be used with only a mouse/trackpad."


---

> let's go push and release everything. in the future. let's also do passes on
> the guards themselves and make sure we do an analysis of the actual guards.
> treat it like you don't really trust the guards at all

The gate had grown two mechanical guards — a test-count check and an
owner-quote checker — and this closes the obvious hole in it: **a guard is a
claim like any other, and a green check is not evidence it works.**

Two failures already argued for it. Pass 1 built a quote checker that found
nine fabricated or altered quotes, and never committed it — it lived in a
scratch directory and vanished with the agent that wrote it, which is the real
reason a whole quoting convention went unaudited for two more passes. Its
committed successor then turned out to check `> ` blockquotes but not the
inline `*"…"*` form: real, committed, green, and half-blind. Both were caught
by looking at the guard rather than at its output.

So each pass now plants a violation of every guard, confirms it is caught, and
asks the harder question — what does this guard silently permit? A check that
is not committed is not a check, and a guard never shown to fail is not known
to work.

---

Pass 5 of the pre-release gate, and the first run under the standing rule
above — the guards taken at their word and then tested. Directed by the owner
as a single task with six items, of which the first was the only blocking one:
`README.md` told a reader that `package.json`'s `engines` field **enforces**
the Node floor.

It does not. npm's `engines` is advisory: with the floor set to `>=99.0.0` on
Node v25.8.2, `npm install` prints `npm warn EBADENGINE` and installs anyway,
exit 0. Nothing anywhere checked the running version, so the promised stop
never came and `make inspect` failed much later with a cryptic
`Unknown file extension ".ts"`.

The owner left the remedy open — make the claim true with a committed
`.npmrc`, or leave it advisory and say so — and named the trade on both sides.
**Measured, and left advisory**: `engine-strict=true` enforces every package's
engines, not this project's, and 19 installed packages declare ranges with
gaps (`^20.19.0 || ^22.12.0 || >=24.0.0`), so a Node clearing this project's
own floor could be refused an install by a transitive dependency. The 22.18
floor also belongs to one optional command — `make inspect` — while the site
itself builds and runs below it. So the check went where the requirement is:
`make inspect` runs `scripts/require-node.mjs` first and refuses in plain
English, and the README now says npm only warns.

The other five items were guard work, and each fix was proved by planting the
violation it is meant to catch: the `CourseFallback` copy guard was aimed at
six words rather than at the claim, and a differently-worded falsehood walked
past all five tests; the owner-quote checker read `CLAUDE.md` alone and so had
never seen `CHANGELOG.md`'s 24 citations; and the test-count check read a
number that excludes skipped tests, and matched only the first of its pattern.

Widening the quote checker to every tracked markdown file found **an unsourced
quotation in `TODO.md`** — the 12/24-hour clock deferral, written as a direct
quote and attributed explicitly, with no prompt in this log containing it.
Per the owner's instruction to report what the widened checker found rather
than quietly fixing quotes to match, it was withdrawn to a paraphrase rather
than reverse-engineered into this file. **If the owner recognises the words,
they belong here as a labelled recovery entry and it can be a quote again.**


---

> ok the page changes based on browser history events is disabled

Closes the one part of the analytics gap that code could not reach. Everything
meanwhile sends itself was already stripped — `send_page_view: false` and a
`page_location` rebuilt from `origin + pathname` — but GA4's enhanced
measurement fires its own page view on every `replaceState`, and this app
rewrites the address on every cursor move, so Google was receiving `t=`, a
timestamp read out of a photograph, and `who=`, the names of the people shown.

Worth keeping: no test guards this. The setting lives in a console this
repository cannot see, so if the property is ever recreated or the toggle
flipped back, the leak returns silently and nothing here fails.

---

> maybe we can do some text validation when a user uses the web interface to
> write a note so ' = @ and other symbols are warned that they are not allowed
> before save. not too much i can do if they hand type it in there. but the
> website is isolated from those errors. are there any security risks that
> might happen becuase i have provided a way for random people to put in plain
> text input?

Asked about the note composer; the answer that came back ranked the real
risks by severity, and the composer's own input was not the top one. The CSV
layer already guards a formula on write and the app renders every note as
text, so a `=` or an `@` typed into a note is safe where it lands and is
needed as ordinary prose — "mile 60 = the wall". Warning about it would
refuse valid writing to fix nothing.

What the same question turned up in the fields nobody was typing into: an
unvalidated `course.url` reaching `<a href>` and `<iframe src>`, which is a
real same-origin XSS from a `manifest.json` someone emails over; and
`unguard()` eating a leading apostrophe out of a file meanwhile did not
write, which is silent data loss in the opposite direction.

> yes do it in the order you've ranked them. nobody is using this app now. so
> hard specing a version doesn't matter too much righ tnow

So: the URL sink first, the apostrophe second. No version bump — the work
lands in `## Unreleased` and the owner cuts the release separately.

---

> let's go and make sure the spec and everything is solid. we're making this
> ready for a real case example. let's make sure this foundation is solid
> before buildin it into and causing tech debt

An independent pre-release review of the `course.url` work came back
DO-NOT-SHIP, and it was right twice over.

**CORRECTION to the entry above, dated 2026-07-30.** This file is append-only,
so the earlier line stands as written and is corrected here instead. It says
the unvalidated `course.url` was "a real same-origin XSS". **That is false.**
React 19.2.8 — the version this project ships — runs `sanitizeURL` over both
`href` and `iframe src`, in the development and production bundles, and
rewrites a `javascript:` URL to a throwing stub. Verified by execution
(mounting both sinks in jsdom and reading the attributes back), not by reading
a changelog, and now pinned in `tests/course-url-guard.test.tsx`.

What was actually reachable, measured the same way: `data:text/html` in the
`<iframe src>`, which renders attacker markup in an opaque origin — UI
spoofing and phishing inside meanwhile's own page, not theft of the File
System Access handles; any `https://` host framed inside the page; and
`http://`. Serious, and a different and lesser thing than script execution.

The claim came from the brief that commissioned the work, was plausible, and
reached four source files and this log before anybody ran it. The guard itself
stays: React's sanitiser covers exactly one scheme and none of the three
problems above, and a security property that rests on a framework's
implementation detail is one dependency bump from vanishing silently.

The second finding was ours alone and worse in practice: making a bad
`course.url` a hard validation error meant one scheme-less paste —
`strava.com/activities/123`, the ordinary thing to type — refused the whole
`manifest.json` on the next Open folder, taking the crop, the aid-station
markers and every hand-placed photograph with it. It is a warning now; the
manifest loads, the URL is kept verbatim, and the reader refuses to draw it.

---

> ok i've updated the roles now. feel free to use sentence / title case when
> displaying

> ok we can generalize "runner" in the future and allow more roles. for example
> if i want to use this same system for a wedding we'd have more roles to
> highlight or add

The owner had typed real roles into `people.csv` — `crew chief`, `runner`,
`pacer` — and two of the three were being thrown away. `Role` was a four-value
enum (`'runner' | 'crew' | 'friend' | 'other'`) enforced in two places, so
`parsePeopleCsv` blanked the unrecognised two and reported a problem, and one
Save then wrote both cells empty. CLAUDE.md's own rule, "Refusing to READ a
row is not permission to DELETE it", violated one level down — at a cell
rather than at a row.

Measured before touching anything: `crew`, `friend` and `other` had ZERO reads
anywhere in the repository outside the enum's own validation, and the runner
toggle in the ingest report could only ever produce `runner` or no role at
all. The enum cost real data and bought nothing.

> we should then add a column in the people csv that just indicates if that
> person should be pinned. then the roles don't matter and we can deal with
> that later. we just care about who gets pinned

This is what made the change simple rather than merely safe. The first plan
kept `runner` as a reserved, case-insensitively matched role — which meant
free-text roles and lane pinning still shared one field, and one shared field
needs a rule kept in step across five call sites. Splitting them instead:
`role` becomes free text carrying no behaviour at all, and a new
`Person.pinned` (a `pinned` column in `people.csv`, written as the integer
`1`) is the only thing that decides whose lane goes on top.

Several pinned people become legal, which is the wedding case above and the
relay case underneath it, so `orderPeople` now moves ALL of them to the front
in roster order and the `N people have role "runner"; only the first will be
pinned` warning is gone — it described a loss that no longer happens.
A `people.csv` or a `manifest.json` with no `pinned` anywhere still works: the
runner is derived from `role` once, at read time, and written down properly on
the next Save. That derivation is keyed on whether the FILE mentions pinning
at all, never on the row, so an author who deliberately unpins somebody does
not have it forced back on by their own role cell.

> yes push it. sure delete. i cleared the test-people dataset, and cleared teh
> test-notes dataset both from google sheets

`SUGGESTED_ROLES` — the four-value vocabulary left behind when `ROLES` stopped
validating anything — was kept on the theory that a suggestion UI might one day
want it. Nothing read it, and a constant with no reader in a decision record
that tells future sessions to check before citing is a claim waiting to go
stale. Deleted, and the two documents that still pointed at it corrected in the
same commit.

Released as **0.4.0** and pushed: the free-text role and `pinned` split above,
the `https:`-only course-URL allowlist, the `unguard` correction, and the
course-URL box committing on blur rather than on every keystroke.

---

> yes fix the timezone/fingerprint bug

`fingerprintNote` took `event.timezone` as an input, and nothing recomputes
the caches keyed on it when the zone is edited. Reproduced by execution before
anything was changed: editing the timezone box resurrected a deleted note, and
made a blank-`id` row fail to adopt the id an existing row already had, so one
note became two.

Two independent couplings, and only the second had any tension in it. The
fingerprint folded `tz` away whenever it matched the event's, so a row that
carries its own `tz` and `utc_offset_min` — every row the site writes, whose
instant no later zone edit can move — changed identity while its instant did
not move at all. That half was pure loss. The other half is that a row
carrying neither resolves through `event.timezone`, so editing the zone
genuinely moves it: its instant *should* change, and its identity should not,
because it is the same row in the same file saying the same thing.

Identity is now the wall clock the row says, read in the note's own zone, with
the sub-minute remainder and a marker for which half of a fall-back hour it is
— the second because 01:30 MDT and 01:30 MST are the same five integers an
hour apart, and collapsing them would swallow one of two notes in silence.
Three other seams were tried against the reproduction and rejected: matching
tombstones by id first (fixes neither — the failing row's id is minted THROUGH
the fingerprint), recomputing the tombstones on a zone change (a tombstone
holds an `at` from the old zone, and `rowIdentity` holds no rows to recompute
from), and dropping `tz` alone (fixes the first failure and leaves the second
untouched).

Fixed in the same pass, and confirmed rather than taken on trust: `Date.parse`
returns `NaN` for an `at` this build cannot read, `JSON.stringify(NaN)` is
`null`, so every unreadable timestamp landed in ONE fingerprint slot and
deduped against the others whatever they said. Reachable through
`legacyNoteToNote`, which copies an imported manifest's `at` across without
validating it.

> my config csv might be key,value instead i might put in other site config
> options in there (like github repo, etc) so we can keep it more generic to
> key,value. this settings file is osmething a user can upload/download as well

> main thing about csv for settings is that you can also dump that in a google
> drive

The second decided the format. A settings file is the natural place for TOML or
YAML, and the dependency budget argues against both — but neither argument
reaches the one that matters: **a TOML file cannot BE a Google Sheet.** Keeping
the settings in CSV stops the file that configures the other five from being the
one file that cannot live where they do. `csv.ts` already exists, and every value
here is a string, so nothing wants nesting or types.

Two things a settings file does want are cheap in CSV: **comments**, by skipping
any key beginning `#`, and **lists**, via the `;` separator `people` and `author`
already use — which `notes_url` needs, because `notes*.csv` globs across several
crew members' files and the three transports must hold the same set.

> i want the local <> sheets <> git to all have the same files that can be
> synced manually or automatically or semi-automatically

This settled the shape after four rejected designs. "The same files" is the
constraint that rules out keeping `manifest.json` for items alone: a JSON file
cannot be a Google Sheet, so the one file left out would be the one holding the
crop, the markers, the course reference and every hand placement — precisely
CLAUDE.md's own list of what a re-ingest cannot reproduce.

> ok then read the csvs i will import after save

And this settled the direction of sync. The owner is the mechanism: the app
reads, Save downloads, the owner imports. No write path to Sheets is built,
which is what lets the whole design need no accounts, no keys and no backend —
reading a published sheet requires no auth, writing requires OAuth and an
origin-bound client ID.

> ideally we accept markdown formatted text and multi line text in the notes, to
> allow for dashes, but i don't think we need to account for that right now

Deferred, with the obstacle recorded because the obvious one is wrong.
Multi-line text is already legal — RFC 4180 permits newlines inside a quoted
field and `parseCsv` handles them; the project normalises them to spaces by
choice. The real obstacle is the dash: a markdown bullet begins `- `, which the
formula guard rewrites, and that guard survives exactly one pass through a
Google Sheet. Markdown's commonest construct is the one this loop protects
least, so it should land with whatever answers that.
