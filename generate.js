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

// Short population format: 139K, 2.3M. Returns null for 0/invalid inputs.
function formatPopShort(pop) {
  const n = Number(pop);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return m.toFixed(1) + 'M';
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

function buildFuelTabs(_slug, currentFuel) {
  // Client-side swap only — we no longer generate per-fuel subpages, so
  // clicks must stay on-page. `setFuel` (mockup script) re-renders the
  // hero/chains/stations from priceData, which has all 4 fuels embedded.
  return FUELS.map(f => {
    const on = f === currentFuel ? ' on' : '';
    return `    <button type="button" class="ft${on}" data-fuel="${f}" onclick="setFuel('${f}', this); return false;">${fuelLabel(f)}</button>`;
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

// ── FAQ header metadata (pills + elevation) ──────────────────
const REGION_PILL_NAME = {
  'houston-metro':      'Greater Houston',
  'dfw-metro':          'DFW Metroplex',
  'sa-metro':           'San Antonio Metro',
  'austin-metro':       'Austin Metro',
  'austin-sa-corridor': 'Austin–SA Corridor',
  'rio-grande-valley':  'Rio Grande Valley',
  'coastal-tx':         'Gulf Coast',
  'west-tx':            'West Texas',
  'south-tx':           'South Texas',
  'central-tx':         'Central Texas',
  'east-tx':            'East Texas',
  'north-tx':           'North Texas',
};
// Permian-basin cities override the generic "West Texas" pill with the
// sub-region name and keep "West Texas" as an additional broad pill.
const CITY_PRIMARY_REGION = {
  'midland-tx':    'Permian Basin',
  'odessa-tx':     'Permian Basin',
  'big-spring-tx': 'Permian Basin',
};
const CITY_BROAD_REGION = {
  'midland-tx':    'West Texas',
  'odessa-tx':     'West Texas',
  'big-spring-tx': 'West Texas',
};
// Elevation (ft) — omitted cities skip the pill.
const CITY_ELEVATION = {
  'houston-tx': 80, 'dallas-tx': 430, 'austin-tx': 489, 'san-antonio-tx': 650,
  'fort-worth-tx': 653, 'el-paso-tx': 3740, 'midland-tx': 2779, 'odessa-tx': 2890,
  'lubbock-tx': 3256, 'amarillo-tx': 3605, 'abilene-tx': 1710, 'big-spring-tx': 2398,
  'arlington-tx': 614, 'plano-tx': 705, 'garland-tx': 571, 'irving-tx': 495,
  'mckinney-tx': 686, 'frisco-tx': 692, 'denton-tx': 642, 'carrollton-tx': 524,
  'laredo-tx': 438, 'brownsville-tx': 33, 'mcallen-tx': 122, 'edinburg-tx': 88,
  'mission-tx': 128, 'pharr-tx': 108, 'corpus-christi-tx': 10, 'galveston-tx': 7,
  'beaumont-tx': 25, 'port-arthur-tx': 16, 'pasadena-tx': 39, 'pearland-tx': 52,
  'sugar-land-tx': 82, 'league-city-tx': 17, 'baytown-tx': 27, 'friendswood-tx': 39,
  'missouri-city-tx': 79, 'waco-tx': 470, 'college-station-tx': 328,
  'round-rock-tx': 719, 'killeen-tx': 833, 'tyler-tx': 544, 'wichita-falls-tx': 948,
};

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
function faqMembership(town, d, info, townChains) {
  const altChain = (townChains || []).find(c => !MEMBERSHIP_FAQ_CHAINS.has(c.chain));
  const altPart = altChain
    ? ` The next-cheapest non-membership chain in ${town.name}, TX is <b>${altChain.chain}</b> at <b>$${faq2dec(altChain.regular)}/gal</b>.`
    : '';
  // Breakeven math: annual gallons × price diff must clear the $50 Sam's fee
  // (industry standard). If it does, membership pays for itself.
  const memberFee = 50;
  const annualGal = 12000 / 25;
  const breakevenPart = altChain
    ? ` Break-even: the $${memberFee}/yr membership pays for itself if you buy at least <b>${Math.ceil(memberFee / Math.max(Number(altChain.regular) - Number(d.cheapestPrice), 0.01))}</b> gallons per year there.`
    : '';
  return {
    q: `Do I need a membership to get the cheapest fuel in ${town.name}, TX?`,
    a: `Yes — <b>${d.cheapestChain}</b> <span class="faq-mbr">membership price</span> posts $${faq2dec(d.cheapestPrice)}/gal and requires a paid membership card to fuel up.${altPart}${breakevenPart}`,
  };
}

function faqRefinery(town, d, info) {
  if (!info.refinery_name) return null;
  const miles = info.refinery_miles;
  const milesPart = Number.isFinite(miles) && miles >= 0
    ? ` — roughly ${miles} mile${miles === 1 ? '' : 's'} away`
    : '';
  const factor = info.price_factor ? ` ${info.price_factor}.` : '';
  const highwayPart = info.highway_primary
    ? ` Finished fuel travels <b>${info.highway_primary}</b> to local terminals.`
    : '';
  return {
    q: `Why is gas in ${town.name}, TX often cheaper than the Texas average?`,
    a: `${town.name}, TX sits near <b>${info.refinery_name}</b>${milesPart}.${factor}${highwayPart}`,
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
  return {
    q: `Why aren't gas prices in ${town.name}, TX lower given nearby oil production?`,
    a: `Even with <b>${rigs}+ active rigs</b> in <b>${county} County</b>, Permian crude travels hundreds of miles to Gulf Coast refineries and returns as finished gasoline.${factor}`,
  };
}

function faqBorder(town, d, info) {
  const factor = info.price_factor ? ` ${info.price_factor}.` : '';
  return {
    q: `Are fuel prices cheaper near the Texas-Mexico border in ${town.name}, TX?`,
    a: `${town.name}, TX sits on the border, where cross-border demand and regional competition shape pump prices.${factor}`,
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
    ? `${town.name}'s ${display}`
    : `${town.name} is adjacent to ${display}`;
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
    a: `Home football weekends, graduations, and major campus events push local traffic and fuel demand above normal levels.${factTail}`,
  };
}

function faqStateAvgFallback(town, d, info) {
  const commute = info.commute_note ? ` ${info.commute_note}.` : '';
  return {
    q: `How do ${town.name}, TX gas prices compare to the Texas state average?`,
    a: `The Texas state average for regular is <b>$${faq2dec(d.stateAvg)}/gal</b>. ${town.name}, TX drivers pay close to the statewide average — choose <b>${d.cheapestChain}</b> to pay below average.${commute}`,
  };
}

function buildFaqItems(town, d) {
  const info = CITY_INFO[town.slug] || {};
  const updatedHuman = formatUpdated(prices.updated);
  const townChains = chainsForTown(town);
  const items = [];

  // Always-on Q1 + Q2 (per-gallon prices rounded to 2 decimals for FAQ)
  const isMember = MEMBERSHIP_FAQ_CHAINS.has(d.cheapestChain);
  const memberBadge = isMember ? ' <span class="faq-mbr">membership price</span>' : '';
  items.push({
    q: `What is the cheapest gas station in ${town.name}, TX right now?`,
    a: `<b>${d.cheapestChain}</b>${memberBadge} is currently the cheapest at <b>$${faq2dec(d.cheapestPrice)}/gal</b> for regular unleaded. Prices last updated ${updatedHuman}.`,
  });
  items.push({
    q: `How much does a full tank cost in ${town.name}, TX?`,
    a: `At current prices, filling a <b>15-gallon</b> tank costs <b>$${d.tankCost15}</b> at <b>${d.cheapestChain}</b>. A <b>20-gallon</b> tank costs <b>$${d.tankCost20}</b>.`,
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
  return faqItems.map(item => `  <details>
    <summary>${escHtml(item.q)}</summary>
    <div class="faq-a">${item.a}</div>
    <div class="faq-src">${escHtml(sourceLine)}</div>
  </details>`).join('\n');
}

// Build the 4-card stat grid per faq-design-spec.md:
// population · vehicles per household · truck ownership % · est. monthly fuel.
// Monthly fuel formula: cheapestPrice * vehiclesPerHousehold * 12000 / 25 / 12
function buildFaqStatsHtml(town, d, info) {
  const pop = Number(town.population) || 0;
  const popShort = formatPopShort(pop) || '—';
  const vph = Number.isFinite(Number(info.vehicles_per_household))
    ? Number(info.vehicles_per_household).toFixed(1)
    : '2.0';
  const truckPct = Number.isFinite(Number(info.truck_ownership_pct))
    ? Number(info.truck_ownership_pct)
    : 20;
  const vphNum = Number(vph);
  const priceNum = Number(d.cheapestPrice);
  const monthlyFuel = Math.round(priceNum * vphNum * 12000 / 25 / 12);

  const cards = [
    { val: popShort,             lbl: 'population' },
    { val: vph,                  lbl: 'vehicles / household' },
    { val: `${truckPct}%`,       lbl: 'truck ownership' },
    { val: `~$${monthlyFuel}`,   lbl: 'est. monthly fuel' },
  ];

  const out = cards.map(c => `    <div class="faq-stat">
      <div class="faq-stat-val">${escHtml(c.val)}</div>
      <div class="faq-stat-lbl">${escHtml(c.lbl)}</div>
    </div>`).join('\n');
  return `  <div class="faq-stats">\n${out}\n  </div>`;
}

// ── FAQ header helpers (per faq-design-spec.md) ──────────────
function buildFaqCityTitle(town) {
  return `Fuel prices &amp; local data — ${escHtml(town.name)}, TX ⛽`;
}

function buildFaqPillsHtml(town, info) {
  const pills = [];
  if (town.county) pills.push(`${town.county} County`);

  // Primary region: Permian sub-region if defined, otherwise cities-info region.
  const primary = CITY_PRIMARY_REGION[town.slug]
    || (info.region && REGION_PILL_NAME[info.region])
    || null;
  if (primary) pills.push(primary);

  // Broad region (e.g. "West Texas" for Permian cities)
  const broad = CITY_BROAD_REGION[town.slug];
  if (broad && broad !== primary) pills.push(broad);

  if (info.highway_primary) pills.push(`${info.highway_primary} corridor`);

  const pop = Number(town.population) || 0;
  if (pop > 0) pills.push(`${pop.toLocaleString('en-US')} residents`);

  const elev = CITY_ELEVATION[town.slug];
  if (Number.isFinite(elev)) pills.push(`${elev.toLocaleString('en-US')} ft elevation`);

  return pills.map(p => `<span class="pill">${escHtml(p)}</span>`).join('');
}

function buildFaqContext(town, info) {
  if (!info || !info.local_fact) return '';
  // Local facts in cities-info.json end without a period; add one for prose.
  const fact = String(info.local_fact).trim();
  const withPeriod = /[.!?]$/.test(fact) ? fact : fact + '.';
  return escHtml(withPeriod);
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
  // 2-level BreadcrumbList: Home → {City}, TX. Enables SERP breadcrumb
  // navigation trail, which tends to lift CTR on city-page impressions.
  const breadcrumb = {
    '@context':       'https://schema.org',
    '@type':          'BreadcrumbList',
    itemListElement:  [
      { '@type': 'ListItem', position: 1, name: 'Texas Gas Prices',
        item: 'https://txgasprices.net/' },
      { '@type': 'ListItem', position: 2, name: `${town.name}, TX`,
        item: `https://txgasprices.net/gas-prices/${town.slug}/` },
    ],
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

  // Per-chain price lookup for each fuel — enables data-{fuel} attrs so
  // the fuel tab JS can swap prices directly from the DOM without any
  // recompute. Keyed by chain name for O(1) merge against the regular list.
  const byChain = {};
  for (const f of FUELS) {
    for (const row of (pd[f] || [])) {
      if (!byChain[row.n]) byChain[row.n] = {};
      byChain[row.n][f] = row.p;
    }
  }

  const cards = heroList.map((c, i) => {
    const isMember = MEMBERSHIP_CHAINS.has(c.n);
    const stationsLine = c.sc && c.sc > 0
      ? `      <div class="cc-stations">${c.sc} station${c.sc === 1 ? '' : 's'} nearby</div>`
      : '';
    const memberBadge = isMember
      ? `      <div><span class="cc-mbr" title="${escAttr(MEMBERSHIP_TOOLTIP)}">⚑ membership price</span></div>`
      : '';
    const fuelAttrs = FUELS.map(f => {
      const v = byChain[c.n] && byChain[c.n][f];
      return v != null ? `data-${f}="${Number(v).toFixed(2)}"` : '';
    }).filter(Boolean).join(' ');
    const parts = [
      `    <div class="cc${i === 0 ? ' best' : ''}" data-chain="${escAttr(c.n)}" ${fuelAttrs} onclick="setChainFilter(this.dataset.chain)">`,
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

// ── calculator reuse ─────────────────────────────────────────
// Extract the full trip-calc HTML block from the mockup so homepage and
// /trip-cost-calculator can share the exact same component (Google Maps
// Distance Matrix, car-db picker, MPG toggle, fuel selector, passengers,
// round-trip toggle). Uses a simple brace counter since nested <div>s
// make regex unreliable.
function extractCalcHtml(fromDefault, toDefault) {
  const startTag = '<div class="calc-card" id="calculator">';
  const start = TEMPLATE.indexOf(startTag);
  if (start === -1) throw new Error('calc-card not found in mockup');
  let depth = 1;
  let i = start + startTag.length;
  while (i < TEMPLATE.length && depth > 0) {
    const nextOpen  = TEMPLATE.indexOf('<div', i);
    const nextClose = TEMPLATE.indexOf('</div>', i);
    if (nextClose === -1) throw new Error('calc-card not closed');
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + 4;
    } else {
      depth--;
      i = nextClose + 6;
    }
  }
  let html = TEMPLATE.slice(start, i);
  html = html.replace('value="{{CITY_NAME_FULL}}"', `value="${escAttr(fromDefault || '')}"`);
  html = html.replace('value="{{DEFAULT_TO_CITY}}"', `value="${escAttr(toDefault || '')}"`);
  html = html.replace(/{{CURRENT_YEAR}}/g, String(CURRENT_YEAR));
  return html;
}

// The mockup's <script> block owns the calc's client-side logic. We
// reuse it verbatim on the homepage and /trip-cost-calculator so the
// calc behaves identically across pages.
function extractMockupScript() {
  const m = TEMPLATE.match(/<script>[\s\S]*?<\/script>/);
  return m ? m[0] : '';
}

// Statewide priceData for the calc's "Use live price" mode when we're
// not on a per-city page. Shape matches buildPriceData() exactly.
function statewidePriceData() {
  const out = {};
  for (const fuel of FUELS) {
    out[fuel] = prices.chains.slice().sort((a, b) => a[fuel] - b[fuel]).map(c => ({
      n:  c.chain,
      p:  Number(c[fuel]),
      ch: 'same',
      a:  STATION_META[c.chain]?.a || 'statewide',
      d:  'statewide',
      sc: null,
    }));
  }
  return out;
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
  // Trailing slash matches Cloudflare's 308 target so sitemap, canonical,
  // og:url, and the final redirect destination are all the same URL.
  const regularPath  = `/gas-prices/${town.slug}/`;
  const fuelPath     = fuel === 'regular' ? regularPath : `/gas-prices/${town.slug}/${fuel}/`;
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

  // Short SEO title: "{City}, TX Gas Prices Today — $X.XX/gal" (~40 chars).
  // Drops "| TXGasPrices" suffix and 3rd decimal.
  const pageTitle = fuel === 'regular'
    ? `${town.name}, TX Gas Prices Today — $${cheapestPrice2}/gal`
    : `${fLabel} Gas Prices in ${town.name}, TX Today — $${cheapestPrice2}/gal`;

  const heroTitle = fuel === 'regular'
    ? `Gas prices in ${town.name}, TX today`
    : `${fLabel} gas prices in ${town.name}, TX today`;

  // Short meta description (~124 chars) — no chain-list tail.
  const metaDesc = fuel === 'regular'
    ? `Live ${town.name}, TX gas prices updated hourly. Cheapest today: ${cheapestChain} at $${cheapestPrice2}/gal. Compare all major stations on one map.`
    : `Live ${town.name}, TX ${fuel} gas prices updated hourly. Cheapest today: ${cheapestChain} at $${cheapestPrice2}/gal. Compare all major stations on one map.`;

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
  const faqPillsHtml = buildFaqPillsHtml(town, cityInfo);
  const faqCityTitle = buildFaqCityTitle(town);
  const faqContext   = buildFaqContext(town, cityInfo);

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

// ── sitemap ──────────────────────────────────────────────────
// ── _redirects (Cloudflare Pages) ────────────────────────────
// Consolidates the removed /gas-prices-by-city-texas ghost URL, then emits
// one 301 per town per dead fuel/cheapest subpage (4 × 100 = 400 lines).
// Total: 401 lines.
function buildRedirects() {
  // Top-level aliases that were serving a Cloudflare SPA fallback (200 OK
  // duplicate of homepage) — force them to canonical "/" via 301.
  const lines = [
    '/gas-prices-by-city-texas  /  301',
    '/gas-prices                /  301',
    '/texas-gas-prices          /  301',
  ];
  for (const t of towns) {
    for (const suffix of ['midgrade', 'premium', 'diesel', 'cheapest']) {
      lines.push(`/gas-prices/${t.slug}/${suffix}  /gas-prices/${t.slug}/  301`);
    }
  }
  return lines.join('\n') + '\n';
}

// ── robots.txt ───────────────────────────────────────────────
function buildRobotsTxt() {
  return [
    'User-agent: *',
    'Allow: /',
    '',
    'Sitemap: https://txgasprices.net/sitemap.xml',
    '',
  ].join('\n');
}

function buildSitemap() {
  const base  = 'https://txgasprices.net';
  const today = new Date().toISOString().split('T')[0];
  const homeLastmod = (prices.updated || today).split('T')[0];
  const urls  = [];

  // Homepage — priority 1.0, lastmod from prices.json.updated
  urls.push(`  <url><loc>${base}/</loc><lastmod>${homeLastmod}</lastmod><changefreq>hourly</changefreq><priority>1.0</priority></url>`);

  // 100 city pages — trailing slash matches Cloudflare's canonical URL,
  // so Googlebot hits the final destination directly (no 308 hop).
  towns.forEach(t => {
    urls.push(`  <url><loc>${base}/gas-prices/${t.slug}/</loc><lastmod>${today}</lastmod><changefreq>hourly</changefreq><priority>0.9</priority></url>`);
  });

  // Two hub pages (trailing slash for the same reason)
  urls.push(`  <url><loc>${base}/cheapest-gas-texas/</loc><lastmod>${today}</lastmod><changefreq>hourly</changefreq><priority>0.9</priority></url>`);
  urls.push(`  <url><loc>${base}/trip-cost-calculator/</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`;
}

// ── homepage ─────────────────────────────────────────────────
// ── homepage ─────────────────────────────────────────────────
// Full Texas-wide landing page. Shares the city-page style block (spliced
// from the mockup <style>) so the visual language matches exactly, but
// the content is statewide: chain cards with "N cities tracked", Texas
// viewport map, top-10 cheapest cities, all-100-cities grid, and a FAQ
// per faq-design-spec.md.
function buildHomepage() {
  const canonical = 'https://txgasprices.net/';
  const updatedHuman = formatUpdated(prices.updated);
  const updatedTimeCt = formatUpdatedTime(prices.updated);

  // Per-town cheapest regular for the top-10 list and all-cities grid.
  const townCheap = towns.map(t => {
    const c = cheapestForTown(t, 'regular');
    return { town: t, chain: c.chain, price: c.regular };
  });
  const sortedByPrice = townCheap.slice().sort((a, b) => a.price - b.price);
  const globalMin = sortedByPrice[0];
  const globalMax = sortedByPrice[sortedByPrice.length - 1];
  const savingsVsMax = (globalMax.price - globalMin.price);

  const stateAvgReg  = prices.stateAverage && prices.stateAverage.regular;
  const stateAvgFmt2 = stateAvgReg != null ? money2(stateAvgReg) : null;
  const stateAvgFmt3 = stateAvgReg != null ? money3(stateAvgReg) : null;

  // Top-level (statewide) chain cards — 100 cities tracked per chain
  // because these are the fallback chains that show on every city page.
  const chainsSorted = prices.chains.slice().sort((a, b) => a.regular - b.regular);
  const chainCardsHtml = chainsSorted.map((c, i) => {
    const badge = i === 0 ? `      <div class="cc-badge">cheapest</div>\n` : '';
    return `    <div class="cc${i === 0 ? ' best' : ''}" data-chain="${escAttr(c.chain)}">
${badge}      <div class="cc-name">${escHtml(c.chain)}</div>
      <div class="cc-price">$${money2(c.regular)}</div>
      <div class="cc-ch ch-nc">— no change</div>
      <div class="cc-stations">${towns.length} cities tracked</div>
    </div>`;
  }).join('\n');

  // Native HTML <select> with "Select a city" placeholder, then 100 cities.
  const cityOptionsHtml = towns
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(t => `      <option value="${t.slug}">${escHtml(t.name)}, TX</option>`)
    .join('\n');

  // Top-10 cheapest cities — replaces the per-city "stations sorted by
  // price" list. Server-rendered so it appears in raw HTML.
  const topTenHtml = sortedByPrice.slice(0, 10).map((x, i) => `    <a class="st-row" href="/gas-prices/${x.town.slug}">
      <div class="st-rk">${i + 1}</div>
      <div class="st-main">
        <div class="st-city">${escHtml(x.town.name)}, TX</div>
        <div class="st-chain">${escHtml(x.chain)}</div>
      </div>
      <div class="st-price">$${money2(x.price)}<span class="st-gal">/gal</span></div>
    </a>`).join('\n');

  // Embed the mockup's full <script> block so the reused calc gets its
  // original event handlers (swap, gps, chips, Distance Matrix, car-db,
  // MPG toggle, etc.). Tokens are substituted with Texas-wide defaults.
  const TX_LAT = '31.9686';
  const TX_LNG = '-99.9018';
  const mockupScriptWithTokens = extractMockupScript()
    .replace('{{PRICE_DATA_JSON}}', JSON.stringify(statewidePriceData(), null, 2))
    .replace('{{INITIAL_FUEL}}', 'regular')
    .replace(/\{\{CITY_NAME_FULL\}\}/g, '')
    .replace(/\{\{CITY_NAME\}\}/g, 'Texas')
    .replace(/\{\{CITY_NAME_URL\}\}/g, 'Texas+TX')
    .replace(/\{\{CITY_LAT\}\}/g, TX_LAT)
    .replace(/\{\{CITY_LNG\}\}/g, TX_LNG)
    .replace(/\{\{CURRENT_YEAR\}\}/g, String(CURRENT_YEAR));

  // FAQ per faq-design-spec.md — Texas-wide header, pills, stats, 6 Qs.
  const faqItems = [
    {
      q: `What is the cheapest gas in Texas right now?`,
      a: `<b>${globalMin.chain}</b> in <b>${globalMin.town.name}, TX</b> posts <b>$${money2(globalMin.price)}/gal</b> for regular unleaded — the cheapest of ${towns.length} tracked cities. The state average is <b>$${stateAvgFmt2 || '—'}/gal</b>, so filling a 15-gallon tank there saves about <b>$${(savingsVsMax * 15).toFixed(2)}</b> versus the priciest Texas city.`,
    },
    {
      q: `How do Texas gas prices compare to the US national average?`,
      a: `Texas consistently runs <b>15–25¢/gal below</b> the US average thanks to <b>29 refineries</b> along the Gulf Coast that process about <b>43% of US gasoline</b>. Today's Texas regular average of <b>$${stateAvgFmt2 || '—'}/gal</b> reflects that advantage.`,
    },
    {
      q: `Why are Gulf Coast Texas cities cheaper than West Texas?`,
      a: `Gulf Coast cities like <b>Houston</b>, <b>Beaumont</b>, and <b>Corpus Christi</b> sit next to major refineries (ExxonMobil Baytown, Motiva Port Arthur, Flint Hills). West Texas cities like <b>El Paso</b>, <b>Lubbock</b>, and <b>Amarillo</b> import finished fuel via pipeline from the Gulf, adding <b>3–5¢/gal</b> in transport costs.`,
    },
    {
      q: `How often do Texas gas prices update on this site?`,
      a: `The Texas state average refreshes <b>hourly</b> from AAA. Per-station prices in 50 major cities refresh <b>every 3 days</b> from GasBuddy via Apify. Last update: ${updatedHuman} CT.`,
    },
    {
      q: `Which chains have the cheapest gas in Texas?`,
      a: `Historically: warehouse clubs <span class="faq-mbr">membership price</span> (<b>Sam's Club</b>, <b>Costco</b>) lead, then <b>Murphy USA</b> (typically 5–15¢ below state average), <b>Buc-ee's</b>, <b>HEB Gas</b>, and Walmart Neighborhood Markets. Today's cheapest top-level chain is <b>${chainsSorted[0].chain}</b> at <b>$${money2(chainsSorted[0].regular)}/gal</b>.`,
    },
    {
      q: `How much does a full tank cost across Texas today?`,
      a: `At the Texas state average of <b>$${stateAvgFmt2 || '—'}/gal</b>, a <b>15-gallon</b> tank costs about <b>$${stateAvgReg != null ? (stateAvgReg * 15).toFixed(2) : '—'}</b>; a <b>20-gallon</b> tank costs <b>$${stateAvgReg != null ? (stateAvgReg * 20).toFixed(2) : '—'}</b>. Filling at today's cheapest station (${globalMin.town.name}, TX) saves up to <b>$${(savingsVsMax * 15).toFixed(2)}</b> per 15 gallons vs the priciest Texas city.`,
    },
  ];

  const faqItemsHtml = faqItems.map(it =>
    `    <details>
      <summary>${escHtml(it.q)}</summary>
      <div class="faq-a">${it.a}</div>
      <div class="faq-src">Source: AAA Texas + GasBuddy via Apify, updated ${updatedHuman} CT</div>
    </details>`
  ).join('\n');

  const faqStatsCards = [
    { val: '30.5M', lbl: 'population' },
    { val: '29',    lbl: 'refineries' },
    { val: '43%',   lbl: 'US gasoline' },
    { val: `${towns.length}`, lbl: 'cities tracked' },
  ];
  const faqStatsHtml = faqStatsCards.map(c => `    <div class="faq-stat">
      <div class="faq-stat-val">${c.val}</div>
      <div class="faq-stat-lbl">${c.lbl}</div>
    </div>`).join('\n');

  const faqPills = [
    'Texas',
    '254 counties',
    '29 refineries',
    `${towns.length} cities tracked`,
    '~30.5M residents',
  ];
  const faqPillsHtml = faqPills.map(p => `<span class="pill">${escHtml(p)}</span>`).join('');

  // JSON-LD: WebPage + Organization + FAQPage (exactly three per spec).
  const webPage = {
    '@context':   'https://schema.org',
    '@type':      'WebPage',
    name:         'Texas Gas Prices Today — Live Prices for 100 Cities',
    description:  `Live Texas gas prices across ${towns.length} cities, updated hourly from AAA. Cheapest today: ${globalMin.chain} in ${globalMin.town.name}, TX at $${money2(globalMin.price)}/gal.`,
    dateModified: prices.updated,
    url:          canonical,
  };
  const organization = {
    '@context': 'https://schema.org',
    '@type':    'Organization',
    name:       'TXGasPrices',
    url:        canonical,
    logo:       'https://txgasprices.net/apple-touch-icon.png',
  };
  const faqSchema = {
    '@context': 'https://schema.org',
    '@type':    'FAQPage',
    mainEntity: faqItems.map(it => ({
      '@type':         'Question',
      name:            it.q,
      acceptedAnswer:  { '@type': 'Answer', text: stripHtml(it.a) },
    })),
  };

  // Splice the city-page style block so the homepage is pixel-identical
  // in visual language without maintaining two copies of the CSS.
  const styleMatch = TEMPLATE.match(/<style>[\s\S]*?<\/style>/);
  const sharedStyles = styleMatch ? styleMatch[0] : '';

  const title = 'Texas Gas Prices Today — Live Prices for 100 Cities';
  const description = `Live Texas gas prices updated hourly across ${towns.length} cities. Cheapest today: ${globalMin.chain} in ${globalMin.town.name}, TX at $${money2(globalMin.price)}/gal. Compare all major stations on one map.`;

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
${JSON.stringify(faqSchema, null, 2)}
</script>
${sharedStyles}
<style>
/* Homepage-only additions (not in the city-page template) */
.top-ten{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;padding:14px 16px}
.top-ten h2{font-size:13px;font-weight:500;color:#1a1a18;margin:0 0 10px;letter-spacing:.02em;text-transform:uppercase}
.st-row{display:grid;grid-template-columns:28px 1fr auto;gap:10px;align-items:center;padding:8px 6px;border-top:0.5px solid rgba(0,0,0,.05);text-decoration:none;color:#1a1a18}
.st-row:first-of-type{border-top:0}
.st-row:hover{background:#f8fbf9}
.st-rk{font-size:12px;color:#9a9990;font-variant-numeric:tabular-nums}
.st-city{font-size:13.5px;font-weight:500}
.st-chain{font-size:11.5px;color:#6b6b66;margin-top:1px}
.st-price{font-size:14px;color:#1D9E75;font-weight:500;font-variant-numeric:tabular-nums}
.st-gal{font-size:10.5px;color:#9a9990;font-weight:400;margin-left:1px}
.cities-all{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;padding:14px 16px}
.cities-all h2{font-size:13px;font-weight:500;color:#1a1a18;margin:0 0 12px;letter-spacing:.02em;text-transform:uppercase}
.home-city-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px}
.home-city-grid .city-card{display:flex;justify-content:space-between;align-items:baseline;padding:9px 12px;border:0.5px solid rgba(0,0,0,.08);border-radius:8px;background:#fff;text-decoration:none;color:#1a1a18;transition:border-color .15s,background .15s}
.home-city-grid .city-card:hover{border-color:#1D9E75;background:#f8fbf9}
.home-city-grid .city-card .cc-name{font-size:13.5px;font-weight:500}
.home-city-grid .city-card .cc-price{font-size:13.5px;color:#1D9E75;font-weight:500;font-variant-numeric:tabular-nums}
.home-city-grid .city-card .cc-gal{font-size:11px;color:#9a9990;font-weight:400;margin-left:1px}
.price-commentary{font-size:13px;color:#4a4a45;line-height:1.55;margin:6px 0 14px;padding:10px 14px;background:#f8f6ef;border-radius:10px}
.price-commentary b{color:#1a1a18;font-weight:500}
.home-tc{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;padding:18px 20px}
.home-tc h2{font-size:16px;font-weight:500;margin:0 0 10px;letter-spacing:-.01em}
.home-tc .tc-row{display:grid;grid-template-columns:1fr 1fr 90px auto;gap:8px;align-items:end}
.home-tc label{font-size:11px;color:#9a9990;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px}
.home-tc input{width:100%;padding:8px 10px;border:0.5px solid rgba(0,0,0,.18);border-radius:8px;font-size:13px;background:#fff;color:#1a1a18}
.home-tc button{padding:9px 18px;border-radius:8px;border:0;background:#1D9E75;color:#fff;font-size:13px;font-weight:500;cursor:pointer}
.home-tc button:hover{background:#148a63}
.home-tc .tc-result{margin-top:12px;font-size:13px;color:#1a1a18;min-height:18px}
.home-tc .tc-result b{color:#1D9E75;font-weight:500}
@media (max-width:600px){.home-tc .tc-row{grid-template-columns:1fr 1fr}.home-tc button{grid-column:1/-1}}
</style>
</head>
<body>
<div class="site">

<!-- NAV -->
<div class="topbar">
  <a class="logo" href="/">TX<em>Gas</em>Prices</a>
  <div class="nav">
    <a class="on" href="/">Home</a>
    <a href="/trip-cost-calculator">Trip Calculator</a>
    <a href="/cheapest-gas-texas">Cheapest in Texas</a>
  </div>
</div>

<!-- HERO -->
<div class="hero">
  <div class="hero-top">
    <div>
      <h1 class="hero-title">Gas prices in Texas today · ⛽</h1>
      <div class="updated"><span class="live-dot"></span>Updated ${updatedHuman}</div>
      <div class="trustbar"><span class="tb-item">Updated ${updatedHuman} CT</span><span class="tb-item">Source: AAA Texas + GasBuddy via Apify</span><span class="tb-item">Prices change 3-4x/week</span></div>
    </div>
    <div class="city-sel">
      <select onchange="if (this.value) window.location.href='/gas-prices/' + this.value" aria-label="Jump to a city">
        <option value="">Select a city</option>
${cityOptionsHtml}
      </select>
    </div>
  </div>

  <div class="price-commentary">
    Texas regular unleaded averages <b>$${stateAvgFmt2 || '—'}/gal</b> today across <b>${towns.length} tracked cities</b>. The cheapest is <b>${globalMin.chain}</b> in <b>${globalMin.town.name}, TX</b> at <b>$${money2(globalMin.price)}/gal</b> — about <b>$${(savingsVsMax).toFixed(2)}/gal</b> below the priciest Texas city today.
  </div>

  <h2 class="slabel h-label">Price by chain — today (statewide)</h2>
  <div class="chains" id="chains">
${chainCardsHtml}
  </div>

  <div class="slabel">Texas gas stations — statewide map</div>
  <div class="map-frame">
    <iframe
      width="100%" height="340" style="border:0"
      allowfullscreen loading="lazy" referrerpolicy="no-referrer-when-downgrade"
      src="https://www.google.com/maps/embed/v1/search?key=AIzaSyB98C7dsv8s_NOCItD5LQOvTviYicYCXdI&q=gas+stations+Texas&center=31.9686,-99.9018&zoom=6">
    </iframe>
  </div>
  <p class="map-note">Zoom in on any Texas metro to see station pins. Click through a city card below for local pricing.</p>
</div>

<!-- TOP 10 CHEAPEST CITIES (replaces the per-city station grid) -->
<section class="top-ten">
  <h2>Top 10 cheapest Texas cities today</h2>
${topTenHtml}
</section>

<!-- TRIP CALCULATOR — full mockup component with empty From/To -->
${extractCalcHtml('', '')}

<!-- FAQ — spec-compliant with Texas-wide content -->
<section class="faq-section">
  <div class="faq-header">
    <div class="faq-title-row">
      <div class="faq-title">Fuel prices &amp; local data — Texas ⛽</div>
      <div class="faq-live">
        <span class="live-dot"></span>
        <span>${updatedTimeCt}</span>
      </div>
    </div>
    <div class="pills">${faqPillsHtml}</div>
  </div>
  <div class="faq-context">Texas refines roughly 43% of the United States' gasoline supply — 29 refineries concentrated along the Gulf Coast keep pump prices below the national average year-round.</div>
  <div class="faq-stats">
${faqStatsHtml}
  </div>
  <div class="faq-items">
${faqItemsHtml}
  </div>
</section>

<div class="footer">
  <span>${buildFooterNote()}</span>
  <span style="margin-left:auto">Murphy USA · HEB Gas · Shell · Chevron · Buc-ee's</span>
</div>

</div>
${mockupScriptWithTokens}
</body>
</html>
`;
}

// ── cheapest-gas-texas hub page ──────────────────────────────
function buildCheapestGasPage() {
  const canonical = 'https://txgasprices.net/cheapest-gas-texas/';
  const updatedHuman  = formatUpdated(prices.updated);
  const updatedTimeCt = formatUpdatedTime(prices.updated);

  // Per-town data for all 4 fuels, pre-sorted into tables.
  const rows = towns.map(t => {
    const cheap = {};
    for (const f of FUELS) {
      const c = cheapestForTown(t, f);
      cheap[f] = { chain: c.chain, price: c[f] };
    }
    return {
      town: t,
      region: (CITY_INFO[t.slug] || {}).region || 'other',
      regular:  cheap.regular.price,
      midgrade: cheap.midgrade.price,
      premium:  cheap.premium.price,
      diesel:   cheap.diesel.price,
      regularChain: cheap.regular.chain,
    };
  });

  // Sorted rankings per fuel — used for tabs + top-10 tables + JSON-LD.
  const sortedBy = Object.fromEntries(FUELS.map(f => [f, rows.slice().sort((a, b) => a[f] - b[f])]));
  const globalMin = sortedBy.regular[0];
  const stateAvgReg = prices.stateAverage && prices.stateAverage.regular;
  const stateAvgFmt2 = stateAvgReg != null ? money2(stateAvgReg) : null;

  const top10CheapRegular = sortedBy.regular.slice(0, 10);
  const top10ExpRegular   = sortedBy.regular.slice(-10).reverse();

  // Regional breakdown — 5 cards. Group by cities-info.json region.
  const REGION_LABEL = {
    'houston-metro':      'Greater Houston',
    'dfw-metro':          'DFW Metroplex',
    'sa-metro':           'San Antonio Metro',
    'austin-metro':       'Austin Metro',
    'austin-sa-corridor': 'Austin–San Antonio Corridor',
    'rio-grande-valley':  'Rio Grande Valley',
    'coastal-tx':         'Gulf Coast',
    'west-tx':            'West Texas',
    'south-tx':           'South Texas',
    'central-tx':         'Central Texas',
    'east-tx':            'East Texas',
    'north-tx':           'North Texas',
    'other':              'Other Texas',
  };
  const byRegion = {};
  for (const r of rows) (byRegion[r.region] = byRegion[r.region] || []).push(r);
  const regionEntries = Object.entries(byRegion)
    .map(([slug, list]) => {
      const avg = list.reduce((s, x) => s + x.regular, 0) / list.length;
      const cheapest = list.slice().sort((a, b) => a.regular - b.regular)[0];
      return { slug, label: REGION_LABEL[slug] || slug, list, avg, cheapest };
    })
    .sort((a, b) => a.avg - b.avg)
    .slice(0, 5);

  const regionCardsHtml = regionEntries.map(re => `    <div class="region-card">
      <h3>${escHtml(re.label)}</h3>
      <div class="region-meta">${re.list.length} ${re.list.length === 1 ? 'city' : 'cities'} · avg $${money3(re.avg)}/gal</div>
      <div class="region-cheapest">Cheapest: <a href="/gas-prices/${re.cheapest.town.slug}">${escHtml(re.cheapest.town.name)}</a> at $${money2(re.cheapest.regular)}</div>
    </div>`).join('\n');

  // Pre-rendered rankings for each fuel — data-fuel attrs let JS swap.
  const mkRankRow = (r, i) => `        <tr>
          <td class="rk">${i + 1}</td>
          <td><a href="/gas-prices/${r.town.slug}">${escHtml(r.town.name)}, TX</a></td>
          <td>${escHtml(r.regularChain)}</td>
          <td class="pg">$${money3(r.regular)}</td>
        </tr>`;
  const top10CheapRowsHtml = top10CheapRegular.map(mkRankRow).join('\n');
  const top10ExpRowsHtml   = top10ExpRegular.map(mkRankRow).join('\n');

  // FULL 100-city table — all rows static HTML, no lazy load.
  const mkFullRow = (r, i, sortField) => `        <tr class="city-row" data-name="${escAttr(r.town.name.toLowerCase())}">
          <td class="rk">${i + 1}</td>
          <td><a href="/gas-prices/${r.town.slug}">${escHtml(r.town.name)}, TX</a></td>
          <td class="pg">$${money3(r.regular)}</td>
          <td>$${money3(r.midgrade)}</td>
          <td>$${money3(r.premium)}</td>
          <td>$${money3(r.diesel)}</td>
          <td>${escHtml(r.regularChain)}</td>
        </tr>`;
  const fullTableRowsHtml = sortedBy.regular.map((r, i) => mkFullRow(r, i, 'regular')).join('\n');

  const faqItems = [
    { q: 'How do you decide which Texas city has the cheapest gas?',
      a: `We compare the <b>posted regular unleaded price</b> at the cheapest tracked chain in each of ${towns.length} Texas cities. Today that's <b>${globalMin.regularChain}</b> in <b>${globalMin.town.name}, TX</b> at <b>$${money2(globalMin.regular)}/gal</b>.`,
      src: `Source: AAA Texas + GasBuddy via Apify, updated ${updatedHuman} CT` },
    { q: 'Why is gas cheaper in some Texas cities than others?',
      a: `Three factors: proximity to Gulf Coast refineries (cities near Houston, Beaumont, Corpus Christi pay less), local chain competition (Buc-ee's, HEB Gas, Murphy USA drive prices down), and transport distance. West Texas and El Paso pay more because pipeline distribution adds 3–5¢/gal.`,
      src: `Source: EIA Refinery Capacity Report + Texas RRC data` },
    { q: 'How often do the rankings update?',
      a: `The Texas state average refreshes <b>hourly</b> from AAA. Per-station prices in 50 major cities refresh <b>every 3 days</b> via GasBuddy through Apify. City rankings shown here reflect the last refresh of both feeds.`,
      src: `Source: AAA Texas + GasBuddy, last updated ${updatedHuman} CT` },
    { q: 'Do the prices include all fees, taxes, and credit-card fees?',
      a: `Yes — posted pump prices include the Texas motor fuel tax (<b>20¢/gal regular</b>) and federal excise tax (<b>18.4¢/gal</b>). Prices are the cash-rate posted price; some stations charge 5–10¢ more for credit-card purchases.`,
      src: `Source: Texas Comptroller + IRS motor fuel tax schedules` },
    { q: 'Are warehouse-club prices (Sam\u2019s, Costco) really the cheapest?',
      a: `Often yes — but only after you pay the annual membership ($50 Sam's, $65 Costco). Break-even is roughly 500 gallons per year if their prices beat a non-member station by 10¢/gal. For ${towns.length}-city rankings we include these <span class="faq-mbr">membership price</span> chains and call them out in the FAQs on each city page.`,
      src: `Source: Sam's Club + Costco membership pricing` },
  ];

  const faqItemsHtml = faqItems.map(it =>
    `    <details>
      <summary>${escHtml(it.q)}</summary>
      <div class="faq-a">${it.a}</div>
      <div class="faq-src">${escHtml(it.src)}</div>
    </details>`
  ).join('\n');

  const faqStatsCards = [
    { val: '30.5M', lbl: 'population' },
    { val: '29',    lbl: 'refineries' },
    { val: '43%',   lbl: 'US gasoline' },
    { val: `${towns.length}`, lbl: 'cities ranked' },
  ];
  const faqStatsHtml = faqStatsCards.map(c => `    <div class="faq-stat">
      <div class="faq-stat-val">${escHtml(c.val)}</div>
      <div class="faq-stat-lbl">${escHtml(c.lbl)}</div>
    </div>`).join('\n');

  const faqPills = [
    'Texas', `${towns.length} cities ranked`, '759 stations tracked', 'Updated hourly',
  ];
  const faqPillsHtml = faqPills.map(p => `<span class="pill">${escHtml(p)}</span>`).join('');

  const webPage = {
    '@context':   'https://schema.org', '@type': 'WebPage',
    name:         'Cheapest Gas in Texas Today',
    description:  `Ranked list of the cheapest and most expensive gas prices across ${towns.length} Texas cities. Updated hourly from AAA.`,
    dateModified: prices.updated, url: canonical,
  };
  const itemList = {
    '@context':    'https://schema.org', '@type': 'ItemList',
    name:          'Top 10 Cheapest Texas Cities — Regular Unleaded',
    numberOfItems: 10,
    itemListElement: top10CheapRegular.map((r, i) => ({
      '@type':   'ListItem',
      position:  i + 1,
      url:       `https://txgasprices.net/gas-prices/${r.town.slug}`,
      name:      `${r.town.name}, TX — $${money2(r.regular)}/gal regular`,
    })),
  };
  const faqSchema = {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: faqItems.map(it => ({
      '@type':         'Question', name: it.q,
      acceptedAnswer:  { '@type': 'Answer', text: stripHtml(it.a) },
    })),
  };

  const styleMatch = TEMPLATE.match(/<style>[\s\S]*?<\/style>/);
  const sharedStyles = styleMatch ? styleMatch[0] : '';

  // Per-fuel data for the tab JS — shape: { fuel: [{slug,name,chain,price3}...] }
  const fuelRankings = Object.fromEntries(FUELS.map(f => [f,
    sortedBy[f].map(r => ({ slug: r.town.slug, name: r.town.name, chain: r.regularChain, p: money3(r[f]) }))
  ]));

  const title = 'Cheapest Gas in Texas Today — 100 Cities Ranked';
  const description = `Cheapest gas in Texas today: ${globalMin.regularChain} in ${globalMin.town.name}, TX at $${money2(globalMin.regular)}/gal. Full rankings for ${towns.length} Texas cities across all 4 fuel grades.`;

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
<meta name="description" content="${escAttr(description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${escAttr(title)}">
<meta property="og:description" content="${escAttr(description)}">
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
${JSON.stringify(itemList, null, 2)}
</script>
<script type="application/ld+json">
${JSON.stringify(faqSchema, null, 2)}
</script>
${sharedStyles}
<style>
.hub-hero{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;padding:22px 24px}
.hub-hero h1{font-size:26px;font-weight:500;margin-bottom:4px;letter-spacing:-.01em}
.hub-hero .sub{font-size:13px;color:#6b6b66}
.big-callout{display:grid;grid-template-columns:auto 1fr;gap:16px;align-items:center;margin-top:14px;padding:14px 16px;background:#f1fbf6;border-radius:10px;border:0.5px solid #c8ead9}
.big-callout .bc-price{font-size:38px;font-weight:500;color:#1D9E75;line-height:1;font-variant-numeric:tabular-nums}
.big-callout .bc-gal{font-size:15px;color:#6b6b66;font-weight:400;margin-left:4px}
.big-callout .bc-where{font-size:13.5px;color:#1a1a18}
.big-callout .bc-where a{color:#1D9E75;text-decoration:none;font-weight:500}
.big-callout .bc-note{font-size:11.5px;color:#6b6b66;margin-top:3px}
.fuel-tabs-row{display:flex;gap:6px;flex-wrap:wrap;padding:12px 16px;background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;border-bottom-left-radius:0;border-bottom-right-radius:0;margin-bottom:-0.5px}
.fuel-tabs-row .ft{padding:6px 16px;border-radius:20px;font-size:13px;cursor:pointer;border:0.5px solid rgba(0,0,0,.1);background:#f1efe8;color:#6b6b66;transition:all .15s}
.fuel-tabs-row .ft.on{background:#E1F5EE;border-color:#5DCAA5;color:#085041;font-weight:500}
.rankings{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;border-top-left-radius:0;border-top-right-radius:0;padding:14px 16px}
.rankings .two-col{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.rankings h2{font-size:13px;font-weight:500;color:#1a1a18;margin:0 0 10px;letter-spacing:.02em;text-transform:uppercase}
.ranktbl{width:100%;border-collapse:collapse;font-size:13px}
.ranktbl th{text-align:left;font-size:11px;color:#9a9990;text-transform:uppercase;letter-spacing:.06em;padding:6px 8px;border-bottom:0.5px solid rgba(0,0,0,.08);font-weight:500}
.ranktbl td{padding:6px 8px;border-bottom:0.5px solid rgba(0,0,0,.05);vertical-align:middle}
.ranktbl tr:last-child td{border-bottom:0}
.ranktbl td a{color:#1a1a18;text-decoration:none}
.ranktbl td a:hover{color:#1D9E75}
.ranktbl .rk{width:30px;color:#9a9990;font-variant-numeric:tabular-nums}
.ranktbl .pg{color:#1D9E75;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap}
@media (max-width:720px){.rankings .two-col{grid-template-columns:1fr}}
.regions{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;padding:14px 16px}
.regions h2{font-size:13px;font-weight:500;margin:0 0 12px;letter-spacing:.02em;text-transform:uppercase}
.region-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.region-card{background:#f8f6ef;border-radius:10px;padding:12px 14px}
.region-card h3{font-size:13.5px;font-weight:500;margin:0 0 4px}
.region-card .region-meta{font-size:11.5px;color:#6b6b66;margin-bottom:2px}
.region-card .region-cheapest{font-size:12px;color:#1a1a18}
.region-card .region-cheapest a{color:#1D9E75;text-decoration:none}
.full-table{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;padding:14px 16px}
.full-table h2{font-size:13px;font-weight:500;margin:0 0 8px;letter-spacing:.02em;text-transform:uppercase}
.full-table .ft-tools{display:flex;gap:10px;align-items:center;margin-bottom:10px}
.full-table .ft-filter{flex:1;max-width:280px;padding:7px 10px;border:0.5px solid rgba(0,0,0,.18);border-radius:8px;font-size:13px;background:#fff;color:#1a1a18}
.full-table .ft-count{font-size:11.5px;color:#9a9990}
.full-table .fulltbl-wrap{max-height:640px;overflow:auto;border:0.5px solid rgba(0,0,0,.06);border-radius:8px}
.fulltbl{width:100%;border-collapse:collapse;font-size:13px;min-width:620px}
.fulltbl thead th{position:sticky;top:0;background:#f8f6ef;text-align:left;font-size:11px;color:#6b6b66;text-transform:uppercase;letter-spacing:.06em;padding:7px 10px;border-bottom:0.5px solid rgba(0,0,0,.1);font-weight:500;z-index:1}
.fulltbl td{padding:7px 10px;border-bottom:0.5px solid rgba(0,0,0,.05)}
.fulltbl tbody tr:nth-child(even){background:#fcfbf7}
.fulltbl tbody tr:hover{background:#f1fbf6}
.fulltbl .rk{color:#9a9990;font-variant-numeric:tabular-nums;width:36px}
.fulltbl .pg{color:#1D9E75;font-weight:500;font-variant-numeric:tabular-nums}
.fulltbl td a{color:#1a1a18;text-decoration:none}
.fulltbl td a:hover{color:#1D9E75}
.eeat{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;padding:18px 20px;font-size:13px;color:#4a4a45;line-height:1.6}
.eeat h2{font-size:14px;font-weight:500;color:#1a1a18;margin:0 0 8px;letter-spacing:.01em}
.eeat ul{margin:6px 0 0 20px;padding:0}
.eeat li{margin-bottom:4px}
</style>
</head>
<body>
<div class="site">

<!-- NAV -->
<div class="topbar">
  <a class="logo" href="/">TX<em>Gas</em>Prices</a>
  <div class="nav">
    <a href="/">Home</a>
    <a href="/trip-cost-calculator">Trip Calculator</a>
    <a class="on" href="/cheapest-gas-texas">Cheapest in Texas</a>
  </div>
</div>

<!-- HERO + big callout -->
<section class="hub-hero">
  <h1>Cheapest Gas in Texas Today</h1>
  <div class="sub">Ranked list of ${towns.length} Texas cities — regular, midgrade, premium, and diesel. Click any fuel tab below.</div>
  <div class="updated" style="margin-top:8px"><span class="live-dot"></span>Updated ${updatedHuman} CT · TX regular avg $${stateAvgFmt2 || '—'}/gal</div>
  <div class="big-callout">
    <div><span class="bc-price">$<span id="bc-price">${money2(globalMin.regular)}</span></span><span class="bc-gal">/gal</span></div>
    <div>
      <div class="bc-where"><span id="bc-chain">${escHtml(globalMin.regularChain)}</span> in <a id="bc-link" href="/gas-prices/${globalMin.town.slug}"><span id="bc-city">${escHtml(globalMin.town.name)}, TX</span></a></div>
      <div class="bc-note">Cheapest <span id="bc-fuel-label">regular unleaded</span> in Texas today · of ${towns.length} tracked cities</div>
    </div>
  </div>
</section>

<!-- FUEL TABS -->
<div class="fuel-tabs-row" id="cgt-tabs">
  <button type="button" class="ft on" data-fuel="regular">Regular</button>
  <button type="button" class="ft"    data-fuel="midgrade">Midgrade</button>
  <button type="button" class="ft"    data-fuel="premium">Premium</button>
  <button type="button" class="ft"    data-fuel="diesel">Diesel</button>
</div>

<!-- TOP 10 RANKINGS -->
<section class="rankings">
  <div class="two-col">
    <div>
      <h2>Top 10 cheapest Texas cities</h2>
      <table class="ranktbl">
        <thead><tr><th>#</th><th>City</th><th>Chain</th><th>Price</th></tr></thead>
        <tbody id="tbl-cheap">
${top10CheapRowsHtml}
        </tbody>
      </table>
    </div>
    <div>
      <h2>Top 10 most expensive Texas cities</h2>
      <table class="ranktbl">
        <thead><tr><th>#</th><th>City</th><th>Chain</th><th>Price</th></tr></thead>
        <tbody id="tbl-exp">
${top10ExpRowsHtml}
        </tbody>
      </table>
    </div>
  </div>
</section>

<!-- 5 REGIONAL CARDS -->
<section class="regions">
  <h2>Regional breakdown</h2>
  <div class="region-cards">
${regionCardsHtml}
  </div>
</section>

<!-- FULL 100-CITY TABLE — all rows static HTML, sticky thead, JS filter uses display:none -->
<section class="full-table">
  <h2>All ${towns.length} Texas cities</h2>
  <div class="ft-tools">
    <input type="search" class="ft-filter" id="ft-filter" placeholder="Filter by city name…" aria-label="Filter by city name">
    <span class="ft-count" id="ft-count">${towns.length} cities</span>
  </div>
  <div class="fulltbl-wrap">
    <table class="fulltbl">
      <thead><tr><th>#</th><th>City</th><th>Regular</th><th>Midgrade</th><th>Premium</th><th>Diesel</th><th>Cheapest chain</th></tr></thead>
      <tbody id="fulltbl-body">
${fullTableRowsHtml}
      </tbody>
    </table>
  </div>
</section>

<!-- E-E-A-T -->
<section class="eeat">
  <h2>How we track Texas gas prices</h2>
  <p>TXGasPrices.net combines two independent feeds — the AAA Texas state-average for hourly refresh and GasBuddy per-station prices via Apify every 3 days — to cover ${towns.length} Texas cities. Every price on this page links back to its source city page with station-level detail.</p>
  <ul>
    <li><b>Primary source:</b> <a href="https://gasprices.aaa.com/?state=TX" rel="nofollow noopener">AAA Texas Gas Price Tracker</a> — official statewide average (refreshed hourly).</li>
    <li><b>Per-station source:</b> <a href="https://apify.com/johnvc/fuelprices" rel="nofollow noopener">GasBuddy via Apify</a> — 759 stations across 50 Texas cities (refreshed every 3 days).</li>
    <li><b>Fallback:</b> For cities without live station data, per-chain prices are estimated from the state average plus typical chain offsets (documented in our open-source generator).</li>
    <li><b>Refineries, population, region labels:</b> US EIA + US Census Bureau 2020 counts.</li>
  </ul>
  <p style="margin-top:8px"><b>Last full refresh:</b> ${updatedHuman} CT. <b>License:</b> data compiled under fair use for comparison/journalism; station names and logos remain property of their respective brand owners.</p>
</section>

<!-- FAQ — spec design with Texas Statewide content -->
<section class="faq-section">
  <div class="faq-header">
    <div class="faq-title-row">
      <div class="faq-title">Fuel prices &amp; local data — Texas Statewide ⛽</div>
      <div class="faq-live">
        <span class="live-dot"></span>
        <span>${updatedTimeCt}</span>
      </div>
    </div>
    <div class="pills">${faqPillsHtml}</div>
  </div>
  <div class="faq-context">Texas refines roughly 43% of US gasoline across 29 refineries — concentrated along the Gulf Coast. That supply advantage keeps Texas pump prices consistently below the national average year-round.</div>
  <div class="faq-stats">
${faqStatsHtml}
  </div>
  <div class="faq-items">
${faqItemsHtml}
  </div>
</section>

<div class="footer">
  <span>${buildFooterNote()}</span>
  <span style="margin-left:auto">AAA Texas · GasBuddy · US EIA</span>
</div>

</div>
<script>
(function(){
  const FUEL_RANKINGS = ${JSON.stringify(fuelRankings)};
  const LABELS = { regular:'regular unleaded', midgrade:'midgrade', premium:'premium', diesel:'diesel' };
  const tabs = document.querySelectorAll('#cgt-tabs .ft');

  function renderRank(rows, fuel) {
    return rows.map((r, i) =>
      '<tr><td class="rk">' + (i + 1) + '</td>' +
      '<td><a href="/gas-prices/' + r.slug + '">' + r.name + ', TX</a></td>' +
      '<td>' + r.chain + '</td>' +
      '<td class="pg">$' + r.p + '</td></tr>'
    ).join('');
  }

  function swapFuel(fuel) {
    const list = FUEL_RANKINGS[fuel] || FUEL_RANKINGS.regular;
    const cheap = list.slice(0, 10);
    const exp   = list.slice(-10).reverse();
    document.getElementById('tbl-cheap').innerHTML = renderRank(cheap, fuel);
    document.getElementById('tbl-exp').innerHTML   = renderRank(exp, fuel);

    // Update big callout
    const first = cheap[0];
    document.getElementById('bc-price').textContent = first.p.replace(/0$/, '').length >= 4 ? first.p.slice(0, -1) : first.p;
    document.getElementById('bc-chain').textContent = first.chain;
    document.getElementById('bc-city').textContent  = first.name + ', TX';
    document.getElementById('bc-link').setAttribute('href', '/gas-prices/' + first.slug);
    document.getElementById('bc-fuel-label').textContent = LABELS[fuel];
  }

  tabs.forEach(t => t.addEventListener('click', () => {
    const fuel = t.dataset.fuel;
    tabs.forEach(x => x.classList.toggle('on', x === t));
    swapFuel(fuel);
  }));

  // Full-table filter — uses display:none on rows, does NOT remove from DOM.
  const filterInput = document.getElementById('ft-filter');
  const countEl     = document.getElementById('ft-count');
  const rows        = document.querySelectorAll('#fulltbl-body .city-row');
  filterInput.addEventListener('input', () => {
    const q = filterInput.value.trim().toLowerCase();
    let visible = 0;
    rows.forEach(r => {
      const name = r.getAttribute('data-name') || '';
      const match = !q || name.includes(q);
      r.style.display = match ? '' : 'none';
      if (match) visible++;
    });
    countEl.textContent = visible + (visible === 1 ? ' city' : ' cities');
  });
})();
</script>
</body>
</html>
`;
}

// ── trip-cost-calculator hub page ────────────────────────────
function buildTripCalcPage() {
  const canonical = 'https://txgasprices.net/trip-cost-calculator/';
  const updatedHuman  = formatUpdated(prices.updated);
  const updatedTimeCt = formatUpdatedTime(prices.updated);
  const stateAvgReg   = prices.stateAverage && prices.stateAverage.regular;
  const stateAvgPrice = stateAvgReg != null ? stateAvgReg : 3.50;
  const stateAvgFmt2  = money2(stateAvgPrice);

  const townByName = Object.fromEntries(towns.map(t => [t.name, t]));
  const townBySlug = Object.fromEntries(towns.map(t => [t.slug, t]));

  // Default 6 routes shown before the user picks an origin.
  const DEFAULT_ROUTES = [
    ['Houston', 'Dallas'],      ['Houston', 'Austin'],
    ['San Antonio', 'Austin'],  ['Dallas', 'Fort Worth'],
    ['Austin', 'Dallas'],       ['Houston', 'San Antonio'],
  ];

  // Shared renderer — takes a pair [fromName, toName] and returns a card
  // that prefills the calc when clicked (handled by the page-end script).
  function makeRouteCardHtml(fromName, toName) {
    const a = townByName[fromName], b = townByName[toName];
    if (!a || !b || a.lat == null || b.lat == null) return '';
    const miles = Math.round(haversineKm(a, b) * 0.621371);
    const sedanCost = (miles / 32) * stateAvgPrice;
    const truckCost = (miles / 20) * stateAvgPrice;
    const href = `/trip-cost-calculator?from=${a.slug}&to=${b.slug}`;
    return `    <a class="route-card" href="${href}" data-from-slug="${escAttr(a.slug)}" data-to-slug="${escAttr(b.slug)}" data-from-name="${escAttr(fromName)}, TX" data-to-name="${escAttr(toName)}, TX">
      <div class="rc-route"><b>${escHtml(fromName)} → ${escHtml(toName)}</b></div>
      <div class="rc-line">${miles} mi · Sedan ~$${sedanCost.toFixed(0)}</div>
      <div class="rc-line">Truck ~$${truckCost.toFixed(0)}</div>
      <span class="rc-cta">Calculate →</span>
    </a>`;
  }

  const routeCardsHtml = DEFAULT_ROUTES
    .map(([f, t]) => makeRouteCardHtml(f, t))
    .filter(Boolean).join('\n');

  // Precompute nearest-3 cities for each town so the client can swap route
  // cards dynamically without recomputing haversine in the browser.
  const ROUTE_BIG_CITY_SLUGS = ['houston-tx', 'san-antonio-tx', 'dallas-tx', 'austin-tx', 'fort-worth-tx', 'el-paso-tx'];
  const nearestCitiesMap = {};
  for (const t of towns) {
    if (t.lat == null || t.lng == null) continue;
    const ranked = towns
      .filter(other => other.slug !== t.slug && other.lat != null && other.lng != null)
      .map(other => ({ slug: other.slug, name: other.name, km: haversineKm(t, other) }))
      .sort((a, b) => a.km - b.km)
      .slice(0, 3)
      .map(x => ({ slug: x.slug, name: x.name }));
    nearestCitiesMap[t.slug] = ranked;
  }
  const bigCitiesData = ROUTE_BIG_CITY_SLUGS
    .filter(s => townBySlug[s])
    .map(s => ({ slug: s, name: townBySlug[s].name }));
  const routeDataJson = JSON.stringify({
    avgPrice:    stateAvgPrice,
    bigCities:   bigCitiesData,
    nearest:     nearestCitiesMap,
    distances:   Object.fromEntries(towns.map(t => [t.slug, { lat: t.lat, lng: t.lng, name: t.name }])),
  });

  const faqItems = [
    { q: 'How much does it cost to drive cross-country?',
      a: `A 2,800-mile Los Angeles → New York drive in a <b>30 MPG sedan</b> burns ~93 gallons — about <b>$325</b> at the current US average. A <b>20 MPG truck or SUV</b> burns ~140 gallons ≈ <b>$490</b>. Shorter example: a Houston, TX → Denver trip (1,030 mi) is roughly <b>$120</b> in a sedan, <b>$180</b> in a truck.`,
      src: `Source: AAA national gas-price average + fueleconomy.gov MPG data` },
    { q: 'What MPG should I use for my vehicle?',
      a: `Use the <b>Pick my car</b> tab to get EPA-certified MPG from <b>fueleconomy.gov</b> (covering all US gas vehicles 1984–${CURRENT_YEAR}). Combined MPG is a weighted city/highway mix — most accurate for mixed driving. Prefer Highway MPG for interstate-heavy trips.`,
      src: `Source: fueleconomy.gov (US Department of Energy)` },
    { q: 'Which states have the cheapest gas?',
      a: `Low-tax states with refinery access — <b>Texas</b>, <b>Missouri</b>, <b>Oklahoma</b>, <b>Mississippi</b>, and <b>Louisiana</b> — typically post the cheapest pump prices. High-tax or supply-constrained states — <b>California</b>, <b>Pennsylvania</b>, <b>Washington</b>, and <b>Illinois</b> — run 50¢–$1.50/gal above the national average. Fueling up before crossing into CA or PA on a road trip can save $10–$25 on a full tank.`,
      src: `Source: EIA state motor-fuel tax data + AAA state-average tracker` },
    { q: 'What about tolls and other fees?',
      a: `Most US states have toll roads — think I-95 in the Northeast, Florida's Turnpike, the Kansas Turnpike, and Texas toll examples like SH 130, TxTag, and Harris County EZ Tag. Plan for $5–$30 per long one-way trip, more in the Northeast corridor. The calculator estimates <b>fuel only</b>; tolls, parking, food, and maintenance are on top.`,
      src: `Source: FHWA toll-road directory + state turnpike authorities` },
    { q: 'Can I use this calculator for trips in any state?',
      a: `Yes — the Google Maps Distance Matrix computes accurate driving distances between any two US addresses, and fueleconomy.gov covers vehicles sold nationwide. Enter any origin and destination in any of the <b>50 US states</b> (or even Canada/Mexico border crossings). For precise per-station prices outside Texas, use the <b>I'm at the pump</b> toggle to type today's local gas price.`,
      src: `Source: Google Maps coverage + fueleconomy.gov database` },
    { q: 'Does the calculator handle round trips?',
      a: `Yes — toggle <b>Round trip</b> below the passenger selector. The calculator doubles the distance and fuel cost but keeps <b>per-person</b> math the same (round-trip cost ÷ passenger count).`,
      src: `Source: Trip Cost Calculator logic` },
  ];

  const faqItemsHtml = faqItems.map(it =>
    `    <details>
      <summary>${escHtml(it.q)}</summary>
      <div class="faq-a">${it.a}</div>
      <div class="faq-src">${escHtml(it.src)}</div>
    </details>`
  ).join('\n');

  const faqStatsCards = [
    { val: '30,000+', lbl: 'vehicles' },
    { val: '50',      lbl: 'US states covered' },
    { val: '1984–' + CURRENT_YEAR, lbl: 'vehicle years' },
    { val: 'Free',   lbl: 'no signup' },
  ];
  const faqStatsHtml = faqStatsCards.map(c => `    <div class="faq-stat">
      <div class="faq-stat-val">${escHtml(c.val)}</div>
      <div class="faq-stat-lbl">${escHtml(c.lbl)}</div>
    </div>`).join('\n');

  const faqPills = [
    'Live prices', '30,000+ vehicles', 'Google Maps distance', 'Free calculator',
  ];
  const faqPillsHtml = faqPills.map(p => `<span class="pill">${escHtml(p)}</span>`).join('');

  const webPage = {
    '@context':   'https://schema.org', '@type': 'WebPage',
    name:         'Trip Cost Calculator — Gas Cost for Any Road Trip',
    description:  'Free calculator that estimates fuel cost for any road trip in the US using real Google Maps distances, EPA MPG data, and live gas prices.',
    dateModified: prices.updated, url: canonical,
  };
  const webApp = {
    '@context': 'https://schema.org', '@type': 'WebApplication',
    name:       'Trip Cost Calculator',
    url:        canonical,
    applicationCategory: 'TravelApplication',
    operatingSystem:     'Any',
    browserRequirements: 'Requires JavaScript',
    offers:              { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  };
  const faqSchema = {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: faqItems.map(it => ({
      '@type':         'Question', name: it.q,
      acceptedAnswer:  { '@type': 'Answer', text: stripHtml(it.a) },
    })),
  };

  const styleMatch = TEMPLATE.match(/<style>[\s\S]*?<\/style>/);
  const sharedStyles = styleMatch ? styleMatch[0] : '';
  const TX_LAT = '31.9686';
  const TX_LNG = '-99.9018';
  const mockupScriptWithTokens = extractMockupScript()
    .replace('{{PRICE_DATA_JSON}}', JSON.stringify(statewidePriceData(), null, 2))
    .replace('{{INITIAL_FUEL}}', 'regular')
    .replace(/\{\{CITY_NAME_FULL\}\}/g, '')
    .replace(/\{\{CITY_NAME\}\}/g, 'Texas')
    .replace(/\{\{CITY_NAME_URL\}\}/g, 'Texas+TX')
    .replace(/\{\{CITY_LAT\}\}/g, TX_LAT)
    .replace(/\{\{CITY_LNG\}\}/g, TX_LNG)
    .replace(/\{\{CURRENT_YEAR\}\}/g, String(CURRENT_YEAR));

  const title = 'Trip Cost Calculator — Gas Cost for Any Road Trip';
  const description = `Free road-trip gas cost calculator. Real Google Maps driving distances, 30,000+ vehicle MPG database (1984–${CURRENT_YEAR}), and live gas prices. Works in all 50 US states.`;

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
<meta name="description" content="${escAttr(description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${escAttr(title)}">
<meta property="og:description" content="${escAttr(description)}">
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
${JSON.stringify(faqSchema, null, 2)}
</script>
${sharedStyles}
<style>
.hub-hero{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;padding:22px 24px}
.hub-hero h1{font-size:24px;font-weight:500;margin-bottom:6px;letter-spacing:-.01em}
.hub-hero .sub{font-size:13px;color:#6b6b66}
.routes-wrap{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;padding:14px 16px}
.routes-wrap h2{font-size:13px;font-weight:500;color:#1a1a18;margin:0 0 4px;letter-spacing:.02em;text-transform:uppercase}
.routes-wrap .routes-sub{font-size:11.5px;color:#9a9990;margin:0 0 10px}
.route-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.route-card{display:block;padding:10px 12px;border:0.5px solid rgba(0,0,0,.08);border-radius:8px;background:#fff;text-decoration:none;color:#1a1a18;transition:border-color .15s,background .15s}
.route-card:hover{border-color:#1D9E75;background:#f8fbf9}
.rc-route{font-size:13px;color:#1a1a18;margin-bottom:3px}
.rc-route b{font-weight:500}
.rc-line{font-size:12px;color:#6b6b66;line-height:1.45}
.rc-cta{display:inline-block;margin-top:4px;font-size:11.5px;color:#1D9E75;font-weight:500}
@media (max-width:900px){.route-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:560px){.route-grid{grid-template-columns:1fr}}
.howit{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;padding:18px 20px}
.howit h2{font-size:13px;font-weight:500;margin:0 0 12px;letter-spacing:.02em;text-transform:uppercase}
.howit-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.howit-step{background:#f8f6ef;border-radius:10px;padding:12px 14px}
.howit-step h3{font-size:13.5px;font-weight:500;margin:0 0 6px;color:#1a1a18}
.howit-step p{font-size:12.5px;color:#6b6b66;line-height:1.55;margin:0}
</style>
</head>
<body>
<div class="site">

<!-- NAV -->
<div class="topbar">
  <a class="logo" href="/">TX<em>Gas</em>Prices</a>
  <div class="nav">
    <a href="/">Home</a>
    <a class="on" href="/trip-cost-calculator">Trip Calculator</a>
    <a href="/cheapest-gas-texas">Cheapest in Texas</a>
  </div>
</div>

<!-- HERO -->
<section class="hub-hero">
  <h1>Trip Cost Calculator</h1>
  <div class="sub">Estimate the gas cost of any US road trip using real Google Maps distances, EPA MPG data, and today's pump prices.</div>
  <div class="updated" style="margin-top:8px"><span class="live-dot"></span>Updated ${updatedHuman} CT · default gas price $${stateAvgFmt2}/gal (TX regular)</div>
</section>

<!-- FULL CALCULATOR — reused from city-page mockup, empty From/To.
     Trip-calc page has its own Popular Routes section below, so we strip the
     orphan "Popular routes" label + chips that's embedded in the shared calc. -->
${extractCalcHtml('', '').replace(
  /\s*<div class="slabel">Popular routes<\/div>\s*<div class="chips" id="chips"><\/div>/,
  ''
)}

<!-- POPULAR ROUTES — default 6, JS swaps when From changes -->
<section class="routes-wrap">
  <h2>Popular routes</h2>
  <p class="routes-sub" id="routes-sub">Tap a card to prefill the calculator.</p>
  <div class="route-grid" id="route-grid">
${routeCardsHtml}
  </div>
</section>

<script id="route-data" type="application/json">
${routeDataJson}
</script>

<!-- HOW IT WORKS — 3 sections -->
<section class="howit">
  <h2>How it works</h2>
  <div class="howit-grid">
    <div class="howit-step">
      <h3>1. Real driving distance</h3>
      <p>Google Maps Distance Matrix computes the actual highway route between your two addresses — not straight-line distance — so the mileage matches what your odometer will show.</p>
    </div>
    <div class="howit-step">
      <h3>2. EPA-certified MPG</h3>
      <p>Pick your exact year, make, and model from the fueleconomy.gov database (30,000+ vehicles, 1984–${CURRENT_YEAR}). Or enter your own MPG manually if you track it yourself.</p>
    </div>
    <div class="howit-step">
      <h3>3. Live gas prices</h3>
      <p>Fuel cost defaults to the gas price we're currently tracking. Prefer a specific chain or the price you see on the pump? Toggle to manual entry and type any amount.</p>
    </div>
  </div>
</section>

<!-- FAQ — spec-compliant header + pills + stats + 6 Qs -->
<section class="faq-section">
  <div class="faq-header">
    <div class="faq-title-row">
      <div class="faq-title">Fuel prices &amp; local data — Trip Calculator ⛽</div>
      <div class="faq-live">
        <span class="live-dot"></span>
        <span>${updatedTimeCt}</span>
      </div>
    </div>
    <div class="pills">${faqPillsHtml}</div>
  </div>
  <div class="faq-context">The Trip Cost Calculator combines EPA vehicle data, Google Maps routing, and live US gas prices so every drive you plan uses real-world numbers, not averages.</div>
  <div class="faq-stats">
${faqStatsHtml}
  </div>
  <div class="faq-items">
${faqItemsHtml}
  </div>
</section>

<div class="footer">
  <span>${buildFooterNote()}</span>
  <span style="margin-left:auto">Data: AAA Texas · fueleconomy.gov · Google Maps</span>
</div>

</div>
${mockupScriptWithTokens}
<script>
(function(){
  // Route-data blob precomputed at build time (nearest-3 per city + big cities).
  const RD = JSON.parse(document.getElementById('route-data').textContent);
  const fromIn = document.getElementById('from-in');
  const toIn   = document.getElementById('to-in');
  const grid   = document.getElementById('route-grid');
  const sub    = document.getElementById('routes-sub');

  function fmtCost(miles, mpg) {
    return '$' + Math.round((miles / mpg) * RD.avgPrice);
  }
  function haversineMi(a, b) {
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const x = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
    return 6371 * 2 * Math.asin(Math.sqrt(x)) * 0.621371;
  }
  function renderCard(fromSlug, fromName, toSlug, toName) {
    const fPt = RD.distances[fromSlug], tPt = RD.distances[toSlug];
    if (!fPt || !tPt) return '';
    const miles = Math.round(haversineMi(fPt, tPt));
    return '<a class="route-card" href="/trip-cost-calculator?from=' + fromSlug + '&to=' + toSlug +
      '" data-from-slug="' + fromSlug + '" data-to-slug="' + toSlug +
      '" data-from-name="' + fromName + ', TX" data-to-name="' + toName + ', TX">' +
      '<div class="rc-route"><b>' + fromName + ' → ' + toName + '</b></div>' +
      '<div class="rc-line">' + miles + ' mi · Sedan ~' + fmtCost(miles, 32) + '</div>' +
      '<div class="rc-line">Truck ~' + fmtCost(miles, 20) + '</div>' +
      '<span class="rc-cta">Calculate →</span>' +
      '</a>';
  }

  // Lookup a town by typed input value (e.g. "Houston, TX"). Returns slug or null.
  function slugFromInput(val) {
    const key = String(val || '').trim().toLowerCase().replace(/,\s*tx\s*$/, '').trim();
    if (!key) return null;
    for (const slug in RD.distances) {
      if (RD.distances[slug].name.toLowerCase() === key) return slug;
    }
    return null;
  }

  // On From change: show 3 biggest non-origin cities + 3 nearest from precompute.
  function refreshRoutesForFrom(fromSlug) {
    if (!fromSlug || !RD.distances[fromSlug] || !RD.nearest[fromSlug]) return; // keep defaults
    const fromName = RD.distances[fromSlug].name;
    const bigNonSelf = RD.bigCities.filter(c => c.slug !== fromSlug).slice(0, 3);
    const nearest3  = RD.nearest[fromSlug].slice(0, 3);
    const seen = new Set();
    const picks = [...bigNonSelf, ...nearest3].filter(c => {
      if (c.slug === fromSlug || seen.has(c.slug)) return false;
      seen.add(c.slug); return true;
    }).slice(0, 6);
    grid.innerHTML = picks.map(c => renderCard(fromSlug, fromName, c.slug, c.name)).join('\n');
    sub.textContent = 'Popular routes from ' + fromName + ', TX. Tap a card to prefill.';
  }

  // Card click — drive the calc exactly as if the user manually filled it:
  //  1) Populate From/To
  //  2) Switch to "Pick my car", then select Toyota → Camry → nearest-to-2023
  //     year, triggering the same async code path as manual selection. If
  //     fueleconomy.gov can't return MPG we fall back to manual MPG = 32.
  //  3) Ensure "Use live price" tab active, fuel=Regular, station=first
  //     (cheapest) option
  //  4) Run calcTrip()
  //  5) Smooth-scroll to the .calc-result row (not page top)
  grid.addEventListener('click', async (e) => {
    const card = e.target.closest('.route-card');
    if (!card) return;
    e.preventDefault();

    const fromName = card.getAttribute('data-from-name') || '';
    const toName   = card.getAttribute('data-to-name') || '';

    // 1. Populate route inputs
    if (fromIn) { fromIn.value = fromName; fromIn.dispatchEvent(new Event('input', { bubbles: true })); }
    if (toIn)   { toIn.value   = toName;   toIn.dispatchEvent(new Event('input', { bubbles: true })); }

    // 2. Vehicle selection: Toyota Camry, nearest year to 2023
    const setManualMpg = () => {
      const mpgM = document.getElementById('mpg-m');
      if (!mpgM) return;
      mpgM.value = '32';
      if (typeof onManualMpg === 'function') onManualMpg();
    };

    try {
      if (typeof setVMode === 'function') setVMode('car');
      if (typeof loadMakes === 'function') await loadMakes();

      const makeSel = document.getElementById('sel-make');
      const hasToyota = makeSel && Array.from(makeSel.options).some(o => o.value === 'Toyota');
      if (!hasToyota) { setManualMpg(); } else {
        makeSel.value = 'Toyota';
        if (typeof onMakeChange === 'function') await onMakeChange();

        const modelSel = document.getElementById('sel-model');
        const hasCamry = modelSel && Array.from(modelSel.options).some(o => o.value === 'Camry');
        if (!hasCamry) { setManualMpg(); } else {
          modelSel.value = 'Camry';
          if (typeof onModelChange === 'function') await onModelChange();

          const yearSel = document.getElementById('sel-year');
          const years = yearSel ? Array.from(yearSel.options).map(o => Number(o.value)).filter(Number.isFinite) : [];
          if (!years.length) { setManualMpg(); } else {
            const target = years.includes(2023)
              ? 2023
              : years.reduce((best, y) => Math.abs(y - 2023) < Math.abs(best - 2023) ? y : best);
            yearSel.value = String(target);
            if (typeof onYearChange === 'function') await onYearChange();

            // If fueleconomy.gov couldn't return MPG (offline, blocked, no
            // data for this trim), the pill shows "MPG not found". Fall back.
            const pillText = (document.getElementById('mpg-pill-text') || {}).textContent || '';
            if (/not found/i.test(pillText)) setManualMpg();
          }
        }
      }
    } catch (err) {
      // Any unexpected error during the async chain → safe fallback.
      setManualMpg();
    }

    // 3. Live-price mode, Regular fuel, default (cheapest) chain
    if (typeof setGasMode === 'function') setGasMode('auto');
    const calcFuel = document.getElementById('calc-fuel');
    if (calcFuel) {
      calcFuel.value = 'regular';
      if (typeof onCalcFuelChange === 'function') onCalcFuelChange();
    }
    const chainSel = document.getElementById('chain-sel');
    if (chainSel && chainSel.options.length) chainSel.selectedIndex = 0;

    // 4. Run the calculation (also re-runs after any subsequent user edit).
    if (typeof calcTrip === 'function') calcTrip();

    // 5. Scroll to results row, not page top.
    const resultEl = document.querySelector('.calc-result');
    if (resultEl) resultEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // From-field change → swap routes (debounce slightly).
  let fromTimer = null;
  function onFromTyped() {
    clearTimeout(fromTimer);
    fromTimer = setTimeout(() => {
      const slug = slugFromInput(fromIn && fromIn.value);
      if (slug) refreshRoutesForFrom(slug);
    }, 250);
  }
  if (fromIn) {
    fromIn.addEventListener('input', onFromTyped);
    fromIn.addEventListener('change', onFromTyped);
    fromIn.addEventListener('blur',   onFromTyped);
  }

  // ?from=/?to= URL params on page load — prefill inputs.
  try {
    const params = new URLSearchParams(window.location.search);
    const fromParam = params.get('from');
    const toParam   = params.get('to');
    if (fromParam && RD.distances[fromParam] && fromIn) {
      fromIn.value = RD.distances[fromParam].name + ', TX';
      refreshRoutesForFrom(fromParam);
    }
    if (toParam && RD.distances[toParam] && toIn) {
      toIn.value = RD.distances[toParam].name + ', TX';
    }
    if ((fromParam || toParam) && typeof window.calcTrip === 'function') window.calcTrip();
  } catch (err) { /* no-op: older browsers without URLSearchParams */ }
})();
</script>
</body>
</html>
`;
}

// ── run ──────────────────────────────────────────────────────
let pageCount = 0;

// Only the main city page. Fuel subpages (midgrade/premium/diesel) and the
// /cheapest alias are consolidated — all 4 fuel prices are embedded in the
// main page and swapped client-side by the fuel tab JS. Old URLs are handled
// by 301 redirects in output/_redirects (see buildRedirects).
towns.forEach(town => {
  const dir = `./output/gas-prices/${town.slug}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/index.html`, buildPage(town, 'regular'));
  pageCount++;
});

fs.mkdirSync('./output', { recursive: true });
fs.writeFileSync('./output/sitemap.xml', buildSitemap());
fs.writeFileSync('./output/robots.txt', buildRobotsTxt());
fs.writeFileSync('./output/_redirects', buildRedirects());
fs.writeFileSync('./output/index.html', buildHomepage());
fs.mkdirSync('./output/trip-cost-calculator', { recursive: true });
fs.writeFileSync('./output/trip-cost-calculator/index.html', buildTripCalcPage());
fs.mkdirSync('./output/cheapest-gas-texas', { recursive: true });
fs.writeFileSync('./output/cheapest-gas-texas/index.html', buildCheapestGasPage());

console.log(`\n✓ Generated ${pageCount} pages across ${towns.length} towns`);
console.log(`✓ Sitemap written with ${towns.length * 6 + 3} URLs`);
console.log(`✓ Output folder: ./output/gas-prices/\n`);
console.log('Sample URLs built:');
towns.slice(0, 5).forEach(t => {
  console.log(`  https://txgasprices.net/gas-prices/${t.slug}`);
  console.log(`  https://txgasprices.net/gas-prices/${t.slug}/diesel`);
});
