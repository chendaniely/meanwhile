# Changelog

Each release pairs what changed with the prompt that asked for it, quoted
verbatim from `PROMPTS.md`. meanwhile is written by Claude and directed by its
owner, and the record of who asked for what is part of the project rather than
a footnote to it — several of the decisions below reversed something Claude had
already built, and the reasons are worth keeping.

## Unreleased

Both items below came out of one question the owner asked about the note
composer — whether letting people type free text anywhere was a risk:

> "maybe we can do some text validation when a user uses the web interface to
> write a note so ' = @ and other symbols are warned that they are not allowed
> before save. not too much i can do if they hand type it in there. but the
> website is isolated from those errors. are there any security risks that
> might happen becuase i have provided a way for random people to put in plain
> text input?"

The answer to the literal question is no: the CSV layer already guards a
formula on write and every note renders as text, so `=` and `@` are safe
where a note lands and are ordinary prose besides — "mile 60 = the wall".
Warning about them would refuse valid writing to fix nothing. What the
question turned up was two problems in the fields nobody was typing into.

> "yes do it in the order you've ranked them. nobody is using this app now. so
> hard specing a version doesn't matter too much righ tnow"

### `course.url` was an unvalidated URL sink

`validateManifest` checked `course.url` was a non-empty string and nothing
else, and `CourseFallback` handed it straight to `<a href>` and, for a
`strava-embed`, to an `<iframe src>` with no host allowlist. A
`manifest.json` — the file this project's whole collaboration model consists
of emailing to people — could therefore put an arbitrary address into either
sink, on a page holding File System Access handles to the owner's entire
photo folder.

What that actually got you, verified by execution against React 19.2.8
(see the correction below, which is where this account was arrived at):
`data:text/html,…` in the `<iframe src>`, rendering attacker markup in an
opaque origin — UI spoofing and phishing inside meanwhile's own page; any
`https://` host framed inside the page; and `http://`. Not script execution:
React sanitises `javascript:` in both sinks.

Now: **a link must be a plain `https://` address, and an embed must
additionally be on strava.com or www.strava.com.** A link merely offers to
leave the page; a frame fetches on the reader's behalf and puts someone
else's document inside it, so only the frame gets a host allowlist. Not an
allowlist of sites to *visit* — a Garmin or COROS activity URL is a
reasonable thing to link to.

One copy of the rule, `src/core/course-url.ts`, imported by both the
validator and the component; a second copy is how the weaker of two checks
ends up being the one that decides. It is hand-rolled rather than
`new URL(...)` because `URL` is a banned global in `tests/core-purity.test.ts`
— the same answer as XML in `course.ts` and CSV in `csv.ts` — and it is
therefore deliberately stricter than a browser's parser: no userinfo
(`https://www.strava.com@evil.test/` has a host of `evil.test`), no non-ASCII
host, and no whitespace, control character or backslash anywhere, since
browsers delete tabs and newlines from a URL before resolving it.

Both layers are needed and the second is not belt-and-braces: the
event-settings box builds a course reference without going near the
validator. A refused URL says so where the link or the embed would have been,
rather than leaving a gap that reads as a bug in meanwhile.

Proved by breaking it eleven ways, each run against the suite: drop the
control-character refusal, allow `@` in the authority, accept `http:`,
suffix-match the embed host instead of matching it exactly, make each guard
return everything, disable each validator branch, put `course.url` back in
the `href` and back in the `src`, and refuse in silence. Every one was
caught. A test never seen to fail is not known to work, and this repository
has shipped several that assert nothing.

#### Corrected before release: it was not an XSS, and the first fix lost data

> "let's go and make sure the spec and everything is solid. we're making this
> ready for a real case example. let's make sure this foundation is solid
> before buildin it into and causing tech debt"

An independent pre-release review said do not ship, and found two things.

**The severity was overstated when first written, in four files and the
prompt log — this section is what corrected it, and the heading above has
been rewritten to match rather than left contradicting it.**
React 19.2.8 — the version this ships — sanitises `javascript:` in both
`href` and `iframe src`, in the development and production bundles, rewriting
it to a throwing stub. Verified by execution rather than by reading a
changelog. So this was never same-origin script execution and it is not
another Leaflet tooltip XSS. What WAS reachable, measured the same way:
`data:text/html` in the `<iframe src>`, rendering attacker markup in an
opaque origin — UI spoofing and phishing inside meanwhile's own page, not
theft of the photo-folder handles; any `https://` host framed inside the
page; and `http://`. Every one of those passed through React untouched.

The guard stays, and still refuses `javascript:`. React's sanitiser covers
exactly one scheme and none of the three problems above; sanitising URLs is
not React's job; and a security property resting on a framework's
implementation detail is one dependency bump from vanishing with nothing here
to notice. The behaviour is now pinned both ways — that React does sanitise
`javascript:`, so nobody rewrites the false claim, and that it sanitises
nothing else, so nobody deletes the guard as redundant.

**Refusing the manifest destroyed data, and that was our own doing.** Making a
bad `course.url` a validation ERROR meant one scheme-less paste —
`strava.com/activities/123`, the ordinary thing to type — refused the whole
`manifest.json` on the next **Open folder**, taking `event.range`, every
marker, the title, the timezone and **every hand-placed photograph** with it:
exactly the list `CLAUDE.md` names as not regenerable from the photos. It also
broke files that already worked, since an `http://` course URL loaded before.

