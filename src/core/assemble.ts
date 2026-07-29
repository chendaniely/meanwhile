/**
 * Turning a folder of files into a manifest.
 *
 * Pure and separate from the browser's folder-reading so the decisions here —
 * who shot what, what an item's id is, which event window to use — are
 * testable without a DOM, and so a future ingest CLI reuses them unchanged.
 */

import type { ExtractedMetadata } from './metadata.ts';
import type { Item, Manifest, Person, PersonId } from './schema.ts';
import { SCHEMA_VERSION } from './schema.ts';
import type { Instant } from './time.ts';
import { placeItems, isWithin, type TimeWindow } from './window.ts';

export interface IngestedFile {
  /** Path relative to the granted folder root, e.g. "sam/IMG_4417.jpg". */
  path: string;
  metadata: ExtractedMetadata;
  bytes?: number;
}

/** Where files that sit at the top level rather than in a person's folder go. */
export const UNSORTED_PERSON: PersonId = 'unsorted';

/**
 * The top-level folder name is the person.
 *
 * This is the convention the ingest teaches, and it matches how the media
 * arrives: each person hands over a folder, or a Google Photos "Download all"
 * ZIP that unpacks into one. Files loose at the root land in `unsorted`,
 * which is visible in the UI and reassignable rather than silently dropped.
 */
export function personIdFromPath(path: string): PersonId {
  const clean = path.replace(/^\/+/, '');
  const slash = clean.indexOf('/');
  if (slash <= 0) return UNSORTED_PERSON;
  return slugify(clean.slice(0, slash)) || UNSORTED_PERSON;
}

/**
 * The naming convention a device uses, e.g. "pxl" or "cam".
 *
 * Phones name their files distinctively, and that survives when the container
 * metadata does not. This is the strongest signal available for a video with
 * no device recorded — much stronger than time proximity, because two people
 * standing together shoot at the same moments but keep their own filenames.
 */
export function filenameFamily(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (/^PXL_/i.test(base)) return 'pxl';
  if (/^dji[_-]/i.test(base)) return 'dji';
  if (/^IMG[-_]\d{8}[-_]WA/i.test(base)) return 'whatsapp';
  if (/^\d{8}[_-]\d{6}/.test(base)) return 'cam';
  if (/^GOPR/i.test(base)) return 'gopro';
  const prefix = /^([A-Za-z]{3,4})[_-]\d/.exec(base);
  return prefix ? (prefix[1] as string).toLowerCase() : 'other';
}

export interface DeviceGrouping {
  personOf: Map<string, PersonId>;
  /** Files whose device was inferred from their filename convention. */
  byFamily: number;
  /** Files whose device was inferred from a neighbor in time. */
  byProximity: number;
}

/**
 * Group files by the device that took them, for flat folders.
 *
 * The main way media arrives is a Google Photos album download: one FLAT
 * folder with everyone's photos mixed together, so `personIdFromPath` has
 * nothing to work with and everything lands in `unsorted`. The device is the
 * next best signal, and in practice it is one device per person.
 *
 * Videos are the wrinkle: Apple writes make/model into the container, but
 * **Android writes no device metadata at all** — 25 real clips had none.
 * Three signals, strongest first:
 *
 *   1. **The filename convention.** Phones name files distinctively and that
 *      survives when the metadata does not. Decisive when one device owns the
 *      convention.
 *   2. **Proximity among the devices that share the convention**, for the
 *      case of two Pixels both writing `PXL_`.
 *   3. **Proximity among all devices**, last.
 *
 * Proximity alone was tried first and is not enough: two people standing
 * together shoot at the same moments, so it put eight Samsung-named clips on
 * the Pixel's lane. They keep their own filenames though, which is why the
 * convention has to outrank the clock.
 *
 * A convention no known device produces becomes its own person — an action
 * camera nobody took stills with is genuinely a fourth lane, not a mistake.
 */
