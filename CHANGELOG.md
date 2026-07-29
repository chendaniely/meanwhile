# Changelog

Each release pairs what changed with the prompt that asked for it, quoted
verbatim from `PROMPTS.md`. meanwhile is written by Claude and directed by its
owner, and the record of who asked for what is part of the project rather than
a footnote to it — several of the decisions below reversed something Claude had
already built, and the reasons are worth keeping.

## 0.1.0 — first working viewer

Point the site at a folder of photographs and look at the race. Nothing is
uploaded; the site ships no media and no event data.

### The shape of it

> "let's built it with an existing project i want to implmeent. but the data
> and website will be separate (e.g., the website will be on github, data will
> exist locally)"

A static renderer, not a locker. It reads files off your disk with the File
System Access API and draws views; a `manifest.json` you export carries the
authoring work. There is no backend and nothing stored server-side, which is
what makes the privacy question answer itself.

### Reading the files

Ingest reads **metadata only** — 128KB of a JPEG, a couple of range reads of a
video — so a 2GB folder costs 26.6MB and about 100ms. EXIF and ISO base media
are parsed by hand rather than with a dependency.

The most important correction came from the owner's real 231 files: **GPS time
is not shutter time.** It timestamps the satellite fix, which is stale by a
median 11 seconds and up to 15 minutes, and non-uniformly — so photographs
taken seconds apart collapsed onto one instant. Ranking it below the shutter
sources took colliding instants from 27 to 2.

The same folder killed the assumption that people hand over one folder each:
it was a flat Google Photos download of three phones, so people are identified
by device — EXIF make and model, then the filename convention, then proximity
in time.

### Looking at it

> "i may not want to see all the photos listed in the timeline, and give me the
> ability to zoom into a certain part of the race"

A two-handle time window over a density histogram, with cluster chips for the
stretches the data actually forms. On the real folder that turns 46.6 days and
230 items into 47 hours and 142, automatically.

> "i like the swim lanes. i feel like as we hover over all the images around
> that time should pop up or something. just looking at when tehre are photos
> and events are not useful"

Right, and it changed the design: marks on a track say *when* without saying
*what*. The swimlanes gained a strip of the actual photographs underneath, one
row per person and aligned with the lane above — the simultaneity claim shown
rather than argued.

### The course

> "i'd like to make sure we are able to also display all the other running
> stats. i almost do want to re-create bits of the strava/garmin interface"

GPX and TCX parse into a course spine: a Leaflet map on real terrain, and
stacked one-measure-per-chart statistics. The owner's own export then taught us
the case the design had not imagined — **120,909 points and not one
timestamp**, a route rather than an activity. Untimed tracks became a supported
mode rather than a parse failure, and meanwhile does not invent the missing
times.

> "sometimes as the runner, you remember moments from the elevation / course.
> especially if there are no photos in that area"

Clicking the course writes a note there, timed from the track when it has one
and interpolated between the surrounding photographs when it does not.

### Writing things down

> "i'd like to be able to provide a comment at any arbitrary time [...] either
> because we forgot to take a photo or it was something that we remembered
> happening during some point of time"

Notes are first-class and belong to no file. They can span time, can belong to
one person — which is what lets a note explain a six-hour gap in someone's lane
— and interleave with the photographs in the feed.

### Getting it back

Export `manifest.json`, drop it back in the folder next time, and names, roles,
captions, the crop and hand-placed times all return. Automatic timestamps are
always re-read from the files, because those are facts about the bytes.
