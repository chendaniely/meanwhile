/**
 * One serializable state object, and its round trip through a URL.
 *
 * The views are four projections of THIS, not four features. Switching view
 * changes `view` and nothing else, which is what makes the cursor survive the
 * switch — scrub to 06:12 in the lanes, flip to the grid, and you are looking
 * at 06:12. That shared cursor is the difference between goggles and four
 * separate pages.
 *
 * It lives in the URL so any moment is a link you can send to someone. That
 * falls out of keeping the state serializable and is likely the feature
 * people use most.
 */

import type { PersonId } from './schema.ts';
import type { Instant } from './time.ts';
import type { TimeWindow } from './window.ts';

export type ViewName = 'feed' | 'lanes';

export const VIEW_NAMES: readonly ViewName[] = ['feed', 'lanes'];

export interface AppState {
  view: ViewName;
  /** Where in time we are looking. Null until something sets it. */
  cursor: Instant | null;
  /** The visible slice. Null means "use the manifest's, or work it out". */
  range: TimeWindow | null;
  /**
   * People currently shown. Null means everyone — deliberately distinct from
   * an empty set, which means the author has hidden every lane.
   */
  visible: ReadonlySet<PersonId> | null;
}

export const INITIAL_STATE: AppState = {
  view: 'feed',
  cursor: null,
  range: null,
  visible: null,
};

/**
 * Serialize to a URL hash fragment.
 *
 * A hash rather than a query string, because this is a static site with no
 * server and no router: the fragment never reaches a server, and changing it
 * does not reload the page.
 *
 * Instants are written as ISO strings rather than epoch numbers so a shared
 * link is legible, and so someone can hand-edit one.
 */
export function toHash(state: AppState): string {
  const parts: string[] = [];
  if (state.view !== INITIAL_STATE.view) parts.push(`view=${state.view}`);
  if (state.cursor !== null) parts.push(`t=${encodeURIComponent(isoOf(state.cursor))}`);
  if (state.range) {
    parts.push(`from=${encodeURIComponent(isoOf(state.range.from))}`);
    parts.push(`to=${encodeURIComponent(isoOf(state.range.to))}`);
  }
  if (state.visible) parts.push(`who=${[...state.visible].map(encodeURIComponent).join(',')}`);
  return parts.join('&');
}

/**
 * Read a hash fragment back.
 *
 * Anything unrecognized is ignored rather than treated as an error: a URL is
 * user-editable and may come from an older version, and a broken link should
 * degrade to a working page rather than a blank one.
 */
export function fromHash(hash: string): AppState {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const state: AppState = { ...INITIAL_STATE };

  const view = params.get('view');
  if (view && (VIEW_NAMES as readonly string[]).includes(view)) state.view = view as ViewName;

  const cursor = instantOf(params.get('t'));
  if (cursor !== null) state.cursor = cursor;

  const from = instantOf(params.get('from'));
  const to = instantOf(params.get('to'));
  // Both or neither: half a range is not a range.
  if (from !== null && to !== null && to > from) state.range = { from, to };

  const who = params.get('who');
  if (who !== null) {
    // An explicit empty `who=` is "everyone hidden", which is a real state and
    // must not be confused with the parameter being absent.
    state.visible = new Set(who.split(',').filter(Boolean));
  }

  return state;
}

function isoOf(instant: Instant): string {
  return new Date(instant).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function instantOf(text: string | null): Instant | null {
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Whether a person's lane should be drawn. */
export function isVisible(state: AppState, person: PersonId): boolean {
  return state.visible === null || state.visible.has(person);
}

/**
 * Toggle one person, starting from "everyone" the first time.
 *
 * Going from all-shown to hiding one has to materialize the full set first,
 * or the first click would hide everyone but the person clicked.
 */
export function toggleVisible(
  state: AppState,
  person: PersonId,
  everyone: readonly PersonId[],
): ReadonlySet<PersonId> {
  const current = state.visible ?? new Set(everyone);
  const next = new Set(current);
  if (next.has(person)) next.delete(person);
  else next.add(person);
  return next;
}
