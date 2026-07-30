import { describe, expect, it } from 'vitest';
import {
  anchorItems,
  atDistance,
  atTime,
  haversine,
  nearestDistance,
  nearestPoint,
  parseCourse,
  simplify,
  estimateInstant,
  type Course,
  type CoursePoint,
  type Sample,
  type TimeAnchor,
  type TimeEstimate,
} from '../src/core/course.ts';

/**
 * Fixtures are shaped like the real exports, namespace prefixes and all,
 * because the prefixes are exactly what a naive tag match gets wrong.
 */

const T0 = Date.UTC(2026, 6, 24, 12, 0, 0);
const iso = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString();

function gpx(points: Array<{ lat: number; lon: number; t: number; ele?: number; hr?: number }>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="StravaGPX" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
 <trk><name>Morning Run</name><trkseg>
${points
  .map(
    (p) => `  <trkpt lat="${p.lat}" lon="${p.lon}">
   ${p.ele === undefined ? '' : `<ele>${p.ele}</ele>`}
   <time>${iso(p.t)}</time>
   ${
     p.hr === undefined
       ? ''
       : `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${p.hr}</gpxtpx:hr><gpxtpx:cad>84</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions>`
   }
  </trkpt>`,
  )
  .join('\n')}
 </trkseg></trk>
</gpx>`;
}

function tcx(
  points: Array<{ lat: number; lon: number; t: number; ele?: number; hr?: number; cad?: number; dist?: number }>,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
 <Activities><Activity Sport="Running"><Lap><Track>
${points
  .map(
    (p) => `  <Trackpoint>
   <Time>${iso(p.t)}</Time>
   <Position><LatitudeDegrees>${p.lat}</LatitudeDegrees><LongitudeDegrees>${p.lon}</LongitudeDegrees></Position>
   ${p.ele === undefined ? '' : `<AltitudeMeters>${p.ele}</AltitudeMeters>`}
   ${p.dist === undefined ? '' : `<DistanceMeters>${p.dist}</DistanceMeters>`}
   ${p.hr === undefined ? '' : `<HeartRateBpm><Value>${p.hr}</Value></HeartRateBpm>`}
   ${p.cad === undefined ? '' : `<Extensions><ns3:TPX><ns3:RunCadence>${p.cad}</ns3:RunCadence></ns3:TPX></Extensions>`}
  </Trackpoint>`,
  )
  .join('\n')}
 </Track></Lap></Activity></Activities>
</TrainingCenterDatabase>`;
}

const LINE = [
  { lat: 45.8, lon: -110.5, t: 0, ele: 1500 },
  { lat: 45.81, lon: -110.5, t: 600, ele: 1600 },
  { lat: 45.82, lon: -110.5, t: 1200, ele: 1550 },
];

describe('parsing a GPX', () => {
  it('reads position, elevation and time from a GPX track', () => {
    // Namespace-prefix stripping itself is exercised by the neighbor test
    // below ('does read heart rate when a Garmin extension carries it') —
    // this fixture (LINE, no `hr`) never emits a prefixed tag at all: trkpt,
    // ele and time are always written unprefixed by gpx(), matching how real
    // GPX writers use them (core elements live in the default namespace; only
    // the TrackPointExtension needs one).
    const course = parseCourse(gpx(LINE));
    expect(course).not.toBeNull();
    expect(course?.samples).toHaveLength(3);
    expect(course?.samples[0]?.lat).toBeCloseTo(45.8, 6);
    expect(course?.samples[0]?.ele).toBe(1500);
    expect(course?.from).toBe(T0);
    expect(course?.to).toBe(T0 + 1_200_000);
  });

  it('says plainly that a Strava GPX has no heart rate', () => {
    // The reason the README tells people to ask for a TCX instead.
    const course = parseCourse(gpx(LINE));
    expect(course?.has).toEqual({ elevation: true, hr: false, cadence: false });
  });

  it('does read heart rate when a Garmin extension carries it', () => {
    // Strava strips it on export, but Garmin Connect and most other tools
    // write gpxtpx:hr — free to support, since the parser is here anyway.
    const course = parseCourse(gpx(LINE.map((p) => ({ ...p, hr: 150 }))));
    expect(course?.has.hr).toBe(true);
    expect(course?.samples[0]?.hr).toBe(150);
  });

  it('computes distance from positions, since GPX does not record it', () => {
    const course = parseCourse(gpx(LINE));
    // A hundredth of a degree of latitude is about 1.11km.
    expect(course?.length).toBeGreaterThan(2000);
    expect(course?.length).toBeLessThan(2400);
  });
});

