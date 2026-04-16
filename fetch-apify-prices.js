/*
 * fetch-apify-prices.js
 *
 * Fetches per-ZIP gas station data from the Apify actor `johnvc/fuelprices`
 * (GasBuddy scraper) for the top 50 Texas cities. Big metros hit 5 ZIPs,
 * medium cities 3, smaller cities 2 — the multi-ZIP sweep catches discount
 * chains that cluster in specific neighborhoods.
 *
 * Pipeline per city:
 *   1. Union all stations across that city's ZIPs.
 *   2. Dedupe:
 *        primary   — same station id from Apify      → keep cheaper price
 *        secondary — same (canonical chain, address) → keep cheaper price
 *   3. Drop stations with no posted credit/cash price.
 *   4. Sort ascending by price, cap at 30 stations.
 *   5. Group by canonical chain name → chains[] (cheapest station per chain).
 *
 * The script caches each ZIP fetch so duplicate ZIPs shared across city
 * arrays are only billed once.
 *
 *   APIFY_TOKEN=... node fetch-apify-prices.js
 *
 * Optional env:
 *   CITY_FILTER=houston-tx,dallas-tx   only run these slugs (for testing)
 *   CONCURRENCY=5                      parallel ZIP fetches (default 5)
 */

const axios = require('axios');
const fs    = require('fs');

const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
if (!APIFY_TOKEN) {
  console.error('ERROR: APIFY_TOKEN env var is required.');
  process.exit(1);
}

// Top 50 Texas cities. Big metros get 5 ZIPs (different quadrants of the
// metro), mid-size cities 3, smaller cities 2. This widens the station net
// per city so niche chains like QuikTrip or Buc-ee's show up when present.
const CITIES = [
  // Big cities — 5 ZIPs
  { slug: 'houston-tx',         zips: ['77079', '77004', '77494', '77084', '77373'] },
  { slug: 'dallas-tx',          zips: ['75248', '75150', '75006', '75080', '75230'] },
  { slug: 'san-antonio-tx',     zips: ['78250', '78230', '78251', '78254', '78239'] },
  { slug: 'austin-tx',          zips: ['78745', '78748', '78664', '78613', '78628'] },
  { slug: 'fort-worth-tx',      zips: ['76116', '76244', '76137', '76036', '76131'] },

  // Medium cities — 3 ZIPs
  { slug: 'el-paso-tx',         zips: ['79925', '79912', '79907'] },
  { slug: 'arlington-tx',       zips: ['76015', '76010', '76017'] },
  { slug: 'corpus-christi-tx',  zips: ['78413', '78411', '78415'] },
  { slug: 'plano-tx',           zips: ['75075', '75093', '75074'] },
  { slug: 'lubbock-tx',         zips: ['79424', '79407', '79413'] },
  { slug: 'laredo-tx',          zips: ['78045', '78041', '78046'] },
  { slug: 'irving-tx',          zips: ['75063', '75038', '75061'] },
  { slug: 'garland-tx',         zips: ['75043', '75040', '75042'] },
  { slug: 'frisco-tx',          zips: ['75034', '75035', '75033'] },
  { slug: 'mckinney-tx',        zips: ['75070', '75071', '75069'] },
  { slug: 'grand-prairie-tx',   zips: ['75051', '75050', '75054'] },
  { slug: 'amarillo-tx',        zips: ['79119', '79109', '79106'] },
  { slug: 'brownsville-tx',     zips: ['78526', '78521', '78520'] },
  { slug: 'killeen-tx',         zips: ['76542', '76541', '76549'] },
  { slug: 'denton-tx',          zips: ['76210', '76201', '76208'] },

  // Smaller cities — 2 ZIPs
  { slug: 'mesquite-tx',        zips: ['75150', '75149'] },
  { slug: 'pasadena-tx',        zips: ['77504', '77502'] },
  { slug: 'mcallen-tx',         zips: ['78504', '78501'] },
  { slug: 'waco-tx',            zips: ['76710', '76706'] },
  { slug: 'midland-tx',         zips: ['79707', '79701'] },
  { slug: 'lewisville-tx',      zips: ['75067', '75056'] },
  { slug: 'carrollton-tx',      zips: ['75010', '75007'] },
  { slug: 'round-rock-tx',      zips: ['78664', '78681'] },
  { slug: 'abilene-tx',         zips: ['79606', '79601'] },
  { slug: 'pearland-tx',        zips: ['77584', '77581'] },
  { slug: 'college-station-tx', zips: ['77845', '77840'] },
  { slug: 'richardson-tx',      zips: ['75080', '75081'] },
  { slug: 'league-city-tx',     zips: ['77573', '77574'] },
  { slug: 'odessa-tx',          zips: ['79762', '79761'] },
  { slug: 'beaumont-tx',        zips: ['77706', '77701'] },
  { slug: 'allen-tx',           zips: ['75013', '75002'] },
  { slug: 'sugar-land-tx',      zips: ['77478', '77479'] },
  { slug: 'edinburg-tx',        zips: ['78539', '78541'] },
  { slug: 'tyler-tx',           zips: ['75703', '75701'] },
  { slug: 'wichita-falls-tx',   zips: ['76308', '76301'] },
  { slug: 'san-angelo-tx',      zips: ['76904', '76901'] },
  { slug: 'longview-tx',        zips: ['75605', '75601'] },
  { slug: 'pflugerville-tx',    zips: ['78660', '78661'] },
  { slug: 'cedar-park-tx',      zips: ['78613', '78641'] },
  { slug: 'georgetown-tx',      zips: ['78628', '78626'] },
  { slug: 'conroe-tx',          zips: ['77304', '77301'] },
  { slug: 'baytown-tx',         zips: ['77521', '77520'] },
  { slug: 'atascocita-tx',      zips: ['77346', '77044'] },
  { slug: 'rowlett-tx',         zips: ['75089', '75088'] },
  { slug: 'flower-mound-tx',    zips: ['75028', '75022'] },
];

