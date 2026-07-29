# meanwhile

*Many people's photos, one shared timeline. See what everyone was doing in
relation to everyone else.*

> **Status: working, but not finished.**
> Point it at a folder and you get a chronological feed of everyone's photos
> and video, croppable to the part of the event you care about. The swimlane,
> grid, and map views aren't built yet. See [Running it](#running-it).

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

## Planned views

All four share one cursor, so switching between them keeps your place in time.

- **Swimlanes** — one lane per person across a shared clock, over the course's
  elevation profile.
- **Feed** — everything interleaved into one chronological scroll, tagged by
  who shot it. The phone view.
- **Moment grid** — pick a time, see what all four people captured right then.
- **Map** — where everyone was, drawn on the course.

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
4. **It shows you the timeline** — a chronological feed of everyone's media,
   grouped into moments and tagged with who shot it. When two people were
   shooting at the same time, the moment says so. That is the whole point of
   the thing.
5. **Export manifest.json** saves the lot, including your crop and any names
   you've corrected.

There's also a report of how much to trust the times, and `make inspect`
(below) for checking a folder from the terminal.

Still missing: the swimlane view, the moment grid, and the map.

### How to arrange your folder

**Two ways, and you don't have to do anything special for either.**

If you have a folder per person, meanwhile uses the folder names:

```
cascade-crest-100/
  sam/       <- the runner
    IMG_4417.jpg
  dan/
    IMG_0001.jpg
```

If everything is in one flat folder — which is what a **Google Photos album
download** gives you, with everyone's photos mixed together — meanwhile
works out who's who **from the phones themselves**. You'll get one lane per
device, named something like "Google Pixel 8 Pro", and you rename each to the
person who was carrying it.

It's not guessing blindly: it reads the camera model recorded inside each
photo, and falls back to how each phone names its files. It tells you which
files it was least sure about. Android videos in particular record no camera
model at all, so those are matched by filename or, failing that, by what else
was being shot at the same moment — which can be wrong when two people are
standing together.

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

## If you're contributing photos to an event

One rule matters more than all the others:

> **AirDrop or a shared Drive folder. Never iMessage or WhatsApp.**

Those apps recompress your photos and strip the timestamp out of them — and a
photo with no timestamp has no place on the timeline. Send originals.

Coming from Google Photos? Use the album's **"Download all"** button to get a
ZIP. Don't right-click-save individual images from the web page; that gives
you a stripped copy.

**On an iPhone, send JPEG rather than HEIC.** iPhones shoot HEIC by default,
and no browser except Safari can display it. meanwhile will still place a
HEIC photo correctly on the timeline — it can read the timestamp — but it
can't show you the picture. To change this: *Settings → Camera → Formats →
Most Compatible*. For photos you've already taken, AirDrop to a Mac converts
them automatically.

## Documentation

- `docs/superpowers/specs/2026-07-28-meanwhile-design.md` — the full design
- `CLAUDE.md` — architecture rules, decision record, verified constraints
- `PROMPTS.md` — verbatim log of the prompts that shaped this project
- `TODO.md` — deliberately deferred ideas

## License

Not yet chosen.