describe('parsing a TCX', () => {
  const RICH = LINE.map((p, i) => ({ ...p, hr: 140 + i * 5, cad: 80 + i, dist: i * 1000 }));

  it('reads the series a GPX cannot carry', () => {
    const course = parseCourse(tcx(RICH));
    expect(course?.has).toEqual({ elevation: true, hr: true, cadence: true });
    expect(course?.samples[1]?.hr).toBe(145);
    expect(course?.samples[1]?.cadence).toBe(81);
  });

  it("prefers the watch's own distance over recomputing it", () => {
    // The device's figure is smoothed; summing raw GPS points turns scatter
    // into kilometres that were never run.
    const course = parseCourse(tcx(RICH));
    expect(course?.length).toBe(2000);
  });

  it('falls back to computing distance when the file omits it', () => {
    const course = parseCourse(tcx(RICH.map(({ dist: _drop, ...rest }) => rest)));
    expect(course?.length).toBeGreaterThan(2000);
  });

  it('reads plain <Cadence> as well as the running extension', () => {
    const xml = tcx(RICH).replace(/<Extensions>[\s\S]*?<\/Extensions>/g, '<Cadence>77</Cadence>');
    expect(parseCourse(xml)?.samples[0]?.cadence).toBe(77);
  });
});

describe('rejecting what cannot be used', () => {
  it('returns null for a track with fewer than two points', () => {
    expect(parseCourse(gpx([LINE[0] as never]))).toBeNull();
  });

  it('returns null for something that is not a track at all', () => {
    expect(parseCourse('<html><body>not a track</body></html>')).toBeNull();
    expect(parseCourse('')).toBeNull();
  });

  it('never places a point with no time at the epoch', () => {
    const broken = gpx(LINE).replace(/<time>[^<]*<\/time>/, '');
    const course = parseCourse(broken) as Course;
    // Whichever way the timed/untimed call goes, 1970 must never appear: that
    // was the original bug, and it puts a photo an eternity from the race.
    for (const sample of course.samples) {
      if (sample.at !== undefined) expect(sample.at).toBeGreaterThan(Date.UTC(2000, 0, 1));
    }
  });
});

describe('a track with no timestamps at all', () => {
  // The shape of a real Strava GPX export: 120k points of lat/lon/ele, and not
  // one <time>. This is a course, not a run.
  const untimed = () =>
    `<?xml version="1.0"?><gpx creator="StravaGPX"><trk><name>Route</name><trkseg>${LINE.map(
      (p) => `<trkpt lat="${p.lat}" lon="${p.lon}"><ele>${p.ele}</ele></trkpt>`,
    ).join('')}</trkseg></trk></gpx>`;

  it('parses, rather than being rejected as broken', () => {
    const course = parseCourse(untimed());
    expect(course).not.toBeNull();
    expect((course as Course).samples).toHaveLength(LINE.length);
  });

  it('reports itself as untimed, with no from/to to mislead anyone', () => {
    const course = parseCourse(untimed()) as Course;
    expect(course.timed).toBe(false);
    expect(course.from).toBeNull();
    expect(course.to).toBeNull();
  });

  it('still measures distance and climb, which need no clock', () => {
    const course = parseCourse(untimed()) as Course;
    expect(course.length).toBeGreaterThan(0);
    expect(course.has.elevation).toBe(true);
  });

  it('refuses to invent a position at a time', () => {
    const course = parseCourse(untimed()) as Course;
    // The whole point: no fabricated marker. A wrong position is worse than
    // an absent one.
    expect(atTime(course, Date.UTC(2026, 6, 24, 12))).toBeNull();
  });

  it('still answers position by distance, which is what it does have', () => {
    const course = parseCourse(untimed()) as Course;
    const point = atDistance(course, course.length / 2);
    expect(point).not.toBeNull();
    expect((point as CoursePoint).at).toBeUndefined();
    expect((point as CoursePoint).lat).toBeGreaterThan(0);
  });

  it('keeps file order, since that is the route order', () => {
    const course = parseCourse(untimed()) as Course;
    expect(course.samples.map((s) => s.lat)).toEqual(LINE.map((p) => p.lat));
  });
});

