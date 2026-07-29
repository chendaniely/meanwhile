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
import { resolveItemInstant, type Instant } from './time.ts';

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

export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, "") // strip combining accents from NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** "sam" -> "Sam", "jo-chen" -> "Jo Chen". A starting point the author edits. */
export function displayNameFor(id: PersonId): string {
  if (id === UNSORTED_PERSON) return 'Unsorted';
  return id
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
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

  const items: Item[] = [];
  const seenPeople = new Set<PersonId>();

  for (const file of files) {
    const person = personIdFromPath(file.path);
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

/** What to tell the author about what just came in. */
export function summarise(manifest: Manifest): IngestSummary {
  const peopleById = new Map(manifest.people.map((p) => [p.id, p]));
  const bySource: Record<string, number> = {};
  let photos = 0;
  let videos = 0;
  let placed = 0;
  let withGps = 0;
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;

  for (const item of manifest.items) {
    bySource[item.timeSource] = (bySource[item.timeSource] ?? 0) + 1;
    if (item.type === 'video') videos++;
    else photos++;
    if (item.gps) withGps++;

    const resolved = resolveItemInstant(item, peopleById.get(item.person), manifest.event);
    if (resolved.instant !== null) {
      placed++;
      if (resolved.instant < from) from = resolved.instant;
      if (resolved.instant > to) to = resolved.instant;
    }
  }

  return {
    total: manifest.items.length,
    photos,
    videos,
    placed,
    unplaced: manifest.items.length - placed,
    withGps,
    bySource,
    span: placed > 0 ? { from, to } : null,
    mvhdCount: bySource['mvhd'] ?? 0,
  };
}
