import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  atDistance,
  atTime,
  nearestDistance,
  type Course,
  type Sample,
} from '../../core/course.ts';
import { assignLaneColors } from '../../core/palette.ts';
import type { Manifest } from '../../core/schema.ts';
import type { Instant } from '../../core/time.ts';
import type { PlacedItem } from '../../core/window.ts';
import { basemaps, defaultBasemapId, hillshade } from './basemaps.ts';

/**
 * The course, on a real map, with everyone plotted on it.
 *
 * Driven by the SAME cursor as the lanes and the feed — move it anywhere and
 * the runner's marker moves here. That is not a feature built for the map; it
 * is what falls out of the whole app being projections of one state object.
 *
 * Leaflet manages its own DOM, so this component keeps React out of the map's
 * internals entirely: React owns the container element and nothing inside it.
 * Mixing the two is the standard way to produce a map that redraws itself to
 * death on every render.
 *
 * WHY MAP DOTS CARRY NAMES. The lane palette is validated for ADJACENT pairs,
 * which is right for lanes and the feed where only neighbours touch. On a map
 * any two dots can land side by side, and under that harder test the palette
 * fails past three people. The label is the secondary encoding that makes it
 * legible — it is not a nicety, and it must not be removed.
 */

interface Props {
  manifest: Manifest;
  course: Course;
  /**
   * The track thinned for drawing — see `simplify`. A real export runs to
   * 120k points, and handing Leaflet a polyline that long costs seconds of
   * layout for detail finer than one screen pixel.
   */
  track: readonly Sample[];
  /** Items in view, so photos with GPS can be pinned where they were taken. */
  items: readonly PlacedItem[];
  at: Instant | null;
  /**
   * Metres along the course the reader is pointing at, shared with the
   * elevation profile. Distance rather than time, because an untimed course
   * has no clock to link the two views by.
   */
  focus: number | null;
  onFocus: (distance: number | null) => void;
  onCursor: (instant: Instant) => void;
  /** Clicking the course picks that point — see CourseCharts for why click. */
  onPick?: ((distance: number) => void) | undefined;
  /**
   * Thumbnails for the photo dots, when a folder is loaded. Optional because
   * the map works with a track and no media at all.
   */
  thumbnails?: {
    acquire: (item: PlacedItem['item']) => Promise<string | null>;
    release: (id: string) => void;
  };
  /** Short, and without the basemap chips: the rail beside a scrolling feed. */
  compact?: boolean;
}

