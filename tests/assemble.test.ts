import { describe, expect, it } from 'vitest';
import {
  UNSORTED_PERSON,
  assembleManifest,
  describeGrouping,
  displayNameFor,
  personIdFromPath,
  slugify,
  summarize,
} from '../src/core/assemble.ts';
import type { Item, Manifest } from '../src/core/schema.ts';
import type { IngestedFile } from '../src/core/assemble.ts';
import {
  LANE_COLORS,
  OVERFLOW_COLOR,
  assignLaneColors,
  isOvercrowded,
  orderPeople,
} from '../src/core/palette.ts';
import type { Person } from '../src/core/schema.ts';
import { validateManifest } from '../src/core/schema.ts';

const file = (path: string, over: Partial<IngestedFile['metadata']> = {}): IngestedFile => ({
  path,
  metadata: { type: 'photo', timeSource: 'exif-offset', at: '2026-08-22T06:12:04-07:00', ...over },
  bytes: 1024,
});

describe('personIdFromPath', () => {
  it('takes the person from the top-level folder', () => {
    // The convention the ingest teaches: each person hands over a folder.
    expect(personIdFromPath('sam/IMG_4417.jpg')).toBe('sam');
    expect(personIdFromPath('Jo Chen/IMG_4417.jpg')).toBe('jo-chen');
    expect(personIdFromPath('sam/subfolder/IMG_4417.jpg')).toBe('sam');
  });

  it('puts loose files in "unsorted" rather than dropping them', () => {
    expect(personIdFromPath('IMG_4417.jpg')).toBe(UNSORTED_PERSON);
    expect(personIdFromPath('/IMG_4417.jpg')).toBe(UNSORTED_PERSON);
  });

  it('slugifies accents and punctuation', () => {
    expect(slugify('Renée O’Brien')).toBe('renee-o-brien');
    expect(displayNameFor('jo-chen')).toBe('Jo Chen');
    expect(displayNameFor(UNSORTED_PERSON)).toBe('Unsorted');
  });

  it('shouts model codes but never short names', () => {
    expect(displayNameFor('google-pixel-8-pro')).toBe('Google Pixel 8 Pro');
    expect(displayNameFor('samsung-sm-f721w')).toBe('Samsung Sm F721W');
    // Two-letter names are real people. "jo-chen" must not become "JO Chen".
    expect(displayNameFor('jo-chen')).toBe('Jo Chen');
    expect(displayNameFor('al')).toBe('Al');
  });
});

