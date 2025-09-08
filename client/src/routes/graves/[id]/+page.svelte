<script>
  import { onMount } from 'svelte';
  import mapboxgl from 'mapbox-gl';
  import { goto } from '$app/navigation';

  // ================================
  // Mapbox config
  // ================================
  mapboxgl.accessToken = 'pk.eyJ1IjoiaW50ZWxsaXRlY2giLCJhIjoiY21jZTZzMm1xMHNmczJqcHMxOWtmaTd4aiJ9.rKhf7nuky9mqxxFAAIJlrQ';

  // ================================
  // State (Svelte 5 runes)
  // ================================
  let mapContainer = $state(null);
  let map = $state(null);
  let isMapLoaded = $state(false);
  let mapStyle = $state('mapbox://styles/mapbox/streets-v12');

  let properties = $state([]);
  let lineStringFeatures = $state([]);

  let selectedProperty = $state(null);
  let selectedBlock = $state('');
  let matchName = $state('');
  let showSearchDropdown = $state(false);

  let userLocation = $state(null);        // {lng,lat,accuracy}
  let hasInitialFix = $state(false);
  let userLocationWatchId = $state(null);
  let isTracking = $state(false);
  let selectedLineString = $state(null);
  let isNavigating = $state(false);
  let currentRoute = $state(null);        // {coordinates:[[lng,lat],...], distance, steps:[]}
  let directionUpdateInterval = $state(null);
  let distanceToDestination = $state(0);
  let progressPercentage = $state(0);
  let currentStep = $state('');

  let errorMessage = $state(null);
  let successMessage = $state(null);

  // Custom modal data or false
  let showExitPopup = $state(false);

  // Queue destination while waiting for first good fix
  let pendingDestination = $state(null);

  // Geolocate control (created after load)
  let geolocate = null;

  // Layer/source IDs for in-style pins
  const USER_SRC = 'user-point';
  const USER_LAYER = 'user-point-symbol';
  const DEST_SRC = 'destination-point';
  const DEST_LAYER = 'destination-point-symbol';

  // Entrances
  const ENTRANCES = [{ lng: 120.9767, lat: 14.4727, name: 'Main Entrance' }];

  const mapStyles = [
    { value: 'mapbox://styles/mapbox/streets-v12', label: 'Mapbox Streets' },
    { value: 'mapbox://styles/mapbox/satellite-v9', label: 'Mapbox Satellite' },
    { value: 'mapbox://styles/mapbox/outdoors-v12', label: 'Mapbox Outdoors' },
    { value: 'mapbox://styles/mapbox/light-v11', label: 'Mapbox Light' },
    { value: 'mapbox://styles/mapbox/dark-v11', label: 'Mapbox Dark' },
    { value: 'osm', label: 'OpenStreetMap' }
  ];

  // ================================
  // Proximity logic — HARD 10m arrival
  // ================================
  const ARRIVAL_THRESHOLD_M = 10; // auto-stop only at ≤10m
  const BASE_NEAR_M    = 70;      // early "malapit na" alert
  let hasNearAlertFired = $state(false);
  let hasArrivedOnce    = $state(false);
  let lastProximityCheckTs = 0;

  // ================================
  // Lifecycle
  // ================================
  onMount(async () => {
    // URL preselect: /graves/:block
    const segs = location.pathname.split('/');
    if (segs[1] === 'graves' && segs[2]) {
      selectedBlock = decodeURIComponent(segs[2]);
      matchName = selectedBlock;
    }

    await initializeMap();
    startTracking();

    await whenMapIdle();
    await loadLineStringFeatures();
    await loadLocatorBlockFeatures();

    await zoomOutToLocatorBounds({ animate: false, padding: 60 });
    await loadLocatorBlockFeatures();

    if (userLocation) {
      map.easeTo({ center: [userLocation.lng, userLocation.lat], zoom: 19 });
    } else {
      map.easeTo({ zoom: 18 });
    }

    if (selectedBlock) {
      const p = getFeatureByName(selectedBlock);
      if (p) {
        selectedProperty = p;
        matchName = p.name;
        setTimeout(async () => {
          if (userLocation) {
            await startNavigationToProperty(p);
            toastSuccess(`Auto-navigating to ${p.name}`);
          } else {
            pendingDestination = p;
            toastSuccess(`Selected ${p.name}. Waiting for your location...`);
          }
        }, 400);
      }
    }

    if (navigator.permissions?.query) {
      try {
        const { state } = await navigator.permissions.query({ name: 'geolocation' });
        if (state === 'denied') {
          toastError('Location permission is blocked. Enable it in your browser settings.');
        }
      } catch {}
    }
  });

  // Keep matchName synced with selectedProperty
  $effect(() => {
    if (selectedProperty?.name && selectedProperty.name !== matchName) {
      matchName = selectedProperty.name;
    }
  });

  // ================================
  // Map setup
  // ================================
  async function initializeMap() {
    if (!mapContainer) return;

    const styleObj = mapStyle === 'osm'
      ? {
          version: 8,
          sources: {
            osm: {
              type: 'raster',
              tiles: ['https://a.tile.openstreetmap.org/{z}/{x}/{y}.png'],
              tileSize: 256,
              attribution: '© OpenStreetMap contributors',
              maxzoom: 19
            }
          },
          layers: [{ id: 'osm-tiles', type: 'raster', source: 'osm', minzoom: 0, maxzoom: 22 }]
        }
      : mapStyle;

    map = new mapboxgl.Map({
      container: mapContainer,
      style: styleObj,
      center: [120.9763, 14.4725],
      zoom: 20,
      attributionControl: true,
      logoPosition: 'bottom-right'
    });

    map.addControl(new mapboxgl.NavigationControl(), 'top-right');

    map.on('load', () => {
      addCemeterySourcesAndLayers();
      addUserAndDestinationLayers();
      isMapLoaded = true;

      geolocate = new mapboxgl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: false,
        showUserLocation: false
      });
      map.addControl(geolocate);

      geolocate.on('geolocate', (e) => {
        const { longitude: lng, latitude: lat, accuracy } = e?.coords || {};
        setUserPin(lng, lat, accuracy);
      });

      if (isTracking) {
        attachGeoWatch();
        try { geolocate.trigger(); } catch {}
      }
    });

    map.on('error', (e) => {
      console.error('Map error:', e?.error);
      toastError('Map error: ' + (e?.error?.message ?? 'Unknown'));
    });
  }

