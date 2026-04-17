/*
 * generate.js
 *
 * Reads the master HTML template from texas_gas_site_ui_mockup.html at
 * runtime and produces one static page per (town, fuel) pair, plus a
 * /cheapest sub-page per town and a sitemap.xml.
 *
 * Substitution is simple `{{TOKEN}}` string replacement. No framework,
 * no template engine — the mockup file itself is the source of truth
 * for layout, styles, and client-side behavior.
 */

const fs   = require('fs');
const path = require('path');

// ── data ──────────────────────────────────────────────────────
const prices    = JSON.parse(fs.readFileSync('./prices.json', 'utf8'));
const towns     = JSON.parse(fs.readFileSync('./towns.json',  'utf8'));
const CITY_INFO = fs.existsSync('./cities-info.json')
  ? JSON.parse(fs.readFileSync('./cities-info.json', 'utf8'))
  : {};
const TEMPLATE  = fs.readFileSync('./texas_gas_site_ui_mockup.html', 'utf8');

const FUELS        = ['regular', 'midgrade', 'premium', 'diesel'];
const hasEstimates = prices.chains.some(c => c.priceMode === 'estimated');
const CURRENT_YEAR = new Date().getFullYear();

// Placeholder station metadata for fallback chains. Real addresses/distances
// come from Apify per-city data when available; these are used only for
// cities without Apify coverage so UI cards aren't blank.
const STATION_META = {
  'Murphy USA':  { a: '4821 Westheimer Rd',   d: '0.4 mi' },
  'HEB Gas':     { a: '2300 S Shepherd Dr',   d: '0.8 mi' },
  "Buc-ee's":    { a: '9350 Katy Freeway',    d: '1.2 mi' },
  'Valero':      { a: '3400 Main St',         d: '0.9 mi' },
  'Exxon':       { a: '1801 Smith St',        d: '1.1 mi' },
  'Conoco':      { a: '7000 Kirby Dr',        d: '1.3 mi' },
  'Shell':       { a: '1100 Louisiana St',    d: '1.4 mi' },
  'Phillips 66': { a: '4200 Richmond Ave',    d: '1.5 mi' },
  'Chevron':     { a: '5600 Richmond Ave',    d: '1.7 mi' },
};

// ── regional price variation ─────────────────────────────────
// Per-city multipliers against the Texas state average. Makes each city
// page slightly different so Google sees unique content across 100 towns.
const REGIONS = {
  // West Texas (+3%): longer refinery supply chain → higher prices
  'el-paso-tx': 'west', 'midland-tx': 'west', 'odessa-tx': 'west',
  'lubbock-tx': 'west', 'amarillo-tx': 'west', 'abilene-tx': 'west',
  'big-spring-tx': 'west',
  // South Texas / border (-3%): lower transport costs + regional competition
  'laredo-tx': 'border', 'brownsville-tx': 'border', 'mcallen-tx': 'border',
  'edinburg-tx': 'border', 'mission-tx': 'border', 'pharr-tx': 'border',
  // DFW Metroplex (+1%)
  'dallas-tx': 'dfw', 'fort-worth-tx': 'dfw', 'arlington-tx': 'dfw',
  'plano-tx': 'dfw', 'garland-tx': 'dfw', 'irving-tx': 'dfw',
  'mckinney-tx': 'dfw', 'frisco-tx': 'dfw', 'denton-tx': 'dfw',
  'carrollton-tx': 'dfw',
  // Greater Houston (-1%)
  'houston-tx': 'houston', 'pasadena-tx': 'houston', 'pearland-tx': 'houston',
  'sugar-land-tx': 'houston', 'missouri-city-tx': 'houston',
  'friendswood-tx': 'houston', 'league-city-tx': 'houston', 'baytown-tx': 'houston',
};
const MULTIPLIERS = { west: 1.03, border: 0.97, dfw: 1.01, houston: 0.99 };

function regionFor(town)         { return REGIONS[town.slug] || 'other'; }
function regionMultiplier(town)  { return MULTIPLIERS[regionFor(town)] || 1.0; }

// ── FAQ pills: region & elevation metadata ───────────────────
// Region slug (from cities-info.json) → human-readable pill label
const REGION_PILL_NAME = {
  'houston-metro':       'Greater Houston',
  'dfw-metro':           'DFW Metroplex',
  'sa-metro':            'San Antonio Metro',
  'austin-metro':        'Austin Metro',
  'austin-sa-corridor':  'Austin–SA Corridor',
  'rio-grande-valley':   'Rio Grande Valley',
  'coastal-tx':          'Gulf Coast',
  'west-tx':             'West Texas',
  'south-tx':            'South Texas',
  'central-tx':          'Central Texas',
  'east-tx':             'East Texas',
  'north-tx':            'North Texas',
};
// Permian-basin cities override the generic "West Texas" pill with
// the sub-region name and keep "West Texas" as an additional broad pill.
const CITY_PRIMARY_REGION = {
  'midland-tx':     'Permian Basin',
  'odessa-tx':      'Permian Basin',
  'big-spring-tx':  'Permian Basin',
};
const CITY_BROAD_REGION = {
  'midland-tx':     'West Texas',
  'odessa-tx':      'West Texas',
  'big-spring-tx':  'West Texas',
};
// Elevation (ft) — hardcoded for major Texas cities; omitted cities skip the pill.
const CITY_ELEVATION = {
  'houston-tx': 80, 'dallas-tx': 430, 'austin-tx': 489, 'san-antonio-tx': 650,
  'fort-worth-tx': 653, 'el-paso-tx': 3740, 'midland-tx': 2779, 'odessa-tx': 2890,
  'lubbock-tx': 3202, 'amarillo-tx': 3605, 'abilene-tx': 1737, 'big-spring-tx': 2401,
  'laredo-tx': 438, 'brownsville-tx': 43, 'mcallen-tx': 122, 'corpus-christi-tx': 23,
  'beaumont-tx': 33, 'tyler-tx': 544, 'waco-tx': 470, 'college-station-tx': 320,
  'killeen-tx': 843, 'round-rock-tx': 650, 'denton-tx': 642, 'plano-tx': 650,
  'arlington-tx': 614, 'garland-tx': 525, 'irving-tx': 463, 'frisco-tx': 688,
  'mckinney-tx': 614, 'richardson-tx': 630, 'carrollton-tx': 531, 'lewisville-tx': 515,
  'allen-tx': 650, 'grand-prairie-tx': 571, 'mesquite-tx': 449, 'pasadena-tx': 39,
  'pearland-tx': 49, 'sugar-land-tx': 82, 'league-city-tx': 10, 'missouri-city-tx': 52,
  'friendswood-tx': 52, 'baytown-tx': 16, 'edinburg-tx': 89, 'mission-tx': 135,
  'pharr-tx': 125, 'wichita-falls-tx': 948, 'tyler-tx': 544,
};

// Membership fees (annual $) for breakeven math in FAQ answers.
const MEMBERSHIP_FEE = {
  "Sam's Club": 50,
  'Costco':    65,
  "BJ's":      55,
};

function regionDesc(town) {
  const r = regionFor(town);
  if (r === 'west')    return 'West Texas';
  if (r === 'dfw')     return 'the Dallas-Fort Worth Metroplex';
  if (r === 'houston') return 'the Greater Houston area';
  if (r === 'border')  return 'South Texas';
  // "Other" — split East/Central Texas by longitude (-96 is a rough divide)
  if (town.lng != null && town.lng > -96.0) return 'East Texas';
  return 'Central Texas';
}

function aboveBelow(mult) {
  if (mult > 1.0)  return 'pay above';
  if (mult < 1.0)  return 'pay below';
  return 'pay close to';
}

// Round to 3 decimals for per-gallon prices.
function round3(n) { return Math.round(Number(n) * 1000) / 1000; }
function money3(n) { return Number(n).toFixed(3); }
function money2(n) { return Number(n).toFixed(2); }

// ── helpers ───────────────────────────────────────────────────
function fmtPrice(n)       { return '$' + Number(n).toFixed(2); }
function fuelLabel(f)      { return f.charAt(0).toUpperCase() + f.slice(1); }

// Returns the live chain array for a town, or null if none exists.
// Tolerates the pre-refactor schema (`cityRow.regular`) by translating it
// on the fly so builds don't regress while the daily fetch replaces old
// entries. Stations with no posted price are dropped.
function liveChainsFor(town) {
  const c = prices.cities && prices.cities[town.slug];
  if (!c) return null;
  if (Array.isArray(c.chains) && c.chains.length) return c.chains;
  if (Array.isArray(c.regular)) {
    const chains = c.regular.filter(r => r && r.regular != null);
    return chains.length ? chains : null;
  }
  return null;
}
function townHasLiveData(town) { return !!liveChainsFor(town); }

// Fuel-grade differential from the Texas state average (e.g. mid is ~$0.44
// above regular). We apply this delta to live regular prices so /midgrade,
// /premium, /diesel pages of live-data cities have plausible numbers.
function fuelDiffFromState() {
  const base = prices.stateAverage || {};
  const r = Number(base.regular) || 0;
  return {
    regular:  0,
    midgrade: (Number(base.midgrade) || 0) - r,
    premium:  (Number(base.premium)  || 0) - r,
    diesel:   (Number(base.diesel)   || 0) - r,
  };
}