It is a warning now. The manifest loads, the URL is kept verbatim — refusing
to act on a value is not permission to delete it — and the reader declines to
render it. Two things make that real: `validateManifest`'s warnings had never
been read by anything in the viewer, and are now routed into the same problems
callout as everything else; and the event-settings box normalises a
scheme-less paste to `https://` **when the edit is committed** — see the
correction below, because the first version of this did it on every keystroke
and made typing worse than not normalising at all. A scheme that is already
there is never rewritten — silently upgrading `http://` would change where
the author said to go.

**Two user-visible strings were lying.** The link read "Open the activity on
Strava" whatever the URL was, with `target="_blank"` so the address bar never
corrected it — an emailed manifest could render a Strava-labelled link to
`https://evil.test/login`. It names the actual host now. And an embed refused
for its HOST also printed "a plain activity URL cannot be embedded", which is
false of a URL containing `/embed/`; each refusal explains only itself.

Eleven more mutations, ten caught. The eleventh — dropping a redundant early
return in the URL normaliser — was confirmed an equivalent mutant by
differential execution over 504 inputs, and the line is kept with a comment
saying so.

#### Corrected again: the usability additions were the shipping blockers

A second independent review passed the security work — 2,717 differential
inputs against the WHATWG parser found no way past the embed allowlist — and
returned do-not-ship on the two conveniences added around it.

**The URL box normalised on every keystroke.** It was a controlled input whose
`onChange` wrote through the normaliser and fed the result back into the
field, so typing `https://www.strava.com/activities/123` by hand ended at
`https://https://www.strava.com/activities/123` — refused by the guard, no
link rendered, and saved to `manifest.json` that way. Pasting worked and
typing did not, the exact inverse of what normalising was for. Backspacing
could not recover either: it converges on `https://h` and never reaches empty,
so "clear the box to remove the course" was unreachable.

**This is a class this project has already paid for**, recorded under "A
rename is TOTAL, and committed — never per-keystroke" — nineteen renames and
an alias list holding every prefix of a name. Fixed the way that entry says,
reusing its precedent rather than inventing a second one: the field holds a
draft, committed on blur or Enter, Escape reverts, and Escape deliberately
does not call `.blur()` (which would fire the commit handler against the
stale draft and commit the edit it was meant to abandon). Normalisation
happens at commit.

The tests could not have caught it: they exercised the normaliser as a pure
function and never mounted the box. There is now a test that types character
by character.

**A correct manifest raised a false alarm.** Routing every validator warning
into the problems callout surfaced one that fires unconditionally for every
Strava course — "no time-and-distance data" — so the commonest workflow there
is (paste a link, Save, Open) reported a problem on a file with nothing wrong,
in a callout whose wording is about unreadable rows and deleted notes, and
which `CourseFallback` already explains properly on the page where it
matters. A warning that fires on an ordinary correct configuration trains
people to ignore the channel. It is gone at the source, so everything
`warnings` still carries describes something actually wrong — which makes
routing them wholesale correct by construction rather than by filtering on
their wording. Manifest advisories are also ordered last now, behind anything
reporting a loss.

**And normalisation no longer promotes words into links.** `none`, `n/a`,
`TBD` and `-` became `https://none` and rendered as anchors reading "Open the
activity on none". A dot is now required before anything is prefixed;
everything else is stored verbatim and refused at render with an explanation,
which is what happened before normalisation existed and was better.

Three smaller corrections: a comment said React's sanitiser misses "two" real
problems immediately after listing three; the claim that refusing non-ASCII
hosts makes `hostOf` "a statement about what will actually be contacted" is
false for numeric IPv4 forms (`0x7f.1` and `2130706433` both dial 127.0.0.1 —
not a bypass, since neither can equal strava.com, but a label/destination
mismatch now that the host is shown as link text, and corrected rather than
papered over with an IPv4 canonicaliser); and a mutation count in `TODO.md`
had gone stale the same day it was written.

### A leading apostrophe someone else typed is no longer eaten

`unguard()` stripped one leading `'` from every cell — right for a file
meanwhile wrote, wrong for one it did not. A note reading `'twas a long
night`, or a person named `'Bama`, lost the apostrophe on the first read and
saved without it, silently and unrecoverably. Open in `TODO.md` since the
0.3.1 gate found it.

It is now the exact inverse of the guard: strip the `'` **if and only if the
remainder matches `FORMULA_LEAD`** — the same question the writer asked when
it decided to add one. Testing the whole remainder rather than just the next
character is the part that matters: a cell written `'  =evil` is ours, and a
next-character check sees a space, keeps the apostrophe, and hands a live
formula back to the spreadsheet.

No migration was needed, and the old `TODO.md` entry had already proved why
without following it through: a file meanwhile wrote carries `''twas`, not
`'twas`, so it reads identically before and after. Only somebody else's file
reads differently, and it now reads correctly.

Broken four ways to prove the tests hold it: revert `unguard` to the old
unconditional strip (4 failures), narrow it to a next-character test (10),
make it never strip at all (20), and give `FORMULA_LEAD` a `/g` flag so its
`lastIndex` carries between calls (13).

The frozen migration fixture, `tests/fixtures/csv-before-2026-07-30.ts`, was
checked and not touched: no cell in it begins with an apostrophe, so it reads
identically either way.

One round-trip difference this introduces, found by the same pre-release
review and now written down in `CLAUDE.md` beside the other four: a foreign
`'twas` reads as `'twas` and is written back as `''twas`. The content is
identical — that is the promise — and the file gains one character, once,
because the writer must guard anything a spreadsheet could run. Stable from
the second write onward.

