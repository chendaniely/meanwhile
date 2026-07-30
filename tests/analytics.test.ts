// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackView } from '../src/viewer/analytics.ts';

/**
 * `trackView` is the ONLY thing allowed to tell Google Analytics anything,
 * and the owner drew the line at "which of the three views is being
 * looked at" and nothing more — see CLAUDE.md's decision record. Two
 * failure modes matter equally here: throwing when `window.gtag` is absent
 * (which is the entire `make dev` experience, not an edge case), and
 * leaking anything beyond the bare view name when it is present.
 */

afterEach(() => {
  delete (window as unknown as { gtag?: unknown }).gtag;
});

describe('trackView: no-ops without gtag', () => {
  it('does not throw when window.gtag is undefined', () => {
    expect((window as unknown as { gtag?: unknown }).gtag).toBeUndefined();
    expect(() => trackView('feed')).not.toThrow();
  });

  it('does not throw when window.gtag is present but not a function', () => {
    (window as unknown as { gtag?: unknown }).gtag = 'not a function';
    expect(() => trackView('lanes')).not.toThrow();
  });
});

describe('trackView: the payload gtag actually receives', () => {
  it('calls gtag with the view name and nothing else', () => {
    const gtag = vi.fn();
    (window as unknown as { gtag?: unknown }).gtag = gtag;

    trackView('course');

    expect(gtag).toHaveBeenCalledTimes(1);
    const [eventCommand, eventName, payload] = gtag.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(eventCommand).toBe('event');
    expect(eventName).toBe('view_change');

    // The exact argument object, not just "was called" — a payload that
    // silently grew a `cursor` or `who` field would still pass a looser
    // assertion.
    expect(payload).toEqual({ view: 'course' });
    expect(Object.keys(payload)).toEqual(['view']);

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('#');
    expect(serialized.toLowerCase()).not.toMatch(/cursor|timestamp|person|who|range|from|to/);
  });

  it('sends each of the three view names verbatim, and only that', () => {
    const gtag = vi.fn();
    (window as unknown as { gtag?: unknown }).gtag = gtag;

    trackView('feed');
    trackView('lanes');
    trackView('course');

    expect(gtag.mock.calls.map((call) => call[2])).toEqual([
      { view: 'feed' },
      { view: 'lanes' },
      { view: 'course' },
    ]);
  });
});
