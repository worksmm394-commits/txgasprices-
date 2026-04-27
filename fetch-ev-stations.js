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
// lower-case key and look up against the towns.json roster.  Aliases for a
// handful of NREL spellings that don't match the canonical town name.
const ALIAS = {
  'ft worth':         'fort-worth-tx',
  'ft. worth':        'fort-worth-tx',
  'mc allen':         'mcallen-tx',
  'mc kinney':        'mckinney-tx',
  'the woodlands':    null, // not a tracked town — explicitly drop
};

function slugForNrelCity(rawCity) {
  if (!rawCity) return null;
  const norm = String(rawCity).toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(ALIAS, norm)) {
    return ALIAS[norm];
  }
  // Build a slug like the towns.json convention — lowercase, hyphens, "-tx".
  const base = norm.replace(/\./g, '').replace(/\s+/g, '-');
  const candidate = `${base}-tx`;
  return SLUG_SET.has(candidate) ? candidate : null;
}

const SLUG_SET = new Set(towns.map(t => t.slug));
const TOWN_BY_SLUG = Object.fromEntries(towns.map(t => [t.slug, t]));

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

  // Group by city slug.  A station whose NREL city does not map to any
  // towns.json slug is silently dropped — we only generate pages for the
  // 100 tracked cities.
  const byCity = {};
  let dropped = 0;
  for (const raw of all) {
    const slug = slugForNrelCity(raw.city);
    if (!slug) { dropped++; continue; }
    const station = extractStation(raw);
    if (!byCity[slug]) byCity[slug] = [];
    byCity[slug].push(station);
  }

  const cities = {};
  for (const slug of Object.keys(byCity)) {
    const stations = byCity[slug];
    const town = TOWN_BY_SLUG[slug];
    const networks = {};
    let dcFast = 0, level2 = 0, freeCount = 0, maxKw = 0;
    for (const s of stations) {
      const net = s.ev_network && s.ev_network !== 'Non-Networked'
        ? s.ev_network
        : (s.ev_network || 'Non-Networked');
      networks[net] = (networks[net] || 0) + 1;
      if (s.ev_dc_fast_num > 0) dcFast++;
      if (s.ev_level2_evse_num > 0) level2++;
      if (s.is_free) freeCount++;
      if (s.max_kw > maxKw) maxKw = s.max_kw;
    }
    // Sort stations: DC fast first, then by max_kw desc, then station name.
    stations.sort((a, b) => {
      if ((b.ev_dc_fast_num > 0 ? 1 : 0) - (a.ev_dc_fast_num > 0 ? 1 : 0) !== 0) {
        return (b.ev_dc_fast_num > 0 ? 1 : 0) - (a.ev_dc_fast_num > 0 ? 1 : 0);
      }
      if (b.max_kw !== a.max_kw) return b.max_kw - a.max_kw;
      return a.station_name.localeCompare(b.station_name);
    });
    cities[slug] = {
      city_name:        town ? town.name : slug,
      stations_count:   stations.length,
      dc_fast_count:    dcFast,
      level2_count:     level2,
      free_count:       freeCount,
      networks,
      max_kw_in_city:   maxKw,
      stations,
    };
  }

  const out = {
    updated:           new Date().toISOString(),
    source:            'NREL Alternative Fuel Stations API',
    total_stations_tx: all.length,
    cities_covered:    Object.keys(cities).length,
    cities,
  };
  fs.writeFileSync('./ev-stations.json', JSON.stringify(out, null, 2));

  console.log('\n───── Run summary ─────');
  console.log(`raw_stations_fetched=${all.length}`);
  console.log(`stations_dropped_unmatched_city=${dropped}`);
  console.log(`cities_with_stations=${Object.keys(cities).length}`);
  const top = Object.entries(cities)
    .sort((a, b) => b[1].stations_count - a[1].stations_count)
    .slice(0, 10);
  console.log('top_cities=');
  for (const [slug, c] of top) {
    console.log(`  ${slug.padEnd(22)} ${String(c.stations_count).padStart(4)}  (DC fast ${c.dc_fast_count})`);
  }
  console.log('\n✓ Wrote ev-stations.json');
})().catch(e => {
  console.error('FATAL:', e.message || e);
  if (e.response && e.response.data) console.error(e.response.data);
  process.exit(1);
});