describe('grouping a flat folder by device', () => {
  // A Google Photos album download: everything loose at the root, three
  // phones mixed together. This is the shape real media actually arrives in.
  const flat: IngestedFile[] = [
    file('PXL_20260724_100000123.jpg', { at: '2026-07-24T10:00:00Z', device: 'google-pixel-8-pro' }),
    file('PXL_20260724_100500456.jpg', { at: '2026-07-24T10:05:00Z', device: 'google-pixel-8-pro' }),
    file('20260724_180000.jpg', { at: '2026-07-24T18:00:00Z', device: 'samsung-sm-f721w' }),
    file('20260724_181000.jpg', { at: '2026-07-24T18:10:00Z', device: 'samsung-sm-f721w' }),
  ];

  it('makes one person per device when there are no subfolders', () => {
    const manifest = assembleManifest(flat, { title: 'x', timezone: 'UTC' });
    expect(manifest.people.map((p) => p.id)).toEqual(['google-pixel-8-pro', 'samsung-sm-f721w']);
    expect(manifest.people.map((p) => p.name)).toEqual(['Google Pixel 8 Pro', 'Samsung Sm F721W']);
  });

  const video = (path: string, at: string): IngestedFile => ({
    path,
    metadata: { type: 'video', timeSource: 'filename', at },
  });

  it('uses the filename convention, NOT proximity, for a device-less video', () => {
    // The bug this replaced: proximity alone put eight Samsung-named clips on
    // the Pixel's lane, because both people were shooting at the same moments.
    // Here the Samsung video sits nearer the Pixel's photos in time, and must
    // still go to the Samsung because only the Samsung names files that way.
    const withVideo = [...flat, video('20260724_101500.mp4', '2026-07-24T10:02:00Z')];
    const manifest = assembleManifest(withVideo, { title: 'x', timezone: 'UTC' });
    expect(manifest.items.find((i) => i.id === '20260724_101500.mp4')?.person).toBe(
      'samsung-sm-f721w',
    );
  });

  it('falls back to proximity only among devices sharing a convention', () => {
    // Two Pixels both name files PXL_, so the convention cannot decide and
    // the clock breaks the tie.
    const twoPixels: IngestedFile[] = [
      file('PXL_20260724_100000000.jpg', { at: '2026-07-24T10:00:00Z', device: 'google-pixel-8-pro' }),
      file('PXL_20260724_200000000.jpg', { at: '2026-07-24T20:00:00Z', device: 'google-pixel-9a' }),
      file('20260724_195900.jpg', { at: '2026-07-24T19:59:00Z', device: 'samsung-sm-f721w' }),
      video('PXL_20260724_195800000.mp4', '2026-07-24T19:58:00Z'),
    ];
    const manifest = assembleManifest(twoPixels, { title: 'x', timezone: 'UTC' });
    // Nearest overall is the Samsung, but only Pixels are candidates.
    expect(manifest.items.find((i) => i.id.endsWith('.mp4'))?.person).toBe('google-pixel-9a');
  });

  it('makes an unrecognized convention its own person', () => {
    // A DJI action camera nobody took stills with is a real fourth lane, not
    // something to fold into whoever happened to be shooting nearby.
    const withDji = [...flat, video('dji_mimo_20260724_1005_video.mp4', '2026-07-24T10:05:00Z')];
    const manifest = assembleManifest(withDji, { title: 'x', timezone: 'UTC' });
    expect(manifest.items.find((i) => i.id.startsWith('dji_'))?.person).toBe('dji');
  });

  it('reports how each guess was made', () => {
    const withVideo = [...flat, video('20260724_180500.mp4', '2026-07-24T18:05:00Z')];
    expect(describeGrouping(withVideo)).toEqual({ by: 'device', byFamily: 1, byProximity: 0 });
    expect(describeGrouping(flat)).toEqual({ by: 'device', byFamily: 0, byProximity: 0 });
  });

  it('prefers folders over devices when folders exist', () => {
    // The author put those folders there on purpose; a device guess must not
    // override a stated intent.
    const foldered = [
      file('sam/a.jpg', { device: 'google-pixel-8-pro' }),
      file('dan/b.jpg', { device: 'google-pixel-8-pro' }),
    ];
    const manifest = assembleManifest(foldered, { title: 'x' });
    expect(manifest.people.map((p) => p.id)).toEqual(['dan', 'sam']);
    expect(describeGrouping(foldered)).toEqual({ by: 'folders', byFamily: 0, byProximity: 0 });
  });

  it('falls back to unsorted when nothing states a device', () => {
    const anonymous = [file('a.jpg'), file('b.jpg')];
    const manifest = assembleManifest(anonymous, { title: 'x' });
    expect(manifest.people.map((p) => p.id)).toEqual([UNSORTED_PERSON]);
  });
});