function addCemeterySourcesAndLayers() {
  // --- sources
  if (!map.getSource('subdivision-blocks-source')) {
    map.addSource('subdivision-blocks-source', {
      type: 'vector',
      url: 'mapbox://intellitech.cmdysziqy2z5w1ppbaq7avd4f-1cy1n' // paths (LineString)
    });
  }

  // NEW: polygons/multipolygons tileset for block shapes
  if (!map.getSource('subdivision-shapes-source')) {
    map.addSource('subdivision-shapes-source', {
      type: 'vector',
      url: 'mapbox://intellitech.cme0cjopc10cw1mn11nkghf53-1j2jx' // polygons
    });
  }

  if (!map.getSource('locator-blocks-source')) {
    map.addSource('locator-blocks-source', {
      type: 'vector',
      url: 'mapbox://intellitech.cme0cp8bs0ato1plqyzz7xcp8-1904w'
    });
  }

  // --- path lines (kept on top of fills)
  if (!map.getLayer('cemetery-paths')) {
    map.addLayer({
      id: 'cemetery-paths',
      type: 'line',
      source: 'subdivision-blocks-source',
      'source-layer': 'subdivision-blocks',
      filter: ['==', '$type', 'LineString'],
      paint: {
        'line-color': '#ffffff',
        'line-width': 0,
        'line-opacity': 0 
      }
    });
  }

  // --- NEW: subdivision polygon fills (rendered UNDER the white paths)
  // note: $type returns 'Polygon' for both Polygon and MultiPolygon, so this catches both.
// --- subdivision polygon fills (PURE WHITE), rendered under the white paths
if (!map.getLayer('subdivision-blocks-fill')) {
  map.addLayer(
    {
      id: 'subdivision-blocks-fill',
      type: 'fill',
      source: 'subdivision-shapes-source',
      'source-layer': 'subdivision-blocks', // adjust if your layer name differs
      filter: ['==', '$type', 'Polygon'],
      paint: {
        'fill-color': '#009966',        // PURE WHITE
        'fill-opacity': 1,              // fully opaque
        'fill-outline-color': '#009966' // white outline (invisible against fill)
      }
    },
    'cemetery-paths' // keep under the path lines
  );
} else {
  // if the layer already exists, force it to white
  map.setPaintProperty('subdivision-blocks-fill', 'fill-color', '#ffffff');
  map.setPaintProperty('subdivision-blocks-fill', 'fill-opacity', 1);
  map.setPaintProperty('subdivision-blocks-fill', 'fill-outline-color', '#ffffff');
}

// OPTIONAL: remove the separate stroke layer if you previously added it
if (map.getLayer('subdivision-blocks-stroke')) {
  map.removeLayer('subdivision-blocks-stroke');
}

  // optional: thin stroke above the fill but still under paths (for crisper edges)
  if (!map.getLayer('subdivision-blocks-stroke')) {
    map.addLayer(
      {
        id: 'subdivision-blocks-stroke',
        type: 'line',
        source: 'subdivision-shapes-source',
        'source-layer': 'subdivision-blocks', // <- adjust if needed
        filter: ['==', '$type', 'Polygon'],
        paint: {
          'line-color': '#0f766e',
          'line-width': 0.8,
          'line-opacity': 0.6
        }
      },
      'cemetery-paths'
    );
  }

  // --- locator points + labels (unchanged)
  if (!map.getLayer('locator-blocks')) {
    map.addLayer({
      id: 'locator-blocks',
      type: 'circle',
      source: 'locator-blocks-source',
      'source-layer': 'locator-blocks',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 15, 6, 20, 10, 22, 14],
        'circle-color': '#ef4444',
        'circle-stroke-width': 3,
        'circle-stroke-color': 'transparent',
        'circle-opacity': 0.0
      }
    });
  }

  if (!map.getLayer('block-markers')) {
    map.addLayer({
      id: 'block-markers',
      type: 'circle',
      source: 'locator-blocks-source',
      'source-layer': 'locator-blocks',
      paint: {
        'circle-radius': 4,
        'circle-color': '#008000',
        'circle-opacity': 0.5
      }
    });
  }

  if (!map.getLayer('block-labels')) {
    map.addLayer({
      id: 'block-labels',
      type: 'symbol',
      source: 'locator-blocks-source',
      'source-layer': 'locator-blocks',
      layout: {
        'text-field': ['get', 'name'],
        'text-size': 8,
        'text-offset': [0, 1.5],
        'text-anchor': 'top',
        'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold']
      },
      paint: {
        'text-color': '#374151',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1
      }
    });
  }

  // interactions
  map.on('click', 'block-markers', (e) => {
    const f = e.features?.[0];
    const name = f?.properties?.name;
    if (!name) return;

    const [lng, lat] = f.geometry.coordinates;
    const property = { id: f.id ?? name, name, lng, lat, feature: f };
    selectedProperty = property;
    matchName = name;

    goto(`/graves/${encodeURIComponent(name)}`);
    startNavigationToProperty(property);
    toastSuccess(`Selected: ${name}`);
  });

  map.on('mouseenter', 'block-markers', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'block-markers', () => (map.getCanvas().style.cursor = ''));
}

  // --- in-style user/destination point sources & SYMBOL layers (pin icons)
  function addUserAndDestinationLayers() {
    if (!map.getSource(USER_SRC)) map.addSource(USER_SRC, { type: 'geojson', data: emptyPoint() });
    if (!map.getSource(DEST_SRC)) map.addSource(DEST_SRC, { type: 'geojson', data: emptyPoint() });

    ensurePinImages();

    if (!map.getLayer(USER_LAYER)) {
      map.addLayer({
        id: USER_LAYER,
        type: 'symbol',
        source: USER_SRC,
        layout: {
          'icon-image': 'pin-user',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.45, 20, 0.9],
          'icon-allow-overlap': true,
          'icon-anchor': 'bottom'
        }
      });
    }

    if (!map.getLayer(DEST_LAYER)) {
      map.addLayer({
        id: DEST_LAYER,
        type: 'symbol',
        source: DEST_SRC,
        layout: {
          'icon-image': 'pin-dest',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.45, 20, 0.9],
          'icon-allow-overlap': true,
          'icon-anchor': 'bottom'
        }
      });
    }
  }

  function ensurePinImages() {
    if (!map.hasImage('pin-user')) map.addImage('pin-user', makePinImage('#ef4444'));
    if (!map.hasImage('pin-dest')) map.addImage('pin-dest', makePinImage('#1d4ed8'));
  }

  // Draw a teardrop pin with white inner circle via <canvas>
  function makePinImage(color = '#ef4444', size = 64) {
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d');

    const w = size, h = size;
    const cx = w / 2;
    const cy = h * 0.42;
    const r  = h * 0.22;
    const tipX = cx, tipY = h - 2;

    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.35, Math.PI * 0.15, Math.PI * 0.85, true);
    const leftX = cx - r * 1.35;
    const rightX = cx + r * 1.35;
    const sideY = cy + r * 0.9;
    ctx.quadraticCurveTo(leftX, sideY + r * 1.3, tipX, tipY);
    ctx.quadraticCurveTo(rightX, sideY + r * 1.3, rightX, cy);
    ctx.closePath();

    ctx.fillStyle = color;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.9, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    const imageData = ctx.getImageData(0, 0, w, h);
    return { width: w, height: h, data: imageData.data };
  }

  function emptyPoint() { return { type: 'FeatureCollection', features: [] }; }
  function pointFeature(lng, lat, props = {}) {
    return { type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lng, lat] } };
  }
  function setPointInSource(srcId, lng, lat, props = {}) {
    const src = map.getSource(srcId); if (!src) return;
    src.setData({ type: 'FeatureCollection', features: [pointFeature(lng, lat, props)] });
  }
  function clearPointSource(srcId) {
    const src = map.getSource(srcId); if (!src) return;
    src.setData(emptyPoint());
  }

  async function whenMapIdle() {
    if (!map) return;
    await new Promise((res) => map.once('idle', res));
    await new Promise((res) => setTimeout(res, 200));
  }

  function normalizeName(v) { if (v === undefined || v === null) return ''; return String(v).trim().toLowerCase(); }
  function toDisplayName(v) { return String(v ?? '').trim(); }

  async function loadLocatorBlockFeatures() {
    if (!map) return;
    await waitForSourceTiles('locator-blocks-source');
    const feats = map.querySourceFeatures('locator-blocks-source', { sourceLayer: 'locator-blocks' });

    const processed = []; const seen = new Set();
    for (const f of feats) {
      const rawName = f?.properties?.name;
      const displayName = toDisplayName(rawName);
      const key = normalizeName(rawName);
      if (!key || seen.has(key)) continue;
      seen.add(key);

      const coords = Array.isArray(f?.geometry?.coordinates) ? f.geometry.coordinates : null;
      if (!coords || coords.length < 2) continue;
      const [lng, lat] = coords;

      processed.push({ id: f.id ?? displayName, name: displayName, lng, lat, feature: f });
    }
    properties = processed;
    console.log('Locator blocks (FULL coverage):', properties.length);
  }

  async function loadLineStringFeatures() {
    try {
      const feats = map.querySourceFeatures('subdivision-blocks-source', {
        sourceLayer: 'subdivision-blocks', filter: ['==', '$type', 'LineString']
      });
      lineStringFeatures = feats.map((f) => ({
        id: f.id ?? `${f.properties?.id ?? Math.random()}`,
        coordinates: f.geometry.coordinates,
        properties: f.properties ?? {},
        geometry: f.geometry
      }));
      console.log('Internal LineStrings:', lineStringFeatures.length);
    } catch (e) {
      console.error('LineString load error', e);
    }
  }

  function getFeatureByName(name) {
    const needle = normalizeName(name);
    if (!needle) return null;
    let found = properties.find(p => normalizeName(p?.name) === needle);
    if (found) return found;
    found = properties.find(p => normalizeName(p?.name).includes(needle));
    return found ?? null;
  }

  function cemeteryBoundsFromPolygon(poly) {
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const [lng, lat] of poly) {
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
    }
    return [[minLng, minLat], [maxLng, maxLat]];
  }

  async function zoomOutToLocatorBounds({ animate = false, padding = 60 } = {}) {
    const [sw, ne] = cemeteryBoundsFromPolygon(getCemeteryBoundary());
    const b = new mapboxgl.LngLatBounds(sw, ne);
    map.fitBounds(b, { padding, animate });
    await whenMapIdle();
    await waitForSourceTiles('locator-blocks-source');
    await waitForSourceTiles('subdivision-blocks-source');
  }

  async function waitForSourceTiles(sourceId, { tries = 20, delay = 150 } = {}) {
    for (let i = 0; i < tries; i++) {
      if (map.isSourceLoaded?.(sourceId) && map.areTilesLoaded?.()) return;
      await whenMapIdle();
      await new Promise(r => setTimeout(r, delay));
    }
  }
