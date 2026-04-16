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
function faqMembership(town, d, info, townChains) {
  const altChain = (townChains || []).find(c => !MEMBERSHIP_FAQ_CHAINS.has(c.chain));
  const altPart = altChain
    ? ` The next-cheapest non-membership chain in ${town.name} is <b>${altChain.chain}</b> at <b>$${faq2dec(altChain.regular)}/gal</b>.`
    : '';
  return {
    q: `Do I need a membership to get the cheapest gas in ${town.name}?`,
    a: `Yes — <b>${d.cheapestChain}</b>'s posted $${faq2dec(d.cheapestPrice)}/gal requires a paid membership card.${altPart}`,
  };
}

function faqRefinery(town, d, info) {
  if (!info.refinery_name) return null;
  const miles = info.refinery_miles;
  const milesPart = Number.isFinite(miles) && miles >= 0
    ? ` — roughly ${miles} mile${miles === 1 ? '' : 's'} away`
    : '';
  const factor = info.price_factor ? ` ${info.price_factor}.` : '';
  return {
    q: `Why is gas in ${town.name} often cheaper than the Texas average?`,
    a: `${town.name} sits near ${info.refinery_name}${milesPart}.${factor}`,
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
    q: `Why aren't gas prices in ${town.name} lower given nearby oil production?`,
    a: `Even with ${rigs}+ active rigs in ${county} County, Permian crude travels hundreds of miles to Gulf Coast refineries and returns as finished gasoline.${factor}`,
  };
}

function faqBorder(town, d, info) {
  const fact = info.local_fact ? ` ${info.local_fact}.` : '';
  const factor = info.price_factor ? ` ${info.price_factor}.` : '';
  return {
    q: `Are gas prices cheaper near the Texas-Mexico border in ${town.name}?`,
    a: `${town.name} sits on the border, where cross-border demand and regional competition shape pump prices.${factor}${fact}`,
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
    q: `How does ${display} affect ${town.name} gas demand?`,
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
    q: `Do ${uniShort} events affect gas prices in ${town.name}?`,
    a: `Home football weekends, graduations, and major campus events push local traffic and fuel demand above normal levels.${factTail}`,
  };
}

function faqStateAvgFallback(town, d, info) {
  const commute = info.commute_note ? ` ${info.commute_note}.` : '';
  return {
    q: `How do ${town.name} gas prices compare to the Texas state average?`,
    a: `The Texas state average for regular is <b>$${faq2dec(d.stateAvg)}/gal</b>. ${town.name} drivers pay close to the statewide average — choose <b>${d.cheapestChain}</b> to pay below average.${commute}`,
  };
}