describe('assembleManifest', () => {
  const files = [file('sam/IMG_4417.jpg'), file('sam/IMG_4418.jpg'), file('dan/IMG_0001.jpg')];

  it('produces a manifest that validates', () => {
    const manifest = assembleManifest(files, { title: 'Cascade Crest 100' });
    expect(validateManifest(manifest).ok).toBe(true);
  });

  it('creates one person per top-level folder', () => {
    const manifest = assembleManifest(files, { title: 'x' });
    expect(manifest.people.map((p) => p.id)).toEqual(['dan', 'sam']);
    expect(manifest.people.map((p) => p.name)).toEqual(['Dan', 'Sam']);
  });

  it('uses the relative path as the item id', () => {
    // Stable across re-ingests of the same folder, which is what lets notes
    // and manual placements survive re-reading the bytes.
    const manifest = assembleManifest(files, { title: 'x' });
    expect(manifest.items.map((i) => i.id)).toEqual([
      'sam/IMG_4417.jpg',
      'sam/IMG_4418.jpg',
      'dan/IMG_0001.jpg',
    ]);
  });

  it('survives the export round trip', () => {
    // What "Export manifest.json" writes must be readable back by the viewer.
    // JSON.stringify silently drops undefined, so this also catches any
    // required field that was left unset.
    const manifest = assembleManifest(
      [
        file('sam/a.jpg', { gps: [47.39, -121.39], width: 4032, height: 3024, orientation: 6 }),
        file('sam/b.mov', { type: 'video', duration: 12.5, timeSource: 'mvhd', at: '2026-08-22T13:00:00Z' }),
        { path: 'c.jpg', metadata: { type: 'photo', timeSource: 'none' }, bytes: 10 },
      ],
      { title: 'Cascade Crest 100', timezone: 'America/Los_Angeles' },
    );
    const reloaded: unknown = JSON.parse(JSON.stringify(manifest));
    const result = validateManifest(reloaded);
    expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
    expect(reloaded).toEqual(manifest);
  });

  it('omits the timezone when none is given rather than writing undefined', () => {
    expect('timezone' in assembleManifest(files, { title: 'x' }).event).toBe(false);
    expect(assembleManifest(files, { title: 'x', timezone: 'America/Los_Angeles' }).event.timezone).toBe(
      'America/Los_Angeles',
    );
  });

  it('keeps existing names and clock offsets on re-ingest', () => {
    const existingPeople: Person[] = [
      { id: 'sam', name: 'Sam Whitfield', role: 'runner', clockOffset: '-PT47S' },
    ];
    const manifest = assembleManifest(files, { title: 'x', existingPeople });
    const sam = manifest.people.find((p) => p.id === 'sam');
    expect(sam?.name).toBe('Sam Whitfield');
    expect(sam?.clockOffset).toBe('-PT47S');
    expect(sam?.role).toBe('runner');
  });

  /**
   * IMPORTANT 3 from the whole-branch review: `people` used to be built ONLY
   * from `seenPeople` — ids that own a file — so a roster row for a crew
   * member who shot nothing (the obvious first thing to do with an editable
   * `people.csv`) was silently dropped here, and then written OUT of
   * `people.csv` on the next Save. Fixed the same way an empty swimlane is
   * drawn rather than omitted: a person the author put in the roster stays,
   * with zero items.
   */
  it('keeps a roster person who owns no media, rather than deleting them', () => {
    const existingPeople: Person[] = [
      { id: 'sam', name: 'Sam' },
      { id: 'crew-jo', name: 'Jo', role: 'crew' },
    ];
    const manifest = assembleManifest(files, { title: 'x', existingPeople });
    expect(manifest.people.map((p) => p.id)).toContain('crew-jo');
    expect(manifest.people.find((p) => p.id === 'crew-jo')).toEqual({
      id: 'crew-jo', name: 'Jo', role: 'crew',
    });
    // Still validates, and still gets a lane color from `assignLaneColors`
    // (which reads off `manifest.people` alone) — both fall out of simply
    // being present in the array, so this is the load-bearing assertion.
    expect(validateManifest(manifest).ok).toBe(true);
  });

  it('keeps captions and hand-placed times on re-ingest', () => {
    // The author's work is not the file's. Re-reading bytes must not undo it.
    const existingItems = [
      {
        id: 'sam/IMG_4417.jpg',
        person: 'sam',
        type: 'photo' as const,
        src: 'sam/IMG_4417.jpg',
        at: '2026-08-22T14:00:00Z',
        timeSource: 'manual' as const,
        note: 'legs are gone but the sun is up',
      },
    ];
    const manifest = assembleManifest(files, { title: 'x', existingItems });
    const item = manifest.items.find((i) => i.id === 'sam/IMG_4417.jpg');
    expect(item?.note).toBe('legs are gone but the sun is up');
    expect(item?.at).toBe('2026-08-22T14:00:00Z');
    expect(item?.timeSource).toBe('manual');
  });

  it('does NOT override a fresh timestamp with a stale automatic one', () => {
    // Only manual placements are preserved; if the file's own metadata
    // improved, the re-read should win.
    const existingItems = [
      {
        id: 'sam/IMG_4417.jpg',
        person: 'sam',
        type: 'photo' as const,
        src: 'sam/IMG_4417.jpg',
        at: '2020-01-01T00:00:00Z',
        timeSource: 'mvhd' as const,
      },
    ];
    const manifest = assembleManifest(files, { title: 'x', existingItems });
    expect(manifest.items.find((i) => i.id === 'sam/IMG_4417.jpg')?.at).toBe(
      '2026-08-22T06:12:04-07:00',
    );
  });
});