## 0.3.1 — 2026-07-30 — the gate turned on itself, then on its own guards

### The analytics leak is shut

> "ok the page changes based on browser history events is disabled"

The one part of it the code could not reach. `send_page_view: false` and a
fragment-free `page_location` stopped everything meanwhile sends itself, but
GA4's enhanced measurement fires its own page view on every `replaceState` —
and the app rewrites the address on every cursor move — carrying `t=`, a
timestamp read from a photograph, and `who=`, people's names. It is a
property-level toggle in the Google Analytics console, so no change here could
close it. Now off.

Worth keeping in mind: nothing in this repo can see that setting, so no test
guards it. If the property is recreated or the toggle flipped back, the leak
returns silently.

### The pre-release gate, run five times

> "can you dispatch some secutiry and privacy independent subagents to review?"

The same review that produced 0.3.0, turned on the release itself and then —
this is the part worth keeping — **turned on its own previous pass**, four
times over. Each pass's findings were, largely, things the pass before it
introduced or missed while fixing that pass's findings: one sentence about
what this app fetches was rewritten by every one of the five. Every item
below was reproduced by execution before it was fixed, and every fix was then
broken again to confirm a test catches it.

**And then on the guards themselves (`f08e3d2`)**

> "let's also do passes on the guards themselves and make sure we do an
> analysis of the actual guards. treat it like you don't really trust the
> guards at all"

The gate had grown two mechanical guards and was reading their output as
evidence they worked. Two failures already argued otherwise: pass 1's quote
checker found nine bad quotes and was never committed — it lived in a scratch
directory and vanished with the agent — and its committed successor was real,
green, and half-blind, checking `> ` blockquotes but not the inline `*"…"*`
form where all four surviving bad citations were. So every pass now plants a
violation of each guard, confirms it is caught, reverts, and asks what the
guard silently permits. A check that is not committed is not a check; a guard
never shown to fail is not known to work. Recorded as a standing rule in
`CLAUDE.md`.

**Data loss, found by running the gate (`71333d3`)**

- **Save erased every row this build refused to READ.** A `notes.csv` row
  carrying a `schema` this build doesn't know, or a day of 32, was reported at
  load and then silently absent from the next file Save wrote — so the advice
  it printed described a repair for data one button press had already
  destroyed. Refused rows are now kept verbatim and written back: a note keeps
  its place in time, a roster row goes after the roster, and its own columns
  come with it. Losing a roster row was worse than losing text: it takes that
  person's clock offset, which moves every photograph they took.
- **"Add files" reverted an in-session rename**, orphaning every note the
  rename had rewritten. It also dropped the crop, the course link and the
  markers.
- **Save threw and did nothing on an unrecognised timezone.** Typing `MDT` —
  the obvious thing to type — produced no file and no message. It is a
  sentence in the error callout now.
- A malformed `manifest.json` handed the folder to a deeper one with nothing
  said; a rename could give a contested name away.

**Tests that were passing without testing anything (`23d309b`)**

Found by deleting production code and watching the suite stay green.
`deriveNoteId` could be replaced by a **constant** with all 178 relevant tests
still passing — which is exactly the bug that caused the note-cloning growth
in 0.3.0. Also uncovered: `locateBox`'s 64-bit branch, and the Android GPS
fallback that is the only place a Pixel clip's position can come from. One
test certified a dead end — a leap second parsed into a value nothing
downstream could resolve, so the item failed to place in silence. Neither a
usable value nor a visible gap, which is the one outcome this project refuses.

**Documentation accuracy (`d1753b4`, then corrected below)**

Owner quotes re-checked against `PROMPTS.md`, comments corrected against the
code they describe, and a `Makefile` message that printed empty values fixed.

**Pass 2: what pass 1 got wrong**

- **The privacy claim was inverted into a false one.** Pass 1 rewrote README
  and CLAUDE.md to say map tiles load "only on the Course view … not on Feed
  or Swimlanes". That is false, and the text it replaced was true. `CourseMap`
  has **two** mount sites — pass 1 checked the import, found one, and stopped.
  The course rail mounts a second map on Feed and Swimlanes, so **once a track
  is in the folder, tiles load on every view**. Six places now agree, and
  CLAUDE.md records the second mount site by name so this stops flipping — it
  had flipped three times. (Pass 3 found that sentence *nearly* right and
  narrowed it once more — see below.)
- **Preserved rows reintroduced unbounded merge growth**: two files carrying
  the same refused row grew 2 → 3 → 4 → 5 → 6 over five rounds — the exact
  signature of the clone bug 0.3.0 fixed. Deduped by content fingerprint, and
  pinned by a five-round test.
- **A preserved row sorted by the wrong clock.** Its position was computed
  from wall-clock cells read as UTC, ignoring the row's own zone: the same row
  sorted first in Denver and last in Tokyo, up to ±14h out of place. That
  defeats the one thing preservation promises beyond not-deleting — that a
  refused row keeps its place in time.
- **The round-trip guarantee was understated three ways.** Saving a file also
  drops fields past the header, drops a cell under a blank header name, and
  adds known-but-absent columns. All four exceptions are now listed. A fifth
  was found and is a genuine bug: a leading apostrophe someone else typed
  (`'twas`) is eaten on the first read. Recorded in `TODO.md` rather than
  patched, because the fix needs a migration story.
