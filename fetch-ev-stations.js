/*
 * fetch-ev-stations.js
 *
 * Pulls every public EV charging station in Texas from the NREL Alternative
 * Fuel Stations API, paginates 200/page, then groups stations by towns.json
 * city slug (only — stations whose city does not match a tracked town are
 * dropped).  Output ev-stations.json drives the per-city EV pages and the
 * statewide /ev-charging-texas/ hub.
 *
 *   NREL_API_KEY=... node fetch-ev-stations.js
 */

const axios = require('axios');
const fs    = require('fs');

const NREL_API_KEY = process.env.NREL_API_KEY;
if (!NREL_API_KEY) {
  console.error('ERROR: NREL_API_KEY env var is required.');
  console.error('Get a free key at https://developer.nrel.gov/signup/ and set it');
  console.error('via the NREL_API_KEY env var (locally) or as a GitHub Actions secret.');
  process.exit(1);
}

const towns = JSON.parse(fs.readFileSync('./towns.json', 'utf8'));

// Map normalized city name → slug for fast grouping.  NREL returns the
// station's city in plain text (e.g. "Houston"), which we coerce to a
// lower-case key and look up against the towns.json roster.  Aliases
// for a handful of NREL spellings that don't match the canonical name.
// Note: "the woodlands" no longer maps to null — under Voronoi every
// station with valid coords gets assigned to its nearest tracked city.
const ALIAS = {
  'ft worth':   'fort-worth-tx',
  'ft. worth':  'fort-worth-tx',
  'mc allen':   'mcallen-tx',
  'mc kinney':  'mckinney-tx',
};

const SLUG_SET = new Set(towns.map(t => t.slug));
const TOWN_BY_SLUG = Object.fromEntries(towns.map(t => [t.slug, t]));
// Cache of towns that have valid coordinates — used for Voronoi nearest-
// neighbor assignment when the NREL city name doesn't match any slug.
const TOWNS_WITH_COORDS = towns.filter(t => t.lat != null && t.lng != null);

// Haversine distance in MILES between two (lat,lng) pairs.  Used for
// Voronoi nearest-city assignment so a station whose NREL city is e.g.
// "Spring" or "Cypress" still lands on the closest tracked town.
function haversine(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
      * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Try fast name-based match first (exact slug or ALIAS).  Returns the
// slug if matched, or null if the caller should fall back to Voronoi.
function slugByName(rawCity) {
  if (!rawCity) return null;
  const norm = String(rawCity).toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(ALIAS, norm)) {
    return ALIAS[norm];
  }
  const base = norm.replace(/\./g, '').replace(/\s+/g, '-');
  const candidate = `${base}-tx`;
  return SLUG_SET.has(candidate) ? candidate : null;
}

// Voronoi assignment: pick the tracked town whose center lat/lng is
// nearest to the station coords.  No radius cutoff; every station with
// valid coords lands on exactly one city, so no double-counting and no
// Texas station gets dropped purely because NREL's city field doesn't
// match our roster.
function nearestSlug(lat, lng) {
  let best = null, bestD = Infinity;
  for (const t of TOWNS_WITH_COORDS) {
    const d = haversine(lat, lng, t.lat, t.lng);
    if (d < bestD) { bestD = d; best = t.slug; }
  }
  return best;
}

const BASE_URL = `https://developer.nrel.gov/api/alt-fuel-stations/v1.json`;
const PAGE_SIZE = 200;

async function fetchPage(offset) {
  const url = BASE_URL +
    `?api_key=${NREL_API_KEY}` +
    `&fuel_type=ELEC` +
    `&state=TX` +
    `&limit=${PAGE_SIZE}` +
    `&offset=${offset}`;
  const res = await axios.get(url, { timeout: 60000 });
  return res.data;
}

function parseConnectorTypes(t) {
  if (Array.isArray(t)) return t;
  if (typeof t === 'string') {
    return t.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  }
  return [];
}