describe('summarize', () => {
  it('counts what came in and finds the event span', () => {
    const manifest = assembleManifest(
      [
        file('sam/a.jpg', { at: '2026-08-22T13:00:00Z', timeSource: 'gps', gps: [47, -121] }),
        file('sam/b.mov', { type: 'video', at: '2026-08-22T15:00:00Z', timeSource: 'mvhd', duration: 12 }),
        file('sam/c.jpg', { timeSource: 'none' }),
      ],
      { title: 'x', timezone: 'America/Los_Angeles' },
    );
    const s = summarize(manifest);

    expect(s.total).toBe(3);
    expect(s.photos).toBe(2);
    expect(s.videos).toBe(1);
    expect(s.placed).toBe(2);
    expect(s.unplaced).toBe(1);
    expect(s.withGps).toBe(1);
    expect(s.mvhdCount).toBe(1);
    expect(s.span).toEqual({ from: Date.UTC(2026, 7, 22, 13), to: Date.UTC(2026, 7, 22, 15) });
  });

  it('reports no span when nothing could be placed', () => {
    const manifest = assembleManifest([file('a.jpg', { timeSource: 'none' })], { title: 'x' });
    expect(summarize(manifest).span).toBeNull();
  });

  it('counts an item as unplaced when a naive time has no timezone to resolve it', () => {
    const manifest = assembleManifest(
      [file('a.jpg', { at: '2026-08-22T06:12:04', timeSource: 'exif-naive' })],
      { title: 'x' },
    );
    expect(summarize(manifest).unplaced).toBe(1);
  });
});

describe('lane colors', () => {
  const people: Person[] = [
    { id: 'dan', name: 'Dan', role: 'crew' },
    { id: 'sam', name: 'Sam', role: 'runner' },
    { id: 'ali', name: 'Ali', role: 'friend' },
  ];

  it('pins the runner to the top lane', () => {
    expect(orderPeople(people).map((p) => p.id)).toEqual(['sam', 'dan', 'ali']);
  });

  it('gives the runner slot 1', () => {
    expect(assignLaneColors(people).get('sam')).toBe(LANE_COLORS[0]);
  });

  it('assigns by person, not by screen position', () => {
    // Hiding a lane must not repaint the others, so the same person keeps the
    // same color regardless of who else is present.
    const withoutDan = people.filter((p) => p.id !== 'dan');
    expect(assignLaneColors(withoutDan).get('sam')).toBe(assignLaneColors(people).get('sam'));
    expect(assignLaneColors(withoutDan).get('ali')).not.toBe(assignLaneColors(people).get('ali'));
  });

  it('respects an explicit color override', () => {
    const custom: Person[] = [{ id: 'sam', name: 'Sam', color: '#ff00ff' }];
    expect(assignLaneColors(custom).get('sam')).toBe('#ff00ff');
  });

  it('never invents a ninth hue', () => {
    // A generated hue would silently break the validated CVD guarantees.
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
    expect(assignLaneColors(many).get('p8')).toBe(OVERFLOW_COLOR);
    expect(assignLaneColors(many).get('p9')).toBe(OVERFLOW_COLOR);
    expect(isOvercrowded(many)).toBe(true);
    expect(isOvercrowded(people)).toBe(false);
  });

  it('has eight distinct validated hues', () => {
    expect(new Set(LANE_COLORS).size).toBe(8);
  });
});

