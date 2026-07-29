/**
 * Every object URL the app creates, and every one it revokes.
 *
 * THE TRAP THIS EXISTS TO CLOSE: `URL.createObjectURL` pins its blob in
 * memory until `revokeObjectURL` is called. Nothing collects it — not GC, not
 * removing the <img>. Create one per tile while scrolling 2,000 files and the
 * tab grows until it dies. So every URL in the app comes from here, and this
 * is the only place that revokes.
 *
 * Two mechanisms, and both are needed:
 *
 *   - **Reference counting**, so a thumbnail is never revoked while a tile is
 *     still showing it.
 *   - **A byte budget with LRU eviction**, so memory is bounded even when
 *     everything has been released. Released entries are kept until the
 *     budget bites, because scrolling back up should not mean decoding again.
 */

import type { Item } from '../../core/schema.ts';
import { decodeThumbnail, decodeVideoPoster } from './thumbnails.ts';

/** Roughly 400 thumbnails at ~240KB each. Far below what a tab can hold. */
const DEFAULT_BUDGET_BYTES = 96 * 1024 * 1024;

/** Decoding is worker-backed but not free; too many at once starves scroll. */
const MAX_CONCURRENT_DECODES = 4;

interface Entry {
  url: string;
  bytes: number;
  refs: number;
  lastUsed: number;
}

export interface MediaStoreOptions {
  budgetBytes?: number;
  /** Longest edge for tile thumbnails, in CSS pixels. */
  thumbWidth?: number;
}

export class MediaStore {
  private readonly files: ReadonlyMap<string, File>;
  private readonly budget: number;
  private readonly thumbWidth: number;

  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<string | null>>();
  /** Full-size URLs, for playing a video or opening a photo at full size. */
  private readonly originals = new Map<string, Entry>();

  private used = 0;
  private clock = 0;
  private running = 0;
  private readonly queue: Array<() => void> = [];
  private disposed = false;

  constructor(files: ReadonlyMap<string, File>, options: MediaStoreOptions = {}) {
    this.files = files;
    this.budget = options.budgetBytes ?? DEFAULT_BUDGET_BYTES;
    this.thumbWidth = options.thumbWidth ?? 480;
  }

  has(id: string): boolean {
    return this.files.has(id);
  }

  /**
   * A small, decoded-down image for a tile. Hold it with `release` when done.
   *
   * Returns null when the browser cannot decode the file — a HEIC outside
   * Safari, most commonly. The item still has its place on the timeline; only
   * the picture is missing.
   */
  async acquireThumbnail(item: Item): Promise<string | null> {
    if (this.disposed) return null;

    const existing = this.entries.get(item.id);
    if (existing) {
      existing.refs++;
      existing.lastUsed = ++this.clock;
      return existing.url;
    }

    const inFlight = this.pending.get(item.id);
    if (inFlight) {
      const url = await inFlight;
      // The entry may have been evicted between resolution and this await.
      const settled = this.entries.get(item.id);
      if (settled) {
        settled.refs++;
        settled.lastUsed = ++this.clock;
      }
      return url;
    }

    const work = this.decode(item);
    this.pending.set(item.id, work);
    try {
      return await work;
    } finally {
      this.pending.delete(item.id);
    }
  }

  private async decode(item: Item): Promise<string | null> {
    const file = this.files.get(item.id);
    if (!file) return null;

    const blob = await this.enqueue(async () => {
      const options = {
        maxWidth: this.thumbWidth,
        ...(item.width !== undefined ? { naturalWidth: item.width } : {}),
      };
      return item.type === 'video'
        ? decodeVideoPoster(file, {
            ...options,
            ...(item.duration !== undefined ? { duration: item.duration } : {}),
          })
        : decodeThumbnail(file, options);
    });

    if (!blob || this.disposed) return null;

    const entry: Entry = {
      url: URL.createObjectURL(blob),
      bytes: blob.size,
      refs: 1,
      lastUsed: ++this.clock,
    };
    this.entries.set(item.id, entry);
    this.used += entry.bytes;
    this.evictIfOver();
    return entry.url;
  }

  release(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    // Deliberately not revoked here. Scrolling back up should not decode
    // again; the budget below is what actually bounds memory.
    this.evictIfOver();
  }

  /**
   * The untouched file, for playing a video or viewing a photo full size.
   *
   * Separate from the thumbnail cache and never evicted while referenced —
   * revoking the URL under a playing <video> stops playback dead.
   */
  acquireOriginal(id: string): string | null {
    if (this.disposed) return null;
    const existing = this.originals.get(id);
    if (existing) {
      existing.refs++;
      return existing.url;
    }
    const file = this.files.get(id);
    if (!file) return null;
    const entry: Entry = {
      url: URL.createObjectURL(file),
      bytes: file.size,
      refs: 1,
      lastUsed: ++this.clock,
    };
    this.originals.set(id, entry);
    return entry.url;
  }

  releaseOriginal(id: string): void {
    const entry = this.originals.get(id);
    if (!entry) return;
    entry.refs--;
    if (entry.refs <= 0) {
      // Originals ARE revoked as soon as nobody holds them: one 4GB clip
      // pinned in memory is a different order of problem from a thumbnail.
      URL.revokeObjectURL(entry.url);
      this.originals.delete(id);
    }
  }

  private evictIfOver(): void {
    if (this.used <= this.budget) return;
    const evictable = [...this.entries.entries()]
      .filter(([, e]) => e.refs === 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

    for (const [id, entry] of evictable) {
      if (this.used <= this.budget) break;
      URL.revokeObjectURL(entry.url);
      this.entries.delete(id);
      this.used -= entry.bytes;
    }
    // If everything is still referenced there is nothing to free; that means
    // more tiles are on screen than the budget allows, which is a layout
    // problem rather than a leak.
  }

  /** Bounded parallelism, so decoding does not starve scrolling. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.running++;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.running--;
            const next = this.queue.shift();
            if (next) next();
          });
      };
      if (this.running < MAX_CONCURRENT_DECODES) run();
      else this.queue.push(run);
    });
  }

  /** Revoke everything. Called when a different folder is loaded. */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) URL.revokeObjectURL(entry.url);
    for (const entry of this.originals.values()) URL.revokeObjectURL(entry.url);
    this.entries.clear();
    this.originals.clear();
    this.queue.length = 0;
    this.used = 0;
  }

  /** For the debug readout, and for tests to assert nothing leaked. */
  stats(): { cached: number; bytes: number; originals: number; queued: number } {
    return {
      cached: this.entries.size,
      bytes: this.used,
      originals: this.originals.size,
      queued: this.queue.length,
    };
  }
}
