# meanwhile

*Many people's photos, one shared timeline. See what everyone was doing in
relation to everyone else.*

> **Status: design only. Nothing is built yet.**
> This repo currently contains a design spec and working notes. There is no
> app to run, no install steps, and no commands. This README will grow setup
> and usage instructions when there is something to set up.

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

## Planned views

All four share one cursor, so switching between them keeps your place in time.

- **Swimlanes** — one lane per person across a shared clock, over the course's
  elevation profile.
- **Feed** — everything interleaved into one chronological scroll, tagged by
  who shot it. The phone view.
- **Moment grid** — pick a time, see what all four people captured right then.
- **Map** — where everyone was, drawn on the course.

## If you're contributing photos to an event

One rule matters more than all the others:

> **AirDrop or a shared Drive folder. Never iMessage or WhatsApp.**

Those apps recompress your photos and strip the timestamp out of them — and a
photo with no timestamp has no place on the timeline. Send originals.

Coming from Google Photos? Use the album's **"Download all"** button to get a
ZIP. Don't right-click-save individual images from the web page; that gives
you a stripped copy.

## Documentation

- `docs/superpowers/specs/2026-07-28-meanwhile-design.md` — the full design
- `CLAUDE.md` — architecture rules, decision record, verified constraints
- `PROMPTS.md` — verbatim log of the prompts that shaped this project
- `TODO.md` — deliberately deferred ideas

## License

Not yet chosen.
