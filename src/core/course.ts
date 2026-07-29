/**
 * The course spine: the runner's track, and everything derived from it.
 *
 * Given a GPX or TCX export, this maps freely between time, distance,
 * elevation and position — which is what unlocks the elevation backdrop, the
 * distance axis, the map, and automatic clock alignment. It is the highest
 * -value optional thing in the project.
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
   * profile, distance — while position-at-time, pace, and automatic clock
   * alignment are simply impossible.
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

/** Element bodies for a tag, ignoring any namespace prefix. */
function* elements(xml: string, tag: string): Generator<string> {
  // Both `<trkpt ...>...</trkpt>` and the self-closing form appear in real
  // files, and every tag may carry a prefix like `gpxtpx:`.
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b([^>]*?)(/?)>`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const attrs = match[1] ?? '';
    if (match[2] === '/') {
      yield `${attrs}>`;
      continue;
    }
    const closeRe = new RegExp(`</(?:[\\w.-]+:)?${tag}\\s*>`, 'i');
    const rest = xml.slice(re.lastIndex);
    const close = closeRe.exec(rest);
    const body = close ? rest.slice(0, close.index) : rest;
    yield `${attrs}>${body}`;
    if (close) re.lastIndex += close.index + close[0].length;
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
  const raw = xml.includes('<Trackpoint') || xml.includes(':Trackpoint')
    ? parseTcx(xml)
    : parseGpx(xml);
  return raw.length >= 2 ? build(raw) : null;
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

function parseGpx(xml: string): RawSample[] {
  const out: RawSample[] = [];
  for (const point of elements(xml, 'trkpt')) {
    const lat = attr(point, 'lat');
    const lon = attr(point, 'lon');
    // Time is optional here, and its absence is a whole supported mode rather
    // than a broken file — see `Course.timed`.
    const at = instant(point, 'time');
    if (lat === undefined || lon === undefined) continue;

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
  return out;
}

function parseTcx(xml: string): RawSample[] {
  const out: RawSample[] = [];
  for (const point of elements(xml, 'Trackpoint')) {
    const at = instant(point, 'Time');
    const lat = num(point, 'LatitudeDegrees');
    const lon = num(point, 'LongitudeDegrees');
    if (at === undefined || lat === undefined || lon === undefined) continue;

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

function build(raw: RawSample[]): Course {
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
  };
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Index of the last sample at or before `value`, by binary search.
 *
 * Only ever called with `'at'` on a timed course, so the non-null assertions
 * on that key hold — `atTime` refuses an untimed course before reaching here.
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
 * Metres along the course at the track point nearest a position.
 *
 * This is what links the map to the elevation profile: point at somewhere on
 * the course and this says how far into the race that is, which is the one
 * quantity both views understand — an untimed track has no clock to share.
 *
 * Squared degrees rather than haversine, because only the ORDERING matters
 * here and this runs on every mouse move. Over a race-sized area the two rank
 * candidates identically; longitude degrees being shorter than latitude ones
 * would only matter for a track spanning a continent.
 *
 * Give it the SIMPLIFIED track. Scanning 120k points per pointer move is
 * wasted work for an answer that moves by less than a pixel.
 */
export function nearestDistance(
  samples: readonly Sample[],
  lat: number,
  lon: number,
): number | null {
  let best: number | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const sample of samples) {
    const gap = (sample.lat - lat) ** 2 + (sample.lon - lon) ** 2;
    if (gap < bestGap) {
      bestGap = gap;
      best = sample.distance;
    }
  }
  return best;
}
