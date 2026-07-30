/**
 * The course spine: the runner's track, and everything derived from it.
 *
 * Given a GPX or TCX export, this maps freely between time, distance,
 * elevation and position — which is what unlocks the elevation backdrop, the
 * distance axis, and the map. It is the highest-value optional thing in the
 * project. (Automatic clock alignment would also read off this mapping, but
 * is not built — see CLAUDE.md's decision record. `clockOffset` today is
 * entered by hand, in `people.csv`.)
 *
 * TWO FORMATS, ON PURPOSE. A **GPX carries no heart rate and no cadence** —
 * per Strava's own documentation it has GPS, elevation, time, and power only
 * from a real power meter. **TCX has heart rate, cadence and watts.** Both
 * are XML, so supporting both costs nothing but this file. (The binary FIT
 * would cost a dependency, which is why it stays deferred.)
 *
 * Pace and grade are in NEITHER format. They are not stored anywhere; they
 * are worked out from distance and time, which is done here.
 *
 * `DOMParser` is a browser global and this file must also run under Node, so
 * the XML is scanned by hand. GPX and TCX are regular enough that this is
 * about eighty lines rather than a parser — and it is why a future ingest CLI
 * gets track parsing for free.
 */

import type { Instant } from './time.ts';

export interface Sample {
  /**
   * When the runner was here. **Absent on an untimed track** — see `timed`.
   */
  at?: Instant;
  lat: number;
  lon: number;
  /** Metres above sea level. */
  ele?: number;
  /** Metres from the start, along the track. */
  distance: number;
  /** Beats per minute. TCX only. */
  hr?: number;
  /** Steps or revolutions per minute. TCX only. */
  cadence?: number;
}

export interface Course {
  samples: Sample[];
  /** Total distance in metres. */
  length: number;
  /**
   * Whether the track carries timestamps.
   *
   * **A GPX may have none at all**, and Strava's export is a live example: it
   * writes 120k points of lat/lon/ele and not one `<time>`. That is a course,
   * not a run. Everything spatial still works — the map, the elevation
   * profile, distance — while position-at-time and pace are simply
   * impossible. (Automatic clock alignment would need this too, once it
   * exists — see the module doc above. It is not built yet either way.)
   *
   * The tempting fix is to spread the field's known start and finish times
   * evenly over the points. Do not: a hundred-miler's pace varies by a factor
   * of five between the first climb and the small hours, so the marker would
   * be confidently, invisibly wrong for most of the race. A missing feature is
   * honest; a fabricated one corrupts the thing this app exists to show.
   */
  timed: boolean;
  /** Null on an untimed track. */
  from: Instant | null;
  to: Instant | null;
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  /** Which optional series this track actually carries. */
  has: { elevation: boolean; hr: boolean; cadence: boolean };
  /** Cumulative ascent in metres, smoothed to ignore GPS jitter. */
  ascent: number;
  /**
   * What was wrong with the file, in plain words — an element it never closes,
   * a coordinate off the planet.
   *
   * Empty for every well-formed track, which is nearly all of them. The
   * alternative to reporting is what this used to do: plot the bad point
   * anyway (a `lat="999999"` blew the map bounds out to the whole world) or
   * grind through a malformed file for minutes. Surfaced by `ingestFolder`
   * into the ingest report alongside the notes and roster problems.
   */
  problems: string[];
}

export interface CoursePoint {
  /** Absent on an untimed track. */
  at?: Instant;
  lat: number;
  lon: number;
  distance: number;
  ele?: number;
  hr?: number;
  cadence?: number;
  /** Seconds per kilometre. Derived, never stored in the file. */
  pace?: number;
  /** Rise over run as a percentage. Derived. */
  grade?: number;
}

// ---------------------------------------------------------------------------
// A very small XML scanner
// ---------------------------------------------------------------------------