describe('re-ingest preserves the author\'s work', () => {
  // The promise behind "export, come back tomorrow, keep working" on a site
  // with no backend. If this breaks, captions and renames vanish silently on
  // the next folder read — the worst kind of failure this project can have.
  const file = (path: string, at?: string): IngestedFile => ({
    path,
    metadata: at
      ? { type: 'photo', timeSource: 'exif-offset', at }
      : { type: 'photo', timeSource: 'none' },
  });

  const first = assembleManifest(
    [file('a.jpg', '2026-07-24T12:00:00Z'), file('b.jpg')],
    { title: 'Race' },
  );

  it('keeps a caption through a re-read of the bytes', () => {
    const edited: Manifest = {
      ...first,
      items: first.items.map((it) => (it.id === 'a.jpg' ? { ...it, note: 'the climb' } : it)),
    };
    const again = assembleManifest(
      [file('a.jpg', '2026-07-24T12:00:00Z'), file('b.jpg')],
      { title: 'Race', existingItems: edited.items, existingPeople: edited.people },
    );
    expect(again.items.find((i) => i.id === 'a.jpg')?.note).toBe('the climb');
  });

  it('keeps a renamed person', () => {
    const renamed: Manifest = {
      ...first,
      people: first.people.map((p) => ({ ...p, name: 'Priya' })),
    };
    const again = assembleManifest(
      [file('a.jpg', '2026-07-24T12:00:00Z')],
      { title: 'Race', existingPeople: renamed.people, existingItems: renamed.items },
    );
    expect(again.people[0]?.name).toBe('Priya');
  });

  it('keeps a role, which carries behaviour rather than being a label', () => {
    const withRole: Manifest = {
      ...first,
      people: first.people.map((p) => ({ ...p, role: 'runner' as const })),
    };
    const again = assembleManifest(
      [file('a.jpg', '2026-07-24T12:00:00Z')],
      { title: 'Race', existingPeople: withRole.people, existingItems: withRole.items },
    );
    expect(again.people[0]?.role).toBe('runner');
  });

  it('keeps a hand-placed time but RE-READS an automatic one', () => {
    // The distinction that matters: a manual placement is authorship, an
    // automatic timestamp is a fact about the bytes. A stale copy of the
    // latter would be worse than no copy.
    const placed: Manifest = {
      ...first,
      items: first.items.map((it) =>
        it.id === 'b.jpg'
          ? { ...it, at: '2026-07-24T15:00:00Z', timeSource: 'manual' as const }
          : { ...it, at: '1999-01-01T00:00:00Z' },
      ),
    };
    const again = assembleManifest(
      [file('a.jpg', '2026-07-24T12:00:00Z'), file('b.jpg')],
      { title: 'Race', existingItems: placed.items, existingPeople: placed.people },
    );
    const a = again.items.find((i) => i.id === 'a.jpg');
    const b = again.items.find((i) => i.id === 'b.jpg');
    expect(b?.at).toBe('2026-07-24T15:00:00Z');
    expect(b?.timeSource).toBe('manual');
    expect(a?.at).toBe('2026-07-24T12:00:00Z');
  });

  it('drops work for a file that is no longer in the folder', () => {
    const again = assembleManifest([file('a.jpg', '2026-07-24T12:00:00Z')], {
      title: 'Race',
      existingItems: [...first.items, { ...(first.items[0] as Item), id: 'gone.jpg' }],
      existingPeople: first.people,
    });
    expect(again.items.some((i) => i.id === 'gone.jpg')).toBe(false);
  });
});