// HALF OF THE SCRIPT


// ================================
// Geolocation
// ================================
function setUserPin(lng, lat, accuracy) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
  userLocation = { lng, lat, accuracy };
  hasInitialFix = true;
  setPointInSource(USER_SRC, lng, lat, { accuracy });

  if (pendingDestination) {
    const dest = pendingDestination; pendingDestination = null;
    startNavigationToProperty(dest);
  }
  checkProximityNow();
}

function startTracking() {
  if (!navigator.geolocation) return toastError('Geolocation not supported');
  if (isTracking) return;
  isTracking = true;

  if (map && isMapLoaded && geolocate) {
    attachGeoWatch();
    try { geolocate.trigger(); } catch {}
  } else {
    const once = () => {
      map.off('load', once);
      if (geolocate) { attachGeoWatch(); try { geolocate.trigger(); } catch {} }
    };
    map?.on('load', once);
  }
}

function attachGeoWatch() {
  if (userLocationWatchId) return;
  userLocationWatchId = navigator.geolocation.watchPosition(
    (pos) => setUserPin(pos.coords.longitude, pos.coords.latitude, pos.coords.accuracy),
    (err) => {
      console.warn('watchPosition error:', err);
      if (err?.code === 1) toastError('Location permission denied. Enable it in your browser settings.');
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

function stopTracking() {
  if (userLocationWatchId) {
    navigator.geolocation.clearWatch(userLocationWatchId);
    userLocationWatchId = null;
  }
  isTracking = false;
}

// ================================
// Navigation
// ================================
const OFF_ROUTE_REROUTE_M   = 25;
const REROUTE_MIN_MS        = 8000;
const STRAIGHT_ARRIVE_M     = 10;
const ARRIVAL_CONFIRM_TICKS = 3;

let arrivalStreak = 0;
let lastRerouteTs = 0;
let routeBoundsFittedOnce = false;

async function startNavigationToProperty(property) {
  if (!property) return toastError('Select a destination.');

  if (!userLocation) {
    pendingDestination = property;
    toastSuccess(`Selected ${property.name}. Waiting for your location...`);
    return;
  }

  stopNavigation();
  isNavigating = true;
  hasNearAlertFired = false;
  hasArrivedOnce = false;
  arrivalStreak = 0;
  routeBoundsFittedOnce = false;

  try {
    const user = [userLocation.lng, userLocation.lat];
    const dest = [property.lng, property.lat];

    const userInside = pointInPolygon(user, getCemeteryBoundary());
    const destInside = pointInPolygon(dest, getCemeteryBoundary());

    let routeCoords = [];
    let navigationSteps = [];
    let totalMeters = 0;

    setPointInSource(DEST_SRC, dest[0], dest[1], { name: property.name });

    // ---------- CASES ----------
    if (userInside && destInside) {
      const plan = planInternalPathStrict({ lng: user[0], lat: user[1] }, property);
      if (plan.coords.length) {
        const leg = trimRouteToDestExact(plan.coords, dest);
        routeCoords = mergeRouteLegs(routeCoords, leg);
        totalMeters += calculatePathDistance(leg);
        navigationSteps.push(...createInternalSteps(leg));
      }
    } else if (!userInside && !destInside) {
      const road = await safeDirections(user, dest);
      if (road?.coordinates?.length) {
        const leg = trimRouteToDestExact(road.coordinates, dest);
        routeCoords = mergeRouteLegs(routeCoords, leg);
        totalMeters += calculatePathDistance(leg);
        navigationSteps.push(...road.steps);
      }
    } else if (userInside && !destInside) {
      const gate = await chooseBestEntrance({ lng: user[0], lat: user[1] }, property, 'exit');
      const insidePlan = planInternalPathStrict({ lng: user[0], lat: user[1] }, gate);
      if (insidePlan.coords.length) {
        const legInside = trimRouteToDestExact(insidePlan.coords, [gate.lng, gate.lat]);
        routeCoords = mergeRouteLegs(routeCoords, legInside);
        totalMeters += calculatePathDistance(legInside);
        navigationSteps.push(...createInternalSteps(legInside));
      }
      const road = await safeDirections([gate.lng, gate.lat], dest);
      if (road?.coordinates?.length) {
        const legRoad = trimRouteToDestExact(road.coordinates, dest);
        routeCoords = mergeRouteLegs(routeCoords, legRoad);
        totalMeters += calculatePathDistance(legRoad);
        navigationSteps.push(...road.steps);
      }
    } else {
      const gate = await chooseBestEntrance({ lng: user[0], lat: user[1] }, property, 'enter');
      const insidePlan = planInternalPathStrict(gate, property);
      if (insidePlan.coords.length) {
        const entryProj = insidePlan.coords[0];
        const toGate = await safeDirections(user, entryProj);
        if (toGate?.coordinates?.length) {
          const legA = trimRouteToDestExact(toGate.coordinates, entryProj);
          routeCoords = mergeRouteLegs(routeCoords, legA);
          totalMeters += calculatePathDistance(legA);
          navigationSteps.push(...toGate.steps);
        }
        const legB = trimRouteToDestExact(insidePlan.coords, dest);
        routeCoords = mergeRouteLegs(routeCoords, legB);
        totalMeters += calculatePathDistance(legB);
        navigationSteps.push(...createInternalSteps(legB));
      }
    }

    // Fallbacks so we ALWAYS have something drawable
    if (!routeCoords.length) {
      console.warn('[nav] No composed route; using straight-line fallback.');
      routeCoords = forceExactDestination([user, dest], dest);
      totalMeters = calculatePathDistance(routeCoords);
    }

    // Final guard: dedupe + enforce exact destination + ensure >= 2 points
    routeCoords = ensureTwoPoints(forceExactDestination(dedupeCoords(routeCoords), dest));

    currentRoute = { coordinates: routeCoords, distance: totalMeters, steps: navigationSteps };
    displayRoute();
    startNavigationUpdates();
    checkProximityNow();
  } catch (e) {
    console.error('Navigation error', e);
    toastError('Failed to create route.');
    stopNavigation();
  }
}

// Wrapper that NEVER throws; returns null on failure
async function safeDirections(start, end) {
  try {
    const r = await getMapboxDirections(start, end);
    if (!r?.coordinates?.length) return null;
    return r;
  } catch (err) {
    console.warn('[directions] Mapbox failed:', err);
    return null;
  }
}

// Start visible route exactly at the user's projection onto the base route
function routeFromUserProjection(userPt, baseCoords) {
  if (!Array.isArray(baseCoords) || baseCoords.length < 2) return ensureTwoPoints(baseCoords ?? []);
  const { closestIndex, projPoint } = findClosestPointOnRoute(userPt, baseCoords);
  const out = [projPoint];
  for (let i = closestIndex + 1; i < baseCoords.length; i++) out.push(baseCoords[i]);
  return ensureTwoPoints(dedupeCoords(out));
}

// GeoJSON LineString must have ≥2 coordinates
function ensureTwoPoints(coords) {
  if (!coords || !coords.length) return [];
  if (coords.length === 1) return [coords[0], coords[0]];
  return coords;
}

// Update existing route source without refitting the map
function setRouteData(coords) {
  const src = map.getSource('route');
  const safe = ensureTwoPoints(coords);
  if (!src || safe.length < 2) return;
  src.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: safe } });
}

