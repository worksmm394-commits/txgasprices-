/*
 * fetch-apify-prices.js
 *
 * Calls the Apify actor `johnvc/fuelprices` (GasBuddy scraper) once per top
 * Texas city and extracts the cheapest current price for each of our 5
 * tracked chains plus the overall cheapest station regardless of chain.
 *
 * Output is MERGED into prices.json under a new `cities` block so it lives
 * alongside the AAA state-average payload produced by fetch-prices.js.
 * generate.js prefers per-city data when present and falls back to the
 * state-average-derived estimates otherwise.
 *
 *   APIFY_TOKEN=... node fetch-apify-prices.js
 *
 * Optional env:
 *   CITY_FILTER=houston-tx,dallas-tx   run only these slugs (for testing)
 *   CONCURRENCY=3                       parallel actor runs (default 3)
 */

const axios = require('axios');
const fs    = require('fs');

const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
if (!APIFY_TOKEN) {
  console.error('ERROR: APIFY_TOKEN env var is required.');
  process.exit(1);
}

// Top 50 Texas cities by population + growth, chosen for maximum search
// traffic coverage. ZIPs are suburban/retail where possible — downtown
// business-district ZIPs under-represent discount chains.
const CITIES = [
  { slug: 'houston-tx',          zip: '77079' },
  { slug: 'san-antonio-tx',      zip: '78250' },
  { slug: 'dallas-tx',           zip: '75248' },
  { slug: 'austin-tx',           zip: '78745' },
  { slug: 'fort-worth-tx',       zip: '76116' },
  { slug: 'el-paso-tx',          zip: '79925' },
  { slug: 'arlington-tx',        zip: '76015' },
  { slug: 'corpus-christi-tx',   zip: '78413' },
  { slug: 'plano-tx',            zip: '75075' },
  { slug: 'lubbock-tx',          zip: '79424' },
  { slug: 'laredo-tx',           zip: '78045' },
  { slug: 'irving-tx',           zip: '75063' },
  { slug: 'garland-tx',          zip: '75043' },
  { slug: 'frisco-tx',           zip: '75034' },
  { slug: 'mckinney-tx',         zip: '75070' },
  { slug: 'grand-prairie-tx',    zip: '75052' },
  { slug: 'amarillo-tx',         zip: '79119' },
  { slug: 'brownsville-tx',      zip: '78526' },
  { slug: 'killeen-tx',          zip: '76542' },
  { slug: 'denton-tx',           zip: '76210' },
  { slug: 'mesquite-tx',         zip: '75150' },
  { slug: 'pasadena-tx',         zip: '77504' },
  { slug: 'mcallen-tx',          zip: '78504' },
  { slug: 'waco-tx',             zip: '76710' },
  { slug: 'midland-tx',          zip: '79707' },
  { slug: 'lewisville-tx',       zip: '75067' },
  { slug: 'carrollton-tx',       zip: '75010' },
  { slug: 'round-rock-tx',       zip: '78664' },
  { slug: 'abilene-tx',          zip: '79606' },
  { slug: 'pearland-tx',         zip: '77584' },
  { slug: 'college-station-tx',  zip: '77845' },
  { slug: 'richardson-tx',       zip: '75080' },
  { slug: 'league-city-tx',      zip: '77573' },
  { slug: 'odessa-tx',           zip: '79762' },
  { slug: 'beaumont-tx',         zip: '77706' },
  { slug: 'allen-tx',            zip: '75013' },
  { slug: 'sugar-land-tx',       zip: '77478' },
  { slug: 'edinburg-tx',         zip: '78539' },
  { slug: 'tyler-tx',            zip: '75703' },
  { slug: 'wichita-falls-tx',    zip: '76308' },
  { slug: 'san-angelo-tx',       zip: '76904' },
  { slug: 'longview-tx',         zip: '75605' },
  { slug: 'pflugerville-tx',     zip: '78660' },
  { slug: 'cedar-park-tx',       zip: '78613' },
  { slug: 'georgetown-tx',       zip: '78628' },
  { slug: 'conroe-tx',           zip: '77304' },
  { slug: 'baytown-tx',          zip: '77521' },
  { slug: 'atascocita-tx',       zip: '77346' },
  { slug: 'rowlett-tx',          zip: '75089' },
  { slug: 'flower-mound-tx',     zip: '75028' },
];

// Canonicalize raw station names to a stable brand label. We group all
// stations by this canonical name and take the cheapest per group. For known
// brand families (Murphy USA/Express, HEB/H-E-B, Bucees/Buc-ee's) we force a
// single canonical spelling; anything else falls through as-is (title-cased).
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
  if (/qu(ik|ick)\s*trip|\bqt\b/i.test(s))  return 'QuikTrip';
  if (/race\s*trac|racetrac/i.test(s))      return 'RaceTrac';
  if (/\bstripes\b/i.test(s))               return 'Stripes';
  if (/love'?s/i.test(s))                   return "Love's";
  if (/pilot|flying\s*j/i.test(s))          return 'Pilot/Flying J';
  if (/\bmobil\b/i.test(s))                 return 'Mobil';
  if (/\bbp\b/i.test(s))                    return 'BP';
  if (/\bspeedway\b/i.test(s))              return 'Speedway';
  if (/\bwawa\b/i.test(s))                  return 'Wawa';
  // Everything else: preserve the name as-is (scraper already title-cases).
  return s;
}

