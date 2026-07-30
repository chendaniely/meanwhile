/**
 * Where the map tiles come from.
 *
 * Every source but one needs **no API key**, so the map works the moment you
 * open it without any configuration. The one exception is `outdoors`
 * (Thunderforest), which sets `needsKey: true` below; `basemaps()` filters it
 * out of the list unless a build-time key is present, so an unconfigured
 * deploy never offers a basemap that would fail. A key is strictly an
 * upgrade: if one is configured the nicer trail basemap appears in the list,
 * and if it is missing or expired the map carries on with the free ones
 * rather than showing a grey grid.
 *
 * A NOTE ON THE KEY, because it is easy to get wrong: this is a static site,
 * so a build-time key is inlined into the published JavaScript and anybody
 * can read it. A GitHub Actions secret keeps it out of the repository, not
 * out of the page. That is normal for client-side maps, and providers handle
 * it with **HTTP-referrer restrictions** — lock the key to the site's domain
 * and it is useless anywhere else. Do that; do not rely on it being hidden.
 *
 * Attribution is not decoration. Every one of these requires it, and OSM's
 * policy is explicit that it must be legible without interacting with the
 * map. Leaflet renders the `attribution` string; do not remove it.
 */

export interface Basemap {
  id: string;
  label: string;
  url: string;
  attribution: string;
  maxZoom: number;
  /**
   * UNUSED: nothing in the codebase reads this field (verified — no
   * `.overlay` reference outside this file). `CourseMap.tsx` decides
   * layer order itself, and adds the hillshade layer FIRST (underneath the
   * chosen basemap, not over it) regardless of this flag. Kept on `HILLSHADE`
   * below as documentation of intent, not as something any code branches on.
   * Remove or wire it up if it needs to do real work.
   */
  overlay?: boolean;
  /** Only offered when a key is configured. */
  needsKey?: boolean;
}

/** Read at build time. Vite inlines it — see the note above about visibility. */
const KEY = (import.meta.env['VITE_THUNDERFOREST_KEY'] as string | undefined) ?? '';

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const BASEMAPS: Basemap[] = [
  {
    // The default for a good reason: contours and hillshading already baked
    // in, which is what a mountain trail race actually needs.
    id: 'topo',
    label: 'Topographic',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: `${OSM_ATTRIBUTION}, <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`,
    maxZoom: 17,
  },
  {
    id: 'satellite',
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
  },
  {
    id: 'street',
    label: 'Street',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: OSM_ATTRIBUTION,
    maxZoom: 19,
  },
  {
    // Purpose-built for trails, and clearly the nicest of the lot — but it
    // needs a key, so it is an addition rather than the default.
    id: 'outdoors',
    label: 'Outdoors',
    url: `https://tile.thunderforest.com/outdoors/{z}/{x}/{y}.png?apikey=${KEY}`,
    attribution: `${OSM_ATTRIBUTION}, tiles &copy; <a href="https://www.thunderforest.com">Thunderforest</a>`,
    maxZoom: 22,
    needsKey: true,
  },
];

const HILLSHADE: Basemap = {
  id: 'hillshade',
  label: 'Hillshade',
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}',
  attribution: 'Hillshade &copy; Esri',
  maxZoom: 16,
  overlay: true,
};

export function basemaps(): Basemap[] {
  return BASEMAPS.filter((map) => !map.needsKey || KEY !== '');
}

/** Terrain relief to lay under a flat street map. */
export function hillshade(): Basemap {
  return HILLSHADE;
}

export function defaultBasemapId(): string {
  // The keyed trail map when it is available, topographic otherwise.
  return KEY !== '' ? 'outdoors' : 'topo';
}