// Per-town chain list.
//   - Live-data city  → return ALL chains Apify found (no padding with fallbacks)
//   - No data city    → return the 9 fallback chains, each × regional multiplier
// Regular price is real for live chains; mid/premium/diesel are derived via
// fuelDiffFromState() since the actor only fetches regular (fuelType: 1).
function chainsForTown(town) {
  const mult = regionMultiplier(town);
  const live = liveChainsFor(town);

  if (live) {
    const diff = fuelDiffFromState();
    return live.map(c => {
      const reg = Number(c.regular);
      return {
        chain:        c.chain,
        priceMode:    'live',
        address:      c.address || null,
        station:      c.station || null,
        stationCount: c.stationCount || null,
        regular:      round3(reg),
        midgrade:     round3(reg + diff.midgrade),
        premium:      round3(reg + diff.premium),
        diesel:       round3(reg + diff.diesel),
      };
    });
  }

  return prices.chains.map(c => {
    const row = {
      chain:        c.chain,
      priceMode:    c.priceMode || 'estimated',
      address:      null,
      station:      null,
      stationCount: null,
    };
    for (const f of FUELS) row[f] = round3(c[f] * mult);
    return row;
  });
}
function sortedByPriceForTown(town, f) {
  return chainsForTown(town).sort((a, b) => a[f] - b[f]);
}
function cheapestForTown(town, f)      { return sortedByPriceForTown(town, f)[0]; }
function mostExpensiveForTown(town, f) { return sortedByPriceForTown(town, f).slice(-1)[0]; }
function stateAvgForTown(_town, f) {
  // State average is state-level, not per-city. Unmultiplied.
  const base = prices.stateAverage && prices.stateAverage[f];
  return base == null ? null : round3(base);
}

// Haversine great-circle distance in km between two {lat, lng} points.
function haversineKm(a, b) {
  const toRad = d => d * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(x));
}

function nearestCities(town, n = 6) {
  if (town.lat == null || town.lng == null) return [];
  return towns
    .filter(t => t.slug !== town.slug && t.lat != null && t.lng != null)
    .map(t => ({ t, km: haversineKm(town, t) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, n)
    .map(x => x.t);
}

function buildNearbyCitiesHtml(town) {
  const cities = nearestCities(town);
  if (!cities.length) return '';
  const items = cities.map(t =>
    `    <li><a href="/gas-prices/${t.slug}">Gas prices in ${t.name}</a></li>`
  ).join('\n');
  return `<section class="nearby">
  <h2>Nearby cities</h2>
  <ul class="nearby-list">
${items}
  </ul>
</section>`;
}

// All user-facing timestamps render in Central Time so the site reads
// consistently for Texas visitors regardless of where the server runs.
function formatUpdated(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

// Time-only render (e.g. "4:05 PM CT") for the FAQ header's live-dot line.
function formatUpdatedTime(iso) {
  const d = new Date(iso);
  const t = d.toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric', minute: '2-digit',
  });
  return `${t} CT`;
}

function formatPopShort(pop) {
  const n = Number(pop);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return (m >= 10 ? m.toFixed(1) : m.toFixed(1)) + 'M';
  }
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return String(n);
}

// Build the priceData object literal the client-side JS expects.
// Shape per fuel: [{n, p, ch, a, d}] sorted cheapest-first.
// Address preference: real Apify address > fallback STATION_META > generic.
function buildPriceData(town) {
  const out = {};
  for (const fuel of FUELS) {
    out[fuel] = sortedByPriceForTown(town, fuel).map(c => ({
      n:  c.chain,
      p:  Number(c[fuel]),
      ch: 'same', // day-over-day delta not tracked yet
      a:  c.address || STATION_META[c.chain]?.a || '1000 Main St',
      d:  STATION_META[c.chain]?.d || 'nearby',
      sc: c.stationCount || null, // station count from Apify (null for fallback)
    }));
  }
  return out;
}

function buildCityOptions(currentFull) {
  return towns.map(t => {
    const val = `${t.name}, TX`;
    const sel = val === currentFull ? ' selected' : '';
    return `        <option value="${val}" data-slug="${t.slug}"${sel}>${val}</option>`;
  }).join('\n');
}

function buildFuelTabs(slug, currentFuel) {
  return FUELS.map(f => {
    const href = f === 'regular'
      ? `/gas-prices/${slug}`
      : `/gas-prices/${slug}/${f}`;
    const on = f === currentFuel ? ' on' : '';
    return `    <a class="ft${on}" href="${href}">${fuelLabel(f)}</a>`;
  }).join('\n');
}

// ── dynamic FAQ ──────────────────────────────────────────────
// Drives both the visible FAQ <details> block AND the FAQPage JSON-LD.
// Answers contain inline <b> for price highlights; JSON-LD strips tags.
//
// Every city gets Q1 (cheapest) + Q2 (tank cost). Additional questions are
// added conditionally from cities-info.json:
//   - cheapest chain is a warehouse club → membership question
//   - refinery_nearby                     → refinery question
//   - oil_rigs_nearby > 0                 → oil-paradox question
//   - border_town                         → border question
//   - military_base                       → military question
//   - college_town                        → college/game-day question
// If no conditionals match and we're under 3 items, a state-average
// comparison fallback is appended. Each city gets 3–6 items total.

const FAQ_MIN = 3;
const FAQ_MAX = 6;
// Walmart and Walmart Neighborhood Market sell fuel to the general public
// without a membership card — only warehouse-club chains (Sam's, Costco, BJ's)
// require a paid card for their posted pump price.
const MEMBERSHIP_FAQ_CHAINS = new Set([
  "Sam's Club", 'Costco', "BJ's",
]);

function stripHtml(s) { return String(s).replace(/<[^>]+>/g, ''); }

// FAQ answers show prices at 2 decimals (consumer-friendly). The underlying
// tokens (page title, meta description) keep 3-decimal precision for SEO
// and accuracy — this helper converts only inside FAQ composition.
function faq2dec(s) {
  const n = Number(s);
  return Number.isFinite(n) ? n.toFixed(2) : String(s);
}

function countyFor(town) {
  return town.county ? town.county : null;
}

// ── conditional-question generators — each returns {q, a} or null ────────
// Question text always includes ", TX" after the city per faq-design-spec.md.
function faqMembership(town, d, info, townChains) {
  const altChain = (townChains || []).find(c => !MEMBERSHIP_FAQ_CHAINS.has(c.chain));
  const fee = MEMBERSHIP_FEE[d.cheapestChain] || 50;
  let mathPart = '';
  let altPart = '';
  if (altChain) {
    const diff = Number(altChain.regular) - Number(d.cheapestPrice);
    altPart = ` The next-cheapest non-membership chain in ${town.name}, TX is <b>${altChain.chain}</b> at <b>$${faq2dec(altChain.regular)}/gal</b>.`;
    if (diff > 0) {
      const gallons = Math.ceil(fee / diff);
      mathPart = ` At <b>$${diff.toFixed(2)}/gal</b> in savings, you'd need to pump about <b>${gallons.toLocaleString('en-US')} gallons</b> a year to break even on the <b>$${fee}</b> membership.`;
    }
  }
  return {
    q: `Do I need a membership to get the cheapest fuel in ${town.name}, TX?`,
    a: `Yes — <b>${d.cheapestChain}</b>'s posted <b>$${faq2dec(d.cheapestPrice)}/gal</b> requires a paid <span class="cc-mbr">membership price</span> card.${altPart}${mathPart}`,
  };
}

function faqRefinery(town, d, info) {
  if (!info.refinery_name) return null;
  const miles = info.refinery_miles;
  const milesPart = Number.isFinite(miles) && miles >= 0
    ? ` — roughly <b>${miles} mile${miles === 1 ? '' : 's'}</b> away`
    : '';
  const factor = info.price_factor ? ` ${info.price_factor}.` : '';
  const hwy = info.highway_primary ? ` Finished fuel travels <b>${info.highway_primary}</b> to local terminals.` : '';
  return {
    q: `Why is gas in ${town.name}, TX often cheaper than the Texas average?`,
    a: `${town.name}, TX sits near <b>${info.refinery_name}</b>${milesPart}.${factor}${hwy}`,
  };
}

function faqOilParadox(town, d, info) {
  const rigs = info.oil_rigs_nearby;
  if (!Number.isFinite(rigs) || rigs <= 0) return null;
  // Cities with a local refinery AND nearby rigs (e.g. Big Spring) don't
  // have the paradox: their fuel is already cheap. Skip the question to
  // avoid contradicting the refinery answer on the same page.
  if (info.refinery_nearby) return null;
  const county = countyFor(town) || 'the county';
  const factor = info.price_factor ? ` ${info.price_factor}.` : '';
  const hwy = info.highway_primary ? ` Gasoline returns on tankers down <b>${info.highway_primary}</b>.` : '';
  return {
    q: `Why aren't gas prices in ${town.name}, TX lower given nearby oil production?`,
    a: `Even with <b>${rigs}+ active rigs</b> in <b>${county} County</b>, Permian crude travels hundreds of miles to Gulf Coast refineries and returns as finished gasoline.${factor}${hwy}`,
  };
}