export function CourseMap({
  manifest, course, track, items, at, focus, onFocus, onCursor, onPick,
  thumbnails, compact = false,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const runner = useRef<L.CircleMarker | null>(null);
  const photoLayer = useRef<L.LayerGroup | null>(null);
  const spot = useRef<L.CircleMarker | null>(null);
  // Read inside Leaflet's own handlers, which are bound once and would
  // otherwise close over the first render's props forever.
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const [layerId, setLayerId] = useState(defaultBasemapId);
  const [relief, setRelief] = useState(false);

  const colors = useMemo(() => assignLaneColors(manifest.people), [manifest.people]);
  const line = useMemo(
    () => track.map((s) => [s.lat, s.lon] as [number, number]),
    [track],
  );

  // ---- create once ----
  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = L.map(container.current, {
      zoomControl: true,
      /*
       * The wheel zooms, plainly. The usual advice is to require ctrl/⌘ so
       * the page can still be scrolled past the map — but this is a map you
       * come to in order to explore a course, on a desktop, with a mouse or
       * trackpad. Making the primary interaction the one that needs a
       * modifier gets that backwards. Keyboard remains available for
       * accessibility: the container is focusable and +/- work.
       */
      scrollWheelZoom: true,
      attributionControl: true,
    });
    map.current = instance;

    const drawn = track;

    /*
     * TWO STROKES, and this is measured rather than styled.
     *
     * The brand orange alone was unreadable on the topographic basemap, whose
     * hillshading is the same warm orange. Sampled against real tiles, the
     * bare line fell below a 3:1 contrast ratio across **87.6%** of an
     * OpenTopoMap tile and **99.4%** of a satellite tile.
     *
     * No single colour fixes that: white vanishes on the pale topo map, dark
     * vanishes on dark satellite imagery. A casing does, because the line's
     * silhouette then carries both a light and a dark edge, and one of them
     * always contrasts. With a #171512 casing, the most saturated
     * brand-consistent orange that clears 3:1 everywhere on both basemaps is
     * #F7A37A — brand orange mixed 40% toward white. Measured: 0.0% of either
     * tile below 3:1.
     *
     * If the colour is changed, re-measure. Do not eyeball it.
     */
    const casing = L.polyline(line, {
      color: '#171512', weight: 7, opacity: 0.85, interactive: false,
    });
    casing.addTo(instance);
    const route = L.polyline(line, {
      color: '#F7A37A', weight: 3, opacity: 1, interactive: false,
    });
    route.addTo(instance);

    /**
     * An invisible fat line under the visible one, carrying the interaction.
     *
     * A 3px stroke is a miserable hover target — on a switchbacking mountain
     * course the reader would be pixel-hunting. This one is wide enough to
     * catch a normal pointer movement and is drawn with zero opacity, so it
     * costs nothing visually.
     */
    const hit = L.polyline(line, { color: '#f26522', weight: 18, opacity: 0 });
    hit.addTo(instance);

    /**
     * Fit the course, once the container has a size.
     *
     * Leaflet works out the zoom from the container's measured dimensions, and
     * on the first paint that measurement is zero — so `fitBounds` silently
     * picks a near-world zoom and the course sits as a squiggle in the middle
     * of Montana. Retry on the next frame, when layout has happened.
     *
     * Only ever fits ONCE. Refitting on later resizes would yank the map back
     * from wherever the reader had panned to.
     */
    let fitted = false;
    const fit = () => {
      instance.invalidateSize();
      const bounds = route.getBounds();
      if (fitted || !bounds.isValid()) return;
      const size = instance.getSize();
      if (size.x === 0 || size.y === 0) return;
      instance.fitBounds(bounds, { padding: [24, 24] });
      fitted = true;
    };
    fit();
    const frame = requestAnimationFrame(fit);

    // Keep Leaflet's idea of the container in step with the real one; without
    // this, tiles come out grey after the panel is resized.
    const observer = new ResizeObserver(() => {
      instance.invalidateSize();
      fit();
    });
    observer.observe(container.current);

    // Created hidden. It is shown only once the cursor resolves to a real
    // position, so an untimed course never flashes a runner at the start line.
    runner.current = L.circleMarker(line[0] ?? [0, 0], {
      radius: 7,
      color: '#171512',
      weight: 2,
      fillColor: '#f26522',
      opacity: 0,
      fillOpacity: 0,
    }).addTo(instance);

    // Start and finish. These matter most on an untimed course, where there is
    // no moving marker and these are the only fixed points of reference.
    const ends = L.layerGroup().addTo(instance);
    const first = line[0];
    const last = line[line.length - 1];
    if (first) {
      L.circleMarker(first, {
        radius: 5, color: '#171512', weight: 2, fillColor: '#199e70', fillOpacity: 1,
      }).bindTooltip('Start', { direction: 'top' }).addTo(ends);
    }
    if (last) {
      L.circleMarker(last, {
        radius: 5, color: '#171512', weight: 2, fillColor: '#e66767', fillOpacity: 1,
      }).bindTooltip('Finish', { direction: 'top' }).addTo(ends);
    }

    // Where the reader is pointing, driven from here or from the profile.
    spot.current = L.circleMarker(line[0] ?? [0, 0], {
      radius: 6,
      color: '#171512',
      weight: 2,
      fillColor: '#e8e4dc',
      opacity: 0,
      fillOpacity: 0,
      interactive: false,
    }).addTo(instance);

    photoLayer.current = L.layerGroup().addTo(instance);

    // Clicking the course scrubs time: the map is an input, not just a
    // picture, and it reads back into the same cursor as everything else.
    hit.on('click', (event: L.LeafletMouseEvent) => {
      // One gesture, one meaning: clicking the course says "here". The app
      // resolves that to a time — from the track if it is timed, otherwise
      // from the photographs either side.
      const pick = onPickRef.current;
      if (pick) {
        const metres = nearestDistance(drawn, event.latlng.lat, event.latlng.lng);
        if (metres !== null) {
          pick(metres);
          return;
        }
      }
      const nearest = nearestSampleTo(course, event.latlng.lat, event.latlng.lng);
      if (nearest !== null) onCursor(nearest);
    });

    // Running a finger along the course moves the profile's crosshair. The
    // search runs over the SIMPLIFIED track — a few thousand points rather
    // than 120k, on every mouse move.
    hit.on('mousemove', (event: L.LeafletMouseEvent) => {
      const metres = nearestDistance(drawn, event.latlng.lat, event.latlng.lng);
      if (metres !== null) onFocusRef.current(metres);
    });
    hit.on('mouseout', () => onFocusRef.current(null));

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      instance.remove();
      map.current = null;
      runner.current = null;
      spot.current = null;
      photoLayer.current = null;
    };
    // Built once per course. Later renders update layers rather than rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [course]);

  // ---- basemap ----
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const chosen = basemaps().find((b) => b.id === layerId) ?? basemaps()[0];
    if (!chosen) return;

    const layers: L.TileLayer[] = [];
    if (relief) {
      layers.push(L.tileLayer(hillshade().url, { attribution: hillshade().attribution, maxZoom: 19 }));
    }
    layers.push(
      L.tileLayer(chosen.url, {
        attribution: chosen.attribution,
        maxZoom: chosen.maxZoom,
        // Past a source's own zoom, keep scaling its last tiles rather than
        // showing a grey grid.
        maxNativeZoom: chosen.maxZoom,
        opacity: relief ? 0.65 : 1,
      }),
    );
    for (const layer of layers) layer.addTo(instance);
    return () => {
      for (const layer of layers) layer.remove();
    };
  }, [layerId, relief]);

  // ---- the runner, following the shared cursor ----
  useEffect(() => {
    const marker = runner.current;
    if (!marker) return;
    const point = at === null ? null : atTime(course, at);
    if (!point) {
      marker.setStyle({ opacity: 0, fillOpacity: 0 });
      return;
    }
    marker.setStyle({ opacity: 1, fillOpacity: 1 });
    marker.setLatLng([point.lat, point.lon]);
  }, [at, course]);

  // ---- the pointer's position along the course ----
  useEffect(() => {
    const marker = spot.current;
    if (!marker) return;
    const point = focus === null ? null : atDistance(course, focus);
    if (!point) {
      marker.setStyle({ opacity: 0, fillOpacity: 0 });
      return;
    }
    marker.setStyle({ opacity: 1, fillOpacity: 1 });
    marker.setLatLng([point.lat, point.lon]);
  }, [focus, course]);

  // ---- where each photo was taken ----
  useEffect(() => {
    const layer = photoLayer.current;
    if (!layer) return;
    layer.clearLayers();
    // Every thumbnail taken out of the store must be handed back, or the blob
    // stays pinned for the life of the tab. See MediaStore.
    const held = new Set<string>();

    for (const entry of items) {
      const gps = entry.item.gps;
      if (!gps) continue;
      const name =
        manifest.people.find((p) => p.id === entry.item.person)?.name ?? entry.item.person;

      const marker = L.circleMarker([gps[0], gps[1]], {
        radius: 4,
        // A dark ring is the same casing trick as the course line, and for
        // the same measured reason: a person's hue alone is not readable
        // against arbitrary map imagery.
        weight: 2,
        color: '#171512',
        fillColor: colors.get(entry.item.person) ?? '#8a8378',
        fillOpacity: 0.9,
      })
        // The name IS the encoding here — see the note at the top. It shows
        // immediately; the picture replaces it once decoded.
        .bindTooltip(name, { direction: 'top' })
        .on('click', () => onCursor(entry.instant))
        .addTo(layer);

      if (!thumbnails) continue;

      marker.on('mouseover', () => {
        void thumbnails.acquire(entry.item).then((url) => {
          if (!url) return;
          held.add(entry.item.id);
          /*
           * Built as DOM rather than an HTML string. The person's name comes
           * from a folder on disk, and Leaflet would happily render markup in
           * it — a filename is not a place to trust.
           */
          const box = document.createElement('figure');
          box.className = 'mapshot';
          const img = document.createElement('img');
          img.src = url;
          img.alt = '';
          const caption = document.createElement('figcaption');
          caption.textContent = name;
          box.append(img, caption);
          marker.setTooltipContent(box);
        });
      });
    }

    return () => {
      for (const id of held) thumbnails?.release(id);
      held.clear();
    };
  }, [items, colors, manifest.people, onCursor, thumbnails]);

  const available = basemaps();

  return (
    <section className={compact ? 'coursemap coursemap--compact' : 'coursemap'}
             aria-label="Course map">
      {!compact && (
      <div className="coursemap__controls">
        {available.map((b) => (
          <button
            key={b.id}
            type="button"
            className={layerId === b.id ? 'chip chip--active' : 'chip'}
            aria-pressed={layerId === b.id}
            onClick={() => setLayerId(b.id)}
          >
            {b.label}
          </button>
        ))}
        <button
          type="button"
          className={relief ? 'chip chip--active' : 'chip'}
          aria-pressed={relief}
          onClick={() => setRelief(!relief)}
          title="Shade the terrain underneath"
        >
          Relief
        </button>
      </div>
      )}
      <div className="coursemap__canvas" ref={container} />
    </section>
  );
}

/**
 * The time at the track point closest to a clicked position.
 *
 * Null on an untimed course, which makes clicking the line a no-op there
 * rather than a jump to an invented moment.
 */
function nearestSampleTo(course: Course, lat: number, lon: number): Instant | null {
  if (!course.timed) return null;
  let best: Instant | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const sample of course.samples) {
    // Squared degrees is fine for "which is nearer" over a race-sized area,
    // and avoids a trigonometric call per sample on every click.
    const gap = (sample.lat - lat) ** 2 + (sample.lon - lon) ** 2;
    if (gap < bestGap && sample.at !== undefined) {
      bestGap = gap;
      best = sample.at;
    }
  }
  return best;
}