- **Two comments pass 1 "corrected" were themselves wrong**, and re-deriving
  the second found a real rendering bug: with Relief on, the hillshade raised
  the map's zoom ceiling to 19 while the topo basemap stopped at 17, so
  **topo blanked entirely at z18–19** — bare hillshade, no contours, no
  trails, no labels — and the `maxNativeZoom` line meant to prevent that was
  unreachable. Fixed.
- **The quote audit missed a whole quoting convention.** Pass 1 checked `> `
  blockquotes; CLAUDE.md also quotes inline. Four bad citations survived,
  including one **spliced together from two different prompts** with the
  owner's typos silently normalised. Fixed to the real text, typos intact; the
  two that were never logged are appended to `PROMPTS.md` as a labelled
  recovery entry. The checker now covers both conventions, catches splices and
  silent typo corrections, and runs as part of `make check` — pass 1's lived
  in a scratch directory and was never wired to anything, which is the other
  reason it missed this.
- A roster message read `"Bob" is now "Bob"` when only a clock offset changed.

**Pass 3: the privacy sentence, and two invariants nothing was holding**

Run against pass 2 the same way pass 2 was run against pass 1.

- **A sentence about map tiles was false exactly where a user reads it.** The
  panel shown for a Strava link told people "the map tiles on this page load
  from other servers automatically" — but that panel only renders when there
  is *no* track, and every map in the app needs one, so no tile is fetched
  there at all. Its replacement said "nothing on it reaches another server
  except the Strava iframe" — which was itself false on the deployed build,
  and pass 4 had to walk the absolute back a third time. (See below; the copy
  that ships now names the analytics tag rather than denying it.)
- **Tiles: two gates, not one.** Pass 2's "every view" missed that Feed and
  Swimlanes also need a time range, which pass 3 said "does not exist until a
  photo is placed or a note is written". Half right: a note is not enough
  either, which pass 4 corrected to a placed *photograph* — see below. A
  folder holding a track and nothing else gets tiles on the Course view
  alone. Corrected in all six places, along with
  "four external hosts unconditionally" — at most two are fetched at a time,
  the chosen basemap plus the optional hillshade, and Thunderforest needs a
  build key it does not have by default.
- **Pass 2's own dedupe had two invariants no test held.** Breaking the
  per-file tally lost a row that someone had genuinely typed twice — and every
  existing test stayed green, because they all happened to read the file with
  more copies first. Relaxing the tie-break rewrote the order of rows nobody
  touched. Both are pinned now, each proved by making the change and watching
  exactly one test fail.
- **`TODO.md` listed a shipped behaviour among the fixes not taken.** Doubling
  our own formula guard on write is not an option to weigh: it already ships,
  and it cannot reach the bug described, which is a first read of a file
  meanwhile never wrote. The bug itself was re-verified and stays open.
- The design spec still carried the old two-app wording of the data-quality
  rule, which README and CLAUDE.md had already been fixed to share verbatim.

**Pass 4: the sentence that has now been wrong three times, and four
canonicalisations nothing was holding**

- **The privacy sentence flipped a third time, and this time it contradicted
  itself.** Pass 3's rewrite opened "nothing else on this page reaches another
  server" and then, one clause later, named the analytics tag as something it
  fetches. Both halves cannot be true, and it is the absolute that is false:
  `make build` puts a googletagmanager.com script in `dist/index.html`, and
  the published site is the only place a manifest someone sent you is ever
  read. The panel now says what waits for your click and what does not,
  without an absolute to walk back. **The component had no test at all** —
  which is why one sentence could be wrong three passes running — so it has
  one now, asserting the substance that keeps breaking rather than the
  wording: that it draws nothing when there IS a track, that no Strava iframe
  is fetched before the click, and that the copy accounts for the analytics
  tag instead of denying it.
- **Four more invariants nothing was holding, all in the same function.**
  Pass 2's preserved-row fingerprint canonicalises four things, each called
  load-bearing in its own docstring, and only one was pinned. Removing any of
  the other three — the column-order sort, NFC on a cell, NFC on a column name
  — or the blank-header skip cloned a preserved row 1 → 2 with the entire
  suite green: the unbounded merge growth 0.3.0 and pass 2 each fixed once,
  reachable from a column drag, a hand-typed accent, or a stray comma. Each
  now has a test, and each was proved by making the mutation and watching
  exactly that one test fail. A docstring calling a line load-bearing is not
  the same as a test pinning it.
- **The tile claim was still wrong for a note-only folder.** Four places said
  tiles reach Feed and Swimlanes "as soon as anything is placed on the
  timeline". A note is placed on the timeline; the tabs need a placed
  *photograph*. One place — the README — had it right, and the other four now
  say what it says.
- The data repository quoted a parser output that had changed under it,
  dropping exactly the "the row is kept" reassurance pass 1 added — so the
  prose around it read as silent loss.

**Pass 5: the guards, taken at their word and then tested**

The first pass run under the new rule, and it found the README making a
promise the tooling does not keep plus three guards that could be walked
past.