const ACTOR           = 'johnvc~fuelprices';
const RUN_SYNC_URL    = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
const CITY_FILTER     = (process.env.CITY_FILTER || '').trim();
const CONCURRENCY     = parseInt(process.env.CONCURRENCY || '3', 10);
const PRICES_PATH     = './prices.json';

// Shape of johnvc/fuelprices output (verified by probing the actor):
//   { name, price_credit, price_cash, priceUnit: "dollars_per_gallon",
//     address_line1, address_locality, address_postalCode, ... }
// A posted price of 0 or null means the station has no current data; we
// prefer the credit price and fall back to cash only when credit is absent.
function pickName(item) {
  return item.name || item.brand || '';
}
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

async function fetchCity(city) {
  const started = Date.now();
  try {
    // Actor rejects `searchLocation`; its input schema uses `search`.
    // Keep searchLocation in the body too for forward-compat (ignored if unknown).
    const res = await axios.post(
      RUN_SYNC_URL,
      { search: city.zip, searchLocation: city.zip, fuelType: 1, maxItems: 30 },
      { headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
    );
    const items = Array.isArray(res.data) ? res.data : [];
    if (!items.length) {
      console.warn(`  ! ${city.slug} (${city.zip}) returned 0 items`);
      return { slug: city.slug, error: 'no-items' };
    }

    // Build a normalized list of stations we can search across.
    // Only stations with a posted credit/cash price make the cut — stale
    // entries with 0 or null prices are dropped here so nothing downstream
    // has to carry the "no posted price" state.
    const stations = items
      .map(i => ({
        raw:     pickName(i),
        canon:   canonicalChainName(pickName(i)),
        price:   pickPrice(i),
        address: pickAddress(i),
      }))
      .filter(s => s.canon && s.price != null);

    // Group stations by canonical chain name; pick the cheapest in each group.
    const byChain = new Map();
    for (const s of stations) {
      const existing = byChain.get(s.canon);
      if (!existing) {
        byChain.set(s.canon, { station: s, count: 1 });
      } else {
        existing.count++;
        if (s.price < existing.station.price) existing.station = s;
      }
    }
    const chainResults = [...byChain.entries()]
      .map(([chain, { station, count }]) => ({
        chain,
        regular:      Math.round(station.price * 1000) / 1000,
        station:      station.raw,
        address:      station.address || null,
        stationCount: count,
      }))
      .sort((a, b) => a.regular - b.regular);

    // Overall cheapest station (any chain) — useful for the homepage + FAQ.
    const overallCheapest = stations.reduce((a, b) => b.price < a.price ? b : a);

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`  ✓ ${city.slug} (${city.zip}) — ${stations.length} stations, ${chainResults.length} chains in ${elapsed}s`);

    return {
      slug: city.slug,
      chains: chainResults,
      cheapestOverall: {
        chain:   canonicalChainName(overallCheapest.raw),
        station: overallCheapest.raw,
        price:   Math.round(overallCheapest.price * 1000) / 1000,
        address: overallCheapest.address || null,
      },
      stationsSeen: stations.length,
    };
  } catch (e) {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const msg = e.response
      ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data).slice(0, 200)}`
      : e.message;
    console.error(`  ✗ ${city.slug} (${city.zip}) in ${elapsed}s — ${msg}`);
    return { slug: city.slug, error: msg };
  }
}

async function runPool(items, worker, concurrency) {
  const out = [];
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

  console.log(`Fetching ${targetCities.length} cities from ${ACTOR} (concurrency=${CONCURRENCY})...`);
  const results = await runPool(targetCities, fetchCity, CONCURRENCY);

  // Build the cities block, keyed by slug. Only cities that succeeded with
  // at least one priced chain are included.
  const citiesBlock = {};
  for (const r of results) {
    if (r && !r.error && Array.isArray(r.chains) && r.chains.length > 0) {
      citiesBlock[r.slug] = {
        chains:           r.chains,
        cheapestOverall:  r.cheapestOverall,
        stationsSeen:     r.stationsSeen,
      };
    }
  }

  // Merge into existing prices.json (preserves stateAverage, chains, etc).
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
      apify: `apify.com/actors/${ACTOR} (daily, ${Object.keys(citiesBlock).length}/${targetCities.length} cities)`,
    },
    cities: {
      ...(existing.cities || {}),
      ...citiesBlock,
    },
    apifyUpdated: new Date().toISOString(),
  };
  fs.writeFileSync(PRICES_PATH, JSON.stringify(merged, null, 2));

  console.log(`\n✓ Merged ${Object.keys(citiesBlock).length} cities into ${PRICES_PATH}`);

  // Readable summary for manual inspection.
  console.log('\n───── Summary ─────');
  for (const r of results) {
    if (r.error) {
      console.log(`\n${r.slug}: ERROR — ${r.error}`);
      continue;
    }
    console.log(`\n${r.slug}  (${r.chains.length} chains, ${r.stationsSeen} stations):`);
    for (const row of r.chains) {
      const count = row.stationCount > 1 ? ` (${row.stationCount}×)` : '';
      console.log(`  ${row.chain.padEnd(14)} $${row.regular.toFixed(3)}/gal${count}  @ ${row.address || row.station}`);
    }
    if (r.cheapestOverall?.price != null) {
      console.log(`  ${'CHEAPEST'.padEnd(14)} $${r.cheapestOverall.price.toFixed(3)}/gal  @ ${r.cheapestOverall.station}`);
    }
  }
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