function faqBorder(town, d, info) {
  const fact = info.local_fact ? ` ${info.local_fact}.` : '';
  const factor = info.price_factor ? ` ${info.price_factor}.` : '';
  const hwy = info.highway_primary ? ` <b>${info.highway_primary}</b> carries the cross-border traffic.` : '';
  return {
    q: `Are fuel prices cheaper near the Texas-Mexico border in ${town.name}, TX?`,
    a: `${town.name}, TX sits on the border, where cross-border demand and regional competition shape pump prices.${factor}${fact}${hwy}`,
  };
}

// Normalize a military_base_name string for use inside a question sentence.
//   - Strips the " — soldiers/acres" suffix
//   - Expands common abbreviations (AFB → Air Force Base, JBSA → Joint Base San Antonio)
//   - For "X adjacent (commuter access)" phrasing → rewrites as "proximity to X"
//   - For "X nearby (Y)" phrasing → strips "nearby" but keeps the parenthetical
function militaryDisplayName(raw) {
  if (!raw) return raw;
  let s = raw.split(' — ')[0].trim();
  s = s.replace(/\bAFB\b/g, 'Air Force Base');
  s = s.replace(/\bJBSA\b/g, 'Joint Base San Antonio');
  const adjMatch = s.match(/^(.+?)\s+adjacent\s*(?:\(commuter[^)]*\))?\s*$/i);
  if (adjMatch) return `proximity to ${adjMatch[1].trim()}`;
  s = s.replace(/\s+nearby\s*\(/, ' (');
  s = s.replace(/\s+nearby\s*$/, '');
  return s;
}

function faqMilitary(town, d, info) {
  if (!info.military_base_name) return null;
  const display = militaryDisplayName(info.military_base_name);
  const commute = info.commute_note ? ` ${info.commute_note}.` : '';
  const startsWithProximity = /^proximity to\b/i.test(display);
  const answerLead = startsWithProximity
    ? `${town.name}, TX's ${display}`
    : `${town.name}, TX is adjacent to <b>${display}</b>`;
  return {
    q: `How does ${display} affect ${town.name}, TX gas demand?`,
    a: `${answerLead}, and its shift changes drive predictable fuel-demand surges.${commute}`,
  };
}

// Only Texas universities with large enrollments AND competitive football
// programs get a college FAQ — game-day traffic is the mechanism the answer
// describes, so small schools (Angelo State, Texas Lutheran, TAMIU Laredo,
// UTRGV regional campuses, Midwestern State, Austin College, Southwestern,
// Blinn, Howard) don't fit the premise and are excluded.
const MAJOR_COLLEGE_PATTERNS = [
  /university of texas at austin|\bUT Austin\b/i,
  /texas a&m university(?!.*international)/i,   // includes TAMU College Station; excludes TAMIU
  /texas tech/i,
  /baylor/i,
  /university of north texas|\bUNT\b/i,
  /\bTCU\b|texas christian/i,
  /university of texas at arlington|\bUT Arlington\b/i,
  /university of texas at san antonio|\bUTSA\b/i,
  /texas state university/i,
  /sam houston state/i,
  /\bUT Tyler\b|university of texas at tyler/i,
  /stephen f\.?\s*austin/i,
];
function isMajorCollegeTown(universityName) {
  if (!universityName) return false;
  return MAJOR_COLLEGE_PATTERNS.some(re => re.test(universityName));
}

function faqCollege(town, d, info) {
  if (!info.university_name) return null;
  if (!isMajorCollegeTown(info.university_name)) return null;
  const uniShort = info.university_name.split(' (')[0].split(',')[0].trim();
  const factMentionsCampus = info.local_fact && (
    /student|campus|university|college|stadium|football|\bA&M\b|\bTech\b|Baylor|\bUT\b/i.test(info.local_fact)
  );
  const factTail = factMentionsCampus ? ` ${info.local_fact}.` : '';
  return {
    q: `Do ${uniShort} events affect gas prices in ${town.name}, TX?`,
    a: `Home football weekends, graduations, and major campus events push local traffic and fuel demand above normal levels in ${town.name}, TX.${factTail}`,
  };
}

function faqStateAvgFallback(town, d, info) {
  const commute = info.commute_note ? ` ${info.commute_note}.` : '';
  return {
    q: `How do ${town.name}, TX gas prices compare to the Texas state average?`,
    a: `The Texas state average for regular is <b>$${faq2dec(d.stateAvg)}/gal</b>. ${town.name}, TX drivers pay close to the statewide average — choose <b>${d.cheapestChain}</b> at <b>$${faq2dec(d.cheapestPrice)}/gal</b> to pay below average.${commute}`,
  };
}

function buildFaqItems(town, d) {
  const info = CITY_INFO[town.slug] || {};
  const updatedHuman = formatUpdated(prices.updated);
  const townChains = chainsForTown(town);
  const items = [];

  // Always-on Q1 + Q2 (per-gallon prices rounded to 2 decimals for FAQ).
  // Membership chains show the yellow badge inline with the chain name.
  const isMembershipCheapest = MEMBERSHIP_FAQ_CHAINS.has(d.cheapestChain);
  const cheapestLabel = isMembershipCheapest
    ? `<b>${d.cheapestChain}</b> <span class="cc-mbr">membership price</span>`
    : `<b>${d.cheapestChain}</b>`;
  items.push({
    q: `What is the cheapest gas station in ${town.name}, TX right now?`,
    a: `${cheapestLabel} is currently the cheapest at <b>$${faq2dec(d.cheapestPrice)}/gal</b> for regular unleaded. Prices last updated ${updatedHuman}.`,
  });
  items.push({
    q: `How much does a full tank cost in ${town.name}, TX?`,
    a: `At current prices, filling a 15-gallon tank costs <b>$${d.tankCost15}</b> at ${cheapestLabel}. A 20-gallon tank costs <b>$${d.tankCost20}</b>.`,
  });

  // Priority-ordered conditionals — appended in order, capped at FAQ_MAX
  const isMembership = MEMBERSHIP_FAQ_CHAINS.has(d.cheapestChain);
  const candidates = [];
  if (isMembership)              candidates.push(faqMembership(town, d, info, townChains));
  if (info.refinery_nearby)      candidates.push(faqRefinery(town, d, info));
  if (info.oil_rigs_nearby > 0)  candidates.push(faqOilParadox(town, d, info));
  if (info.border_town)          candidates.push(faqBorder(town, d, info));
  if (info.military_base)        candidates.push(faqMilitary(town, d, info));
  if (info.college_town)         candidates.push(faqCollege(town, d, info));

  for (const c of candidates) {
    if (c && items.length < FAQ_MAX) items.push(c);
  }

  // Fallback if still under the minimum
  if (items.length < FAQ_MIN) items.push(faqStateAvgFallback(town, d, info));

  return items;
}

// Server-render the FAQ <details> blocks. A small source-citation line is
// appended below every answer — same text on every item for a given page
// (the user spec is explicit: one line under each answer).
function buildFaqItemsHtml(faqItems, sourceLine) {
  return faqItems.map(item => `    <details>
      <summary>${escHtml(item.q)}</summary>
      <div class="faq-a">${item.a}<span class="faq-src">${escHtml(sourceLine)}</span></div>
    </details>`).join('\n');
}

// Build 4 stat cards per faq-design-spec.md:
//   [population] [vehicles/household] [truck ownership] [~$XX est. monthly fuel]
// Monthly fuel = cheapestPrice * vph * 12000 miles/year / 25 mpg / 12 months.
// Missing data falls back to a dash so the grid always has 4 cells.
function buildFaqStatsHtml(town, d, info) {
  const popShort   = formatPopShort(town.population) || '—';
  const vph        = Number.isFinite(info.vehicles_per_household) ? info.vehicles_per_household : null;
  const truck      = Number.isFinite(info.truck_ownership_pct)    ? info.truck_ownership_pct    : null;
  const cheapest   = Number(d.cheapestPrice);
  const monthly    = (vph != null && Number.isFinite(cheapest))
    ? Math.round(cheapest * vph * 12000 / 25 / 12)
    : null;

  const cards = [
    { val: popShort,                              lbl: 'population' },
    { val: vph != null ? vph.toFixed(1) : '—',    lbl: 'vehicles / household' },
    { val: truck != null ? `${truck}%` : '—',     lbl: 'truck ownership' },
    { val: monthly != null ? `~$${monthly}` : '—', lbl: 'est. monthly fuel' },
  ];

  return cards.map(c => `    <div class="faq-stat">
      <div class="faq-stat-val">${escHtml(c.val)}</div>
      <div class="faq-stat-lbl">${escHtml(c.lbl)}</div>
    </div>`).join('\n');
}

// Build the pills row under the FAQ header. Skips any pill whose data is
// unavailable. Permian-basin cities (Midland/Odessa/Big Spring) get both a
// specific region pill and a broader "West Texas" pill.
function buildFaqPillsHtml(town, info) {
  const pills = [];
  if (town.county) pills.push(`${town.county} County`);
  const primary = CITY_PRIMARY_REGION[town.slug] || REGION_PILL_NAME[info.region];
  if (primary) pills.push(primary);
  const broad = CITY_BROAD_REGION[town.slug];
  if (broad) pills.push(broad);
  if (info.highway_primary) pills.push(`${info.highway_primary} corridor`);
  if (town.population) pills.push(`${town.population.toLocaleString('en-US')} residents`);
  const elev = CITY_ELEVATION[town.slug];
  if (elev != null) pills.push(`${elev.toLocaleString('en-US')} ft elevation`);
  return pills.map(p => `<span class="faq-pill">${escHtml(p)}</span>`).join('');
}