- **The README told a non-JS reader that `package.json` "enforces" the Node
  floor. It does not.** npm's `engines` field is advisory: on Node v25.8.2
  with the floor set to `>=99.0.0`, `npm install` prints `npm warn
  EBADENGINE` and then installs, exit 0. Nothing anywhere checked the running
  version, so the promised stop never came and `make inspect` failed later
  with `Unknown file extension ".ts"` instead. The README now says npm only
  warns, and the check sits where the requirement actually is: `make inspect`
  runs `scripts/require-node.mjs` first and refuses in plain English.
  **`engine-strict=true` was measured and rejected** — it enforces every
  package's engines, not ours, and 19 installed packages declare ranges with
  gaps (`^20.19.0 || ^22.12.0 || >=24.0.0`), so a Node that clears this
  project's own floor would be refused an install by a transitive
  dependency's opinion. The 22.18 floor belongs to one optional command; the
  site builds and runs below it.
- **The copy guard on the privacy sentence was aimed at six words, not at the
  claim.** It required one of three nouns near one of three verbs, so a
  differently-worded falsehood — "no analytics or anything else is ever sent
  anywhere from this page" — passed all five tests in the file. It now tests
  the property instead: a clause may deny outbound contact only if it names
  what the denial is limited to, tiles or the local `make dev` build. Proved
  by putting that exact sentence back into the component and watching the
  guard fail.
- **The owner-quote checker only ever read `CLAUDE.md`.** `CHANGELOG.md`
  quotes a prompt for every release (24 citations), and `README.md`, `TODO.md`
  and `docs/` quote too — none of it checked. Widened to every tracked
  markdown file except `PROMPTS.md`, and it immediately found **an unsourced
  quotation in `TODO.md`**: the 12/24-hour clock deferral was written as a
  direct quote and attributed explicitly, and no prompt in the log contains
  it. Withdrawn to a paraphrase rather than tidying the log to fit. The 24
  `CHANGELOG.md` citations all check out. (Narrowing the scan to blockquotes
  that open with a quotation mark was tried, and rejected: measured across
  every file it silently drops a real citation that opens with an elision
  marker.)
- **The test-count check could be satisfied without being true, two ways.**
  It read `numPassedTests`, which excludes skipped tests — so `.skip` plus a
  decrement in `CLAUDE.md` passed while the coverage vanished. And it matched
  only the *first* `**N tests pass**`, so a second, stale copy could sit there
  forever. It now refuses any skipped or todo test outright, and requires
  exactly one such line.
- `package-lock.json` said `0.1.0` while `package.json` said `0.3.0`, three
  releases stale, because npm only rewrites it on install. `make release`
  checks both copies of the version in the lockfile now.
- The README's `make inspect` sample was hand-written and omitted the header
  row, the rule and the summary the real command prints. Replaced with real
  output.

## 0.3.0 — 2026-07-30 — hardened before it carries anything irreversible

### Security: a file from someone else was the way in

> "can you dispatch some secutiry and privacy independent subagents to review?"

Four independent reviews, run before any real notes existed. The trust
boundary here is not a network attacker — there is no server and no account —
it is that **people email each other CSV files**. Everything below was
reproduced by execution, not theorised.

- **A person's name could run script.** The map labelled each photo dot by
  handing Leaflet a string, which it assigns with `innerHTML` — so a name of
  `<img src=x onerror=…>` executed, in a page holding handles to your entire
  photo folder. Names now go in as text nodes.
- **One row in someone's file could silently delete your note.** Note ids
  aren't secret, so a `deleted=1` row naming yours erased it with no warning,
  and the next Save wrote the tombstone over the text. Deletion still
  propagates — that is the point of it — but it now says which file deleted
  what, and quotes the note it removed.
- **A `manifest.json` in any subfolder replaced your event.** A contributor
  zipping their own working folder in could swap the title, timezone, crop,
  course and roster, including a clock offset that moves every photograph.
  The one closest to the top now wins, and anything ignored is named.
- **A spreadsheet formula could hide in an unknown column.** The guard missed
  a leading tab or carriage return, which Excel strips before evaluating.
- **A copied row cloned itself on every merge** — 2, 3, 4, 5, 6 notes over
  five rounds. Now stable at 2.
- **A malformed track could freeze the tab.** An unclosed tag made the parser
  quadratic: 3 seconds on a 100KB file, minutes on a megabyte. Now 4ms.
- Coordinates off the planet are refused rather than plotted.

Verified clean, so it is on record: **nothing sensitive has ever been in
either repository** — every object, reachable and unreachable, in both — and
no photograph, its EXIF, its GPS or its bytes can reach the network, because
no network call exists in the kernel at all.

### Analytics learns the view, and nothing else

> "i don't think i need view-usage. maybe the only tab info that is useful is
> which view are people looking at, but i don't need to track time/people
> information at all."

The app's URL fragment carries a photo-derived timestamp and the ids of
whichever people are shown or hidden — the whole point of "any moment is a
shareable link" — and it must never reach Google. Two mechanisms would have
sent it there: GA4's default `page_location` is `location.href` (fragment
included), and `useAppState` calls `history.replaceState` on every cursor
change, which GA4's "enhanced measurement" listens for.

`googleAnalytics()` in `vite.config.ts` now sets `send_page_view: false` and
sends exactly one `page_view` itself, addressed at `location.origin +
location.pathname` — no fragment, by construction. A new
`src/viewer/analytics.ts#trackView` is the only other thing the app tells
Google: one `view_change` event, `{ view }` only, fired from `App.tsx` on a
genuine view change and never on a cursor scrub or a lane toggle. `make dev`
still sends nothing at all.

**This does not fully close the gap.** GA4's enhanced measurement can fire
its own automatic `page_view` on `replaceState` independent of
`send_page_view`, reading the live URL — fragment included — at that moment.
No code change reaches that; it is a per-stream toggle in the GA4 console —
recorded in `TODO.md`. See CLAUDE.md's "Analytics learns the view, and
nothing else" and its "Verified external constraints" table, and `TODO.md`'s
deploy-and-process section for the action item.

