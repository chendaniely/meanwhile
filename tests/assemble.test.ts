import { describe, expect, it } from 'vitest';
import {
  UNSORTED_PERSON,
  assembleManifest,
  displayNameFor,
  personIdFromPath,
  slugify,
  summarize,
} from '../src/core/assemble.ts';
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