describe('simplify', () => {
  it('drops points that do not change the line', () => {
    // A dead-straight run of points: everything between the ends is redundant.
    const straight: Sample[] = Array.from({ length: 50 }, (_, i) => ({
      lat: 45 + i * 0.0001,
      lon: -110,
      distance: i * 11.1,
    }));
    expect(simplify(straight, 5)).toHaveLength(2);
  });

  it('keeps a corner that a straight line would cut', () => {
    const corner: Sample[] = [
      { lat: 45, lon: -110, distance: 0 },
      { lat: 45.01, lon: -110, distance: 1113 },
      { lat: 45.01, lon: -110.01, distance: 1900 },
    ];
    expect(simplify(corner, 5)).toHaveLength(3);
  });

  it('keeps both ends, always', () => {
    const line: Sample[] = Array.from({ length: 20 }, (_, i) => ({
      lat: 45 + i * 0.00001,
      lon: -110,
      distance: i,
    }));
    const out = simplify(line, 100);
    expect(out[0]).toEqual(line[0]);
    expect(out[out.length - 1]).toEqual(line[line.length - 1]);
  });

  it('does not treat the far leg of an out-and-back as redundant', () => {
    // Distance to the SEGMENT, not the infinite line. `back` stops one step
    // short of the exact starting point (realistic — GPS noise means a real
    // out-and-back rarely closes to the metre), so the first and last samples
    // are numerically distinct and the top-level segment has nonzero length.
    // The turnaround sits almost exactly along that first-to-last line, so an
    // UNCLAMPED distance-to-the-infinite-line call finds it "close" and drops
    // it; only clamping the projection to the segment sees it for what it is:
    // ~2.1km off the endpoint.
    const there: Sample[] = Array.from({ length: 20 }, (_, i) => ({
      lat: 45 + i * 0.001, lon: -110, distance: i * 111,
    }));
    const back: Sample[] = Array.from({ length: 19 }, (_, i) => ({
      lat: 45.019 - i * 0.001, lon: -110, distance: 2109 + i * 111,
    }));
    const out = simplify([...there, ...back], 5);
    expect(out.length).toBeGreaterThanOrEqual(3);
    // The turnaround must survive, or the map shows a course half as long.
    expect(Math.max(...out.map((s) => s.lat))).toBeCloseTo(45.019, 3);
  });

  it('handles a track far larger than the call-stack argument limit', () => {
    // 120,909 points is the real file. Anything using Math.min(...array) or
    // recursion dies here.
    const huge: Sample[] = Array.from({ length: 120_909 }, (_, i) => ({
      lat: 45 + Math.sin(i / 500) * 0.05,
      lon: -110 + i * 0.000001,
      distance: i * 2,
    }));
    const out = simplify(huge, 8);
    expect(out.length).toBeGreaterThan(2);
    expect(out.length).toBeLessThan(huge.length / 10);
  });
});

describe('ascent', () => {
  it('ignores altimeter wobble', () => {
    // A barometric altimeter drifts a metre or two constantly. Summing every
    // rise turns that noise into thousands of phantom feet of climb.
    const jittery = Array.from({ length: 200 }, (_, i) => ({
      lat: 45.8 + i * 0.0001,
      lon: -110.5,
      t: i * 10,
      ele: 1500 + (i % 2 === 0 ? 1 : -1),
    }));
    expect(parseCourse(gpx(jittery))?.ascent).toBe(0);
  });

  it('counts a real climb', () => {
    const climb = Array.from({ length: 100 }, (_, i) => ({
      lat: 45.8 + i * 0.0001,
      lon: -110.5,
      t: i * 10,
      ele: 1500 + i * 10,
    }));
    expect(parseCourse(gpx(climb))?.ascent).toBeCloseTo(990, -1);
  });
});