function startNavigationUpdates() {
  if (directionUpdateInterval) clearInterval(directionUpdateInterval);
  directionUpdateInterval = setInterval(() => {
    if (!isTracking || !userLocation || !currentRoute) return;

    const userPt = [userLocation.lng, userLocation.lat];

    // Visible route starts at projection (no stub from the pin)
    const visible = routeFromUserProjection(userPt, currentRoute.coordinates);
    setRouteData(visible);

    // Progress metrics
    const total = calculatePathDistance(currentRoute.coordinates);
    const remaining = calculatePathDistance(visible);
    const traveled = Math.max(0, total - remaining);
    progressPercentage = Math.min(100, Math.max(0, (traveled / Math.max(1, total)) * 100));
    distanceToDestination = remaining;
    currentStep = getCurrentStepByDistance(traveled, total, currentRoute.steps);

    // Simple off-route detection → reroute
    const { distance: offDist } = findClosestPointOnRoute(userPt, currentRoute.coordinates);
    const now = Date.now();
    if (offDist > OFF_ROUTE_REROUTE_M && now - lastRerouteTs > REROUTE_MIN_MS && selectedProperty) {
      lastRerouteTs = now;
      startNavigationToProperty(selectedProperty);
      return;
    }

    checkProximityNow();
  }, 1000);
}