// Canonicalize raw station names to a stable brand label. Groups all stations
// under one brand even when scraper returns variants (Murphy USA/Express).
function canonicalChainName(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/murphy/i.test(s))                    return 'Murphy USA';
  if (/\bh[\s.-]?e[\s.-]?b\b/i.test(s))      return 'HEB Gas';
  if (/buc[- ]?ee/i.test(s))                return "Buc-ee's";
  if (/\bshell\b/i.test(s))                 return 'Shell';
  if (/chevron/i.test(s))                   return 'Chevron';
  if (/\bexxon\b/i.test(s))                 return 'Exxon';
  if (/\bvalero\b/i.test(s))                return 'Valero';
  if (/phillips\s*66/i.test(s))             return 'Phillips 66';
  if (/\bconoco\b/i.test(s))                return 'Conoco';
  if (/\btexaco\b/i.test(s))                return 'Texaco';
  if (/\bsunoco\b/i.test(s))                return 'Sunoco';
  if (/7[\s-]?eleven/i.test(s))             return '7-Eleven';
  if (/circle\s*k/i.test(s))                return 'Circle K';
  if (/\bcostco\b/i.test(s))                return 'Costco';
  if (/\bsam'?s\s*club\b/i.test(s))         return "Sam's Club";
  if (/\bbj'?s\b/i.test(s))                 return "BJ's";
  if (/walmart\s*neighborhood/i.test(s))    return 'Walmart Neighborhood Market';
  if (/\bwalmart\b/i.test(s))               return 'Walmart';
  if (/qu(ik|ick)\s*trip|\bqt\b/i.test(s))  return 'QuikTrip';
  if (/race\s*trac|racetrac/i.test(s))      return 'RaceTrac';
  if (/\bstripes\b/i.test(s))               return 'Stripes';
  if (/love'?s/i.test(s))                   return "Love's";
  if (/pilot|flying\s*j/i.test(s))          return 'Pilot/Flying J';
  if (/\bmobil\b/i.test(s))                 return 'Mobil';
  if (/\bbp\b/i.test(s))                    return 'BP';
  if (/\bspeedway\b/i.test(s))              return 'Speedway';
  if (/\bwawa\b/i.test(s))                  return 'Wawa';
  if (/tom\s*thumb/i.test(s))               return 'Tom Thumb';
  return s;
}

const ACTOR        = 'johnvc~fuelprices';
const RUN_SYNC_URL = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
const CITY_FILTER  = (process.env.CITY_FILTER || '').trim();
const CONCURRENCY  = parseInt(process.env.CONCURRENCY || '5', 10);
const PRICES_PATH  = './prices.json';

function pickName(item)  { return item.name || item.brand || ''; }
function pickPrice(item) {
  const credit = Number(item.price_credit);
  if (Number.isFinite(credit) && credit > 0) return credit;
  const cash = Number(item.price_cash);
  if (Number.isFinite(cash) && cash > 0) return cash;
  return null;
}
function pickAddress(item) {
  const parts = [item.address_line1, item.address_locality].filter(Boolean);
  return parts.join(', ');
}
function round3(n) { return Math.round(Number(n) * 1000) / 1000; }

async function fetchZip(zip, retries = 2) {
  const started = Date.now();
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(
        RUN_SYNC_URL,
        { search: zip, searchLocation: zip, fuelType: 1, maxItems: 30 },
        { headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
      );
      const items = Array.isArray(res.data) ? res.data : [];
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`  ✓ ZIP ${zip} — ${items.length} items in ${elapsed}s`);
      return items;
    } catch (e) {
      const msg = e.response
        ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data).slice(0, 200)}`
        : e.message;
      if (attempt < retries) {
        console.warn(`  … ZIP ${zip} retry ${attempt + 1}/${retries} — ${msg}`);
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      } else {
        console.error(`  ✗ ZIP ${zip} failed — ${msg}`);
        return null;
      }
    }
  }
}

async function runPool(items, worker, concurrency) {
  const out = new Array(items.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (idx < items.length) {
        const i = idx++;
        out[i] = await worker(items[i]);
      }
    })
  );
  return out;
}

function buildCityResult(city, rawItems) {
  // Dedupe: primary by station id, secondary by (canonical chain, address).
  // When duplicates are found, keep whichever price is cheaper.
  const byId = new Map();
  const byChainAddr = new Map();

  for (const item of rawItems) {
    const price = pickPrice(item);
    if (price == null) continue;
    const canonical = canonicalChainName(pickName(item));
    if (!canonical) continue;
    const addr = (item.address_line1 || '').toLowerCase().trim();
    const addrKey = canonical + '|' + addr;
    const id = String(item.id || `${canonical}|${addr}|${item.address_postalCode || ''}`);
    const entry = { raw: item, canonical, price, addr, addrKey, id };

    // Primary dedup: same station id
    const existingById = byId.get(id);
    if (existingById) {
      if (price < existingById.price) {
        byId.set(id, entry);
        byChainAddr.set(addrKey, entry);
      }
      continue;
    }

    // Secondary dedup: same (chain, address)
    const existingByAddr = byChainAddr.get(addrKey);
    if (existingByAddr) {
      if (price < existingByAddr.price) {
        byId.delete(existingByAddr.id);
        byId.set(id, entry);
        byChainAddr.set(addrKey, entry);
      }
      continue;
    }

    byId.set(id, entry);
    byChainAddr.set(addrKey, entry);
  }

  // Sort all unique stations ascending by price, cap at 30.
  const stations = [...byId.values()]
    .sort((a, b) => a.price - b.price)
    .slice(0, 30);

  // Group by canonical chain for the summary array.
  const byChain = new Map();
  for (const s of stations) {
    const existing = byChain.get(s.canonical);
    if (!existing) {
      byChain.set(s.canonical, { station: s, count: 1 });
    } else {
      existing.count++;
      if (s.price < existing.station.price) existing.station = s;
    }
  }
  const chains = [...byChain.entries()]
    .map(([chain, { station, count }]) => ({
      chain,
      regular:      round3(station.price),
      station:      station.raw.name,
      address:      pickAddress(station.raw) || null,
      stationCount: count,
    }))
    .sort((a, b) => a.regular - b.regular);

  const cheapest = stations[0] || null;

  return {
    slug: city.slug,
    chains,
    cheapestOverall: cheapest ? {
      chain:   cheapest.canonical,
      station: cheapest.raw.name,
      price:   round3(cheapest.price),
      address: pickAddress(cheapest.raw) || null,
    } : null,
    stationsSeen: stations.length,
    stationsRaw:  rawItems.length,
    zipsFetched:  city.zips.length,
  };
}

(async () => {
  const filterSet = CITY_FILTER
    ? new Set(CITY_FILTER.split(',').map(s => s.trim()).filter(Boolean))
    : null;
  const targetCities = filterSet
    ? CITIES.filter(c => filterSet.has(c.slug))
    : CITIES;

  if (!targetCities.length) {
    console.error('No cities selected. Check CITY_FILTER.');
    process.exit(1);
  }

  // Unique ZIPs across all target cities — fetch each ONLY ONCE and share
  // the result across whichever cities include it.
  const uniqueZips = [...new Set(targetCities.flatMap(c => c.zips))];
  console.log(
    `Fetching ${uniqueZips.length} unique ZIPs ` +
    `(across ${targetCities.length} cities, ` +
    `${targetCities.reduce((s, c) => s + c.zips.length, 0)} total ZIP slots) ` +
    `at concurrency=${CONCURRENCY}...`
  );

  const zipCache = {};
  await runPool(uniqueZips, async (zip) => {
    zipCache[zip] = await fetchZip(zip);
  }, CONCURRENCY);

  const zipsFailed = uniqueZips.filter(z => zipCache[z] === null);
  const totalRaw = uniqueZips.reduce((s, z) => s + (zipCache[z]?.length || 0), 0);
  console.log(`\nZIP fetches: ${uniqueZips.length - zipsFailed.length}/${uniqueZips.length} successful, ${totalRaw} total raw items.`);

  // Aggregate per city from the cached ZIP results.
  const cityResults = targetCities.map(city => {
    const rawItems = city.zips.flatMap(z => zipCache[z] || []);
    return buildCityResult(city, rawItems);
  });

  const citiesBlock = {};
  const empties = [];
  for (const r of cityResults) {
    if (r.chains && r.chains.length > 0) {
      citiesBlock[r.slug] = {
        chains:          r.chains,
        cheapestOverall: r.cheapestOverall,
        stationsSeen:    r.stationsSeen,
        zipsFetched:     r.zipsFetched,
      };
    } else {
      empties.push(r.slug);
    }
  }

  // Merge into existing prices.json non-destructively.
  let existing = {};
  if (fs.existsSync(PRICES_PATH)) {
    try { existing = JSON.parse(fs.readFileSync(PRICES_PATH, 'utf8')); }
    catch { existing = {}; }
  }
  const merged = {
    ...existing,
    updated: new Date().toISOString(),
    source: {
      ...(existing.source || {}),
      apify: `apify.com/actors/${ACTOR} (daily, ${Object.keys(citiesBlock).length}/${targetCities.length} cities, ${uniqueZips.length} ZIPs)`,
    },
    cities: {
      ...(existing.cities || {}),
      ...citiesBlock,
    },
    apifyUpdated: new Date().toISOString(),
  };
  fs.writeFileSync(PRICES_PATH, JSON.stringify(merged, null, 2));
  console.log(`\n✓ Merged ${Object.keys(citiesBlock).length} cities into ${PRICES_PATH}`);

  // Summary ready for machine parsing by the caller (node -e or grep).
  console.log('\n───── Run summary ─────');
  console.log(`unique_zips_fetched=${uniqueZips.length}`);
  console.log(`zips_failed=${zipsFailed.length}${zipsFailed.length ? ' (' + zipsFailed.join(',') + ')' : ''}`);
  console.log(`total_raw_items=${totalRaw}`);
  console.log(`cities_with_data=${Object.keys(citiesBlock).length}`);
  console.log(`cities_empty=${empties.length}${empties.length ? ' (' + empties.join(',') + ')' : ''}`);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
