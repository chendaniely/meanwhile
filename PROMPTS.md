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