export function groupByDevice(files: readonly IngestedFile[]): DeviceGrouping {
  const personOf = new Map<string, PersonId>();

  // Anchors: files that state their own device, in time order.
  const anchors: Array<{ at: number; device: string }> = [];
  // Which devices are known to produce each filename convention.
  const familyDevices = new Map<string, Set<string>>();

  for (const f of files) {
    const device = f.metadata.device;
    if (!device) continue;
    const at = roughInstant(f.metadata.at);
    if (at !== null) anchors.push({ at, device });
    const family = filenameFamily(f.path);
    const set = familyDevices.get(family) ?? new Set<string>();
    set.add(device);
    familyDevices.set(family, set);
  }
  anchors.sort((a, b) => a.at - b.at);

  let byFamily = 0;
  let byProximity = 0;

  for (const f of files) {
    if (f.metadata.device) {
      personOf.set(f.path, f.metadata.device);
      continue;
    }

    const family = filenameFamily(f.path);
    const candidates = familyDevices.get(family);
    const at = roughInstant(f.metadata.at);

    // One device owns this naming convention: unambiguous.
    if (candidates?.size === 1) {
      personOf.set(f.path, [...candidates][0] as string);
      byFamily++;
      continue;
    }

    // Several devices share it — two Pixels both name files PXL_ — so fall
    // back to proximity, but only among those devices.
    if (candidates && candidates.size > 1 && at !== null) {
      const nearest = nearestDevice(anchors, at, candidates);
      if (nearest) {
        personOf.set(f.path, nearest);
        byProximity++;
        continue;
      }
    }

    // A naming convention no known device produces is its own device — an
    // action camera nobody took stills with. Better a named fourth lane than
    // silently folding it into someone else's.
    if (!candidates && family !== 'other' && family !== 'whatsapp') {
      personOf.set(f.path, family);
      byFamily++;
      continue;
    }

    const nearest = at === null ? null : nearestDevice(anchors, at);
    if (nearest) {
      personOf.set(f.path, nearest);
      byProximity++;
    } else {
      personOf.set(f.path, UNSORTED_PERSON);
    }
  }

  return { personOf, byFamily, byProximity };
}

/**
 * A timestamp good enough to sort by, without needing a timezone.
 *
 * Grouping only cares which files are near each other, and every candidate is
 * within the same event, so reading a naive string as if it were UTC is fine
 * here. It would NOT be fine for placing an item on the timeline.
 */
function roughInstant(at: string | undefined): number | null {
  if (!at) return null;
  const t = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(at) ? at : `${at}Z`);
  return Number.isNaN(t) ? null : t;
}

function nearestDevice(
  anchors: ReadonlyArray<{ at: number; device: string }>,
  at: number,
  only?: ReadonlySet<string>,
): string | null {
  const pool = only ? anchors.filter((a) => only.has(a.device)) : anchors;
  if (pool.length === 0) return null;

  let best: string | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const a of pool) {
    const gap = Math.abs(a.at - at);
    if (gap < bestGap) {
      bestGap = gap;
      best = a.device;
    }
  }
  return best;
}

export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, "") // strip combining accents from NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * "sam" -> "Sam", "google-pixel-8-pro" -> "Google Pixel 8 Pro".
 *
 * Only ever a starting point: when grouping falls back to the device, the
 * author renames "Samsung SM-F721W" to whoever was carrying it.
 */