describe('looking up a moment', () => {
  const course = parseCourse(tcx(LINE.map((p, i) => ({ ...p, hr: 140 + i * 10, dist: i * 1000 }))));

  it('interpolates between samples', () => {
    // Halfway between the first two points in time.
    const point = atTime(course as never, T0 + 300_000);
    expect(point?.distance).toBeCloseTo(500, 0);
    expect(point?.ele).toBeCloseTo(1550, 0);
    expect(point?.hr).toBeCloseTo(145, 0);
  });

  it('derives pace and grade, which no file stores', () => {
    const point = atTime(course as never, T0 + 300_000);
    // 1000m in 600s is 600 s/km.
    expect(point?.pace).toBeCloseTo(600, 0);
    // 100m up over 1000m along is 10%.
    expect(point?.grade).toBeCloseTo(10, 1);
  });

  it('answers at the exact endpoints', () => {
    expect(atTime(course as never, T0)?.distance).toBe(0);
    expect(atTime(course as never, T0 + 1_200_000)?.distance).toBeCloseTo(2000, 0);
  });

  it('returns null outside the track', () => {
    expect(atTime(course as never, T0 - 1000)).toBeNull();
    expect(atTime(course as never, T0 + 9_999_999)).toBeNull();
  });
});

describe('looking up a distance', () => {
  const course = parseCourse(tcx(LINE.map((p, i) => ({ ...p, dist: i * 1000 }))));

  it('maps distance back to a time and a place', () => {
    const point = atDistance(course as never, 1500);
    expect(point?.at).toBeCloseTo(T0 + 900_000, -2);
    expect(point?.lat).toBeCloseTo(45.815, 4);
  });

  it('returns null off either end', () => {
    expect(atDistance(course as never, -1)).toBeNull();
    expect(atDistance(course as never, 99_999)).toBeNull();
  });
});

describe('haversine', () => {
  it('measures a known distance', () => {
    // One degree of latitude is about 111km anywhere on earth.
    expect(haversine(45, -110, 46, -110)).toBeCloseTo(111_195, -2);
  });

  it('is zero for the same point', () => {
    expect(haversine(45.8, -110.5, 45.8, -110.5)).toBe(0);
  });
});

describe('distance and time round-trip', () => {
  // The map and the elevation profile talk to each other in METRES, because
  // an untimed course has no clock to share. On a timed course that means
  // converting time -> distance -> time, and if that drifts, hovering the map
  // moves the profile's crosshair to the wrong place (and vice versa).
  it('returns to the same instant it started from', () => {
    const course = parseCourse(gpx(LINE)) as Course;
    const from = course.from as number;
    const to = course.to as number;
    for (let i = 1; i < 10; i++) {
      const instant = from + ((to - from) * i) / 10;
      const metres = (atTime(course, instant) as CoursePoint).distance;
      const back = (atDistance(course, metres) as CoursePoint).at as number;
      // Within a second: the two interpolations walk the same segments.
      expect(Math.abs(back - instant)).toBeLessThan(1000);
    }
  });

  it('on an untimed course, distance is its own round-trip', () => {
    const xml = `<?xml version="1.0"?><gpx><trk><trkseg>${LINE.map(
      (p) => `<trkpt lat="${p.lat}" lon="${p.lon}"><ele>${p.ele}</ele></trkpt>`,
    ).join('')}</trkseg></trk></gpx>`;
    const course = parseCourse(xml) as Course;
    const metres = course.length / 3;
    expect((atDistance(course, metres) as CoursePoint).distance).toBeCloseTo(metres, 3);
  });
});

