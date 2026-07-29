import { describe, expect, it } from 'vitest';
import {
  INITIAL_STATE,
  fromHash,
  isVisible,
  toHash,
  toggleVisible,
  type AppState,
} from '../src/core/state.ts';

const T = Date.UTC(2026, 6, 24, 6, 12, 4);
const T2 = Date.UTC(2026, 6, 25, 6, 12, 4);

describe('URL round trip', () => {
  it('survives a full state', () => {
    const state: AppState = {
      view: 'lanes',
      cursor: T,
      range: { from: T, to: T2 },
      visible: new Set(['sam', 'dan']),
    };
    const back = fromHash(toHash(state));
    expect(back.view).toBe('lanes');
    expect(back.cursor).toBe(T);
    expect(back.range).toEqual({ from: T, to: T2 });
    expect([...(back.visible as ReadonlySet<string>)].sort()).toEqual(['dan', 'sam']);
  });

  it('writes nothing for the default state, so the URL stays clean', () => {
    expect(toHash(INITIAL_STATE)).toBe('');
  });

  it('writes instants as readable ISO strings, not epoch numbers', () => {
    // A shared link should be legible, and hand-editable.
    const hash = toHash({ ...INITIAL_STATE, cursor: T });
    expect(decodeURIComponent(hash)).toContain('2026-07-24T06:12:04Z');
  });
});

describe('reading a hash that has been messed with', () => {
  it('ignores an unknown view rather than blanking the page', () => {
    expect(fromHash('#view=hologram').view).toBe(INITIAL_STATE.view);
  });

  it('ignores an unparseable time', () => {
    expect(fromHash('#t=lunchtime').cursor).toBeNull();
  });

  it('refuses half a range', () => {
    // Half a range is not a range; taking the one value would silently crop
    // the timeline to somewhere the sender never meant.
    expect(fromHash('#from=2026-07-24T00:00:00Z').range).toBeNull();
    expect(fromHash('#to=2026-07-24T00:00:00Z').range).toBeNull();
  });

  it('refuses an inverted range', () => {
    expect(fromHash('#from=2026-07-25T00:00:00Z&to=2026-07-24T00:00:00Z').range).toBeNull();
  });

  it('ignores parameters it does not know', () => {
    expect(fromHash('#view=lanes&nonsense=1').view).toBe('lanes');
  });

  it('reads an empty hash as the default state', () => {
    expect(fromHash('')).toEqual(INITIAL_STATE);
    expect(fromHash('#')).toEqual(INITIAL_STATE);
  });
});

describe('who is visible', () => {
  it('treats absent as everyone', () => {
    const state = fromHash('');
    expect(state.visible).toBeNull();
    expect(isVisible(state, 'anyone')).toBe(true);
  });

  it('distinguishes "everyone" from "nobody"', () => {
    // `who=` with nothing after it means the author hid every lane, which is
    // a real state and must not silently become "show everything".
    const nobody = fromHash('#who=');
    expect(nobody.visible).toEqual(new Set());
    expect(isVisible(nobody, 'sam')).toBe(false);
  });

  it('hides only the person toggled, starting from everyone', () => {
    // The first toggle has to materialize the full set first, or clicking one
    // person would hide all the others.
    const everyone = ['sam', 'dan', 'ali'];
    const next = toggleVisible(fromHash(''), 'dan', everyone);
    expect([...next].sort()).toEqual(['ali', 'sam']);
  });

  it('toggles back on', () => {
    const state: AppState = { ...INITIAL_STATE, visible: new Set(['sam']) };
    expect([...toggleVisible(state, 'dan', ['sam', 'dan'])].sort()).toEqual(['dan', 'sam']);
  });
});