export function displayNameFor(id: PersonId): string {
  if (id === UNSORTED_PERSON) return 'Unsorted';
  return id
    .split('-')
    .filter(Boolean)
    .map((word) =>
      // Segments with digits are model codes and read better shouting:
      // "f721w" -> "F721W". Short segments are NOT uppercased, because
      // two-letter names are real: "jo-chen" must not become "JO Chen".
      /\d/.test(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

export interface AssembleOptions {
  title: string;
  /** IANA zone. Without it, naive timestamps cannot become instants. */
  timezone?: string;
  /** Carried through so re-ingesting a folder keeps names and clock offsets. */
  existingPeople?: readonly Person[];
  /** Carried through so re-ingesting keeps captions and manual placements. */
  existingItems?: readonly Item[];
}

/**
 * Build a manifest from ingested files.
 *
 * Item ids are the relative path. That makes them stable across re-ingests of
 * the same folder, which is what lets captions and hand-placed timestamps
 * survive re-running the ingest — the alternative, a counter or a hash of the
 * bytes, loses them the moment anything is renamed or re-saved.
 */
export function assembleManifest(files: readonly IngestedFile[], opts: AssembleOptions): Manifest {
  const byId = new Map<string, Person>();
  for (const p of opts.existingPeople ?? []) byId.set(p.id, p);

  const previous = new Map<string, Item>();
  for (const it of opts.existingItems ?? []) previous.set(it.id, it);

  // Folders win when they exist, because the author put them there on
  // purpose. Only when EVERY file sits loose at the root — which is what a
  // Google Photos album download looks like — do we fall back to the device.
  const foldered = files.some((f) => personIdFromPath(f.path) !== UNSORTED_PERSON);
  const byDevice = foldered ? null : groupByDevice(files);

  const items: Item[] = [];
  const seenPeople = new Set<PersonId>();

  for (const file of files) {
    const person = byDevice?.personOf.get(file.path) ?? personIdFromPath(file.path);
    seenPeople.add(person);

    const m = file.metadata;
    const item: Item = {
      id: file.path,
      person,
      type: m.type,
      src: file.path,
      timeSource: m.timeSource,
    };
    if (m.at !== undefined) item.at = m.at;
    if (m.gps !== undefined) item.gps = m.gps;
    if (m.duration !== undefined) item.duration = m.duration;
    if (m.width !== undefined) item.width = m.width;
    if (m.height !== undefined) item.height = m.height;
    if (m.orientation !== undefined) item.orientation = m.orientation;
    if (file.bytes !== undefined) item.bytes = file.bytes;

    // A hand-placed time and a caption are the author's work, not the file's.
    // Re-reading the bytes must never throw them away.
    const before = previous.get(item.id);
    if (before?.note !== undefined) item.note = before.note;
    if (before?.timeSource === 'manual' && before.at !== undefined) {
      item.at = before.at;
      item.timeSource = 'manual';
    }

    items.push(item);
  }

  const people: Person[] = [...seenPeople].sort().map((id) => {
    const existing = byId.get(id);
    if (existing) return existing;
    return { id, name: displayNameFor(id) };
  });

  const manifest: Manifest = {
    schema: SCHEMA_VERSION,
    event: opts.timezone ? { title: opts.title, timezone: opts.timezone } : { title: opts.title },
    people,
    items,
  };
  return manifest;
}

export interface IngestSummary {
  total: number;
  photos: number;
  videos: number;
  placed: number;
  unplaced: number;
  withGps: number;
  /** Counts by timeSource, so the UI can show how trustworthy the set is. */
  bySource: Record<string, number>;
  /** Earliest and latest placed instants, or null when nothing is placed. */
  span: { from: Instant; to: Instant } | null;
  /**
   * Items whose only timestamp came from `mvhd`. Apple writes local time
   * there with no zone, so these deserve a warning rather than silence.
   */
  mvhdCount: number;
}

/**
 * How people were worked out, for the report.
 *
 * Worth surfacing rather than hiding: device grouping is a guess, and the
 * proximity fallback is a guess on top of a guess. The author is the only one
 * who knows whose phone was whose.
 */
export interface GroupingInfo {
  /** 'folders' when subfolders were used, 'device' for a flat folder. */
  by: 'folders' | 'device';
  /** Files whose device came from their filename convention. Reliable. */
  byFamily: number;
  /** Files whose device came from a neighbor in time. A guess. */
  byProximity: number;
}

export function describeGrouping(files: readonly IngestedFile[]): GroupingInfo {
  const foldered = files.some((f) => personIdFromPath(f.path) !== UNSORTED_PERSON);
  if (foldered) return { by: 'folders', byFamily: 0, byProximity: 0 };
  const { byFamily, byProximity } = groupByDevice(files);
  return { by: 'device', byFamily, byProximity };
}

/**
 * What to tell the author about what just came in.
 *
 * When a `range` is given, the counts describe what is INSIDE it — that is
 * the working set, and reporting the whole folder would contradict what the
 * views are showing. Unplaced items are never windowed: having no time at all
 * is not the same as falling outside a range.
 */
export function summarize(manifest: Manifest, range?: TimeWindow): IngestSummary {
  const { placed, unplaced } = placeItems(manifest);
  const visible = range ? placed.filter((p) => isWithin(p.instant, range)) : placed;

  const bySource: Record<string, number> = {};
  let photos = 0;
  let videos = 0;
  let withGps = 0;

  const counted = [...visible.map((p) => p.item), ...unplaced.map((u) => u.item)];
  for (const item of counted) {
    bySource[item.timeSource] = (bySource[item.timeSource] ?? 0) + 1;
    if (item.type === 'video') videos++;
    else photos++;
    if (item.gps) withGps++;
  }

  const first = visible[0];
  const last = visible[visible.length - 1];

  return {
    total: counted.length,
    photos,
    videos,
    placed: visible.length,
    unplaced: unplaced.length,
    withGps,
    bySource,
    span: first && last ? { from: first.instant, to: last.instant } : null,
    mvhdCount: bySource['mvhd'] ?? 0,
  };
}
