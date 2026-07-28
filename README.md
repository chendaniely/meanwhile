# meanwhile

*Many people's photos, one shared timeline. See what everyone was doing in
relation to everyone else.*

> **Status: early. The scaffolding and the timeline maths are built; none of
> the views are.**
> You can run it, but right now it shows an empty page. See
> [Running it](#running-it) below.

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

- The timeline maths: the manifest format, its validation, and all the
  clock-offset and timezone handling.
- A page that loads, in the right typeface and colors.

Nothing else. There is no way to load photos yet — that's the next step.

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
