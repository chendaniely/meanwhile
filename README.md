# meanwhile

*Many people's photos, one shared timeline. See what everyone was doing in
relation to everyone else.*

> **Status: working, but not finished.**
> Point it at a folder and you get a chronological feed and a swimlane view of
> everyone's photos and video, croppable to the part of the event you care
> about. Drop a GPX or TCX in too and a course view appears — a real
> topographic map with the elevation, heart rate, cadence and pace charts
> underneath. The moment grid isn't built yet. See
> [Running it](#running-it).

## Two things to know before you start

**1. One folder is fine — it sorts people out by phone.**

You don't have to organise anything. If you give it a single folder with
everyone's photos mixed together — which is exactly what a **Google Photos
album download** gives you — meanwhile works out who's who from the phones
themselves, using the camera model recorded inside each photo. You get one
lane per device, named something like "Google Pixel 8 Pro", and you rename
each to whoever was carrying it.

If you *do* have a folder per person, it uses those names instead.

**2. Get originals. Anything sent through a chat app is useless here.**

> **AirDrop, a shared Drive/Dropbox folder, or a Google Photos album.
> Never iMessage, WhatsApp, Messenger, Instagram, or Slack.**

Those apps recompress photos and **strip the timestamp out of them** — and a
photo with no timestamp has no place on a timeline. It's not a quality
issue you can live with; the photo simply cannot be positioned.

Things that destroy the timestamp:

| | |
|---|---|
| **WhatsApp, Messenger, Instagram DMs, Slack, Discord** | Strip everything. WhatsApp leaves the date in the filename but not the time. |
| **iMessage** | Strips it unless the sender picks the original size. |
| **Screenshotting a photo** | You get a picture of a picture, with today's date. |
| **Right-click-saving from Google Photos in a browser** | Gives a re-encoded copy with the metadata removed. Use the album's **"Download all"** button instead. |
| **Emailing "optimised for web"** | Same story. |
| **Airdropped to a phone, then re-shared** | Usually survives once, rarely twice. |

Things that keep it: **AirDrop**, **a USB cable**, **Google Photos "Download
all"**, **Dropbox/Drive uploads of the original file**, **iCloud shared
albums**, and **email with "actual size"**.

meanwhile will tell you which files arrived stripped and who sent them, so you
can go back and ask — but it can't recover what isn't there.

## The idea

A friend runs a 100-mile ultramarathon. He takes photos. So does his crew, and
so do the friends who drove out to the aid stations. Afterwards, all of it
sits in four separate phones and four separate cloud accounts — four thin,
separate stories.

What's missing is **simultaneity**. Nobody can see that while he was grinding
up a climb at 2am, one crew member was asleep in a car and another was boiling
water at the next aid station. Laid side by side on one clock, those four
piles become the race.

meanwhile puts everyone's media on a shared timeline and lets you scrub
through it — one lane per person, so the gaps are as legible as the photos.

## How it will work

**meanwhile is a renderer, not a locker.** It's a public website that stores
nothing and hosts nothing. You give it a small file describing your event —
who was there, what they shot, and when — and it draws the timeline. Your
photos stay wherever you keep them.

Two ways to use it:

- **On your own machine.** Point it at a folder of photos and it reads them
  straight off your disk. Nothing is uploaded; nothing leaves your computer,
  even though the site itself is public.
- **Shared with others.** Publish the description file with links to your
  photos, and anyone you send it to can open the timeline on their phone.

If the runner exports their **track file**, the timeline gets much richer: an
elevation profile behind the photos, a map of the course, and his heart rate
and cadence through the race. Camera clocks that drift are still corrected by
hand, once per person, in `people.csv` — there's no automatic alignment yet.

### Ask for the TCX, not the GPX — and not the Strava link

A Strava link alone can't do any of that. meanwhile can show one, but it's
just a link (or at best Strava's own embedded widget, which is a sealed box
that can't follow your cursor). None of it says *where the runner was at
2:14am*, which is the whole point.

**And a GPX won't carry his heart rate or cadence.** Per Strava's own
documentation, a GPX export contains GPS, elevation and time — but no heart
rate and no cadence. The format that has them is **TCX**:

| | Heart rate | Cadence | Power | GPS + elevation |
|---|---|---|---|---|
| GPX | ✗ | ✗ | only from a real power meter | ✓ |
| **TCX** | **✓** | **✓** | ✓ | ✓ |

Getting it takes about ten seconds, and he has to be the one to do it — it
only works for your own activities:

> Open the activity on strava.com and add **`/export_tcx`** to the address:
> `https://www.strava.com/activities/<id>/export_tcx`
>
> The **⋯ → Export GPX** menu item also works, if you don't need the
> heart-rate data.

Either way it's the athlete's own file, so there are no API terms or fees —
and Garmin, COROS and the rest all export the same formats, so none of this
depends on Strava.

### Check the file has times in it

There is a third possibility, and it is the one that actually turned up first:
**a GPX with no `<time>` in it at all.** Strava writes one of these when you
export a *route* rather than an *activity* — same `.gpx` extension, same
`creator="StravaGPX"`, 120,000 points of latitude, longitude and elevation, and
not a single timestamp.

meanwhile opens it and tells you so rather than failing. You still get:

- the map, the course line, start and finish
- the elevation profile, total distance and total climb
- the crosshair, reading out elevation and gradient at any point

What needs times, and so is missing:

- the runner's marker moving with the timeline cursor
- pace

Automatic clock alignment is *not* on that list: it isn't built yet either
way, so a timed track will not turn it on. Camera clocks are corrected by
hand, once per person, in `people.csv`.

To check before you send it on, open the file in any text editor and search for
`<time>`. No matches means it is a route. The fix is to export from the
**activity** page — the one with the date and the elapsed time on it — not from
a route or a segment.

meanwhile never guesses the missing times. It would be easy to spread the
race's start and finish evenly across the course, and it would be wrong
everywhere: a hundred-miler's pace varies several-fold between the first climb
and four in the morning, so the marker would sit confidently in the wrong
place. A missing feature is honest. A fabricated one quietly ruins the thing
you came here to see.

**Pace and grade aren't in any track file**, and don't need to be: they're
worked out from the distance and time between points.

## The views

There are three, and they all share one cursor, so switching between them
keeps your place in time — and that place lives in the address bar, so any
moment is a link you can text to someone.

- **Feed** ✅ — everything interleaved into one chronological scroll, grouped
  into moments and tagged by who shot it. The phone view.
- **Swimlanes** ✅ — one lane per person across a shared clock. The gaps are
  the point: the six-hour hole in the runner's lane while three crew lanes are
  busy *is* the story of the night section. A note you write for someone shows
  up right in their lane — which is what lets it explain a gap, like "asleep
  at Cottonwood" captioning those six empty hours. A note for nobody in
  particular gets its own row above everyone else's; a note with a duration
  draws as a bar instead of a dot.
- **Course** ✅ — the map, drawn on real terrain, with elevation, heart rate,
  cadence and pace charts underneath, and photo dots plotted on the route.
  Needs a GPX or TCX; there is no separate "map view" — the map lives inside
  this one.

Not yet built: a **moment grid** — pick a time, see what everyone captured
right then, in a grid rather than a scroll.

## Running it

You need **Node.js 22.18 or newer**. Check with `node --version`. If you
don't have it, install it from [nodejs.org](https://nodejs.org/) or with
`brew install node`. That floor is set by `make inspect`
(`scripts/inspect-media.ts`), which runs as plain TypeScript with no build
step — Node only strips types without a flag from 22.18 (the first LTS with
it unflagged); older Node either needs `--experimental-strip-types` by hand
or, before 22.6, can't run it at all. `package.json`'s `engines` field
enforces this floor.

Then, from inside this folder:

```sh
make install    # once, and again after pulling changes
make dev        # starts the site at http://localhost:5173
```

Leave `make dev` running and open that address in **Chrome or Edge**. Press
`Ctrl-C` in the terminal to stop it.

> Chrome or Edge specifically, for now. Reading a folder off your own disk
> uses a browser feature Safari and Firefox don't have yet. That only affects
> *building* a timeline on your own machine — once a timeline points at
> photos on the web, any browser can open it.

Other commands:

| Command | What it does |
|---|---|
| `make help` | List every command |
| `make inspect DIR=~/photos` | Report what meanwhile reads from a folder of media |
| `make test` | Run the test suite |
| `make check` | Type-check and test; CI also runs a clean install and build |
| `make build` | Produce the publishable site in `dist/` |
| `make preview` | Serve `dist/` so you can check it before publishing |
| `make clean` | Delete `dist/` and the installed packages |
| `make release VERSION=0.1.0` | Check the changelog, version and tag agree, then tag |

**Your photos never go in this repo.** `data/` is ignored by git, and so are
media files anywhere in the folder. This is deliberate: a 24-hour race across
several people is many gigabytes of video, and git keeps every byte forever
even after you delete it.

## What works today

Run `make dev`, click **Open a folder**, and:

1. **It reads every photo and video** and works out when each was taken —
   JPEG, HEIC, MOV, and MP4.
2. **It works out who's who**, from folder names or from the phones
   themselves.
3. **It crops to the event.** A folder usually holds far more than the day
   itself; meanwhile finds the stretch where the photos actually cluster and
   opens on that. Drag the handles, or click the date chips, to change it.
4. **It shows you the timeline**, two ways. The **feed** is a chronological
   scroll grouped into moments — when two people were shooting at the same
   time, the moment says so. The **swimlanes** put one lane per person on a
   shared clock, so you can see who was and wasn't shooting, and when. Moving
   across them shows what everyone was looking at; **clicking pins that
   moment** so it holds still while you reach for a photo, and clicking again
   lets it follow the pointer once more. The **scroll wheel zooms** the time
   range, which is the same range the slider at the top controls.
5. **Click any photo or video** to see it full size; video plays there.
6. **The address bar follows you.** View, cursor, crop, and hidden lanes all
   live in the URL, so any moment is a link you can send to someone.
7. **Click Save** to download a zip with everything editable: `notes.csv`,
   `people.csv`, and `manifest.json` — your crop, corrected names, and every
   note and caption.

8. **Drop a GPX or TCX in the folder** and a **Course** view appears: the
   route on a real topographic map, with terrain shading, satellite and
   street basemaps to switch between, and the elevation profile underneath.
   Heart rate, cadence and pace charts appear too, if the file carries them
   (a TCX does; a GPX doesn't).
9. **The map and the profile follow each other.** Run the pointer along the
   elevation profile and a marker tracks it around the map; run it along the
   course on the map and the profile's crosshair follows, reading out
   elevation and gradient at that point. The map zooms on the scroll wheel.
10. **The course rides along with the photos.** With a track loaded, a strip
   showing the map and the elevation profile sticks to the top of the feed
   and follows what you scroll past, so you can see where each photo was
   taken without leaving the timeline.

11. **Name people, mark the runner, caption photos.** The lanes start out
   named after the phones that shot them; rename each one in the report.
   Marking someone the runner pins their lane to the top. Any photo can be
   captioned from the lightbox.
12. **Write a note at any time, with or without a photo.** Something happened
   that nobody photographed &mdash; a wrong turn, a nap in the car, a rough
   patch at 3am. Add it under the timeline and it appears in the feed in
   order, alongside the photographs. It can cover a stretch of time rather
   than a moment, and can belong to one person, which is what lets a note
   explain a gap in their lane. Every note &mdash; and every photo's caption
   &mdash; is a row in a spreadsheet file called `notes.csv` that lives in the
   folder with the photos, so anyone on the crew can add or fix one up outside
   the site too. See [The notes file](#the-notes-file) below. A photo with a
   caption shows a small speech-bubble on its tile.
13. **Point at the course and write about it.** Hovering a photo's dot on the
   map shows the photo. And **clicking anywhere on the course** &mdash; on the
   map or on the elevation profile &mdash; opens the note box already set to
   that moment, with the time taken from the track if it has one, or worked
   out from the photographs either side if it does not. So a climb you
   remember but nobody photographed can still be written down. It says so
   rather than guessing when there is nothing to work from.
14. **Your work comes back.** Click **Save**, unzip what you get, and drop
   `notes.csv`, `people.csv`, and `manifest.json` into the folder along with
   the photos — names, roles, notes, captions, the crop, and hand-placed times
   all return, exactly as you set them. Every other timestamp is still
   re-read fresh from the file itself, so a stale copy can never override
   what the photo actually says.

There's also a report of how much to trust the times, an expandable list of
any files that arrived without a timestamp (with who to ask for the
originals), and `make inspect` for checking a folder from the terminal.

Still missing: the moment grid as its own view, and publishing to the web.

## The notes file

Every note — and every photo's caption, which is really just a note pointed
at a photo — lives in a file called **`notes.csv`**, right there in the
folder next to the photos. It's a spreadsheet. Open it in Excel, Google
Sheets, or Numbers, and you can read, add, or fix up any note in the event
without touching the website at all.

| Column | What goes there |
|---|---|
| `id` | Leave it blank on a new row — the site fills it in the next time you open the folder. |
| `year`, `month`, `day`, `hour`, `minute` | When it happened, as plain numbers — `2026,7,25,15,45` for 3:45pm on 25 July 2026. Midnight is `hour,minute` = `0,0`, with `year`/`month`/`day` still filled in as usual. |
| `duration` | How long it lasted, only if it's a span rather than an instant — `PT3H40M` for three hours forty minutes. Leave it blank for something that happened at one moment. |
| `tz` | Only fill this in if the note happened in a different timezone than the event itself. Leave it blank otherwise. |
| `people` | Who the note is about. Several names, separated by semicolons — `Priya;Sam`. |
| `photo` | If this note is a caption, the photo it belongs to. Blank for a note with no photo. The site writes the full path (e.g. `priya/PXL_….jpg` when photos sit in a folder per person); if you type a plain filename by hand, it works too, as long as only one photo in the folder has that name. |
| `author` | Who wrote it. Same rule as `people` — semicolons for more than one name. |
| `text` | What happened. |

**Why the date is five plain numbers instead of one date and one time.** Any
format that *looks* like a date or a time gets silently rewritten the moment
a spreadsheet saves it — Excel turns `2026-07-25` into `7/25/26`, and `15:45`
into `3:45 PM` or a fraction like `0.65625`. Plain numbers like `7` and `45`
don't look like a date to a spreadsheet, so nothing gets rewritten. It costs
a little typing, but not much: you can drag-fill the year, month, and day
down a column of rows in one go, then type in each row's own hour and
minute — which is how most nights actually get logged, one date and many
times. (On the site itself, the note box still shows one plain time field;
the splitting only happens in the file.)

**Several people can each keep their own file, and they merge.** Any file
whose name starts with `notes` and ends in `.csv` counts — `notes.csv`,
`notes-priya.csv`, `notes-sam.csv` all work side by side in the same folder.
Drop in as many as you like; meanwhile reads all of them, puts every row in
time order, and shows them together. Nobody has to merge anything by hand,
and nobody can clobber anyone else's file by keeping their own. If you
accidentally copy a row, meanwhile notices and gives the copy its own `id`
rather than silently merging it into the original or losing it.

**A photo with a note shows a small speech-bubble** on its tile, so you can
tell which photos have something written about them without opening each one.

**Getting your work back.** Click **Save** and you get a single zip file
containing `notes.csv`, `people.csv` — the list of names, who's the runner,
and any clock corrections, in the same spreadsheet-editable style — and
`manifest.json`. Unzip it and drop all three into the folder with your
photos. Next time you open that folder, every note, caption, name, and
correction comes right back. A time you placed by hand stays exactly as you
set it; every other photo and video timestamp is still re-read fresh from
the file itself, so a stale note file can never make a photo lie about when
it was taken.

## Publishing it

The site is a renderer, so publishing it ships **no photographs, no manifest
and no track** — only the app. Whoever opens it points it at their own files.

`.github/workflows/pages.yml` builds and deploys on every push to `main`. To
turn it on once: **Settings → Pages → Source → GitHub Actions**. The tests and
the type-check gate the deploy, because a broken timeline is worse than a stale
one.

It publishes to `https://<user>.github.io/meanwhile/`. Assets resolve under
that path via `base` in `vite.config.ts`; if you rename the repository, change
it there or set `MEANWHILE_BASE`.

### The optional map key

The map works with no key at all — OpenTopoMap, Esri imagery, Esri hillshade
and OSM are all keyless, which is why Leaflet was chosen over MapLibre. A free
[Thunderforest](https://www.thunderforest.com) key adds their Outdoors basemap:
put it in **Settings → Secrets and variables → Actions** as
`VITE_THUNDERFOREST_KEY`, and locally in `.env.local` as
`VITE_THUNDERFOREST_KEY=...`.

**One caveat that is easy to get wrong.** This is a static site, so Vite bakes
the key into the published JavaScript. A repository secret keeps it out of your
source, **not out of the page** — anyone can read it from the deployed site.
That is normal for client-side maps and providers expect it: restrict the key
by HTTP referrer to your own domain, and it is useless anywhere else. Do not
rely on it being hidden.

## Why it's fast, and why nothing is uploaded

meanwhile opens a folder of hundreds of photos and gigabytes of video in
about a second, on a website that has no server. That sounds like it
shouldn't work. Here's what's actually going on — it's three separate tricks,
and none of them involve copying your files.

### It reads slivers of your files, not your files

When you pick a folder, the browser doesn't hand meanwhile your photos. It
hands over a **list of handles** — the equivalent of a shelf reference rather
than the book. Nothing is copied, nothing moves, and nothing touches the
network.

Then it reads only the small head of each file it needs — about 115KB per
file on average, 1.3% of a real 2GB folder — because timestamps live in
known, predictable places:

- **In a photo**, the date sits in a block right at the front of the file. By
  the format's own rules that block can't be bigger than about 64KB, however
  huge the photo — so meanwhile reads the first 128KB and stops.
- **In a video**, the information is usually at the *very end* (a camera
  doesn't know how long a recording is until you stop it). Rather than read
  the whole file to get there, meanwhile follows a chain of signposts: each
  chunk of a video file begins by stating its own length, so it can hop from
  one to the next, reading 16 bytes each hop, until it lands on the part it
  wants. Finding the metadata in a 122MB clip costs about three hops.

On the real race folder — 231 files, 2GB:

| | |
|---|---|
| Media on disk | 2,034 MB |
| **Actually read** | **26.6 MB** — 1.3% |
| Time | about a tenth of a second |

The 98.7% it skipped is the photographs themselves, which it has no reason to
look at yet.

### Thumbnails are shrunk *while* being decoded

A 4080×3072 photo takes about **47MB of memory** once opened — that's the
pixels, not the file. Fifty of those on screen would be 2.4GB and a dead tab.

So meanwhile never opens one at full size. It asks the browser to decode
*and* shrink in a single step, on a background thread, so the full-size
version never exists at all. What comes out is about **41KB** — around 60×
smaller than the file and 80× smaller than the opened image.

It also only does this for tiles near your screen, a few at a time, and keeps
what it made in case you scroll back.

### The lightbox is fast because it does almost nothing

This is the surprising one. When you click a photo, meanwhile doesn't load
it. It creates a **temporary address that points at the file on your disk**,
and hands that to the browser — which then reads and displays it with the same
built-in machinery that opens any image, written in C++ and tuned for
decades.

Making that address costs the same whether the file is 1MB or 500MB, because
nothing is being copied. Measured in the browser:

```
  1 MB file  ->  0.14 ms
 50 MB file  ->  0.55 ms
500 MB file  ->  0.25 ms      (the differences are just noise)
```

Video works the same way, which is why a clip starts playing immediately and
you can scrub it: the browser streams from the file on disk exactly as a
video player would.

The one catch is that those temporary addresses **hold the file in memory
until they're explicitly thrown away** — nothing cleans them up for you. Get
that wrong and the tab swells until it dies. So every one of them is handed
out and taken back in a single place in the code, with a test that fails if
any is created and not released.

### How it works out who's who

If you have a folder per person, it uses the folder names:

```
cascade-crest-100/
  sam/       <- the runner
    IMG_4417.jpg
  dan/
    IMG_0001.jpg
```

Otherwise it goes by device, as described at the top. It isn't guessing
blindly — it reads the camera model recorded inside each photo, and falls
back to how each phone names its files.

**Where it's least certain, and says so:** Android videos record no camera
model at all. Those are matched by filename where the naming is
distinctive, and failing that by what else was being shot at the same
moment — which can be wrong when two people are standing together. The
report tells you how many fell back to that weakest signal.

If you only have a handful of loose files, **Pick files instead** works too.

### Where the GPX goes

There is no separate button for the track, and nowhere to upload it to.
**Put the `.gpx` or `.tcx` in the folder with the photos** — anywhere inside
it, at any depth — and meanwhile finds it while it reads the folder. A
**Course** tab then appears next to Feed and Swimlanes.

If you have several tracks in there, the richest one wins: a TCX carrying
heart rate beats a bare GPX.

**Pick files instead** also accepts a track, so you can select the photos and
the `.gpx` together, and a track on its own is enough to look at the course
before any photos exist.

### Checking your media before you build anything

Point this at a folder and it tells you what meanwhile would make of it:

```sh
make inspect DIR=~/Desktop/race-photos
```

It reads metadata only. Nothing is written, moved, or uploaded. You get one
line per file and a summary like:

```
sam/IMG_4417.jpg    photo gps          2026-08-22T13:12:04Z       47.3900,-121.3900
sam/IMG_0042.MOV    video qt-offset    2026-08-22T06:20:00-07:00  47.3900,-121.3900 12.5s
stripped.jpg        photo none         -                          -
```

The `timeSource` column is the one to read. It says **where the time came
from**, best to worst:

| Source | Means |
|---|---|
| `exif-offset` / `qt-offset` | The moment the shutter fired, and the device knew its timezone. Best. |
| `exif-naive` / `qt-naive` | The shutter, but no timezone recorded — needs the event timezone set. |
| `gps` | From satellites. Immune to a wrong camera clock, but see below. |
| `filename` | Recovered from the filename after the metadata was stripped. |
| `mvhd` | Last resort, from a video's header. **May be off by hours** — see below. |
| `none` | No timestamp. Goes to the unplaced tray, listed for you to chase down. |

Three things worth knowing:

- **`gps` is ranked below the shutter, which is counter-intuitive.** GPS time
  comes from satellites, so it looks like it should win. But it records when
  the *last position fix* happened, not when you pressed the button — on your
  race photos it lagged by 11 seconds on average and by as much as 15 minutes.
  Worse, it lagged *unevenly*, so photos taken seconds apart collapsed onto
  the same timestamp and lost their order. A timezone that's wrong at least
  shifts everything by the same amount.

- **A lot of `none` means something stripped your files in transit** —
  usually iMessage or WhatsApp. Get the originals.
- **`mvhd` is not trustworthy.** That field is supposed to be UTC, but Apple
  writes local time into it with no timezone, so a clip read from it can land
  hours off with nothing on screen to warn you. `make inspect` prints a
  warning when any file falls back to it.

## What to send the people who took photos

Copy and paste this to them:

> I'm putting everyone's photos from the race onto one shared timeline, so we
> can see what each of us was doing at the same moments.
>
> For it to work I need the **original files**, because the timestamp inside
> them is what places each photo. Sending them through WhatsApp, iMessage,
> Messenger or Instagram strips that out and the photo can't be used.
>
> Easiest ways that keep it intact:
> - **AirDrop** them to me (iPhone/Mac)
> - Drop them in the **shared Drive/Dropbox folder**
> - Add them to the **shared Google Photos album**
>
> Videos too, please. And don't worry about picking the good ones — send
> everything, it's easier to leave things out later than to chase them down.

**One extra note for iPhone users.** iPhones shoot HEIC by default, and no
browser except Safari can display it. meanwhile will still place a HEIC photo
at the right moment — it reads the timestamp fine — but the picture itself
shows as a placeholder. To change it: *Settings → Camera → Formats → Most
Compatible*. Photos already taken convert automatically when AirDropped to a
Mac.

## Documentation

- `docs/superpowers/specs/2026-07-28-meanwhile-design.md` — the full design
- `docs/superpowers/specs/2026-07-29-notes-as-csv-design.md` — why notes and
  people live in spreadsheet-editable CSV files instead of the manifest
- `CLAUDE.md` — architecture rules, decision record, verified constraints
- `PROMPTS.md` — verbatim log of the prompts that shaped this project
- `TODO.md` — deliberately deferred ideas

## License

Not yet chosen.