describe('nearestDistance', () => {
  // Hovering the map reads back a distance, which drives the profile's
  // crosshair. If this picks the wrong point the two views disagree.
  const samples: Sample[] = [
    { lat: 45.0, lon: -110.0, distance: 0 },
    { lat: 45.1, lon: -110.0, distance: 1000 },
    { lat: 45.2, lon: -110.0, distance: 2000 },
  ];

  it('finds the nearest point, not the first or last', () => {
    expect(nearestDistance(samples, 45.11, -110.001)).toBe(1000);
  });

  it('snaps to an end when the pointer is past it', () => {
    expect(nearestDistance(samples, 44.0, -110.0)).toBe(0);
    expect(nearestDistance(samples, 46.0, -110.0)).toBe(2000);
  });

  it('returns null for an empty track rather than a misleading zero', () => {
    // Zero is a real position — the start line — so it must not double as
    // "no answer".
    expect(nearestDistance([], 45, -110)).toBeNull();
  });

  it('agrees with what the profile would look up at that distance', () => {
    const course = parseCourse(gpx(LINE)) as Course;
    const target = course.samples[1] as Sample;
    const metres = nearestDistance(course.samples, target.lat, target.lon) as number;
    const point = atDistance(course, metres) as CoursePoint;
    expect(point.lat).toBeCloseTo(target.lat, 5);
    expect(point.lon).toBeCloseTo(target.lon, 5);
  });
});

describe('anchorItems', () => {
  const samples: Sample[] = Array.from({ length: 200 }, (_, i) => ({
    lat: 45 + i * 0.001,
    lon: -110,
    distance: i * 111,
  }));
  const untimed: Course = {
    samples, length: 199 * 111, timed: false, from: null, to: null,
    bounds: { minLat: 45, maxLat: 45.199, minLon: -110, maxLon: -110 },
    has: { elevation: false, hr: false, cadence: false }, ascent: 0,
  };
  const none = new Map<string, number>();

  describe('when the track has no times, GPS is the only option', () => {
    it('places an item taken on the course', () => {
      const a = anchorItems([{ id: 'a', gps: [45.05, -110] as const }], untimed, none);
      expect(a.get('a')?.distance).toBeCloseTo(50 * 111, -1);
      expect(a.get('a')?.from).toBe('gps');
    });

    it('ignores an item with no GPS rather than guessing', () => {
      // An action camera has no receiver at all. Nothing honest to do here.
      expect(anchorItems([{ id: 'a' }], untimed, none).size).toBe(0);
    });

    it('rejects an item taken nowhere near the course', () => {
      expect(anchorItems([{ id: 'far', gps: [46.5, -111.5] as const }], untimed, none).size).toBe(0);
    });

    it('accepts an item just off the trail, like an aid station', () => {
      expect(anchorItems([{ id: 'aid', gps: [45.05, -109.99745] as const }], untimed, none).has('aid')).toBe(true);
    });
  });

  describe('when the track is timed, time wins', () => {
    const timed = parseCourse(gpx(LINE)) as Course;

    it('places an item with NO GPS at all — which GPS never could', () => {
      // The case that matters most: action-cam video, and every Android clip
      // that carries no location.
      const at = new Map([['clip', (timed.from as number) + 600_000]]);
      const a = anchorItems([{ id: 'clip' }], timed, at);
      expect(a.get('clip')?.from).toBe('time');
      expect(a.get('clip')?.distance).toBeGreaterThan(0);
    });

    it('prefers time even when GPS is present and plausible', () => {
      const at = new Map([['p', (timed.from as number) + 600_000]]);
      const a = anchorItems([{ id: 'p', gps: [45.8, -110.5] as const }], timed, at);
      expect(a.get('p')?.from).toBe('time');
    });

    it('is not fooled by a wildly wrong GPS fix', () => {
      // A stale fix can land a photo on the wrong side of a ridge. The clock
      // does not fail that way, so the clock decides.
      const at = new Map([['p', (timed.from as number) + 600_000]]);
      const viaTime = anchorItems([{ id: 'p', gps: [12, 100] as const }], timed, at);
      expect(viaTime.get('p')?.from).toBe('time');
      expect(viaTime.get('p')?.distance).toBeGreaterThan(0);
    });

    it('falls back to GPS for an item outside the track span', () => {
      // Shot before the start or after the finish: there is no
      // position-at-time, but the photo still knows where it was taken.
      const at = new Map([['before', (timed.from as number) - 86_400_000]]);
      const a = anchorItems([{ id: 'before', gps: [45.81, -110.5] as const }], timed, at);
      expect(a.get('before')?.from).toBe('gps');
    });

    it('drops an item that is outside the span and has no GPS', () => {
      const at = new Map([['x', (timed.from as number) - 86_400_000]]);
      expect(anchorItems([{ id: 'x' }], timed, at).size).toBe(0);
    });
  });

  it('measures the off-course distance honestly across longitudes', () => {
    // A degree of longitude is ~78km at 45N, not 111km. Ranking without that
    // correction picks the wrong sample on an east-west course.
    const near = nearestPoint(samples, 45.05, -110.001) as { metresAway: number };
    expect(near.metresAway).toBeGreaterThan(50);
    expect(near.metresAway).toBeLessThan(100);
  });
});