function stopNavigation() {
  isNavigating = false;
  if (directionUpdateInterval) { clearInterval(directionUpdateInterval); directionUpdateInterval = null; }
  if (map?.getLayer('route')) map.removeLayer('route');
  if (map?.getSource('route')) map.removeSource('route');

  if (map?.getLayer('cemetery-paths')) {
    map.setPaintProperty('cemetery-paths', 'line-opacity', 1);
    map.setPaintProperty('cemetery-paths', 'line-color', '#ffffff');
    map.setPaintProperty('cemetery-paths', 'line-width', 3);
    map.setFilter('cemetery-paths', ['==', '$type', 'LineString']);
  }

  clearPointSource(DEST_SRC);
  currentRoute = null;
  hasNearAlertFired = false;
  arrivalStreak = 0;
}

function displayRoute() {
  if (!currentRoute) return;
  if (map.getLayer('route')) map.removeLayer('route');
  if (map.getSource('route')) map.removeSource('route');

  const base = ensureTwoPoints(currentRoute.coordinates);
  if (base.length < 2) { toastError('No route to draw.'); return; }

  const startCoords = (userLocation)
    ? routeFromUserProjection([userLocation.lng, userLocation.lat], base)
    : base;

  map.addSource('route', {
    type: 'geojson',
    data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ensureTwoPoints(startCoords) } }
  });

  map.addLayer({
    id: 'route',
    type: 'line',
    source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#3b82f6', 'line-width': 6, 'line-opacity': 0.9 }
  });

  if (!routeBoundsFittedOnce) {
    const bounds = new mapboxgl.LngLatBounds();
    for (const c of base) bounds.extend(c);
    map.fitBounds(bounds, { padding: 100, maxZoom: 20 });
    routeBoundsFittedOnce = true;
  }
}