/**
 * Element bodies for a tag, ignoring any namespace prefix.
 *
 * **An element's body never runs past the next opening tag of the same name,
 * and the scan never restarts from the beginning.** Both halves of that are
 * the fix for a quadratic hang found by a security review: an unclosed
 * `<trkpt>` used to be handed the ENTIRE REST OF THE FILE as its body, which
 * was then regex-scanned for `<ele>`, `<hr>` and `<cad>` — none of which are
 * there, so each scan runs to the end. Measured before the fix on a 101 KB
 * file of unclosed tags: 2,000 points took 3.0 seconds, and ~1 MB would have
 * frozen the tab for minutes. `parseCourse` runs synchronously during ingest,
 * so there is no way out of it but closing the tab.
 *
 * Nothing legitimate is lost. `<trkpt>` and `<Trackpoint>` cannot nest, so the
 * next opening tag is a hard ceiling on where the current element can end; a
 * well-formed file always closes before it, and this changes nothing for one.
 * A malformed element still yields whatever it did contain — the point is to
 * bound the work, not to throw the file away — and `parseCourse` reports it.
 *
 * `closeRe` is a single global regex whose `lastIndex` only ever moves
 * forward, so finding the closing tags costs one pass over the file in total
 * rather than one pass per element.
 */
function* elements(
  xml: string,
  tag: string,
  problems?: string[],
): Generator<string> {
  // Both `<trkpt ...>...</trkpt>` and the self-closing form appear in real
  // files, and every tag may carry a prefix like `gpxtpx:`.
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b([^>]*?)(/?)>`, 'gi');
  const closeRe = new RegExp(`</(?:[\\w.-]+:)?${tag}\\s*>`, 'gi');
  let unclosed = 0;
  // Once `closeRe` has run off the end, there is no closing tag left anywhere
  // after it, so asking again would rescan the whole remaining file for
  // nothing — which on a file with NO closing tags at all is quadratic all on
  // its own. Measured: without this flag, 4,000 unclosed tags still took 259
  // ms and doubling still quadrupled it.
  let noMoreCloses = false;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const attrs = match[1] ?? '';
    if (match[2] === '/') {
      yield `${attrs}>`;
      continue;
    }
    const bodyStart = re.lastIndex;

    // Where the next element of this kind begins — the ceiling on this one.
    // Peeking costs a second pass over the gap and no more, because `re` is
    // restored and re-scans only from `bodyStart`.
    const saved = re.lastIndex;
    const peek = re.exec(xml);
    const ceiling = peek ? peek.index : xml.length;
    re.lastIndex = saved;

    if (closeRe.lastIndex < bodyStart) closeRe.lastIndex = bodyStart;
    const close = noMoreCloses ? null : closeRe.exec(xml);
    if (close === null) noMoreCloses = true;

    if (close && close.index <= ceiling) {
      yield `${attrs}>${xml.slice(bodyStart, close.index)}`;
      re.lastIndex = close.index + close[0].length;
      continue;
    }

    // Unclosed. Rewind `closeRe` so the tag it did find — which belongs to
    // some later element — is still available to that one.
    if (close) closeRe.lastIndex = close.index;
    unclosed++;
    yield `${attrs}>${xml.slice(bodyStart, ceiling)}`;
  }
  if (unclosed > 0 && problems) {
    problems.push(
      `${unclosed} <${tag}> ${unclosed === 1 ? 'element is' : 'elements are'} never closed, so ` +
        `${unclosed === 1 ? 'it was' : 'they were'} read only as far as the next <${tag}>. ` +
        'Re-export the track if anything looks wrong.',
    );
  }
}

/** Text of the first matching child tag, ignoring namespace prefixes. */
function text(source: string, tag: string): string | null {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([^<]*)<`, 'i');
  const match = re.exec(source);
  return match?.[1]?.trim() ?? null;
}