// Title shown in the FAQ header bar.
function buildFaqCityTitle(town) {
  return `Fuel prices & local data — ${town.name}, TX ⛽`;
}

// Italic context line: the local_fact sentence from cities-info.json.
function buildFaqContext(town, info) {
  const raw = (info.local_fact || '').trim();
  if (!raw) return `${town.name}, TX — local fuel market.`;
  const needsPeriod = !/[.!?]$/.test(raw);
  return needsPeriod ? `${raw}.` : raw;
}

function buildHeadExtra(town, fuel, canonicalPath, pageTitle, metaDesc, faqItems, opts = {}) {
  const { noindex = false } = opts;
  const webPage = {
    '@context':   'https://schema.org',
    '@type':      'WebPage',
    name:         pageTitle,
    description:  metaDesc,
    dateModified: prices.updated,
    url:          `https://txgasprices.net${canonicalPath}`,
  };
  const faq = {
    '@context': 'https://schema.org',
    '@type':    'FAQPage',
    mainEntity: faqItems.map(item => ({
      '@type': 'Question',
      name:    item.q,
      // JSON-LD must match visible text semantically. Visible answers have
      // <b> around prices; strip tags here so rich-result validators see
      // plain text identical to what users read.
      acceptedAnswer: { '@type': 'Answer', text: stripHtml(item.a) },
    })),
  };
  const breadcrumbItems = [
    { '@type': 'ListItem', position: 1, name: 'Home',
      item: 'https://txgasprices.net/' },
    { '@type': 'ListItem', position: 2, name: `${town.name}, TX Gas Prices`,
      item: `https://txgasprices.net/gas-prices/${town.slug}` },
  ];
  if (fuel !== 'regular') {
    breadcrumbItems.push({
      '@type': 'ListItem', position: 3, name: fuelLabel(fuel),
      item: `https://txgasprices.net/gas-prices/${town.slug}/${fuel}`,
    });
  }
  const breadcrumb = {
    '@context':       'https://schema.org',
    '@type':          'BreadcrumbList',
    itemListElement:  breadcrumbItems,
  };
  const lines = [
    `<meta name="description" content="${metaDesc}">`,
    `<link rel="canonical" href="https://txgasprices.net${canonicalPath}">`,
    `<meta property="og:title" content="${pageTitle}">`,
    `<meta property="og:description" content="${metaDesc}">`,
    `<meta property="og:url" content="https://txgasprices.net${canonicalPath}">`,
    `<meta property="og:image" content="https://txgasprices.net/og-image.png">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:image" content="https://txgasprices.net/og-image.png">`,
  ];
  if (noindex) {
    // /cheapest alias pages carry noindex to avoid duplicate-content dilution;
    // they still inherit the canonical pointing at the regular page so link
    // equity consolidates there.
    lines.push(`<meta name="robots" content="noindex,follow">`);
  }
  lines.push(
    `<script type="application/ld+json">`,
    JSON.stringify(webPage, null, 2),
    `</script>`,
    `<script type="application/ld+json">`,
    JSON.stringify(breadcrumb, null, 2),
    `</script>`,
    `<script type="application/ld+json">`,
    JSON.stringify(faq, null, 2),
    `</script>`,
  );
  return lines.join('\n');
}

function buildEstBanner(town, fuel) {
  // Suppress the "estimates" banner for cities that have live per-chain
  // prices from Apify — regular is real, and mid/premium/diesel are derived
  // from the real regular + state fuel-grade differentials, which is close
  // enough that warning about estimates would be misleading.
  if (townHasLiveData(town)) return '';
  if (!hasEstimates) return '';
  const avg = prices.stateAverage && prices.stateAverage[fuel];
  const avgText = avg != null
    ? ` (${fmtPrice(avg)}/gal ${fuel} today)`
    : '';
  return `  <div class="estnote"><b>Chain prices are estimates.</b> We start from the Texas state average${avgText} and apply typical per-chain offsets. Live per-station pricing coming soon.</div>`;
}

function buildFooterNote() {
  return hasEstimates
    ? 'State average from AAA (gasprices.aaa.com) · per-chain prices are estimates'
    : 'Per-chain live pricing · backed by AAA state-average baseline';
}

function defaultToCity(currentName) {
  // Dallas origin → Houston; everyone else → Dallas.
  return currentName === 'Dallas' ? 'Houston, TX' : 'Dallas, TX';
}

// ── chain card server-rendering ──────────────────────────────
// Chains where the posted price requires a paid membership.
const MEMBERSHIP_CHAINS = new Set([
  "Sam's Club", 'Costco', "BJ's",
]);
const MEMBERSHIP_TOOLTIP = "Requires Sam's Club / Costco / BJ's membership";

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Server-render the hero chain card grid for a city's initial (regular) fuel.
// Matches the client-side renderHero() output so the page looks identical
// before the JS re-renders on load — and, importantly, the membership badge
// appears in the raw HTML for search crawlers and no-JS visitors.
function renderInitialChainsHtml(town) {
  const pd = buildPriceData(town);
  const list = pd.regular || [];
  if (!list.length) return '';

  const HERO_MAX = 6;
  const needsToggle = list.length > HERO_MAX;
  const heroList = needsToggle ? list.slice(0, HERO_MAX) : list;

  const cards = heroList.map((c, i) => {
    const isMember = MEMBERSHIP_CHAINS.has(c.n);
    const stationsLine = c.sc && c.sc > 0
      ? `      <div class="cc-stations">${c.sc} station${c.sc === 1 ? '' : 's'} nearby</div>`
      : '';
    const memberBadge = isMember
      ? `      <div><span class="cc-mbr" title="${escAttr(MEMBERSHIP_TOOLTIP)}">⚑ membership price</span></div>`
      : '';
    const parts = [
      `    <div class="cc${i === 0 ? ' best' : ''}" data-chain="${escAttr(c.n)}" onclick="setChainFilter(this.dataset.chain)">`,
      i === 0 ? `      <div class="cc-badge">cheapest</div>` : null,
      `      <div class="cc-name">${escHtml(c.n)}</div>`,
      `      <div class="cc-price">$${c.p.toFixed(2)}</div>`,
      `      <div class="cc-ch ch-nc">— no change</div>`,
      stationsLine || null,
      memberBadge || null,
      `    </div>`,
    ].filter(Boolean);
    return parts.join('\n');
  }).join('\n');

  const toggleBtn = needsToggle
    ? `\n    <div class="chains-toggle"><button type="button" onclick="toggleChainsExpanded()">Show all ${list.length} chains ▼</button></div>`
    : '';

  return '\n' + cards + toggleBtn + '\n  ';
}

function dataSourceFor(town) {
  return townHasLiveData(town) ? 'GasBuddy data' : 'AAA Texas estimate';
}

// ── substitution ──────────────────────────────────────────────
function render(tokens) {
  let html = TEMPLATE;
  for (const [k, v] of Object.entries(tokens)) {
    // Literal {{TOKEN}} replacement; use a RegExp with global flag.
    const re = new RegExp('\\{\\{' + k + '\\}\\}', 'g');
    html = html.replace(re, v);
  }
  return html;
}