function completeNavigation() {
  stopNavigation();
  toastSuccess(`Arrived at ${selectedProperty?.name ?? 'destination'}`);
  showConfirmation({
    title: 'Navigate to Exit?',
    message: 'Do you want directions back to the nearest entrance?',
    confirmText: 'Yes, guide me',
    cancelText: 'No, stay here',
    onConfirm: () => { showExitPopup = false; window.location.replace('/graves/Main%20Gate'); },
    onCancel: () => { toastSuccess('Navigation ended. You can exit at your own pace.'); }
  });
}

function calculateRemainingDistance(startIdx) {
  let d = 0; const coords = currentRoute?.coordinates || [];
  for (let i = startIdx; i < coords.length - 1; i++) d += calculateDistance(coords[i], coords[i + 1]);
  return d;
}

function getCurrentStepByDistance(traveled, total, steps = []) {
  if (!steps?.length) return 'Continue to destination';
  let acc = 0;
  for (const s of steps) { acc += s.distance; if (acc >= traveled) return s.instruction; }
  return 'Continue to destination';
}

// ================================
// Proximity (≤10m arrival, with confirmation)
// ================================
function effectiveNearRadius() {
  const acc = Number.isFinite(userLocation?.accuracy) ? userLocation.accuracy : 20;
  const jitter = Math.max(0, acc - 5);
  const base = (typeof BASE_NEAR_M === 'number' ? BASE_NEAR_M : 60);
  return Math.max(40, base - Math.min(40, jitter) * 0.8);
}

function getDestinationPoint() {
  if (selectedProperty?.lng != null && selectedProperty?.lat != null) return [selectedProperty.lng, selectedProperty.lat];
  const src = map.getSource(DEST_SRC);
  const fc = src?.serialize ? src.serialize().data : src?._data || src?.data;
  const feat = fc?.features?.[0];
  return feat?.geometry?.type === 'Point' ? feat.geometry.coordinates : null;
}

function checkProximityNow() {
  if (!userLocation || !isNavigating || hasArrivedOnce) return;
  const now = Date.now(); if (now - lastProximityCheckTs < 250) return; lastProximityCheckTs = now;

  const userPt = [userLocation.lng, userLocation.lat];
  const destPt = getDestinationPoint(); if (!destPt) return;

  const straight = calculateDistance(userPt, destPt);

  let alongRemaining = Infinity;
  if (currentRoute?.coordinates?.length) {
    const trimmed = routeFromUserProjection(userPt, currentRoute.coordinates);
    alongRemaining = calculatePathDistance(trimmed);
  }

  const nearMetric = Math.min(straight, alongRemaining);
  const near = effectiveNearRadius();
  if (!hasNearAlertFired && nearMetric <= near) {
    hasNearAlertFired = true;
    toastSuccess(`Malapit ka na sa ${selectedProperty?.name ?? 'destination'} (~${Math.round(nearMetric)}m)`);
    try { navigator.vibrate?.(120); } catch {}
  }

  if (alongRemaining <= ARRIVAL_THRESHOLD_M && straight <= STRAIGHT_ARRIVE_M) {
    arrivalStreak++;
    if (arrivalStreak >= ARRIVAL_CONFIRM_TICKS) {
      hasArrivedOnce = true;
      completeNavigation();
      return;
    }
  } else {
    arrivalStreak = 0;
  }
}

// ================================
// Internal routing (pure planner + renderer)
// ================================
function mergeRouteLegs(existing, incoming) {
  if (!incoming?.length) return existing ?? [];
  if (!existing?.length) return incoming.slice();

  const out = existing.slice();
  const last = out[out.length - 1];

  const inc = incoming.slice();
  inc[0] = last; // seam equality
  for (let i = 1; i < inc.length; i++) {
    if (!almostEqualCoord(out[out.length - 1], inc[i])) out.push(inc[i]);
  }
  return out;
}