// CCS / CHAdeMO / Tesla DC fast power assumptions when NREL does not break
// out per-port kW.  These are conservative typical maximums for Texas
// stations (Tesla V3 250, EA hyperchargers 350) — used only for max_kw
// presentation, never for billing math.
const CONNECTOR_KW = {
  'J1772COMBO':      150,
  'CCS':             150,
  'CHADEMO':         50,
  'TESLA':           250,
  'NEMA1450':        9.6,
  'J1772':           7.2,
  'NEMA515':         1.4,
  'NEMA520':         1.9,
};

function maxKwForStation(s) {
  // NREL rarely exposes per-port kW.  Take the max from known DC fast
  // connector assumptions, but only count fast types when the station
  // actually has at least one DC fast port.
  const conns = parseConnectorTypes(s.ev_connector_types);
  const dcCount = Number(s.ev_dc_fast_num) || 0;
  let max = 0;
  for (const c of conns) {
    const key = c.toUpperCase().replace(/[\s_-]/g, '');
    const kw = CONNECTOR_KW[key];
    if (kw == null) continue;
    // Only count fast-charge assumptions when DC fast ports exist.
    if (kw >= 50 && dcCount === 0) continue;
    if (kw > max) max = kw;
  }
  return max;
}

function totalPortsForStation(s) {
  const units = Array.isArray(s.ev_charging_units) ? s.ev_charging_units : [];
  let total = 0;
  for (const u of units) {
    const pc = Number(u && u.port_count);
    if (Number.isFinite(pc) && pc > 0) total += pc;
  }
  if (total > 0) return total;
  // Fall back to the per-level counts when charging_units isn't populated.
  return (Number(s.ev_dc_fast_num) || 0) +
         (Number(s.ev_level2_evse_num) || 0) +
         (Number(s.ev_level1_evse_num) || 0);
}

function isFreeStation(s) {
  return /\bfree\b/i.test(String(s.ev_pricing || ''));
}

function is24hStation(s) {
  return /24\s*hours/i.test(String(s.access_days_time || ''));
}

function extractStation(s) {
  const conns = parseConnectorTypes(s.ev_connector_types);
  return {
    id:                  s.id,
    station_name:        s.station_name || '',
    street_address:      s.street_address || '',
    city:                s.city || '',
    state:               s.state || '',
    zip:                 s.zip || '',
    latitude:            s.latitude,
    longitude:           s.longitude,
    ev_connector_types:  conns,
    ev_level2_evse_num:  Number(s.ev_level2_evse_num) || 0,
    ev_dc_fast_num:      Number(s.ev_dc_fast_num) || 0,
    ev_level1_evse_num:  Number(s.ev_level1_evse_num) || 0,
    ev_network:          s.ev_network || '',
    ev_network_web:      s.ev_network_web || '',
    ev_pricing:          s.ev_pricing || '',
    access_code:         s.access_code || '',
    access_days_time:    s.access_days_time || '',
    date_last_confirmed: s.date_last_confirmed || '',
    open_date:           s.open_date || '',
    facility_type:       s.facility_type || '',
    max_kw:              maxKwForStation(s),
    is_free:             isFreeStation(s),
    is_24h:              is24hStation(s),
    total_ports:         totalPortsForStation(s),
  };
}

