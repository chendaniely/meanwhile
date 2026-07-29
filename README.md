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

If the runner exports a **GPX track** from their watch, the timeline gets much
richer: an elevation profile behind the photos, a map of the course, the
option to lay everything out by mile instead of by hour — and automatic
correction of the clock differences between everyone's cameras.

### Ask for the GPX, not the Strava link

A Strava link alone can't do any of that. meanwhile can show one, but it's
just a link (or at best Strava's own embedded widget, which is a sealed box
that can't follow your cursor). None of it says *where the runner was at
2:14am*, which is the whole point.

The file that does is a GPX, and getting it takes about ten seconds:

> On strava.com, open the activity → the **⋯** menu → **Export GPX**.

It's the athlete's own file, so there are no API terms or fees involved — and
the same export works from Garmin, COROS, or any other watch, so none of this
depends on Strava at all.

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

There's also a report of how much to trust the times, an expandable list of
any files that arrived without a timestamp (with who to ask for the
originals), and `make inspect` for checking a folder from the terminal.

Still missing: the moment grid, the map, and the course elevation profile —
all three of which want the GPX.

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
