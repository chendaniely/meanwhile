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
 *      (worst pair ΔE 1.6 under deuteranopia). Dots on the map therefore
 *      carry the person's name as a direct label. That is not a nicety; it is
 *      the secondary encoding that makes the map legible at all.
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
 * The runner is always slot 1. Everyone else follows in manifest order, which
 * is stable across reloads because the manifest is a file. An explicit
 * `person.color` wins over both.
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
 * Lane order: the runner on top, then everyone else as the manifest lists
 * them.
 *
 * The runner's lane is pinned because the swimlanes tell the race, and the
 * race is their story — every other lane is read in relation to it. Only the
 * first person with role "runner" is pinned; the validator warns if there is
 * more than one.
 */
export function orderPeople(people: readonly Person[]): Person[] {
  const runnerIndex = people.findIndex((p) => p.role === 'runner');
  if (runnerIndex <= 0) return [...people];
  const runner = people[runnerIndex] as Person;
  return [runner, ...people.filter((_, i) => i !== runnerIndex)];
}

/** True when there are more people than distinguishable hues. */
export function isOvercrowded(people: readonly Person[]): boolean {
  return people.filter((p) => !p.color).length > MAX_DISTINCT_PEOPLE;
}
