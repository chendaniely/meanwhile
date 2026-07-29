# meanwhile

*Many people's photos, one shared timeline. See what everyone was doing in
relation to everyone else.*

> **Status: working, but not finished.**
> Point it at a folder and you get a chronological feed and a swimlane view of
> everyone's photos and video, croppable to the part of the event you care
> about. The moment grid and the map aren't built yet, and neither is the
> course profile. See [Running it](#running-it).

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
elevation profile behind the photos, a map of the course, the option to lay
everything out by mile instead of by hour, his heart rate and cadence through
the race — and automatic correction of the clock differences between
everyone's cameras.

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
- automatic clock alignment

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

All four share one cursor, so switching between them keeps your place in time
— and that place lives in the address bar, so any moment is a link you can
text to someone.

- **Feed** ✅ — everything interleaved into one chronological scroll, grouped
  into moments and tagged by who shot it. The phone view.
- **Swimlanes** ✅ — one lane per person across a shared clock. The gaps are
  the point: the six-hour hole in the runner's lane while three crew lanes are
  busy *is* the story of the night section.
- **Moment grid** — pick a time, see what everyone captured right then.
- **Map** — where everyone was, drawn on the course. Needs the GPX.

## Running it

You need **Node.js 20 or newer**. Check with `node --version`. If you don't
have it, install it from [nodejs.org](https://nodejs.org/) or with
`brew install node`.

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
| `make check` | Everything the project checks before a commit |
| `make build` | Produce the publishable site in `dist/` |
| `make preview` | Serve `dist/` so you can check it before publishing |
| `make clean` | Delete `dist/` and the installed packages |

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
   shared clock, so you can see who was and wasn't shooting, and when. Click
   anywhere on the lanes to drop a cursor.
5. **Click any photo or video** to see it full size; video plays there.
6. **The address bar follows you.** View, cursor, crop, and hidden lanes all
   live in the URL, so any moment is a link you can send to someone.
7. **Export manifest.json** saves the lot, including your crop and any names
   you've corrected.

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
   explain a gap in their lane.
13. **Point at the course and write about it.** Hovering a photo's dot on the
   map shows the photo. And pointing anywhere on the elevation profile offers
   **Note here** with a time worked out from the photographs either side of
   it &mdash; so a climb you remember but nobody photographed can still be
   written down. It refuses rather than guesses beyond the outermost photo.
14. **Your work comes back.** Export `manifest.json`, and next time drop that
   file into the folder along with the photos — names, roles, captions, the
   crop, and hand-placed times all return. Timestamps are always re-read from
   the files themselves, so a stale copy can never override what the photo
   actually says.

There's also a report of how much to trust the times, an expandable list of
any files that arrived without a timestamp (with who to ask for the
originals), and `make inspect` for checking a folder from the terminal.

Still missing: the moment grid as its own view, and publishing to the web.

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

Then it reads only the few kilobytes it needs from each one, because
timestamps live in known, predictable places:

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
| `none` | No timestamp. Goes to the unplaced tray for you to place by hand. |

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
- `CLAUDE.md` — architecture rules, decision record, verified constraints
- `PROMPTS.md` — verbatim log of the prompts that shaped this project
- `TODO.md` — deliberately deferred ideas

## License

Not yet chosen.