6 new tests, each verified by breaking the production code and confirming
the corresponding test failed before restoring it.

### The CSV format, hardened before it carries anything irreversible

> "yes we should write the tz, sometimes we can infer it from the gps of the
> photo, but we should be able to either infer the tz and allow user to
> modify if needed. we should use a standard tz format and provide links for
> users to easily search/find the tz to use. i'm okay with using UTC offsets"

> "you're right, the merge model will make it hard, so let's just go with the
> data version column value"

The owner created a private repo to hold one race's written record
permanently. Four reviewers examined `notes*.csv` and `people.csv` first,
because once real notes are committed every choice becomes a migration
carried forever. Nothing here changes what the files are for; it changes what
they can no longer lose.

**Both files carry a per-row `schema` version, and the check that reads it.**
Blank means "the version this reader knows", so a hand-added row needs
nothing typed; a row from a newer build is refused by name instead of being
half-understood. Per row rather than per file because these files merge by
row-bind — a row from someone's older copy lands among newer rows and has to
carry its own version.

**`people.csv` keeps columns it does not understand**, which `notes*.csv`
already did. A roster carrying `pronouns` lost it on the next save; a build
without this fix would have deleted the `schema` column itself.

**Every note now records its timezone AND its UTC offset.** `tz` used to be
blanked whenever it matched the event, which looked free and was not: change
the event's timezone afterwards and every note silently moved while the
photographs beside them stayed put, with nothing on the row to say what was
meant. The offset — plain integer minutes, `-360` — is what tells the two
01:30s of a fall-back night apart, which a zone name alone cannot do. The
event's own zone is now guessed from the offsets the photographs themselves
recorded rather than from the browser's clock, and the Timezone field says
which one it landed on with a link to look one up.

**Impossible dates are refused rather than quietly corrected.** `month` 13,
`day` 32, `hour` 24, a year of `26`, a minute of `45.7` — a drag-fill or a
slip of the finger produces all of these, every one was silently accepted,
and every one then rewrote itself on the next save, so the file stopped
saying what its author typed and nothing reported it.

**A deleted note stays in the file, marked deleted.** Deleting one used to
remove it from memory and nowhere else, so anybody else's older copy brought
it back on the next merge with nothing recording that the removal was
deliberate. Every deletion made before this column existed is unrecorded
forever, which is why it landed now rather than later.

**Notes record when they were written**, not only when the thing happened —
"at the time" versus "remembered two years later" is the difference between a
log and a memoir, and it cannot be reconstructed afterwards.

Two joins that silently failed now hold: names written in different Unicode
normalisation forms match (`José` and `José` are visually identical and were
not equal), and merging a saved copy of `notes.csv` with a pristine one no
longer grows the note count — it used to, measured at 2 → 3 → 4 → 5 → 6 over
five rounds before this fix; the same merge now holds at 2 every round.
Minted ids never end in a digit, because a spreadsheet's fill handle
increments a trailing number when a row is dragged.

Migration is pinned to a frozen copy of both files as they were written
before any of this, asserted to produce the same instants, ids and text —
then to repair themselves into the new shape on the first save without losing
a thing.

### `EVENT.md` — a per-copy pointer to where an event's data lives

> "let's create a separate file that the readme and claude reads that points
> to the git backed repo. this way you have the context of where this current
> project's git repo is, but it's not fully baked into the context if other
> people want to use it"

meanwhile is a renderer and holds no event of its own, but one person's copy
needs to remember which event they are on and where its written record is
kept — the data repo's URL, the local photo folder, clock offsets worked out
by hand. Putting that in `README.md` or `CLAUDE.md` directly would bake one
owner's private data repo into the app everyone else clones.

`EVENT.md` is gitignored and holds the real answers; `EVENT.example.md` is the
committed template everyone else starts from. Nothing about the app depends on
either file — absent, the app has no idea it exists, and you just open a
folder as usual.

### A rename can no longer corrupt the record

> "i need a way (possibly in the site interface itself) to connect the notes
> and people datasets, where the author in notes is the new display alias
> for the name in people. [...] i am essentially asking for a non
> destructive way to rename people ids that are displayed. assume in the
> future i might have multiple of the same device so we need to maeksure the
> id in people are unique so the rename can happen with a join or something"

An independent format review, run before real data went into version control,
found the rename input firing once per KEYSTROKE. Renaming "Google Pixel 8
Pro" to "Priya" ran about nineteen renames, filling `also_known_as` with every
prefix along the way so that `G` and `P` resolved to that person — and
backspacing through empty wrote `""` into the note's people list, after which
a guard in the rename itself meant it never healed. The note's link to that
person was destroyed permanently, on the most ordinary interaction there is.

A rename is now a committed action (blur or Enter, Escape reverts) and is
total or refused — refused on a blank name, on a `;` (the list delimiter,
which has no escape), and on a name another person already claims. That last
case was its own silent corruption: renaming Alice to "Bob" produced two
people called Bob, and "Bob" then resolved to neither, orphaning both notes
including the one that never involved Alice.