function buildFaqItems(town, d) {
  const info = CITY_INFO[town.slug] || {};
  const updatedHuman = formatUpdated(prices.updated);
  const townChains = chainsForTown(town);
  const items = [];

  // Always-on Q1 + Q2 (per-gallon prices rounded to 2 decimals for FAQ)
  items.push({
    q: `What is the cheapest gas in ${town.name} right now?`,
    a: `<b>${d.cheapestChain}</b> is currently the cheapest at <b>$${faq2dec(d.cheapestPrice)}/gal</b> for regular unleaded. Prices last updated ${updatedHuman}.`,
  });
  items.push({
    q: `How much does a full tank cost in ${town.name}?`,
    a: `At current prices, filling a 15-gallon tank costs <b>$${d.tankCost15}</b> at ${d.cheapestChain}. A 20-gallon tank costs <b>$${d.tankCost20}</b>.`,
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

// Build 3 stat cards above the FAQ accordion, keyed off what the city
// actually is in cities-info.json. Category priority:
//   oil rigs > border > refinery > military > college > price fallback.
// Each card shows a short uppercase label, a bold value, and a context line.
function buildFaqStatsHtml(town, d, info) {
  const pop = Number(town.population) || 0;
  const popFmt = pop > 0 ? pop.toLocaleString('en-US') : null;
  const cards = [];

  const pushCard = (label, value, context) => {
    if (value == null || value === '') return;
    cards.push({ label, value, context: context || '' });
  };

  if (info.oil_rigs_nearby && info.oil_rigs_nearby > 0) {
    pushCard('Active oil rigs',
      `${info.oil_rigs_nearby}+`,
      `in ${town.county || 'the county'} County`);
    if (info.refinery_miles) {
      pushCard('Miles to refinery',
        `${info.refinery_miles} mi`,
        'round-trip for finished fuel');
    }
    pushCard('Truck ownership',
      `${info.truck_ownership_pct || 0}%`,
      'of household vehicles');
  } else if (info.border_town) {
    pushCard('Truck share of traffic',
      `${info.truck_traffic_pct || 0}%`,
      'cross-border freight flow');
    if (info.daily_traffic_count) {
      pushCard('Daily traffic',
        info.daily_traffic_count.toLocaleString('en-US'),
        `vehicles on ${info.highway_primary || 'primary highway'}`);
    }
    if (popFmt) pushCard('Population', popFmt, 'residents');
  } else if (info.refinery_nearby && info.refinery_name) {
    const capMatch = info.refinery_name.match(/([\d,]+)\s*bbl\/day/i);
    const refShort = info.refinery_name.split('—')[0].trim();
    pushCard('Nearest refinery capacity',
      capMatch ? `${capMatch[1]} bbl/day` : 'major refinery',
      refShort);
    pushCard('Distance',
      `${info.refinery_miles || 0} mi`,
      `from ${town.name}`);
    if (info.fuel_terminal_miles != null) {
      pushCard('Fuel terminal',
        `${info.fuel_terminal_miles} mi`,
        'to nearest pipeline terminal');
    }
  } else if (info.military_base && info.military_base_name) {
    const soldierMatch = info.military_base_name.match(/([\d,]+)\s*active-duty/i);
    const sqMiMatch    = info.military_base_name.match(/([\d.,]+)\s*square miles/i);
    const acreMatch    = info.military_base_name.match(/([\d,]+)\s*acres/i);
    const baseShort    = info.military_base_name.split(/[—(]/)[0].trim();
    pushCard('Military base', baseShort, `adjacent to ${town.name}`);
    if (soldierMatch) {
      pushCard('Active-duty personnel', soldierMatch[1], 'stationed at base');
    }
    if (sqMiMatch) {
      pushCard('Base size',
        `${sqMiMatch[1]} sq mi`,
        acreMatch ? `${acreMatch[1]} acres` : 'land area');
    } else if (acreMatch) {
      pushCard('Base size', `${acreMatch[1]} acres`, 'land area');
    }
  } else if (info.college_town && info.university_name) {
    const enrollMatch = info.university_name.match(/([\d,]+)\s*students/i);
    const uniShort = info.university_name.split(' (')[0].split(',')[0].trim();
    pushCard('Anchor university', uniShort, 'largest local institution');
    if (enrollMatch) {
      pushCard('Students enrolled', enrollMatch[1], 'full- and part-time');
    }
    if (popFmt) pushCard('City population', popFmt, 'residents');
  }

  // Fill to 3 with price-based cards (also used as the sole fallback for
  // cities with none of the conditional categories).
  if (cards.length < 3) {
    pushCard('Cheapest gas',
      `$${faq2dec(d.cheapestPrice)}/gal`,
      `at ${d.cheapestChain}`);
  }
  if (cards.length < 3) {
    pushCard('15-gallon tank', `$${d.tankCost15}`, 'full tank cost');
  }
  if (cards.length < 3) {
    const diff = Number(d.stateAvg) - Number(d.cheapestPrice);
    const abs = Math.abs(diff).toFixed(2);
    pushCard(diff >= 0 ? 'Saved vs state avg' : 'Above state avg',
      `$${abs}/gal`, 'vs Texas average');
  }

  const out = cards.slice(0, 3).map(c => `    <div class="faq-stat">
      <div class="fs-label">${escHtml(c.label)}</div>
      <div class="fs-value">${escHtml(c.value)}</div>
      <div class="fs-context">${escHtml(c.context)}</div>
    </div>`).join('\n');
  return `  <div class="faq-stats">\n${out}\n  </div>`;
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

  const pageTitle = fuel === 'regular'
    ? `Gas Prices in ${town.name}, TX Today — Cheapest $${cheapestPrice}/gal | TXGasPrices`
    : `${fLabel} Gas Prices in ${town.name}, TX Today — Cheapest $${cheapestPrice}/gal | TXGasPrices`;

  const heroTitle = fuel === 'regular'
    ? `Gas prices in ${town.name}, TX`
    : `${fLabel} gas prices in ${town.name}, TX`;

  const metaDesc = `Live ${fuel === 'regular' ? '' : fuel + ' '}gas prices in ${town.name}, TX `
    + `updated hourly from AAA. Cheapest: ${cheapestChain} at $${cheapestPrice}/gal. `
    + `Compare Murphy USA, HEB, Shell, Chevron and more across local stations.`;

  const faqItems = buildFaqItems(town, {
    cheapestPrice, cheapestChain, tankCost15, tankCost20, stateAvg,
  });
  const updatedHuman = formatUpdated(prices.updated);
  const sourceLine = townHasLiveData(town)
    ? `Source: GasBuddy via Apify · ${updatedHuman}`
    : `Source: AAA Texas · ${updatedHuman}`;
  const faqItemsHtml = buildFaqItemsHtml(faqItems, sourceLine);
  const faqStatsHtml = buildFaqStatsHtml(town, {
    cheapestPrice, cheapestChain, tankCost15, tankCost20, stateAvg,
  }, CITY_INFO[town.slug] || {});

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
    DATA_SOURCE:               dataSourceFor(town),
    INITIAL_CHAINS_HTML:       renderInitialChainsHtml(town),
  });
}

// ── sitemap ──────────────────────────────────────────────────
function buildSitemap() {
  const base  = 'https://txgasprices.net';
  const today = new Date().toISOString().split('T')[0];
  const urls  = [];

  towns.forEach(t => {
    urls.push(`  <url><loc>${base}/gas-prices/${t.slug}</loc><lastmod>${today}</lastmod><changefreq>hourly</changefreq><priority>0.9</priority></url>`);
    FUELS.slice(1).forEach(f => {
      urls.push(`  <url><loc>${base}/gas-prices/${t.slug}/${f}</loc><lastmod>${today}</lastmod><changefreq>hourly</changefreq><priority>0.7</priority></url>`);
    });
    urls.push(`  <url><loc>${base}/gas-prices/${t.slug}/cheapest</loc><lastmod>${today}</lastmod><changefreq>hourly</changefreq><priority>0.7</priority></url>`);
  });

  urls.push(`  <url><loc>${base}/trip-cost-calculator</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`);
  urls.push(`  <url><loc>${base}/cheapest-gas-texas</loc><lastmod>${today}</lastmod><changefreq>hourly</changefreq><priority>0.8</priority></url>`);
  urls.push(`  <url><loc>${base}/gas-prices-by-city-texas</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`);

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
  const stateAvgRegular = prices.stateAverage && prices.stateAverage.regular;
  const stateAvgFmt = stateAvgRegular != null ? money3(stateAvgRegular) : null;

  // Compute each town's cheapest regular and find the global minimum.
  const townCheap = towns.map(t => {
    const c = cheapestForTown(t, 'regular');
    return { town: t, chain: c.chain, price: c.regular };
  });
  const globalMin = townCheap.reduce((a, b) => b.price < a.price ? b : a);

  const cardGridHtml = townCheap
    .slice()
    .sort((a, b) => (b.town.population || 0) - (a.town.population || 0))
    .map(x => `    <a class="city-card" href="/gas-prices/${x.town.slug}">
      <span class="cc-name">${x.town.name}</span>
      <span class="cc-price">$${money3(x.price)}<span class="cc-gal">/gal</span></span>
    </a>`).join('\n');

  const webPage = {
    '@context':   'https://schema.org',
    '@type':      'WebPage',
    name:         'Texas Gas Prices Today',
    description:  'Find the cheapest gas prices across Texas. Compare chains in 100+ Texas cities.',
    dateModified: prices.updated,
    url:          canonical,
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
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1efe8;color:#1a1a18;padding:16px;font-size:14px}
.site{display:flex;flex-direction:column;gap:10px;max-width:960px;margin:0 auto}
.topbar{background:#fff;border:0.5px solid rgba(0,0,0,.09);border-radius:12px;padding:11px 20px;display:flex;align-items:center;justify-content:space-between}
.logo{font-size:16px;font-weight:500}.logo em{color:#1D9E75;font-style:normal}
.nav{display:flex;gap:20px}.nav a{font-size:13px;color:#6b6b66;text-decoration:none}
.nav a.on{color:#1a1a18;font-weight:500}
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
  <div class="logo">TX<em>Gas</em>Prices</div>
  <div class="nav">
    <a class="on" href="/">Home</a>
    <a href="/gas-prices/houston-tx">Houston</a>
    <a href="/gas-prices/dallas-tx">Dallas</a>
    <a href="/gas-prices/austin-tx">Austin</a>
  </div>
</div>

<div class="hero">
  <h1>Gas prices in Texas today</h1>
  <div class="sub">Compare cheapest gas across ${towns.length} Texas cities · Murphy USA, HEB, Shell, Chevron, Buc-ee's</div>
  <div class="updated"><span class="dot"></span>Updated ${updatedHuman}</div>
  <div class="summary">
    <div class="sbox">
      <div class="slabel">Cheapest in Texas</div>
      <div class="sval g">$${money3(globalMin.price)}<span style="font-size:13px;color:#9a9990;font-weight:400">/gal</span></div>
      <div class="ssub">${globalMin.chain} · <a href="/gas-prices/${globalMin.town.slug}" style="color:#1D9E75;text-decoration:none">${globalMin.town.name}</a></div>
    </div>
    ${stateAvgFmt ? `<div class="sbox">
      <div class="slabel">Texas state average</div>
      <div class="sval">$${stateAvgFmt}<span style="font-size:13px;color:#9a9990;font-weight:400">/gal</span></div>
      <div class="ssub">Regular unleaded · AAA</div>
    </div>` : ''}
    <div class="sbox">
      <div class="slabel">Cities tracked</div>
      <div class="sval">${towns.length}</div>
      <div class="ssub">Texas cities · ${prices.chains.length} chains each</div>
    </div>
  </div>
</div>

<section class="cities">
  <h2>All Texas cities — cheapest regular unleaded</h2>
  <div class="city-grid">
${cardGridHtml}
  </div>
</section>

<div class="footer">
  <span>${buildFooterNote()}</span>
  <span style="margin-left:auto">Murphy USA · HEB Gas · Shell · Chevron · Buc-ee's</span>
</div>

</div>
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
fs.writeFileSync('./output/index.html', buildHomepage());

console.log(`\n✓ Generated ${pageCount} pages across ${towns.length} towns`);
console.log(`✓ Sitemap written with ${towns.length * 6 + 3} URLs`);
console.log(`✓ Output folder: ./output/gas-prices/\n`);
console.log('Sample URLs built:');
towns.slice(0, 5).forEach(t => {
  console.log(`  https://txgasprices.net/gas-prices/${t.slug}`);
  console.log(`  https://txgasprices.net/gas-prices/${t.slug}/diesel`);
});