function buildPage(town, fuel, opts = {}) {
  const { isCheapestAlias = false } = opts;
  const fLabel       = fuelLabel(fuel);
  const cheap        = cheapestForTown(town, fuel);
  const expensive    = mostExpensiveForTown(town, fuel);

  // Canonical always points to the regular page. The /cheapest alias gets
  // noindex so duplicate content doesn't dilute the primary URL.
  const regularPath  = `/gas-prices/${town.slug}`;
  const fuelPath     = fuel === 'regular' ? regularPath : `${regularPath}/${fuel}`;
  const canonicalPath = isCheapestAlias ? regularPath : fuelPath;

  const cheapestPrice          = money3(cheap[fuel]);
  const cheapestPrice2         = money2(cheap[fuel]);
  const cheapestChain          = cheap.chain;
  const mostExpensivePrice     = money3(expensive[fuel]);
  const mostExpensiveChain     = expensive.chain;
  const savings                = money3(expensive[fuel] - cheap[fuel]);
  const tankCost15             = money2(cheap[fuel] * 15);
  const tankCost20             = money2(cheap[fuel] * 20);
  const tankSavingsVsExpensive = money2((expensive[fuel] - cheap[fuel]) * 15);
  const stateAvgNum            = stateAvgForTown(town, fuel);
  const stateAvg               = stateAvgNum != null ? money3(stateAvgNum) : cheapestPrice;
  const numStations            = prices.chains.length;

  // Abbreviate only in title/og:title to keep fuel subtype titles ≤60 chars;
  // visible page content (hero, FAQ, breadcrumbs) still uses the full name.
  const titleCityName = town.slug === 'north-richland-hills-tx'
    ? 'N. Richland Hills'
    : town.name;
  const pageTitle = fuel === 'regular'
    ? `${titleCityName}, TX Gas Prices Today — $${cheapestPrice2}/gal`
    : `${fLabel} Gas Prices in ${titleCityName}, TX Today — $${cheapestPrice2}/gal`;

  const heroTitle = fuel === 'regular'
    ? `Gas prices in ${town.name}, TX`
    : `${fLabel} gas prices in ${town.name}, TX`;

  const metaDesc = fuel === 'regular'
    ? `Live ${town.name}, TX gas prices updated hourly. Cheapest today: ${cheapestChain} at $${cheapestPrice2}/gal. Compare all major stations on one map.`
    : `Live ${fuel} gas prices in ${town.name}, TX updated hourly. Cheapest today: ${cheapestChain} at $${cheapestPrice2}/gal. Compare all major stations on one map.`;

  const faqItems = buildFaqItems(town, {
    cheapestPrice, cheapestChain, tankCost15, tankCost20, stateAvg,
  });
  const updatedHuman = formatUpdated(prices.updated);
  const sourceLine = townHasLiveData(town)
    ? `Source: GasBuddy via Apify, updated ${updatedHuman} CT`
    : `Source: AAA Texas, updated ${updatedHuman} CT`;
  const faqItemsHtml = buildFaqItemsHtml(faqItems, sourceLine);
  const cityInfo = CITY_INFO[town.slug] || {};
  const faqStatsHtml = buildFaqStatsHtml(town, {
    cheapestPrice, cheapestChain, tankCost15, tankCost20, stateAvg,
  }, cityInfo);
  const faqPillsHtml  = buildFaqPillsHtml(town, cityInfo);
  const faqCityTitle  = buildFaqCityTitle(town);
  const faqContext    = buildFaqContext(town, cityInfo);

  const population = Number(town.population) || 0;
  const populationFormatted = population > 0 ? population.toLocaleString('en-US') : 'many';
  const mult = regionMultiplier(town);

  return render({
    PAGE_TITLE:       pageTitle,
    HEAD_EXTRA:       buildHeadExtra(town, fuel, canonicalPath, pageTitle, metaDesc, faqItems, {
      noindex: isCheapestAlias,
    }),
    CITY_SLUG:        town.slug,
    CITY_NAME:        town.name,
    CITY_NAME_FULL:   `${town.name}, TX`,
    CITY_NAME_URL:    encodeURIComponent(`${town.name} TX`).replace(/%20/g, '+'),
    CITY_LAT:         town.lat != null ? String(town.lat) : '',
    CITY_LNG:         town.lng != null ? String(town.lng) : '',
    UPDATED:          formatUpdated(prices.updated),
    HERO_TITLE:       heroTitle,
    CITY_OPTIONS:     buildCityOptions(`${town.name}, TX`),
    FUEL_TABS:        buildFuelTabs(town.slug, fuel),
    INITIAL_FUEL:     fuel,
    EST_BANNER:       buildEstBanner(town, fuel),
    PRICE_DATA_JSON:  JSON.stringify(buildPriceData(town), null, 2),
    FOOTER_NOTE:      buildFooterNote(),
    DEFAULT_TO_CITY:  defaultToCity(town.name),
    CURRENT_YEAR:     String(CURRENT_YEAR),
    CHEAPEST_PRICE:   cheapestPrice,
    CHEAPEST_CHAIN:   cheapestChain,
    SAVINGS:          savings,
    NEARBY_CITIES:    buildNearbyCitiesHtml(town),
    MOST_EXPENSIVE_PRICE:      mostExpensivePrice,
    MOST_EXPENSIVE_CHAIN:      mostExpensiveChain,
    TANK_COST_15:              tankCost15,
    TANK_COST_20:              tankCost20,
    TANK_SAVINGS_VS_EXPENSIVE: tankSavingsVsExpensive,
    STATE_AVG:                 stateAvg,
    NUM_STATIONS:              String(numStations),
    // New regional/geo tokens
    COUNTY:                    town.county || '',
    POPULATION:                String(population),
    POPULATION_FORMATTED:      populationFormatted,
    REGION_DESC:               regionDesc(town),
    ABOVE_BELOW:               aboveBelow(mult),
    FAQ_ITEMS_HTML:            faqItemsHtml,
    FAQ_STATS_HTML:            faqStatsHtml,
    FAQ_PILLS_HTML:            faqPillsHtml,
    FAQ_CITY_TITLE:            faqCityTitle,
    FAQ_CONTEXT:               faqContext,
    UPDATED_TIME:              formatUpdatedTime(prices.updated),
    DATA_SOURCE:               dataSourceFor(town),
    INITIAL_CHAINS_HTML:       renderInitialChainsHtml(town),
  });
}

// ── Cloudflare Pages _redirects ─────────────────────────────
// Catches common typos and the removed /gas-prices-by-city-texas URL so
// any inbound links (including the old sitemap entry) consolidate to /.
function buildRedirects() {
  return [
    '/gas-prices-by-city-texas  /  301',
    '/gas-prices                /  301',
    '/texas-gas-prices          /  301',
    '/trip-calculator           /trip-cost-calculator  301',
    '',
  ].join('\n');
}