`notes*.csv` refers to people by name, not id, so renaming a lane from a
device slug ("Google Pixel 8 Pro") to a person ("Priya") used to orphan every
note already written under the old name too. `people.csv` gains a fifth
column, `also_known_as`; renaming now pushes the OLD name onto it and
rewrites every already-loaded note to the new name, and `resolvePersonNames`
matches a note's `people`/`author` against a person's current name OR any
recorded alias — so an untouched crew member's copy of `notes.csv`, or a note
nobody has re-saved yet, keeps resolving after a rename. Display everywhere
now falls back `name` → first alias → the device-slug prettifier, in one
function, rather than showing blank for a hand-added roster row that only has
an alias.

The two collisions are handled differently, deliberately, because they are not
the same failure: claiming a name someone else already has is refused outright
(above); but a rename whose OLD name is itself already claimed by someone
else still proceeds — the id gets its new name — while skipping the alias and
the note rewrite, rather than guessing which of the two people a note under
that shared old name actually meant. That mirrors the project's existing rule
for an ambiguous photo-caption match.

Broken joins are now loud rather than silent: unresolved note names are
reported at ingest and drawn in the event-level row, and a `photo` matching no
file at all is reported, not just an ambiguous one. Aliases are cleaned on
read, write and rename, so the column cannot grow without bound.

## 0.2.0 — 2026-07-30 — notes in CSV, an audited codebase, and a live site

Everything below shipped between 0.1.0 and this release. The headline is that
notes and the people roster moved out of `manifest.json` into spreadsheet-
editable CSV, that the whole codebase went through six passes of
documentation and comment auditing, and that the site now deploys to GitHub
Pages.

### The site goes live, and is measured

> "i think we should also be pushing these up to github, with releases, tags,
> and changelogs updates. i want to be able to test this on github actions +
> github pages."

Published to GitHub Pages from `main`. The deployed page loads Google
Analytics; `make dev` does not, because local mode reads private photographs
off your own disk and the promise that nothing leaves the machine has to keep
meaning something for the person it protects. The README and CLAUDE.md now
enumerate every external request the page makes rather than claiming there
are none.

### Notes now appear in the swimlanes

> "what i did notice is when i create a note i do not see it in the swimlane"

