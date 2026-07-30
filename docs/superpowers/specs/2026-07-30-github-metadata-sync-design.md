# Syncing metadata with a GitHub repo — design

**Date:** 2026-07-30
**Status:** approved, not yet implemented
**Owner:** Daniel Chen (@chendaniely)

## The problem

The written record of an event — `notes.csv`, `people.csv`, `manifest.json` —
is the one part nobody can recreate. A photograph can be copied again from
the card; nobody can retype what someone remembered about 3am at Cottonwood a
year later.

Today that record only exists in a folder on one laptop, and moving it
anywhere means pressing **Save**, finding the zip, unpacking three files over
the old ones, and committing by hand. Every step is a chance to lose a
session's notes.

The owner has created a private repo for exactly this record
(`chendaniely/meanwhile-cm100-g`). This is how the site talks to it.

> "let's built it around a PAT i can save it in my password credential store.
> and gather files from them. if the crew member DOES have a github account, i
> can add them to the repo and they can use their own PAT?"

## Who connects, and how

Three tiers, and **the app treats the first two identically** — there is one
code path, not two.

| | How they connect |
|---|---|
| The owner | Their own fine-grained PAT |
| Crew **with** GitHub | Added as a repo collaborator, their own fine-grained PAT |
| Crew **without** GitHub | Never touch this feature. They send a `notes-<name>.csv`, and the existing row-bind merge absorbs it |

**Per-person tokens rather than one shared token**, and the distinction is
load-bearing. A shared PAT is a bearer credential that acts as whoever minted
it: every crew member's commit would be authored by the owner, the history
could not say who wrote what, and revoking for one person would break it for
everyone. Collaborator access plus each person's own token gives correct
authorship and per-person revocation, and needs no OAuth — which matters,
because OAuth would need a server to hold a client secret and this project
has no backend by design.

Crew without a GitHub account are **not a degraded case**. The merge design
exists for them: files arrive, get row-bound, deduped by `id` and sorted by
time. No account, no token, no git.

## The token is never persisted

**Kept in memory for the session only. Not `localStorage`, not
`sessionStorage`, not the manifest, not the exported zip.**

The reason is specific rather than general caution: GitHub Pages project
sites share one origin. `chendaniely.github.io/meanwhile/` has the same
`localStorage` as **every other project page the same user publishes**, so a
token stored there is readable by any of them. The existing `meanwhile.author`
setting lives there quite safely because it is a display preference; a
credential is a different thing.

The owner keeps the PAT in a password manager, so the cost of not persisting
it is one paste per session. That is the whole mitigation, and it removes the
class of problem rather than managing it.

**Hard rules:**

- The token never enters `manifest.json`, `notes.csv`, `people.csv`, the
  saved zip, the URL, or any log line.
- It is held in React state (or a ref) and dropped on reload.
- The UI never renders it back as readable text after entry.

## What the PAT needs

A **fine-grained** personal access token, scoped to the single metadata repo:

- **Repository access:** only that repo
- **Permissions:** `Contents: Read and write`

Nothing else. The README of the metadata repo should say this, because a
crew member being told "make a token" will otherwise reach for a classic
token with `repo` scope, which grants access to everything they own.

## Reading

Given a repo (`owner/name`, optional branch, default `main`) the site fetches
each of `notes.csv`, `people.csv` and `manifest.json` from the Contents API,
and feeds them into exactly the paths a picked folder already uses —
`mergeNotes`, `parsePeopleCsv`, `validateManifest`. **No new parsing.** A repo
missing any of the three is normal, not an error: a fresh event has no
manifest yet.

The media still comes from a local folder. This feature moves the *written
record*, never the photographs — see "Not in scope".

## Writing, and why a conflict is a merge

The Contents API replaces a file by `PUT` with the blob `sha` of the version
being replaced. If anyone has pushed since the site last read, that `sha` is
stale and GitHub answers **409**.

**A 409 must not surface as an error.** The correct response is the one the
whole notes format was designed around:

1. Re-fetch the current remote `notes.csv`.
2. `mergeNotes([remote, local])` — row-bind, dedupe by `id`, sort by `at`.
3. `PUT` the union with the fresh `sha`.

Two people editing the same event from different machines therefore converge
rather than collide, which is the property the opaque-`id` decision bought.
Retry once; if it 409s again, report it plainly rather than looping.

`people.csv` and `manifest.json` merge less naturally — the roster is a set
keyed by `id` (same union-by-id rule), and the manifest is derived data where
last-write-wins is acceptable because it can be regenerated from the photos.

Each save is **one commit per file that changed**, with a message naming the
event and the count (`meanwhile: 3 notes, 1 person — Cascade Crest 100`).

## Failure modes, all of which must say what to do

| What happened | What the person sees |
|---|---|
| Token expired or revoked (401) | "That token is no longer valid — create a new one and paste it in." |
| Token lacks write permission (403) | "This token can read but not write. It needs Contents: Read and write." |
| Not a collaborator / wrong repo (404) | "Cannot find that repo with this token. Check the URL, and that you have been added to it." |
| Rate limited (403 + header) | Name the reset time. |
| Offline | "Could not reach GitHub. Your notes are still here — Save downloads the zip as usual." |

The last one matters most: **losing the network must never mean losing notes.**
The zip download stays available at all times and is the fallback, not a
legacy path.

## UI

A **Connect to GitHub** control in the collapsed settings panel — not the top
bar, which is reserved for things used constantly. It asks for the repo URL
and the token, shows connected/disconnected state, and offers **Load from
GitHub** and **Save to GitHub** beside the existing Save.

Once connected, the ordinary **Save** button offers both: download a zip, or
commit. Never silently change what an existing control does.

## Not in scope

- **Media.** Photographs and video stay local. Seeing everyone's media on one
  timeline needs the deferred bucket upload and is independent of this.
- **OAuth / GitHub App.** Needs a backend.
- **Conflict UI.** There is none by design; conflicts merge.
- **Browsing or picking a repo.** The URL is typed or pasted.

## What would reverse this

If the crew ever needs per-person identity *without* GitHub accounts, this
becomes the wrong shape and the answer is a real backend with real auth — at
which point "the site is a renderer, not a locker" is being reversed, which is
the project's founding decision and should not go quietly.
