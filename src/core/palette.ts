/**
 * Lane colors.
 *
 * Eight fixed hues in a fixed order, assigned to people once and never
 * cycled. The order is the colorblind-safety mechanism, not decoration — the
 * palette was validated against this app's surface (#171512) and passes the
 * lightness band, chroma floor, CVD separation, normal-vision floor, and
 * contrast checks for ADJACENT pairs.
 *
 * TWO RULES THAT MUST NOT BE BROKEN:
 *
 *   1. Color follows the person, never their position on screen. Hiding a
 *      lane must not repaint the others, so assignment is keyed off the
 *      manifest's people list and computed once.
 *
 *   2. Adjacent-pair safety is not all-pairs safety. Lanes, the feed, and the
 *      grid only ever put neighbors side by side, so adjacent is the right
 *      test. THE MAP IS DIFFERENT — any two dots can land next to each other,
 *      and under that harder test this palette fails past three people
 *      (worst pair ΔE 1.6 under deuteranopia). Dots on the map carry the
 *      person's name, but only as a hover tooltip (CourseMap.tsx), not a
 *      permanent label — the dots are one per photograph, and with 200+ in
 *      view a permanent label on each would overlap into noise. That leaves
 *      an open gap: two adjacent dots are colour-only until you hover one.
 *      See TODO.md for the standard fix (a second channel that scales, e.g.
 *      per-person marker shape) — not yet built, an open decision.
 */

import type { Person, PersonId } from './schema.ts';

/**
 * Validated against this app's dark surface, #171512, using the dataviz
 * skill's palette validator — an external tool, not a script that lives in
 * this repo, so don't go looking for `scripts/validate_palette.js`.
 * Worst adjacent pair: yellow-aqua, ΔE 8.4 protan. All checks PASS.
 */
export const LANE_COLORS: readonly string[] = [
  '#3987e5', // blue
  '#d95926', // orange
  '#199e70', // aqua
  '#c98500', // yellow
  '#d55181', // magenta
  '#008300', // green
  '#9085e9', // violet
  '#e66767', // red
];

/**
 * People past the eighth get this rather than an invented ninth hue. A
 * generated hue would quietly break every guarantee above; a neutral one
 * makes the crowding visible so lanes can be grouped instead.
 */
export const OVERFLOW_COLOR = '#8a8378';

export const MAX_DISTINCT_PEOPLE = LANE_COLORS.length;

/**
 * Assign a color to every person.
 *
 * Pinned people take the first slots. Everyone else follows in manifest
 * order, which is stable across reloads because the manifest is a file. An
 * explicit `person.color` wins over both.
 */
export function assignLaneColors(people: readonly Person[]): Map<PersonId, string> {
  const ordered = orderPeople(people);
  const out = new Map<PersonId, string>();
  let slot = 0;
  for (const person of ordered) {
    if (person.color) {
      out.set(person.id, person.color);
      continue;
    }
    out.set(person.id, LANE_COLORS[slot] ?? OVERFLOW_COLOR);
    slot++;
  }
  return out;
}

/**
 * Lane order: everyone pinned on top, then everyone else, each group in the
 * order the roster lists them.
 *
 * A lane is pinned because the swimlanes tell one story and every other lane
 * is read in relation to it — the runner in an ultra, the couple at a
 * wedding, the whole team in a relay.
 *
 * **All of them, not just the first.** This used to move the first person
 * whose `role` was exactly `"runner"` and silently leave any others where
 * they were, which is why `validateManifest` had to warn about a second one.
 * `Person.pinned` replaced that: several pinned people are legal, ordinary,
 * and the reason the field exists at all. See `Person.pinned` in `schema.ts`.
 */
export function orderPeople(people: readonly Person[]): Person[] {
  const pinned = people.filter((p) => p.pinned);
  if (pinned.length === 0) return [...people];
  return [...pinned, ...people.filter((p) => !p.pinned)];
}

/**
 * True when there are more people NEEDING an automatic hue than there are
 * distinguishable hues to give them.
 *
 * Only counts people without an explicit `color` — someone who hand-assigned
 * a colour has already made their own distinguishability call and should not
 * be warned about running out of a palette they opted out of.
 */
export function isOvercrowded(people: readonly Person[]): boolean {
  return people.filter((p) => !p.color).length > MAX_DISTINCT_PEOPLE;
}