function planInternalPathStrict(startPoint, endPoint) {
  if (!lineStringFeatures?.length) return { coords: [], length: 0 };

  let bestStart = null, bestDest = null;
  for (const f of lineStringFeatures) {
    const ns = nearestOnLine([startPoint.lng, startPoint.lat], f.coordinates);
    const nd = nearestOnLine([endPoint.lng, endPoint.lat], f.coordinates);
    if (!bestStart || ns.distance < bestStart.distance) bestStart = { ...ns, feature: f };
    if (!bestDest  || nd.distance  < bestDest.distance)  bestDest  = { ...nd, feature: f };
  }

  let chain = [];

  if (bestStart.feature.id === bestDest.feature.id) {
    const C = bestStart.feature.coordinates.slice();
    C.splice(bestStart.index + 1, 0, bestStart.point);
    C.splice(bestDest.index  + 2, 0, bestDest.point);
    const si = nearestRouteIndexOnCoords(bestStart.point, C);
    const di = nearestRouteIndexOnCoords(bestDest.point,  C);
    chain = si <= di ? C.slice(si, di + 1) : C.slice(di, si + 1).reverse();

  } else {
    const { edges, nid } = buildEndpointGraph(lineStringFeatures, 10);

    const sFeat = bestStart.feature.coordinates;
    const dFeat = bestDest.feature.coordinates;
    const sEnds = [sFeat[0], sFeat[sFeat.length - 1]];
    const dEnds = [dFeat[0], dFeat[dFeat.length - 1]];

    const sNode = sEnds.reduce((a, b) =>
      calculateDistance(bestStart.point, b) < calculateDistance(bestStart.point, a) ? b : a
    );
    const dNode = dEnds.reduce((a, b) =>
      calculateDistance(bestDest.point, b) < calculateDistance(bestDest.point, a) ? b : a
    );

    const nodePath = dijkstra(edges, nid(sNode), nid(dNode));
    if (!nodePath.length) return { coords: [], length: 0 };
    const nodeChain = nodePath.map(id => id.split(',').map(Number));

    const sIdx = nearestRouteIndexOnCoords(bestStart.point, sFeat);
    const sNodeIdx = nearestRouteIndexOnCoords(sNode, sFeat);
    const sSeg = sIdx <= sNodeIdx ? sFeat.slice(sIdx, sNodeIdx + 1) : sFeat.slice(sNodeIdx, sIdx + 1).reverse();

    const dIdx = nearestRouteIndexOnCoords(bestDest.point, dFeat);
    const dNodeIdx = nearestRouteIndexOnCoords(dNode, dFeat);
    const dSeg = dNodeIdx <= dIdx ? dFeat.slice(dNodeIdx, dIdx + 1) : dFeat.slice(dIdx, dNodeIdx + 1).reverse();

    chain = [bestStart.point, ...sSeg.slice(1), ...nodeChain, ...dSeg.slice(1), bestDest.point];
  }

  chain = dedupeCoords(chain);
  return { coords: chain, length: calculatePathDistance(chain) };
}

// Preview styling only
async function navigateUsingInternalPaths(endPoint, startPoint) {
  const plan = planInternalPathStrict(startPoint, endPoint);
  selectedLineString = { id: 'internal', coordinates: plan.coords };
  map.setPaintProperty('cemetery-paths', 'line-opacity', 0);
  map.setPaintProperty('cemetery-paths', 'line-color', '#ef4444');
  map.setPaintProperty('cemetery-paths', 'line-width', 2);
}

// ----------------
// Exact trim to target (robust “last near-best”)
function trimRouteToDestExact(routeCoords, destPt, epsM = 2.0) {
  if (!Array.isArray(routeCoords) || routeCoords.length < 2) return [destPt.slice()];

  let minD = Infinity;
  const projs = [];
  for (let i = 0; i < routeCoords.length - 1; i++) {
    const a = routeCoords[i], b = routeCoords[i + 1];
    const p = nearestPointOnSegment(destPt, a, b);
    projs.push({ i, proj: p.point, d: p.distance });
    if (p.distance < minD) minD = p.distance;
  }

  let chosen = projs[projs.length - 1];
  for (let k = projs.length - 1; k >= 0; k--) {
    if (projs[k].d <= minD + epsM) { chosen = projs[k]; break; }
  }

  const out = routeCoords.slice(0, chosen.i + 1);
  if (!almostEqualCoord(out[out.length - 1], chosen.proj)) out.push(chosen.proj);
  if (!almostEqualCoord(out[out.length - 1], destPt)) out.push(destPt.slice());
  return dedupeCoords(out);
}

// Ensure last coord equals dest (safety guard)
function forceExactDestination(coords, destPt) {
  if (!coords?.length) return [destPt.slice()];
  const last = coords[coords.length - 1];
  if (!almostEqualCoord(last, destPt)) return trimRouteToDestExact(coords, destPt);
  return coords;
}