(async () => {
  let offset = 0;
  const all = [];
  let totalReported = null;
  console.log(`Fetching all Texas EV stations from NREL (limit=${PAGE_SIZE} per page)…`);
  while (true) {
    const data = await fetchPage(offset);
    if (totalReported == null && Number.isFinite(Number(data.total_results))) {
      totalReported = Number(data.total_results);
      console.log(`  NREL reports ${totalReported} total Texas EV stations.`);
    }
    const items = Array.isArray(data.fuel_stations) ? data.fuel_stations : [];
    if (!items.length) break;
    all.push(...items);
    console.log(`  offset=${offset} → +${items.length} (running total ${all.length})`);
    if (items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    if (totalReported != null && offset >= totalReported) break;
  }
  console.log(`Fetched ${all.length} raw stations.`);

  // Group raw NREL records by city slug.  Two-tier assignment:
  //   1. ALIAS / exact slug match on NREL's `city` field (fast).
  //   2. Voronoi fallback — nearest tracked town by Haversine distance
  //      to the station's lat/lng — when the name doesn't match.
  // Only stations missing both lat AND lng get dropped (ungroupable).
  // No radius cutoff: every Texas station with coords lands on exactly
  // one of the 100 tracked cities, so no double-counting.
  const rawByCity = {};
  let droppedNoCoords = 0;
  let matchedByName = 0;
  let matchedByVoronoi = 0;
  for (const raw of all) {
    let slug = slugByName(raw.city);
    if (slug) {
      matchedByName++;
    } else {
      const lat = raw.latitude, lng = raw.longitude;
      if (lat == null || lng == null) { droppedNoCoords++; continue; }
      slug = nearestSlug(Number(lat), Number(lng));
      if (!slug) { droppedNoCoords++; continue; }
      matchedByVoronoi++;
    }
    if (!rawByCity[slug]) rawByCity[slug] = [];
    rawByCity[slug].push(raw);
  }
  // For symmetry with the old summary block.  Keeping `dropped` so the
  // existing post-loop logging still references something sensible.
  const dropped = droppedNoCoords;

  // Dedup key: lat+lng rounded to 4 decimal places (~11m precision)
  // collapses adjacent stalls; falls back to normalized name+address
  // when geo coords are missing.
  function dedupKey(raw) {
    const lat = raw.latitude, lng = raw.longitude;
    if (lat != null && lng != null) {
      return `geo:${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
    }
    const name = String(raw.station_name || '').toLowerCase().trim();
    const addr = String(raw.street_address || '').toLowerCase().trim();
    return `name:${name}|${addr}`;
  }

  // Aggregate one or more port-records into a single physical-location
  // record.  Boolean flags OR; ports SUM; max_kw MAX; connectors UNION;
  // strings/coords come from the first record (which already won the
  // sort within the city — see below for ordering).
  function mergeRecord(loc, raw) {
    const dcNum   = Number(raw.ev_dc_fast_num) || 0;
    const l2Num   = Number(raw.ev_level2_evse_num) || 0;
    const l1Num   = Number(raw.ev_level1_evse_num) || 0;
    const ports   = totalPortsForStation(raw);
    const kw      = maxKwForStation(raw);
    const isFree  = isFreeStation(raw);
    const is24h   = is24hStation(raw);
    const conns   = parseConnectorTypes(raw.ev_connector_types);
    if (!loc) {
      return {
        name:             raw.station_name || '',
        address:          raw.street_address || '',
        city:             raw.city || '',
        state:            raw.state || '',
        zip:              raw.zip || '',
        network:          raw.ev_network || 'Non-Networked',
        network_web:      raw.ev_network_web || '',
        lat:              raw.latitude != null ? Number(raw.latitude) : null,
        lng:              raw.longitude != null ? Number(raw.longitude) : null,
        max_kw:           kw,
        total_ports:      ports,
        is_dc_fast:       dcNum > 0,
        is_level2:        l2Num > 0,
        is_free:          isFree,
        is_24h:           is24h,
        connectors:       [...conns],
        pricing:          raw.ev_pricing || '',
        access_days_time: raw.access_days_time || '',
        facility_type:    raw.facility_type || '',
      };
    }
    if (kw > loc.max_kw) loc.max_kw = kw;
    loc.total_ports += ports;
    if (dcNum > 0) loc.is_dc_fast = true;
    if (l2Num > 0) loc.is_level2 = true;
    if (isFree)    loc.is_free   = true;
    if (is24h)     loc.is_24h    = true;
    for (const c of conns) {
      if (!loc.connectors.includes(c)) loc.connectors.push(c);
    }
    if (!loc.pricing && raw.ev_pricing) loc.pricing = raw.ev_pricing;
    if (!loc.access_days_time && raw.access_days_time) loc.access_days_time = raw.access_days_time;
    return loc;
  }

  // Per-city dedup pipeline.
  const cities = {};
  let totalUniqueStations = 0;
  let totalPortsTx = 0;
  let totalDuplicatesCollapsed = 0;
  for (const slug of Object.keys(rawByCity)) {
    const portRecords = rawByCity[slug];
    const byLocation = {};
    for (const raw of portRecords) {
      const key = dedupKey(raw);
      byLocation[key] = mergeRecord(byLocation[key], raw);
    }
    const stations = Object.values(byLocation);
    totalDuplicatesCollapsed += (portRecords.length - stations.length);

    // Per-city aggregates count UNIQUE physical locations, not ports.
    // `networks` counts how many unique locations operate each network.
    const networks = {};
    let dcFast = 0, level2 = 0, freeCount = 0, maxKw = 0, cityPorts = 0;
    for (const s of stations) {
      const net = s.network || 'Non-Networked';
      networks[net] = (networks[net] || 0) + 1;
      if (s.is_dc_fast) dcFast++;
      if (s.is_level2)  level2++;
      if (s.is_free)    freeCount++;
      if (s.max_kw > maxKw) maxKw = s.max_kw;
      cityPorts += s.total_ports;
    }

    // Sort: DC fast first → max_kw desc → name asc.
    stations.sort((a, b) => {
      const aFast = a.is_dc_fast ? 1 : 0;
      const bFast = b.is_dc_fast ? 1 : 0;
      if (aFast !== bFast) return bFast - aFast;
      if (b.max_kw !== a.max_kw) return b.max_kw - a.max_kw;
      return (a.name || '').localeCompare(b.name || '');
    });

    const town = TOWN_BY_SLUG[slug];
    cities[slug] = {
      city_name:        town ? town.name : slug,
      stations_count:   stations.length,
      dc_fast_count:    dcFast,
      level2_count:     level2,
      free_count:       freeCount,
      total_ports:      cityPorts,
      networks,
      max_kw_in_city:   maxKw,
      stations,
    };
    totalUniqueStations += stations.length;
    totalPortsTx += cityPorts;
  }

  const out = {
    updated:              new Date().toISOString(),
    source:               'NREL Alternative Fuel Stations API',
    total_stations_tx:    totalUniqueStations,        // unique physical locations
    total_ports_tx:       totalPortsTx,               // sum of ports across all locations
    raw_records_fetched:  all.length,                 // pre-dedup port-level record count
    cities_covered:       Object.keys(cities).length,
    cities,
  };
  fs.writeFileSync('./ev-stations.json', JSON.stringify(out, null, 2));

  console.log('\n───── Run summary ─────');
  console.log(`raw_port_records_fetched=${all.length}`);
  console.log(`matched_by_name=${matchedByName}`);
  console.log(`matched_by_voronoi=${matchedByVoronoi}`);
  console.log(`dropped_no_coords=${droppedNoCoords}`);
  console.log(`unique_physical_locations=${totalUniqueStations}`);
  console.log(`total_ports_across_tx=${totalPortsTx}`);
  console.log(`port_records_collapsed_to_existing_locations=${totalDuplicatesCollapsed}`);
  console.log(`cities_with_stations=${Object.keys(cities).length}`);
  const top = Object.entries(cities)
    .sort((a, b) => b[1].stations_count - a[1].stations_count)
    .slice(0, 10);
  console.log('top_cities=');
  for (const [slug, c] of top) {
    console.log(`  ${slug.padEnd(22)} ${String(c.stations_count).padStart(4)} stations  ${String(c.total_ports).padStart(4)} ports  (DC fast ${c.dc_fast_count})`);
  }
  console.log('\n✓ Wrote ev-stations.json');
})().catch(e => {
  console.error('FATAL:', e.message || e);
  if (e.response && e.response.data) console.error(e.response.data);
  process.exit(1);
});