function num(source: string, tag: string): number | undefined {
  const value = text(source, tag);
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function attr(source: string, name: string): number | undefined {
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(source);
  if (!match?.[1]) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function instant(source: string, tag: string): Instant | undefined {
  const value = text(source, tag);
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parse a GPX or TCX track. Returns null if there is nothing usable in it. */
export function parseCourse(xml: string): Course | null {
  const problems: string[] = [];
  const raw = xml.includes('<Trackpoint') || xml.includes(':Trackpoint')
    ? parseTcx(xml, problems)
    : parseGpx(xml, problems);
  return raw.length >= 2 ? build(raw, problems) : null;
}

/**
 * Whether a coordinate is somewhere on Earth.
 *
 * `exif.ts` has range-checked its coordinates from the start; this file did
 * not, so `lat="999999"` was plotted — one bad point stretched the map's
 * bounds across the whole planet and dragged the distance total with it.
 * Rejecting the point and saying so is the same rule the rest of the project
 * follows: a visible gap beats a confident lie.
 */
function onEarth(lat: number, lon: number): boolean {
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/** One line about however many points had to be dropped, not one per point. */
function reportOffEarth(count: number, problems: string[]): void {
  if (count === 0) return;
  problems.push(
    `${count} ${count === 1 ? 'point is' : 'points are'} not on Earth — a latitude outside ` +
      '-90 to 90, or a longitude outside -180 to 180 — so ' +
      `${count === 1 ? 'it was' : 'they were'} left out of the course.`,
  );
}

interface RawSample {
  at?: Instant;
  lat: number;
  lon: number;
  ele?: number;
  hr?: number;
  cadence?: number;
  /** The device's own distance reading. TCX records it; GPX does not. */
  reported?: number;
}

function parseGpx(xml: string, problems: string[]): RawSample[] {
  const out: RawSample[] = [];
  let offEarth = 0;
  for (const point of elements(xml, 'trkpt', problems)) {
    const lat = attr(point, 'lat');
    const lon = attr(point, 'lon');
    // Time is optional here, and its absence is a whole supported mode rather
    // than a broken file — see `Course.timed`.
    const at = instant(point, 'time');
    if (lat === undefined || lon === undefined) continue;
    if (!onEarth(lat, lon)) {
      offEarth++;
      continue;
    }

    const sample: RawSample = { lat, lon };
    if (at !== undefined) sample.at = at;
    const ele = num(point, 'ele');
    if (ele !== undefined) sample.ele = ele;
    // Garmin's TrackPointExtension, which Strava does NOT write on export but
    // Garmin Connect and many other tools do. Free to support since we are
    // already here.
    const hr = num(point, 'hr');
    if (hr !== undefined) sample.hr = hr;
    const cadence = num(point, 'cad');
    if (cadence !== undefined) sample.cadence = cadence;
    out.push(sample);
  }
  reportOffEarth(offEarth, problems);
  return out;
}

function parseTcx(xml: string, problems: string[]): RawSample[] {
  const out: RawSample[] = [];
  let offEarth = 0;
  for (const point of elements(xml, 'Trackpoint', problems)) {
    const at = instant(point, 'Time');
    const lat = num(point, 'LatitudeDegrees');
    const lon = num(point, 'LongitudeDegrees');
    if (at === undefined || lat === undefined || lon === undefined) continue;
    if (!onEarth(lat, lon)) {
      offEarth++;
      continue;
    }

    const sample: RawSample = { at, lat, lon };
    const ele = num(point, 'AltitudeMeters');
    if (ele !== undefined) sample.ele = ele;
    // <HeartRateBpm><Value>145</Value></HeartRateBpm> — the number is on the
    // inner tag, so `Value` is what to read.
    const hr = num(point, 'Value');
    if (hr !== undefined) sample.hr = hr;
    // Plain <Cadence> is cycling; running watches use <RunCadence> in the
    // activity extension. Either will do.
    const cadence = num(point, 'RunCadence') ?? num(point, 'Cadence');
    if (cadence !== undefined) sample.cadence = cadence;
    const reported = num(point, 'DistanceMeters');
    if (reported !== undefined) sample.reported = reported;
    out.push(sample);
  }
  reportOffEarth(offEarth, problems);
  return out;
}

// ---------------------------------------------------------------------------
// Deriving
// ---------------------------------------------------------------------------

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in metres. */
export function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Ignore elevation wobbles smaller than this when totalling ascent.
 *
 * A barometric altimeter drifts by a metre or two constantly. Summing every
 * rise unfiltered turns that noise into thousands of phantom feet of climb —
 * the classic way to report a flat run as mountainous.
 */
const ASCENT_THRESHOLD_M = 3;

/**
 * How much of a track must carry timestamps before it counts as a timed run.
 *
 * Well above any plausible dropout rate and well below "a route export with a
 * stray timestamp in it", so the two cases never get confused.
 */
const TIMED_FRACTION = 0.9;

function build(raw: RawSample[], problems: string[]): Course {
  // Is this a run, or just a route?
  //
  // A few missing times mean a GPS dropout mid-race: drop those points and
  // keep the time axis, since losing a handful of points from a 120k-point
  // track is invisible while losing time costs the runner marker, pace, and
  // clock alignment. Wholesale absence means a different KIND of file — a
  // course with no run attached — and there every point is worth keeping,
  // because geometry is all the file has.
  const withTime = raw.filter((s) => s.at !== undefined).length;
  const timed = raw.length > 0 && withTime >= raw.length * TIMED_FRACTION && withTime >= 2;
  if (timed) {
    raw = raw.filter((s) => s.at !== undefined);
    raw.sort((a, b) => (a.at as number) - (b.at as number));
  }
  // On an untimed track FILE ORDER IS THE ROUTE ORDER — the only ordering
  // there is, and the correct one. Sorting on a missing key would compare NaN
  // and scramble the course into noise.

  const samples: Sample[] = [];
  let distance = 0;
  let previous: RawSample | null = null;

  for (const point of raw) {
    if (previous) {
      // The watch's own distance beats recomputing it: it is smoothed and
      // accounts for GPS scatter that a naive point-to-point sum turns into
      // extra kilometres.
      distance =
        point.reported !== undefined && previous.reported !== undefined && point.reported >= previous.reported
          ? point.reported
          : distance + haversine(previous.lat, previous.lon, point.lat, point.lon);
    } else if (point.reported !== undefined) {
      distance = point.reported;
    }

    const sample: Sample = { lat: point.lat, lon: point.lon, distance };
    if (point.at !== undefined) sample.at = point.at;
    if (point.ele !== undefined) sample.ele = point.ele;
    if (point.hr !== undefined) sample.hr = point.hr;
    if (point.cadence !== undefined) sample.cadence = point.cadence;
    samples.push(sample);
    previous = point;
  }

  let ascent = 0;
  let reference: number | undefined;
  for (const sample of samples) {
    if (sample.ele === undefined) continue;
    if (reference === undefined) reference = sample.ele;
    const rise = sample.ele - reference;
    if (rise >= ASCENT_THRESHOLD_M) {
      ascent += rise;
      reference = sample.ele;
    } else if (rise <= -ASCENT_THRESHOLD_M) {
      reference = sample.ele;
    }
  }

  const first = samples[0] as Sample;
  const last = samples[samples.length - 1] as Sample;

  // Accumulated in one pass rather than with `Math.min(...array)`. A real
  // Strava export is 120,909 points, and spreading an array that long into a
  // call throws RangeError: every argument becomes a stack slot.
  const bounds = {
    minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity,
  };
  for (const s of samples) {
    if (s.lat < bounds.minLat) bounds.minLat = s.lat;
    if (s.lat > bounds.maxLat) bounds.maxLat = s.lat;
    if (s.lon < bounds.minLon) bounds.minLon = s.lon;
    if (s.lon > bounds.maxLon) bounds.maxLon = s.lon;
  }

  return {
    samples,
    length: last.distance,
    timed,
    from: timed ? (first.at as Instant) : null,
    to: timed ? (last.at as Instant) : null,
    bounds,
    has: {
      elevation: samples.some((s) => s.ele !== undefined),
      hr: samples.some((s) => s.hr !== undefined),
      cadence: samples.some((s) => s.cadence !== undefined),
    },
    ascent,
    problems,
  };
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Index of the last sample at or before `value`, by binary search.
 *
 * Called with `'at'` from `atTime`, which is only reachable on a timed
 * course (it refuses an untimed one before reaching here), so the non-null
 * assertions on that key hold there. Also called with `'distance'` from
 * `atDistance`, which has no such guard — distance is meaningful whether or
 * not the course is timed.
 */
function indexBefore(samples: readonly Sample[], value: number, key: 'at' | 'distance'): number {
  const keyOf = (i: number) => (samples[i] as Sample)[key] as number;
  let lo = 0;
  let hi = samples.length - 1;
  if (keyOf(0) >= value) return 0;
  if (keyOf(hi) <= value) return hi;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (keyOf(mid) <= value) lo = mid;
    else hi = mid;
  }
  return lo;
}

function interpolate(a: Sample, b: Sample, ratio: number): CoursePoint {
  const mix = (x?: number, y?: number) =>
    x === undefined || y === undefined ? (x ?? y) : x + (y - x) * ratio;

  const point: CoursePoint = {
    lat: a.lat + (b.lat - a.lat) * ratio,
    lon: a.lon + (b.lon - a.lon) * ratio,
    distance: a.distance + (b.distance - a.distance) * ratio,
  };
  if (a.at !== undefined && b.at !== undefined) point.at = a.at + (b.at - a.at) * ratio;
  const ele = mix(a.ele, b.ele);
  if (ele !== undefined) point.ele = ele;
  const hr = mix(a.hr, b.hr);
  if (hr !== undefined) point.hr = hr;
  const cadence = mix(a.cadence, b.cadence);
  if (cadence !== undefined) point.cadence = cadence;

  // Pace and grade come from the segment, not the point: an instantaneous
  // value at a single sample is meaningless. Pace additionally needs time, so
  // an untimed track yields grade and no pace.
  const metres = b.distance - a.distance;
  if (a.at !== undefined && b.at !== undefined) {
    const seconds = (b.at - a.at) / 1000;
    if (seconds > 0 && metres > 0.5) point.pace = (seconds / metres) * 1000;
  }
  if (metres > 0.5 && a.ele !== undefined && b.ele !== undefined) {
    point.grade = ((b.ele - a.ele) / metres) * 100;
  }
  return point;
}

/**
 * Where the runner was at a given moment. Null if outside the track, and
 * **always null on an untimed course** — there is no honest answer there.
 */
export function atTime(course: Course, at: Instant): CoursePoint | null {
  if (!course.timed || course.from === null || course.to === null) return null;
  if (course.samples.length === 0 || at < course.from || at > course.to) return null;
  const i = indexBefore(course.samples, at, 'at');
  const a = course.samples[i] as Sample;
  const b = course.samples[Math.min(i + 1, course.samples.length - 1)] as Sample;
  // Safe: `course.timed` means every sample carries a time.
  const aAt = a.at as Instant;
  const span = (b.at as Instant) - aAt;
  return interpolate(a, b, span > 0 ? (at - aAt) / span : 0);
}

/** Where the runner was at a given distance along the course. */
export function atDistance(course: Course, distance: number): CoursePoint | null {
  if (course.samples.length === 0 || distance < 0 || distance > course.length) return null;
  const i = indexBefore(course.samples, distance, 'distance');
  const a = course.samples[i] as Sample;
  const b = course.samples[Math.min(i + 1, course.samples.length - 1)] as Sample;
  const span = b.distance - a.distance;
  return interpolate(a, b, span > 0 ? (distance - a.distance) / span : 0);
}

// ---------------------------------------------------------------------------
// Simplification
// ---------------------------------------------------------------------------

/**
 * Thin a track down for DRAWING, keeping its shape.
 *
 * A real export is not a few thousand points. The owner's Strava GPX is
 * **120,909** — enough SVG path data to stall the tab, and pointless besides,
 * since the map is at most ~1500px across and the screen cannot resolve
 * anything finer than a few metres.
 *
 * Ramer–Douglas–Peucker rather than "keep every Nth point": uniform decimation
 * discards points by position in the file, so it rounds off exactly the tight
 * switchbacks that make a mountain course recognisable while wasting its
 * budget on the long straight road sections. RDP drops a point only when the
 * line would not visibly move without it, so the corners survive.
 *
 * **Never simplify before measuring.** Distance and ascent must come from the
 * full track — cutting corners literally shortens the course. Call this on the
 * way to a renderer and nowhere else.
 */
export function simplify(samples: readonly Sample[], toleranceM: number): Sample[] {
  if (samples.length <= 2 || toleranceM <= 0) return [...samples];

  // Work in metres on a local tangent plane so the tolerance is a real
  // distance. Over a race-sized area the error in this is far below the
  // tolerance itself.
  const lat0 = ((samples[0] as Sample).lat * Math.PI) / 180;
  const mPerDegLat = 111_132;
  const mPerDegLon = 111_320 * Math.cos(lat0);
  const x = (s: Sample) => s.lon * mPerDegLon;
  const y = (s: Sample) => s.lat * mPerDegLat;

  const keep = new Uint8Array(samples.length);
  keep[0] = 1;
  keep[samples.length - 1] = 1;

  // An explicit stack, not recursion: 120k points can nest deep enough to
  // overflow the call stack on a degenerate track.
  const stack: Array<[number, number]> = [[0, samples.length - 1]];
  const tolSq = toleranceM * toleranceM;

  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    if (last <= first + 1) continue;

    const ax = x(samples[first] as Sample);
    const ay = y(samples[first] as Sample);
    const bx = x(samples[last] as Sample);
    const by = y(samples[last] as Sample);
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    let worst = -1;
    let worstIndex = -1;
    for (let i = first + 1; i < last; i++) {
      const px = x(samples[i] as Sample);
      const py = y(samples[i] as Sample);
      let distSq: number;
      if (lenSq === 0) {
        distSq = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        // Distance to the SEGMENT, clamped — not to the infinite line. An
        // out-and-back doubles over itself, and the unclamped form would call
        // the far end of the return leg "close to" the outbound line.
        let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        distSq = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
      }
      if (distSq > worst) {
        worst = distSq;
        worstIndex = i;
      }
    }

    if (worst > tolSq && worstIndex > 0) {
      keep[worstIndex] = 1;
      stack.push([first, worstIndex], [worstIndex, last]);
    }
  }

  const out: Sample[] = [];
  for (let i = 0; i < samples.length; i++) if (keep[i] === 1) out.push(samples[i] as Sample);
  return out;
}

/**
 * The point on the course nearest a position, and how far off it is.
 *
 * Two jobs. It links the map to the profile — point anywhere on the course
 * and `distance` says how far into the race that is, the one quantity both
 * views understand. And it **places a PHOTO on the course from its own GPS**,
 * which is how a timeline of photographs can drive a map even when the track
 * carries no timestamps at all: the photo knows where it was taken, so no
 * interpolation is involved and nothing is invented.
 *
 * `metresAway` is what makes that safe. A photo shot at home, or at the
 * airport on the way there, is nearest to *some* point on the course, and
 * without the distance to reject it that photo would pin a marker to a
 * mountain the photographer never visited. Callers must threshold it.
 *
 * Candidates are ranked in scaled squared degrees — no trigonometry per
 * sample, which matters when this runs on every pointer move — and only the
 * winner is measured properly.
 *
 * Give it the SIMPLIFIED track: scanning 120k points for an answer that moves
 * by less than a pixel is wasted work.
 */
export function nearestPoint(
  samples: readonly Sample[],
  lat: number,
  lon: number,
): { distance: number; metresAway: number } | null {
  if (samples.length === 0) return null;
  // Longitude degrees are shorter than latitude ones away from the equator;
  // without this the ranking is stretched east-west and picks the wrong point.
  const scale = Math.cos((lat * Math.PI) / 180);
  let best: Sample | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const sample of samples) {
    const dLat = sample.lat - lat;
    const dLon = (sample.lon - lon) * scale;
    const gap = dLat * dLat + dLon * dLon;
    if (gap < bestGap) {
      bestGap = gap;
      best = sample;
    }
  }
  if (!best) return null;
  return { distance: best.distance, metresAway: haversine(lat, lon, best.lat, best.lon) };
}

/** Metres along the course at the track point nearest a position. */
export function nearestDistance(
  samples: readonly Sample[],
  lat: number,
  lon: number,
): number | null {
  return nearestPoint(samples, lat, lon)?.distance ?? null;
}

/**
 * How far off the course an item may be and still count as taken on it.
 *
 * Generous enough for GPS scatter, a switchback the simplified track cut, and
 * an aid station just off the trail; tight enough to reject the pub
 * afterwards.
 */
export const ON_COURSE_TOLERANCE_M = 750;

/** Where an item's position on the course came from. Surfaced, never hidden. */
export type AnchorSource = 'time' | 'gps';

export interface Anchor {
  /** Metres into the race. */
  distance: number;
  from: AnchorSource;
  /** How far the item's own GPS sat from the course. Only for `gps`. */
  metresAway?: number;
}

/**
 * Place items along the course, so a timeline of media can drive a map.
 *
 * **TIME FIRST, GPS ONLY AS A FALLBACK.** The order matters and is not
 * arbitrary:
 *
 * - **Every item has a timestamp** — that is the spine of this whole app —
 *   whereas GPS is patchy. Android videos routinely carry none, and an action
 *   camera strapped to a runner typically has no GPS receiver at all. Those
 *   are exactly the clips worth placing, and time places them.
 * - **A phone's GPS fix goes wrong in ways a clock does not.** A stale or
 *   scattered fix can land a photo on the wrong side of a ridge. Clock error
 *   is a constant offset, correctable once per device via `clockOffset`;
 *   GPS error is per-shot and not correctable at all.
 *
 * So when the track is timed, position-at-time answers for everything. GPS is
 * used only when the track has NO times — which is a real case, since a
 * Strava route export has none — and there it is a measurement rather than a
 * guess, which is what makes it acceptable at all.
 *
 * Items that can be placed neither way are absent from the result. An absent
 * anchor shows nothing; a wrong one points at a mountain nobody climbed.
 *
 * Disagreement between the two is not noise, it is signal: an item whose GPS
 * sits far from where the track says the runner was at that moment is
 * evidence of a clock offset, which is the basis of automatic alignment.
 */
export function anchorItems<
  T extends { id: string; gps?: readonly [number, number] },
>(
  items: readonly T[],
  course: Course,
  instants: ReadonlyMap<string, Instant>,
  samples: readonly Sample[] = course.samples,
  toleranceM: number = ON_COURSE_TOLERANCE_M,
): Map<string, Anchor> {
  const out = new Map<string, Anchor>();
  if (course.samples.length === 0) return out;

  for (const item of items) {
    if (course.timed) {
      const at = instants.get(item.id);
      if (at !== undefined) {
        const point = atTime(course, at);
        if (point) {
          out.set(item.id, { distance: point.distance, from: 'time' });
          continue;
        }
      }
      // Outside the track's own span — the runner was not out there yet, or
      // had finished. Fall through rather than clamping to an end.
    }

    if (!item.gps) continue;
    const near = nearestPoint(samples, item.gps[0], item.gps[1]);
    if (near && near.metresAway <= toleranceM) {
      out.set(item.id, { distance: near.distance, from: 'gps', metresAway: near.metresAway });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Estimating a time from where you were
// ---------------------------------------------------------------------------

/** A place on the course whose time is actually known, from a photograph. */
export interface TimeAnchor {
  distance: number;
  at: Instant;
}

export interface TimeEstimate {
  at: Instant;
  /** The two real observations it sits between. */
  before: TimeAnchor;
  after: TimeAnchor;
  /** Seconds between those two — how much slack the estimate has. */
  gapSeconds: number;
  /** True when more than one pass bracketed this distance. See below. */
  ambiguous: boolean;
}

/**
 * Guess when the runner was at a point on the course, from the photographs.
 *
 * **This is interpolation, which this project otherwise refuses** — so the
 * difference matters. The rejected case was spreading a race's start and
 * finish evenly across a whole hundred-miler: two observations, a hundred
 * miles apart, across a pace that varies several-fold. This case is bounded by
 * two REAL observations that are usually minutes apart, and it exists to
 * answer a question the owner actually has:
 *
 * > "sometimes as the runner, you remember moments from the elevation /
 * > course. especially if there are no photos in that area"
 *
 * Three rules keep it honest:
 *
 * 1. **It never extrapolates.** Outside the range the photographs cover it
 *    returns null rather than a guess, because beyond the last observation
 *    there is nothing to interpolate between.
 * 2. **It reports its own slack.** `gapSeconds` is the distance in time
 *    between the two anchors, which is the honest error bar. Callers show it.
 * 3. **It admits ambiguity.** Distance is NOT a function of time on an
 *    out-and-back or a lollipop — the runner passes mile 40 twice — so
 *    anchors are walked in TIME order and every bracketing pass is a
 *    candidate. `near` picks between them, and `ambiguous` says when there
 *    was a choice.
 *
 * Constant pace between the two anchors is assumed. Over the few minutes that
 * usually separate two photographs that is a small claim; over a long gap it
 * is not, which is exactly what `gapSeconds` is for.
 */
export function estimateInstant(
  anchors: readonly TimeAnchor[],
  distance: number,
  near?: Instant,
): TimeEstimate | null {
  if (anchors.length < 2) return null;
  const ordered = [...anchors].sort((a, b) => a.at - b.at);

  const candidates: TimeEstimate[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const before = ordered[i] as TimeAnchor;
    const after = ordered[i + 1] as TimeAnchor;
    const lo = Math.min(before.distance, after.distance);
    const hi = Math.max(before.distance, after.distance);
    if (distance < lo || distance > hi) continue;

    const span = after.distance - before.distance;
    // Two photographs from the same spot: no movement to interpolate over, so
    // the earlier of the two is the honest answer rather than a ratio of zero.
    const ratio = span === 0 ? 0 : (distance - before.distance) / span;
    candidates.push({
      at: before.at + (after.at - before.at) * ratio,
      before,
      after,
      gapSeconds: (after.at - before.at) / 1000,
      ambiguous: false,
    });
  }

  if (candidates.length === 0) return null;
  const ambiguous = candidates.length > 1;

  // With several passes, the one nearest whatever the reader is already
  // looking at is the one they mean.
  let best = candidates[0] as TimeEstimate;
  if (near !== undefined) {
    let bestGap = Math.abs(best.at - near);
    for (const candidate of candidates.slice(1)) {
      const gap = Math.abs(candidate.at - near);
      if (gap < bestGap) {
        bestGap = gap;
        best = candidate;
      }
    }
  }
  return { ...best, ambiguous };
}