describe('estimateInstant', () => {
  // Lets the runner point at a climb they remember and get a time, when
  // nobody photographed that stretch.
  const t = (h: number, m = 0) => Date.UTC(2026, 6, 25, h, m);

  const outbound: TimeAnchor[] = [
    { distance: 0, at: t(6) },
    { distance: 10_000, at: t(7) },
    { distance: 20_000, at: t(9) },
  ];

  it('interpolates between two photographs', () => {
    const e = estimateInstant(outbound, 5_000) as TimeEstimate;
    expect(e.at).toBe(t(6, 30));
  });

  it('respects an uneven pace between segments', () => {
    // The second 10km took two hours, not one. Halfway through it is 08:00.
    const e = estimateInstant(outbound, 15_000) as TimeEstimate;
    expect(e.at).toBe(t(8));
  });

  it('reports its own slack, so the caller can be honest about it', () => {
    const e = estimateInstant(outbound, 15_000) as TimeEstimate;
    expect(e.gapSeconds).toBe(7200);
    expect(e.before.distance).toBe(10_000);
    expect(e.after.distance).toBe(20_000);
  });

  it('REFUSES to extrapolate past the last photograph', () => {
    // Beyond the observations there is nothing to interpolate between, and a
    // number here would be pure invention.
    expect(estimateInstant(outbound, 30_000)).toBeNull();
  });

  it('refuses before the first photograph too', () => {
    expect(estimateInstant([{ distance: 5_000, at: t(6) }, { distance: 9_000, at: t(7) }], 1_000))
      .toBeNull();
  });

  it('needs at least two observations', () => {
    expect(estimateInstant([{ distance: 0, at: t(6) }], 0)).toBeNull();
  });

  it('handles an out-and-back, where distance is not a function of time', () => {
    // The runner passes 5km twice: outbound at 07:00 and returning at 10:00.
    const there: TimeAnchor[] = [
      { distance: 0, at: t(6) },
      { distance: 10_000, at: t(8) },
      { distance: 0, at: t(12) },
    ];
    const e = estimateInstant(there, 5_000) as TimeEstimate;
    expect(e.ambiguous).toBe(true);
    // With no hint it takes the first pass: 5km of 10km in two hours.
    expect(e.at).toBe(t(7));
  });

  it('uses the cursor to choose which pass was meant', () => {
    const there: TimeAnchor[] = [
      { distance: 0, at: t(6) },
      { distance: 10_000, at: t(8) },
      { distance: 0, at: t(12) },
    ];
    const back = estimateInstant(there, 5_000, t(11)) as TimeEstimate;
    expect(back.at).toBe(t(10));
    expect(back.ambiguous).toBe(true);
  });

  it('is not ambiguous on a course that only goes one way', () => {
    expect((estimateInstant(outbound, 5_000) as TimeEstimate).ambiguous).toBe(false);
  });

  it('does not divide by zero when two photographs share a spot', () => {
    const still: TimeAnchor[] = [
      { distance: 4_000, at: t(6) },
      { distance: 4_000, at: t(7) },
    ];
    const e = estimateInstant(still, 4_000) as TimeEstimate;
    expect(Number.isFinite(e.at)).toBe(true);
    expect(e.at).toBe(t(6));
  });
});
