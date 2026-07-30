// @vitest-environment jsdom
import L from 'leaflet';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { displayName, parsePeopleCsv } from '../src/core/people-csv.ts';
import { nameLabel } from '../src/viewer/map/CourseMap.tsx';

/**
 * STORED XSS, found by an independent security review.
 *
 * `CourseMap.tsx` labelled each photo dot with `bindTooltip(name)` — a
 * STRING. Leaflet's `DivOverlay._updateContent` assigns string content with
 * `node.innerHTML = content`, so the name was parsed as markup.
 *
 * That name comes from `people.csv` or from a folder name, and this app's
 * entire collaboration model is that other people send those files in. So a
 * crew member could execute script in a page holding File System Access
 * handles and object URLs for the owner's whole photo folder — defeating the
 * one guarantee the project makes, that the photographs never leave the
 * machine. On GitHub Pages the origin is shared with every other project the
 * owner publishes, so it reached that storage too.
 *
 * The fix is to hand Leaflet a NODE, which it appends instead of parsing.
 * These tests pin both halves: that a hostile name survives parsing as inert
 * text, and that Leaflet really would have executed it as a string — because
 * a regression test for the fix is worthless if the underlying danger it
 * guards against ever stops being real.
 */

// No double quotes in the payload: it is embedded in a quoted CSV field
// below, and escaping them there would be testing my own test rather than
// the product. An unquoted onerror is just as executable.
const HOSTILE = '<img src=x onerror=globalThis.__PWNED=true>';

describe('map dot labels cannot execute a name', () => {
  it('keeps a hostile name verbatim through people.csv — the parser is not the defence', () => {
    // Worth pinning: the CSV layer deliberately does NOT sanitise. It is a
    // data format, not an HTML escaper, and stripping markup there would
    // corrupt a legitimate name containing a bracket. The defence belongs at
    // the point of rendering.
    const csv = `id,name,role,clock_offset,also_known_as,schema\nevil,"${HOSTILE}",crew,,,\n`;
    const { people, problems } = parsePeopleCsv(csv);
    expect(problems).toEqual([]);
    expect(people[0]?.name).toBe(HOSTILE);
    expect(displayName(people[0]!)).toBe(HOSTILE);
  });

  it('renders a hostile name as TEXT, creating no element and firing nothing', () => {
    delete (globalThis as Record<string, unknown>)['__PWNED'];

    const host = document.createElement('div');
    document.body.append(host);
    const map = L.map(host).setView([45, -110], 10);
    const marker = L.circleMarker([45, -110]).bindTooltip(nameLabel(HOSTILE)).addTo(map);
    marker.openTooltip();

    const el = marker.getTooltip()?.getElement();
    expect(el).toBeTruthy();
    // No <img> was created, so no onerror can ever run.
    expect(el?.querySelectorAll('img')).toHaveLength(0);
    // The name is still shown — escaping must not mean losing it.
    expect(el?.textContent).toContain(HOSTILE);
    expect((globalThis as Record<string, unknown>)['__PWNED']).toBeUndefined();

    map.remove();
    host.remove();
  });

  it('confirms the danger is real: the same name as a STRING does build an element', () => {
    // If Leaflet ever stops parsing strings as HTML this test fails, and the
    // node-based fix above becomes belt-and-braces rather than load-bearing.
    // Either way the failure is informative, which is the point of pinning it.
    const host = document.createElement('div');
    document.body.append(host);
    const map = L.map(host).setView([45, -110], 10);
    const marker = L.circleMarker([45, -110]).bindTooltip(HOSTILE).addTo(map);
    marker.openTooltip();

    const el = marker.getTooltip()?.getElement();
    expect(el?.querySelectorAll('img').length).toBeGreaterThan(0);

    map.remove();
    host.remove();
  });

  it('pins the CALL SITE, not just the helper', () => {
    // The behavioural tests above would still pass if CourseMap went back to
    // `bindTooltip(name)`, because they exercise `nameLabel` directly. This
    // reads the source and fails on the dangerous shape itself — the only
    // assertion here that catches a revert.
    // Relative to the repo root, which is vitest's cwd. `import.meta.url` is
    // not a file: URL under the jsdom environment this file runs in.
    const src = readFileSync('src/viewer/map/CourseMap.tsx', 'utf8');
    // The dangerous shape, exactly: a bare `name` passed as the tooltip
    // content. Literals ('Start', 'Finish') are fine; so is nameLabel(name).
    expect(src).not.toMatch(/\.bindTooltip\(\s*name\s*[,)]/);
    expect(src).toContain('.bindTooltip(nameLabel(name)');
  });
});