// ================================
// Directions (raw)
// ================================
async function getMapboxDirections(start, end) {
  const url = `https://api.mapbox.com/directions/v5/mapbox/walking/${start[0]},${start[1]};${end[0]},${end[1]}?steps=true&geometries=geojson&access_token=${mapboxgl.accessToken}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.routes?.length) throw new Error('No route found');
  const r = data.routes[0];
  const coords = r.geometry?.coordinates || [];
  const steps = r.legs?.[0]?.steps?.map((s) => ({
    instruction: s.maneuver?.instruction ?? 'Continue',
    distance: s.distance ?? 0
  })) ?? [];
  return { coordinates: coords, steps };
}

// ================================
// Helpers
// ================================
function getCemeteryBoundary() {
  return [
    [120.975, 14.470],
    [120.978, 14.470],
    [120.978, 14.473],
    [120.975, 14.473],
    [120.975, 14.470]
  ];
}
function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = ((yi > point[1]) !== (yj > point[1])) &&
      (point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function findNearestEntrance(fromPoint = null) {
  if (!fromPoint) return ENTRANCES[0];
  let best = ENTRANCES[0], md = Infinity;
  for (const e of ENTRANCES) {
    const d = calculateDistance([fromPoint.lng, fromPoint.lat], [e.lng, e.lat]);
    if (d < md) { md = d; best = e; }
  }
  return best;
}

function calculateDistance(a, b) {
  const toRad = (deg) => deg * Math.PI / 180;
  const [lng1, lat1] = a, [lng2, lat2] = b;
  const R = 6371e3;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const la1 = toRad(lat1), la2 = toRad(lat2);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function almostEqualCoord(a, b, epsDeg = 1e-6) {
  if (!a || !b) return false;
  return Math.abs(a[0] - b[0]) < epsDeg && Math.abs(a[1] - b[1]) < epsDeg;
}

function dedupeCoords(arr, epsDeg = 1e-6) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const c of arr) if (!out.length || !almostEqualCoord(out[out.length - 1], c, epsDeg)) out.push(c);
  return out;
}

function nearestPointOnSegment(p, a, b) {
  const A = p[0] - a[0], B = p[1] - a[1];
  const C = b[0] - a[0], D = b[1] - a[1];
  const dot = A * C + B * D, lenSq = C * C + D * D;
  if (lenSq === 0) return { point: a, distance: calculateDistance(p, a) };
  let t = dot / lenSq; t = Math.max(0, Math.min(1, t));
  const proj = [a[0] + t * C, a[1] + t * D];
  return { point: proj, distance: calculateDistance(p, proj) };
}

function toastSuccess(message) {
  successMessage = message;
  setTimeout(() => { if (successMessage === message) successMessage = null; }, 3000);
  console.log('[OK]', message);
}
function toastError(message) {
  errorMessage = message;
  setTimeout(() => { if (errorMessage === message) errorMessage = null; }, 5000);
  console.error('[ERR]', message);
}

function showConfirmation({ title, message, confirmText, cancelText, onConfirm, onCancel }) {
  showExitPopup = { title, message, confirmText, cancelText, onConfirm, onCancel };
}

// ================================
// UI Handlers
// ================================
function handleSearchInput(e) {
  const val = (e?.target?.value ?? '').toString();
  matchName = val;
  if (!val.trim()) return;
  const exact = getFeatureByName(val);
  if (exact) selectedProperty = exact;
}

function goNavigate() {
  if (!selectedProperty) {
    const p = getFeatureByName(matchName);
    if (!p) return toastError(`Block "${matchName}" not found.`);
    selectedProperty = p;
  }
  goto(`/graves/${encodeURIComponent(selectedProperty.name)}`);
  startNavigationToProperty(selectedProperty);
}

</script>


<!-- ================================
     UI
================================== -->
<style>
  .hud { position: absolute; inset: 12px auto auto 12px; z-index: 10; display:flex; gap:.5rem; align-items:center; }
  .card { background: #ffffff; border-radius: 12px; padding: .6rem .75rem; box-shadow: 0 8px 24px rgba(0,0,0,.08); }
  .btn { background: #1d4ed8; color: #fff; border: 0; border-radius: 10px; padding: .55rem .8rem; cursor: pointer; }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  .toast { position: absolute; right: 12px; top: 12px; z-index: 30; }
  .map { position: absolute; inset: 0; }
  .modal-backdrop{ position:fixed; inset:0; background:rgba(0,0,0,.4); display:grid; place-items:center; z-index:50; }
  .modal{ background:#fff; border-radius:14px; padding:1rem; width:min(92vw,420px); }
</style>

<div class="map" bind:this={mapContainer}></div>

<div class="hud">
  <div class="card" style="display:flex;gap:.5rem;align-items:center">
    <input
      placeholder="Search block / facility"
      value={matchName}
      on:input={handleSearchInput}
      style="border:1px solid #e5e7eb;border-radius:8px;padding:.5rem .6rem;min-width:260px"
    />
    <button class="btn" on:click={goNavigate}>Navigate</button>
  </div>
</div>

{#if successMessage}
  <div class="toast card" style="color:#065f46;border-left:4px solid #10b981">✅ {successMessage}</div>
{/if}
{#if errorMessage}
  <div class="toast card" style="color:#991b1b;border-left:4px solid #ef4444">⚠️ {errorMessage}</div>
{/if}

{#if showExitPopup}
  <div class="modal-backdrop">
    <div class="modal">
      <h3 style="margin:0 0 .35rem 0;font-weight:600">{showExitPopup.title}</h3>
      <p style="margin:.25rem 0 .75rem 0; color:#4b5563">{showExitPopup.message}</p>
      <div style="display:flex;gap:.5rem;justify-content:flex-end">
        <button
          class="card"
          style="background:#f3f4f6;border:1px solid #e5e7eb"
          on:click={() => { showExitPopup.onCancel?.(); showExitPopup = false; }}>
          {showExitPopup.cancelText ?? 'Cancel'}
        </button>
        <button
          class="btn"
          on:click={() => { showExitPopup.onConfirm?.(); showExitPopup = false; }}>
          {showExitPopup.confirmText ?? 'OK'}
        </button>
      </div>
    </div>
  </div>
{/if}