`Swimlanes.tsx` had no reference to notes at all — CLAUDE.md had described
this as built since M9 ("`person` is optional and does real work... the note
sits in that person's lane"), and the six-pass documentation audit below
still missed it, because the claim had no code near it to contradict.

- A note whose `people` list is non-empty now draws in EACH of those
  people's lanes, at its time, in that person's own lane colour — so it can
  actually explain a gap, e.g. "asleep at Cottonwood" sitting in the
  six-hour hole it names.
- A note with nobody named (or nobody the roster recognises) is
  event-level: its own row, pinned above every person lane, coloured with
  the palette's existing neutral rather than an invented ninth hue.
- A note with a `duration` draws as a span, not a point.
- The row is omitted entirely when a folder has no notes.
- A caption (`note.photo` set) is excluded the same way `Feed`'s caller
  already excludes it, so it does not appear a second time as a lane mark.
- Clicking a note mark moves the shared cursor to the note's own time, not
  the pixel clicked.

### A documentation audit, looped six times — and the bugs it turned up

> "I want you to take another thorough pass-through all of the comments and the
> documentation. you now assume the comments and the functions that it is
> commenting sync up. I want you to review the comments and confirm that the
> code does what the comment is saying. same with the larger pieces of
> documentation. I want you to keep looping through this process until you find
> no more discrepancies in the documentation and comments"

About 145 inaccuracies fixed across comments, prose, test names and
user-facing strings. Most were stale claims, but a comment is a claim about
behaviour, so checking them turned up real defects — these are the ones that
change what the app does:

- **Escape no longer unpins the moment strip while the lightbox is open.** It
  closed the lightbox *and* released the pin, undoing the pin you had just set
  so the strip would hold still while you reached for a photo. Escape had also
  never worked at all: the handler sat on a `role="presentation"` element that
  could not receive focus.
- **The feed no longer hides a note when no photograph shares its window.**
  Notes were filtered by time but the empty-state check counted only media, so
  a note alone in the window was discarded — the one failure this project
  treats as worth spending UI on.
- **Five CSS custom properties were used in fourteen places and defined
  nowhere**, silently collapsing `border-radius` to zero and dropping the notes
  panel's margin entirely.
- **Six labels moved off the faintest text colour.** At 3.98:1 it fails WCAG AA
  for body text, and the token's own rule said it was never for text a reader
  needs — including the "nothing" label in the moment strip and the explanation
  shown on a photo the browser cannot decode.
- **The sticky course rail no longer tucks under the header**, which is now
  measured at runtime rather than assumed.
- **`notes.csv` and `people.csv` are git-ignored**, along with the zip that
  Save produces and every media extension ingest accepts. They hold names and
  prose, and `.gitignore`'s first line promises event data never reaches git.
  Nothing had been committed; the gap is closed.
- **`d3-time` is gone** — installed and justified in the dependency budget,
  imported nowhere.

The most consequential documentation fix has no user-visible effect and is the
reason for the rest: several comments still said GPS timestamps are
authoritative. They are not — GPS records the satellite fix, not the shutter,
lagging a median 11 seconds and up to 919, unevenly enough to scramble the
order of photographs taken moments apart. That correction cost 231 real files
to establish, and five surviving copies of the old claim were sitting where a
future session would read them first.

### Notes and the people roster move out of the manifest

> "i think it'll be better if notes were in a separate file. it'll be much
> easier to either edit in the site, or offline in a spreadsheet program [...]
> at this point i forgot what the manifest file is for, but i think most people
> will care the most about the notes"

Forgetting what the manifest was for was the diagnosis, not a lapse. Notes and
photo captions now live in `notes*.csv`; names, roles and clock offsets live
in `people.csv`. The manifest keeps everything derived — items, GPS,
`timeSource` — and stops carrying the small, irreplaceable slice a person
actually typed. A caption collapsed into a note whose `photo` column names the
item: one file, one editor, one merge. Saving now downloads one zip of
`notes.csv`, `people.csv` and `manifest.json`, built by a hand-rolled,
store-only ZIP writer — no dependency. A photo with a note now shows a small
chat glyph on its tile, which is the discoverability fix: a caption used to be
invisible until the lightbox was open.

### Safe from corruption in a spreadsheet

> "i want to make sure the underlying data is safe from corruption"

No format survives a spreadsheet except a plain integer — Excel rewrites
`2026-07-25` to `7/25/26` and `15:45` to a day fraction the moment the file is
saved. A note's timestamp is therefore five bare integers
(`year,month,day,hour,minute`), which look like nothing a spreadsheet
"corrects." A span is an ISO-8601 duration (`PT3H40M`) rather than an end
timestamp or a bare number of minutes, so the unit travels with the value and
a race crossing midnight needs no extra column. The composer still shows one
time box — the split is a property of the file, not the UI. Every cell that
could execute as a formula (`=`, `+`, `-`, `@`) is written with a guarding
apostrophe, and the file is written UTF-8 with a byte-order mark so Excel on
Windows does not mangle the apostrophes and emoji notes are full of.

### Merging needs no version control

> "i think it'll be okay if we end up making it look like 2 comments at the
> same time. that's okay. when we visualize it it'll show up one after the
> other."

`id` is opaque and stable; the timestamp is ordinary data, not an identity —
a spreadsheet reformats ISO dates on save, two people can write at the same
second, and retiming a note would otherwise look like a delete plus an
insert to anything trying to merge two files. So merging several people's
`notes*.csv` files is **row-bind, dedupe by id, sort by time**: no locking, no
conflict resolution, no merge UI. A blank `id` is minted on load; a duplicated
`id` — the signature of a copied row — gets one side re-minted. Two people
editing copies of the same note at once produce two notes at that instant,
shown one after the other, exactly as asked for.

### The composer writes exactly what the format defines

> "we should make sure that in the UI the note button is also matching this
> set of specs, so when it is used to create a note it is writing the corret
> information to the correct file."

> "i guess you can have multiple authors as well. i can imagine multiple
> people writing down an experience all at the same time."

`Whose` and the new `Written by` are both searchable multi-selects, backed by
the same `people`/`author` columns and the same parsing rule. A "you are…"
picker in the top bar — kept in the browser's local storage, never the
manifest, since it describes the laptop rather than the event — pre-fills
`Written by` on every new note without ever blocking one from being written.

### Fixed before merge

The whole-branch review found that the pieces, each correct alone, leaked data
where they met. Everything below was caught by review or by end-to-end testing
rather than by the suite, and each now has a test.

- **"Add files" destroyed every note and caption written in the session.**
  The composer had been moved off the manifest, which silently disconnected the
  mechanism that carried notes across a re-ingest. A two-click path, advertised
  in the README, with nothing on disk yet to recover from.
- **Unknown CSV columns were dropped on save** — and because the merge
  fingerprint includes them, the note then *duplicated* on the next load.
- **A person in `people.csv` who owned no media was silently deleted from it**,
  which is what adding a crew member to the roster looks like.
- **An invalid `role` corrupted `manifest.json`** so it failed its own
  validator, losing the crop, the course reference, markers and every
  hand-placed time on the next open.
- **A hand-typed row with a blank `id` had no stable identity across reads**,
  which produced three separate bugs — a duplicate on "Add files", a deleted
  note resurrecting, and an edited-then-deleted note resurrecting. Fixed at the
  cause with a session-scoped row-to-id map rather than a fourth patch.
- **Notes could be invisible on load**, because the default time window was
  computed from photo clusters and ignored notes entirely.

## 0.1.0 — 2026-07-29 — first working viewer

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

> "sometimes as the runner, you rememer moments from the elevation / course.
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

### Getting the interface out of the way

> "after i upload 200+ images all the things on the bottom of the site are
> really hard to notice"

Structural, not cosmetic: the feed is unbounded, and the export button, people
list, unplaced tray and note composer all rendered *after* it. Things are now
placed by how often they are used — a sticky top bar for what must always be
reachable, the note composer floating within reach of whatever you are
reading, and the reference material collapsed above the views.

> "the click on the swim lane is a toggle"

Hovering the lanes previews a moment; clicking pins it so the strip holds
still while you reach for a photograph, and clicking again lets go. The wheel
zooms the time window. The moment strip is a fixed height, because tiles that
wrapped made the page bounce as you scrubbed — including the photographs you
were reaching for.

> "loop through the site to make sure everythign is consistant and no
> conflicts"

One action, one name, one control. "Save manifest" and "Export manifest.json"
were the same thing twice; the verb now carries the meaning, so *Open* always
replaces and *Add* always merges. Stacking became a named scale after the note
dock was found floating over the lightbox.

### Getting it back

Export `manifest.json`, drop it back in the folder next time, and names, roles,
captions, the crop and hand-placed times all return. Automatic timestamps are
always re-read from the files, because those are facts about the bytes.