// ── robots.txt ───────────────────────────────────────────────
function buildRobotsTxt() {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /gas-prices/*/cheapest',
    '',
    'Sitemap: https://txgasprices.net/sitemap.xml',
    '',
  ].join('\n');
}

// ── sitemap ──────────────────────────────────────────────────
function buildSitemap() {
  const base  = 'https://txgasprices.net';
  const today = new Date().toISOString().split('T')[0];
  const homeLastmod = (prices.updated || today).split('T')[0];
  const urls  = [];

  urls.push(`  <url><loc>${base}/</loc><lastmod>${homeLastmod}</lastmod><changefreq>hourly</changefreq><priority>1.0</priority></url>`);

  towns.forEach(t => {
    urls.push(`  <url><loc>${base}/gas-prices/${t.slug}</loc><lastmod>${today}</lastmod><changefreq>hourly</changefreq><priority>0.9</priority></url>`);
    FUELS.slice(1).forEach(f => {
      urls.push(`  <url><loc>${base}/gas-prices/${t.slug}/${f}</loc><lastmod>${today}</lastmod><changefreq>hourly</changefreq><priority>0.7</priority></url>`);
    });
    urls.push(`  <url><loc>${base}/gas-prices/${t.slug}/cheapest</loc><lastmod>${today}</lastmod><changefreq>hourly</changefreq><priority>0.7</priority></url>`);
  });

  urls.push(`  <url><loc>${base}/trip-cost-calculator</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`);
  urls.push(`  <url><loc>${base}/cheapest-gas-texas</loc><lastmod>${today}</lastmod><changefreq>hourly</changefreq><priority>0.8</priority></url>`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`;
}

// ── homepage ─────────────────────────────────────────────────
// Real landing page (not a redirect). Lists all 100 cities as cards with
// their current cheapest price so Google has a hub page to crawl from.
function buildHomepage() {
  const canonical = 'https://txgasprices.net/';
  const updatedHuman = formatUpdated(prices.updated);

  // Per-fuel cheapest-in-Texas + per-fuel state average, all server-rendered
  // so the fuel tab JS can swap without any fetch.
  const perFuel = {};
  for (const f of FUELS) {
    const townList = towns.map(t => {
      const c = cheapestForTown(t, f);
      return { town: t, chain: c.chain, price: c[f] };
    });
    const gm = townList.reduce((a, b) => b.price < a.price ? b : a);
    perFuel[f] = {
      townPrices: townList,
      globalMin:  { slug: gm.town.slug, name: gm.town.name, chain: gm.chain, price: money3(gm.price) },
      stateAvg:   prices.stateAverage && prices.stateAverage[f] != null ? money3(prices.stateAverage[f]) : null,
    };
  }
  const stateAvgFmt = perFuel.regular.stateAvg;
  const globalMin   = perFuel.regular.globalMin;

  // Population-sorted card grid. Each card embeds all 4 fuel prices so the
  // fuel tab JS only toggles displayed text — no re-sort, no price lookup.
  const cardGridHtml = towns
    .slice()
    .sort((a, b) => (b.population || 0) - (a.population || 0))
    .map(t => {
      const attrs = FUELS.map(f => {
        const c = cheapestForTown(t, f);
        return `data-${f}="${money3(c[f])}"`;
      }).join(' ');
      const regPrice = money3(cheapestForTown(t, 'regular').regular);
      return `    <a class="city-card" href="/gas-prices/${t.slug}" ${attrs}>
      <span class="cc-name">${t.name}</span>
      <span class="cc-price">$<span class="cc-val">${regPrice}</span><span class="cc-gal">/gal</span></span>
    </a>`;
    }).join('\n');

  // City list for trip-calc datalist (both From and To use the same list).
  const tripCalcCityOptions = towns
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(t => `    <option value="${t.name}, TX">`).join('\n');

  // Per-fuel data for client-side swap. Minimal JSON: just the globalMin
  // per fuel (hero stat) + the state avg per fuel (summary box).
  const fuelDataJson = JSON.stringify(
    Object.fromEntries(FUELS.map(f => [f, {
      min:     perFuel[f].globalMin,
      avg:     perFuel[f].stateAvg,
    }]))
  );

  // Lat/lng lookup for client-side trip-calc distance math (haversine).
  const cityCoords = Object.fromEntries(
    towns.filter(t => t.lat != null && t.lng != null)
      .map(t => [t.name.toLowerCase(), { lat: t.lat, lng: t.lng }])
  );

  const webPage = {
    '@context':   'https://schema.org',
    '@type':      'WebPage',
    name:         'Texas Gas Prices Today',
    description:  'Find the cheapest gas prices across Texas. Compare chains in 100+ Texas cities.',
    dateModified: prices.updated,
    url:          canonical,
  };
  const organization = {
    '@context': 'https://schema.org',
    '@type':    'Organization',
    name:       'TXGasPrices',
    url:        'https://txgasprices.net/',
    logo:       'https://txgasprices.net/apple-touch-icon.png',
  };
  const website = {
    '@context': 'https://schema.org',
    '@type':    'WebSite',
    name:       'TXGasPrices',
    url:        'https://txgasprices.net/',
  };

  const title = 'Texas Gas Prices Today — Compare Cheapest Gas in 100 Cities | TXGasPrices';
  const description = 'Find the cheapest gas prices across Texas. Compare Murphy USA, HEB Gas, Shell, Chevron and Buc-ee\'s in 100+ Texas cities. Updated hourly from AAA data.';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<meta name="theme-color" content="#1a1a18">
<meta name="description" content="${description}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="https://txgasprices.net/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://txgasprices.net/og-image.png">
<script type="application/ld+json">
${JSON.stringify(webPage, null, 2)}
</script>
<script type="application/ld+json">
${JSON.stringify(organization, null, 2)}
</script>
<script type="application/ld+json">
${JSON.stringify(website, null, 2)}
</script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1efe8;color:#1a1a18;padding:16px;font-size:14px}
.site{display:flex;flex-direction:column;gap:10px;max-width:960px;margin:0 auto}
.topbar{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;padding:11px 20px;display:flex;align-items:center;justify-content:space-between}
.logo{font-size:16px;font-weight:500;text-decoration:none;color:#1a1a18}.logo em{color:#1D9E75;font-style:normal}
.nav{display:flex;gap:20px}.nav a{font-size:13px;color:#6b6b66;text-decoration:none}
.nav a.on{color:#1a1a18;font-weight:500}
.ftabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
.ftabs .ft{padding:6px 16px;border-radius:20px;font-size:13px;cursor:pointer;border:0.5px solid rgba(0,0,0,.1);background:#f1efe8;color:#6b6b66;transition:all .15s}
.ftabs .ft.on{background:#E1F5EE;border-color:#5DCAA5;color:#085041;font-weight:500}
.tripcalc{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;padding:18px 20px}
.tripcalc h2{font-size:16px;font-weight:500;margin-bottom:12px;letter-spacing:-.01em}
.tripcalc .tc-row{display:grid;grid-template-columns:1fr 1fr 100px auto;gap:8px;align-items:end}
.tripcalc label{font-size:11px;color:#9a9990;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px}
.tripcalc input{width:100%;padding:8px 10px;border:0.5px solid rgba(0,0,0,.18);border-radius:8px;font-size:13px;background:#fff;color:#1a1a18}
.tripcalc button{padding:9px 18px;border-radius:8px;border:0;background:#1D9E75;color:#fff;font-size:13px;font-weight:500;cursor:pointer}
.tripcalc button:hover{background:#148a63}
.tripcalc .tc-result{margin-top:12px;font-size:13px;color:#1a1a18;min-height:18px}
.tripcalc .tc-result b{color:#1D9E75;font-weight:500}
@media (max-width:600px){.tripcalc .tc-row{grid-template-columns:1fr 1fr;gap:8px}.tripcalc button{grid-column:1/-1}}
.hero{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;padding:22px 24px}
.hero h1{font-size:24px;font-weight:500;margin-bottom:6px;letter-spacing:-.01em}
.hero .sub{font-size:13px;color:#6b6b66}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-top:18px}
.sbox{background:#f8f6ef;border-radius:10px;padding:14px 16px}
.sbox .slabel{font-size:10.5px;color:#9a9990;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.sbox .sval{font-size:22px;font-weight:500}
.sbox .ssub{font-size:12px;color:#6b6b66;margin-top:2px}
.sbox .sval.g{color:#1D9E75}
.cities{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;padding:18px 20px}
.cities h2{font-size:13px;font-weight:500;color:#1a1a18;margin-bottom:14px;letter-spacing:.02em;text-transform:uppercase}
.city-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px}
.city-card{display:flex;justify-content:space-between;align-items:baseline;padding:10px 12px;border:0.5px solid rgba(0,0,0,.08);border-radius:8px;background:#fff;text-decoration:none;color:#1a1a18;transition:border-color .15s,background .15s}
.city-card:hover{border-color:#1D9E75;background:#f8fbf9}
.cc-name{font-size:13.5px;font-weight:500}
.cc-price{font-size:13.5px;color:#1D9E75;font-weight:500;font-variant-numeric:tabular-nums}
.cc-gal{font-size:11px;color:#9a9990;font-weight:400;margin-left:1px}
.footer{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;padding:11px 20px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px;color:#9a9990}
.footer span{color:#6b6b66}
.updated{font-size:12px;color:#6b6b66;margin-top:4px}
.updated .dot{display:inline-block;width:6px;height:6px;background:#1D9E75;border-radius:50%;margin-right:5px;vertical-align:middle}
</style>
</head>
<body>
<div class="site">

<div class="topbar">
  <a class="logo" href="/">TX<em>Gas</em>Prices</a>
  <div class="nav">
    <a class="on" href="/">Home</a>
    <a href="/cheapest-gas-texas">Cheapest Gas</a>
    <a href="/trip-cost-calculator">Trip Calculator</a>
  </div>
</div>

<div class="hero">
  <h1>Gas prices in Texas today</h1>
  <div class="sub">Compare cheapest gas across ${towns.length} Texas cities · Murphy USA, HEB, Shell, Chevron, Buc-ee's</div>
  <div class="updated"><span class="dot"></span>Updated ${updatedHuman}</div>
  <div class="summary">
    <div class="sbox">
      <div class="slabel"><span id="min-label">Cheapest regular in Texas</span></div>
      <div class="sval g">$<span id="min-price">${globalMin.price}</span><span style="font-size:13px;color:#9a9990;font-weight:400">/gal</span></div>
      <div class="ssub"><span id="min-chain">${globalMin.chain}</span> · <a id="min-link" href="/gas-prices/${globalMin.slug}" style="color:#1D9E75;text-decoration:none"><span id="min-town">${globalMin.name}</span></a></div>
    </div>
    ${stateAvgFmt ? `<div class="sbox">
      <div class="slabel"><span id="avg-label">Texas regular average</span></div>
      <div class="sval">$<span id="avg-price">${stateAvgFmt}</span><span style="font-size:13px;color:#9a9990;font-weight:400">/gal</span></div>
      <div class="ssub">From AAA · updated hourly</div>
    </div>` : ''}
    <div class="sbox">
      <div class="slabel">Cities tracked</div>
      <div class="sval">${towns.length}</div>
      <div class="ssub">Texas cities · ${prices.chains.length} chains each</div>
    </div>
  </div>
</div>

<section class="tripcalc" id="tripcalc">
  <h2>Calculate Your Texas Trip Gas Cost</h2>
  <form class="tc-row" onsubmit="return tcCalc(event)">
    <div><label for="tc-from">From</label><input id="tc-from" list="tc-cities" placeholder="City, TX" autocomplete="off"></div>
    <div><label for="tc-to">To</label><input id="tc-to" list="tc-cities" placeholder="City, TX" autocomplete="off"></div>
    <div><label for="tc-mpg">MPG</label><input id="tc-mpg" type="number" min="5" max="80" step="1" value="25"></div>
    <button type="submit">Calculate</button>
  </form>
  <datalist id="tc-cities">
${tripCalcCityOptions}
  </datalist>
  <div class="tc-result" id="tc-result"></div>
</section>

<section class="cities">
  <h2>All Texas cities — cheapest gas</h2>
  <div class="ftabs" id="fuel-tabs" role="tablist">
    <button type="button" class="ft on" data-fuel="regular" role="tab" aria-selected="true">Regular</button>
    <button type="button" class="ft" data-fuel="midgrade" role="tab" aria-selected="false">Midgrade</button>
    <button type="button" class="ft" data-fuel="premium" role="tab" aria-selected="false">Premium</button>
    <button type="button" class="ft" data-fuel="diesel" role="tab" aria-selected="false">Diesel</button>
  </div>
  <div class="city-grid" id="city-grid">
${cardGridHtml}
  </div>
</section>

<div class="footer">
  <span>${buildFooterNote()}</span>
  <span style="margin-left:auto">Murphy USA · HEB Gas · Shell · Chevron · Buc-ee's</span>
</div>

</div>
<script>
(function(){
  const FUEL_DATA = ${fuelDataJson};
  const FUEL_LABELS = { regular:'regular', midgrade:'midgrade', premium:'premium', diesel:'diesel' };

  // Fuel tab: swap card prices + hero stats. No fetch — all data is in
  // data-{fuel} attrs on cards and in FUEL_DATA for hero summary.
  const tabs = document.querySelectorAll('#fuel-tabs .ft');
  const cards = document.querySelectorAll('#city-grid .city-card');
  tabs.forEach(tab => tab.addEventListener('click', () => {
    const fuel = tab.dataset.fuel;
    tabs.forEach(t => {
      const on = t === tab;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    cards.forEach(c => {
      const v = c.getAttribute('data-' + fuel);
      if (v) c.querySelector('.cc-val').textContent = v;
    });
    const d = FUEL_DATA[fuel];
    if (d) {
      const min = d.min;
      document.getElementById('min-label').textContent = 'Cheapest ' + FUEL_LABELS[fuel] + ' in Texas';
      document.getElementById('min-price').textContent = min.price;
      document.getElementById('min-chain').textContent = min.chain;
      document.getElementById('min-town').textContent  = min.name;
      document.getElementById('min-link').setAttribute('href', '/gas-prices/' + min.slug);
      const avgEl = document.getElementById('avg-price');
      if (avgEl && d.avg) avgEl.textContent = d.avg;
      const avgLabel = document.getElementById('avg-label');
      if (avgLabel) avgLabel.textContent = 'Texas ' + FUEL_LABELS[fuel] + ' average';
    }
  }));

  // Trip calc (client-side). Uses haversine between the two cities if both
  // match an entry in CITY_COORDS; otherwise falls back to a gentle error.
  const CITY_COORDS = ${JSON.stringify(cityCoords)};
  const STATE_AVG_REG = ${stateAvgFmt || 'null'};
  function haversineMi(a, b) {
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const x = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
    return 6371 * 2 * Math.asin(Math.sqrt(x)) * 0.621371;
  }
  function cityKey(s) {
    return String(s || '').toLowerCase().replace(/,\\s*tx\\s*$/, '').trim();
  }
  window.tcCalc = function(e) {
    e.preventDefault();
    const from = cityKey(document.getElementById('tc-from').value);
    const to   = cityKey(document.getElementById('tc-to').value);
    const mpg  = Math.max(5, Math.min(80, Number(document.getElementById('tc-mpg').value) || 25));
    const out  = document.getElementById('tc-result');
    const a = CITY_COORDS[from], b = CITY_COORDS[to];
    if (!a || !b) {
      out.innerHTML = 'Pick two Texas cities from the list to see a cost estimate.';
      return false;
    }
    const miles = haversineMi(a, b);
    const gallons = miles / mpg;
    const price = STATE_AVG_REG || 3.50;
    const cost = gallons * price;
    out.innerHTML =
      '<b>' + miles.toFixed(0) + ' mi</b> one-way · ' +
      '<b>' + gallons.toFixed(1) + ' gal</b> at ' + mpg + ' MPG · ' +
      'about <b>$' + cost.toFixed(2) + '</b> in fuel (TX avg $' + Number(price).toFixed(2) + '/gal). ' +
      '<a href="/trip-cost-calculator" style="color:#1D9E75;text-decoration:none">See full calculator →</a>';
    return false;
  };
})();
</script>
</body>
</html>
`;
}

// ── trip-cost-calculator hub page ────────────────────────────
function buildTripCalcPage() {
  const canonical = 'https://txgasprices.net/trip-cost-calculator';
  const updatedHuman = formatUpdated(prices.updated);
  const stateAvgReg = prices.stateAverage && prices.stateAverage.regular;
  const stateAvgFmt = stateAvgReg != null ? money3(stateAvgReg) : null;
  const stateAvgPrice = stateAvgReg != null ? stateAvgReg : 3.50;
  const DEFAULT_MPG = 25;

  const townByName = Object.fromEntries(towns.map(t => [t.name, t]));
  const ROUTE_PAIRS = [
    ['Houston', 'Dallas'],
    ['Austin', 'San Antonio'],
    ['Dallas', 'Houston'],
    ['Houston', 'Austin'],
    ['El Paso', 'Dallas'],
    ['Houston', 'San Antonio'],
    ['Dallas', 'Austin'],
    ['Corpus Christi', 'Houston'],
    ['Dallas', 'Fort Worth'],
    ['San Antonio', 'Austin'],
  ];

  const routeCardsHtml = ROUTE_PAIRS.map(([fromName, toName]) => {
    const a = townByName[fromName];
    const b = townByName[toName];
    if (!a || !b || a.lat == null || b.lat == null) return '';
    const miles = haversineKm(a, b) * 0.621371;
    const gallons = miles / DEFAULT_MPG;
    const cost = gallons * stateAvgPrice;
    return `    <a class="route-card" href="/gas-prices/${a.slug}">
      <div class="rc-route">${fromName} → ${toName}</div>
      <div class="rc-stats"><span class="rc-miles">${miles.toFixed(0)} mi</span><span class="rc-cost">$${cost.toFixed(2)}</span></div>
      <div class="rc-note">${gallons.toFixed(1)} gal at ${DEFAULT_MPG} MPG · $${money2(stateAvgPrice)}/gal</div>
    </a>`;
  }).filter(Boolean).join('\n');

  const cityOptions = towns
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(t => `    <option value="${t.name}, TX">`).join('\n');
  const cityCoords = Object.fromEntries(
    towns.filter(t => t.lat != null && t.lng != null)
      .map(t => [t.name.toLowerCase(), { lat: t.lat, lng: t.lng }])
  );

  const faqItems = [
    {
      q: 'How is the trip distance calculated?',
      a: `Great-circle (as-the-crow-flies) distance between the two city centers. Real driving distance along highways is typically 10–20% longer, so actual fuel use will be slightly higher than the estimate.`,
    },
    {
      q: 'What MPG should I enter?',
      a: `Use your vehicle's real-world combined fuel economy. Modern sedans average 30–35 MPG, SUVs 22–28 MPG, and trucks 16–22 MPG. The EPA sticker value is usually close; mileage on I-10 at 75 mph will be a bit lower.`,
    },
    {
      q: 'What gas price does the calculator use?',
      a: `The current Texas state average for regular unleaded from AAA (${stateAvgFmt != null ? '$' + stateAvgFmt : 'today\u2019s'}/gal). For the most accurate estimate, check the cheapest station page for your destination city and use that price instead.`,
    },
    {
      q: 'Does the estimate include tolls, parking, or wear-and-tear?',
      a: `No — only fuel. Texas toll roads (TxTag, SH 130, Harris County EZ Tag) can add $5–$30 per one-way trip on long drives. Maintenance averages another ~$0.10/mile over a car's lifetime.`,
    },
    {
      q: 'How often is the gas price updated?',
      a: `The Texas state average refreshes hourly from AAA data. Per-city station prices refresh every 3 days. Last updated ${updatedHuman} CT.`,
    },
  ];

  const faqHtml = faqItems.map(it =>
    `  <div class="faq-q">${it.q}</div>
  <div class="faq-a">${it.a}</div>`
  ).join('\n');

  const webPage = {
    '@context':   'https://schema.org',
    '@type':      'WebPage',
    name:         'Texas Trip Gas Cost Calculator',
    description:  'Estimate fuel cost for any Texas city-to-city drive using current Texas gas prices and your vehicle MPG.',
    dateModified: prices.updated,
    url:          canonical,
  };
  const webApp = {
    '@context':        'https://schema.org',
    '@type':           'WebApplication',
    name:              'Texas Trip Gas Cost Calculator',
    url:               canonical,
    applicationCategory: 'TravelApplication',
    operatingSystem:   'Any',
    browserRequirements: 'Requires JavaScript',
    offers:            { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  };
  const faqSchema = {
    '@context': 'https://schema.org',
    '@type':    'FAQPage',
    mainEntity: faqItems.map(it => ({
      '@type':         'Question',
      name:            it.q,
      acceptedAnswer:  { '@type': 'Answer', text: it.a },
    })),
  };
  const breadcrumb = {
    '@context':       'https://schema.org',
    '@type':          'BreadcrumbList',
    itemListElement:  [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://txgasprices.net/' },
      { '@type': 'ListItem', position: 2, name: 'Trip Calculator', item: canonical },
    ],
  };

  const title = 'Texas Trip Gas Cost Calculator — Fuel Cost Between Any TX Cities';
  const description = 'Calculate the fuel cost for any Texas city-to-city drive using live Texas gas prices. Enter your MPG and two cities — get miles, gallons used, and total cost.';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<meta name="theme-color" content="#1a1a18">
<meta name="description" content="${description}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="https://txgasprices.net/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://txgasprices.net/og-image.png">
<script type="application/ld+json">
${JSON.stringify(webPage, null, 2)}
</script>
<script type="application/ld+json">
${JSON.stringify(webApp, null, 2)}
</script>
<script type="application/ld+json">
${JSON.stringify(breadcrumb, null, 2)}
</script>
<script type="application/ld+json">
${JSON.stringify(faqSchema, null, 2)}
</script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1efe8;color:#1a1a18;padding:16px;font-size:14px}
.site{display:flex;flex-direction:column;gap:10px;max-width:960px;margin:0 auto}
.topbar{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;padding:11px 20px;display:flex;align-items:center;justify-content:space-between}
.logo{font-size:16px;font-weight:500;text-decoration:none;color:#1a1a18}.logo em{color:#1D9E75;font-style:normal}
.nav{display:flex;gap:20px}.nav a{font-size:13px;color:#6b6b66;text-decoration:none}
.nav a.on{color:#1a1a18;font-weight:500}
.hero{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;padding:22px 24px}
.hero h1{font-size:24px;font-weight:500;margin-bottom:6px;letter-spacing:-.01em}
.hero .sub{font-size:13px;color:#6b6b66}
.card{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;padding:18px 20px}
.card h2{font-size:15px;font-weight:500;margin-bottom:12px;letter-spacing:-.005em}
.tc-row{display:grid;grid-template-columns:1fr 1fr 110px auto;gap:10px;align-items:end}
.tc-row label{font-size:11px;color:#9a9990;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px}
.tc-row input{width:100%;padding:9px 10px;border:0.5px solid rgba(0,0,0,.18);border-radius:8px;font-size:13px;background:#fff;color:#1a1a18}
.tc-row button{padding:10px 20px;border-radius:8px;border:0;background:#1D9E75;color:#fff;font-size:13px;font-weight:500;cursor:pointer}
.tc-row button:hover{background:#148a63}
.tc-result{margin-top:14px;padding:12px 14px;background:#f8f6ef;border-radius:8px;font-size:13px;min-height:18px;color:#1a1a18}
.tc-result b{color:#1D9E75;font-weight:500}
.tc-hint{font-size:12px;color:#9a9990;margin-top:8px}
.route-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.route-card{display:block;padding:12px 14px;border:0.5px solid rgba(0,0,0,.08);border-radius:10px;background:#fff;text-decoration:none;color:#1a1a18;transition:border-color .15s,background .15s}
.route-card:hover{border-color:#1D9E75;background:#f8fbf9}
.rc-route{font-size:13.5px;font-weight:500;margin-bottom:6px}
.rc-stats{display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px}
.rc-miles{color:#6b6b66}
.rc-cost{color:#1D9E75;font-weight:500;font-variant-numeric:tabular-nums}
.rc-note{font-size:11px;color:#9a9990}
.howit ol{margin:0 0 0 18px;font-size:13px;color:#1a1a18;line-height:1.55}
.howit li{margin-bottom:4px}
.faq{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;padding:18px 20px}
.faq h2{font-size:15px;font-weight:500;margin-bottom:12px}
.faq-q{font-size:13.5px;font-weight:500;color:#1a1a18;margin-top:12px}
.faq-q:first-of-type{margin-top:0}
.faq-a{font-size:13px;color:#6b6b66;line-height:1.55;margin-top:4px}
.footer{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;padding:11px 20px;font-size:12px;color:#9a9990}
.updated-line{font-size:12px;color:#6b6b66;margin-top:4px}
.updated-line .dot{display:inline-block;width:6px;height:6px;background:#1D9E75;border-radius:50%;margin-right:5px;vertical-align:middle}
@media (max-width:600px){.tc-row{grid-template-columns:1fr 1fr;gap:8px}.tc-row button{grid-column:1/-1}}
</style>
</head>
<body>
<div class="site">

<div class="topbar">
  <a class="logo" href="/">TX<em>Gas</em>Prices</a>
  <div class="nav">
    <a href="/">Home</a>
    <a href="/cheapest-gas-texas">Cheapest Gas</a>
    <a class="on" href="/trip-cost-calculator">Trip Calculator</a>
  </div>
</div>

<div class="hero">
  <h1>Texas Trip Gas Cost Calculator</h1>
  <div class="sub">Estimate fuel cost for any Texas city-to-city drive using live Texas gas prices.</div>
  <div class="updated-line"><span class="dot"></span>Updated ${updatedHuman} · TX regular avg $${stateAvgFmt || '—'}/gal</div>
</div>

<section class="card">
  <h2>Calculate Your Texas Trip Gas Cost</h2>
  <form class="tc-row" onsubmit="return tcCalc(event)">
    <div><label for="tc-from">From city</label><input id="tc-from" list="tc-cities" placeholder="e.g. Houston, TX" autocomplete="off"></div>
    <div><label for="tc-to">To city</label><input id="tc-to" list="tc-cities" placeholder="e.g. Dallas, TX" autocomplete="off"></div>
    <div><label for="tc-mpg">MPG</label><input id="tc-mpg" type="number" min="5" max="80" step="1" value="${DEFAULT_MPG}"></div>
    <button type="submit">Calculate</button>
  </form>
  <datalist id="tc-cities">
${cityOptions}
  </datalist>
  <div class="tc-result" id="tc-result">Pick two Texas cities to see miles, gallons used, and estimated fuel cost.</div>
  <div class="tc-hint">Tip: results use straight-line distance between city centers. Real driving routes typically add 10–20% more miles.</div>
</section>

<section class="card">
  <h2>Popular Texas routes</h2>
  <div class="route-grid">
${routeCardsHtml}
  </div>
</section>

<section class="card howit">
  <h2>How it works</h2>
  <ol>
    <li>We measure the straight-line distance between the two city centers you pick (great-circle / haversine).</li>
    <li>Divide the miles by your vehicle's MPG to get gallons of fuel needed.</li>
    <li>Multiply by the current Texas regular unleaded average from AAA (refreshed hourly).</li>
    <li>For a more accurate number, look up the destination city's cheapest station on its city page and use that price.</li>
  </ol>
</section>

<section class="faq">
  <h2>Frequently asked questions</h2>
${faqHtml}
</section>

<div class="footer">
  <span>${buildFooterNote()}</span>
</div>

</div>
<script>
(function(){
  const CITY_COORDS = ${JSON.stringify(cityCoords)};
  const STATE_AVG_REG = ${stateAvgFmt || 'null'};
  const DEFAULT_MPG = ${DEFAULT_MPG};
  function haversineMi(a, b) {
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const x = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
    return 6371 * 2 * Math.asin(Math.sqrt(x)) * 0.621371;
  }
  function cityKey(s) {
    return String(s || '').toLowerCase().replace(/,\\s*tx\\s*$/, '').trim();
  }
  window.tcCalc = function(e) {
    e.preventDefault();
    const from = cityKey(document.getElementById('tc-from').value);
    const to   = cityKey(document.getElementById('tc-to').value);
    const mpg  = Math.max(5, Math.min(80, Number(document.getElementById('tc-mpg').value) || DEFAULT_MPG));
    const out  = document.getElementById('tc-result');
    const a = CITY_COORDS[from], b = CITY_COORDS[to];
    if (!a || !b) {
      out.innerHTML = 'Pick two Texas cities from the list to see the trip cost.';
      return false;
    }
    const miles = haversineMi(a, b);
    const gallons = miles / mpg;
    const price = STATE_AVG_REG || 3.50;
    const cost = gallons * price;
    const roundTrip = cost * 2;
    out.innerHTML =
      '<b>' + miles.toFixed(0) + ' mi</b> one-way · ' +
      '<b>' + gallons.toFixed(1) + ' gal</b> at ' + mpg + ' MPG · ' +
      'about <b>$' + cost.toFixed(2) + '</b> in fuel' +
      ' (round trip ~$' + roundTrip.toFixed(2) + ')' +
      '. Based on TX avg $' + Number(price).toFixed(2) + '/gal regular.';
    return false;
  };
})();
</script>
</body>
</html>
`;
}

// ── run ──────────────────────────────────────────────────────
let pageCount = 0;

towns.forEach(town => {
  FUELS.forEach(fuel => {
    const dir = fuel === 'regular'
      ? `./output/gas-prices/${town.slug}`
      : `./output/gas-prices/${town.slug}/${fuel}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/index.html`, buildPage(town, fuel));
    pageCount++;
  });
  // /cheapest alias: same content as regular, but noindex'd and canonical
  // pointing at the regular path so the duplicate won't dilute rankings.
  const cheapDir = `./output/gas-prices/${town.slug}/cheapest`;
  fs.mkdirSync(cheapDir, { recursive: true });
  fs.writeFileSync(
    `${cheapDir}/index.html`,
    buildPage(town, 'regular', { isCheapestAlias: true })
  );
  pageCount++;
});

fs.mkdirSync('./output', { recursive: true });
fs.writeFileSync('./output/sitemap.xml', buildSitemap());
fs.writeFileSync('./output/robots.txt', buildRobotsTxt());
fs.writeFileSync('./output/_redirects', buildRedirects());
fs.writeFileSync('./output/index.html', buildHomepage());
fs.mkdirSync('./output/trip-cost-calculator', { recursive: true });
fs.writeFileSync('./output/trip-cost-calculator/index.html', buildTripCalcPage());

console.log(`\n✓ Generated ${pageCount} pages across ${towns.length} towns`);
console.log(`✓ Sitemap written with ${towns.length * 6 + 3} URLs`);
console.log(`✓ Output folder: ./output/gas-prices/\n`);
console.log('Sample URLs built:');
towns.slice(0, 5).forEach(t => {
  console.log(`  https://txgasprices.net/gas-prices/${t.slug}`);
  console.log(`  https://txgasprices.net/gas-prices/${t.slug}/diesel`);
});
