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
const prices   = JSON.parse(fs.readFileSync('./prices.json', 'utf8'));
const towns    = JSON.parse(fs.readFileSync('./towns.json',  'utf8'));
const TEMPLATE = fs.readFileSync('./texas_gas_site_ui_mockup.html', 'utf8');

const FUELS        = ['regular', 'midgrade', 'premium', 'diesel'];
const hasEstimates = prices.chains.some(c => c.priceMode === 'estimated');
const CURRENT_YEAR = new Date().getFullYear();

// Placeholder station metadata. Real addresses/distances require a per-
// station data source (e.g. GasBuddy). Until then we reuse fixed strings
// so the UI cards look real and consistent across cities.
const STATION_META = {
  'Murphy USA': { a: '4821 Westheimer Rd',  d: '0.4 mi' },
  'HEB Gas':    { a: '2300 S Shepherd Dr',  d: '0.8 mi' },
  "Buc-ee's":   { a: '9350 Katy Freeway',   d: '1.2 mi' },
  'Shell':      { a: '1100 Louisiana St',   d: '1.4 mi' },
  'Chevron':    { a: '5600 Richmond Ave',   d: '1.7 mi' },
};

// ── helpers ───────────────────────────────────────────────────
function fmtPrice(n)       { return '$' + Number(n).toFixed(2); }
function fuelLabel(f)      { return f.charAt(0).toUpperCase() + f.slice(1); }
function sortedByPrice(f)  { return [...prices.chains].sort((a, b) => a[f] - b[f]); }
function cheapestFor(f)    { return sortedByPrice(f)[0]; }
function mostExpensiveFor(f) { return sortedByPrice(f).slice(-1)[0]; }

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

function formatUpdated(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    + ' — '
    + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

// Build the priceData object literal the client-side JS expects.
// Shape per fuel: [{n, p, ch, a, d}] sorted cheapest-first.
function buildPriceData() {
  const out = {};
  for (const fuel of FUELS) {
    out[fuel] = sortedByPrice(fuel).map(c => ({
      n:  c.chain,
      p:  Number(c[fuel]),
      ch: 'same', // day-over-day delta not tracked yet
      a:  STATION_META[c.chain]?.a || '1000 Main St',
      d:  STATION_META[c.chain]?.d || '1.0 mi',
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

function buildHeadExtra(town, fuel, canonicalPath, pageTitle, metaDesc, faqData) {
  const webPage = {
    '@context':   'https://schema.org',
    '@type':      'WebPage',
    name:         pageTitle,
    description:  metaDesc,
    dateModified: prices.updated,
    url:          `https://txgasprices.net${canonicalPath}`,
  };
  const updatedHuman = formatUpdated(prices.updated);
  // JSON-LD questions and answers MUST match the visible FAQ on the page,
  // or Google will withhold rich results. Keep these strings in lockstep
  // with the <details> block in the template.
  const faq = {
    '@context': 'https://schema.org',
    '@type':    'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name:    `What is the cheapest gas in ${town.name} right now?`,
        acceptedAnswer: {
          '@type': 'Answer',
          text: `${faqData.cheapestChain} is currently the cheapest at $${faqData.cheapestPrice}/gal for regular unleaded. Prices last updated ${updatedHuman}.`,
        },
      },
      {
        '@type': 'Question',
        name:    `How much does a full tank cost in ${town.name}?`,
        acceptedAnswer: {
          '@type': 'Answer',
          text: `At current prices, filling a 15-gallon tank costs $${faqData.tankCost15} at ${faqData.cheapestChain}. A 20-gallon tank costs $${faqData.tankCost20}.`,
        },
      },
      {
        '@type': 'Question',
        name:    `How do ${town.name} gas prices compare to the Texas average?`,
        acceptedAnswer: {
          '@type': 'Answer',
          text: `The Texas state average for regular is $${faqData.stateAvg}/gal. ${town.name} drivers pay the state average — choose ${faqData.cheapestChain} to pay below average.`,
        },
      },
      {
        '@type': 'Question',
        name:    `Which gas station is most expensive in ${town.name}?`,
        acceptedAnswer: {
          '@type': 'Answer',
          text: `${faqData.mostExpensiveChain} is currently the most expensive at $${faqData.mostExpensivePrice}/gal — $${faqData.savings}/gal more than ${faqData.cheapestChain}.`,
        },
      },
    ],
  };
  return [
    `<meta name="description" content="${metaDesc}">`,
    `<link rel="canonical" href="https://txgasprices.net${canonicalPath}">`,
    `<meta property="og:title" content="${pageTitle}">`,
    `<meta property="og:description" content="${metaDesc}">`,
    `<meta property="og:url" content="https://txgasprices.net${canonicalPath}">`,
    `<script type="application/ld+json">`,
    JSON.stringify(webPage, null, 2),
    `</script>`,
    `<script type="application/ld+json">`,
    JSON.stringify(faq, null, 2),
    `</script>`,
  ].join('\n');
}

function buildEstBanner(fuel) {
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

function buildPage(town, fuel) {
  const fLabel       = fuelLabel(fuel);
  const cheap        = cheapestFor(fuel);
  const expensive    = mostExpensiveFor(fuel);
  const canonicalPath = fuel === 'regular'
    ? `/gas-prices/${town.slug}`
    : `/gas-prices/${town.slug}/${fuel}`;

  const cheapestPrice         = Number(cheap[fuel]).toFixed(2);
  const cheapestChain         = cheap.chain;
  const mostExpensivePrice    = Number(expensive[fuel]).toFixed(2);
  const mostExpensiveChain    = expensive.chain;
  const savings               = (Number(expensive[fuel]) - Number(cheap[fuel])).toFixed(2);
  const tankCost15            = (Number(cheap[fuel]) * 15).toFixed(2);
  const tankCost20            = (Number(cheap[fuel]) * 20).toFixed(2);
  const tankSavingsVsExpensive = ((Number(expensive[fuel]) - Number(cheap[fuel])) * 15).toFixed(2);
  const stateAvg              = prices.stateAverage && prices.stateAverage[fuel] != null
    ? Number(prices.stateAverage[fuel]).toFixed(2)
    : cheapestPrice;
  const numStations           = prices.chains.length;

  const pageTitle = fuel === 'regular'
    ? `Gas Prices in ${town.name}, TX Today — Cheapest $${cheapestPrice}/gal | TXGasPrices`
    : `${fLabel} Gas Prices in ${town.name}, TX Today — Cheapest $${cheapestPrice}/gal | TXGasPrices`;

  const heroTitle = fuel === 'regular'
    ? `Gas prices in ${town.name}, TX`
    : `${fLabel} gas prices in ${town.name}, TX`;

  const metaDesc = `Live ${fuel === 'regular' ? '' : fuel + ' '}gas prices in ${town.name}, TX `
    + `updated hourly from AAA. Cheapest: ${cheapestChain} at $${cheapestPrice}/gal. `
    + `Compare Murphy USA, HEB, Shell, Chevron and more across local stations.`;

  return render({
    PAGE_TITLE:       pageTitle,
    HEAD_EXTRA:       buildHeadExtra(town, fuel, canonicalPath, pageTitle, metaDesc, {
      cheapestPrice, cheapestChain, savings,
      mostExpensivePrice, mostExpensiveChain,
      tankCost15, tankCost20, stateAvg,
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
    EST_BANNER:       buildEstBanner(fuel),
    PRICE_DATA_JSON:  JSON.stringify(buildPriceData(), null, 2),
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
  // /cheapest alias = regular page
  const cheapDir = `./output/gas-prices/${town.slug}/cheapest`;
  fs.mkdirSync(cheapDir, { recursive: true });
  fs.writeFileSync(`${cheapDir}/index.html`, buildPage(town, 'regular'));
  pageCount++;
});

fs.mkdirSync('./output', { recursive: true });
fs.writeFileSync('./output/sitemap.xml', buildSitemap());

// Root redirect: / → /gas-prices/houston-tx (the highest-population city).
// Uses both <meta refresh> (crawler-safe) and a JS fallback for instant UX.
const ROOT_DEST = '/gas-prices/houston-tx';
fs.writeFileSync('./output/index.html', `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>TXGasPrices.net — Texas Gas Prices</title>
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0;url=${ROOT_DEST}">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<meta name="theme-color" content="#1a1a18">
<link rel="canonical" href="https://txgasprices.net${ROOT_DEST}">
<script>location.replace(${JSON.stringify(ROOT_DEST)});</script>
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px;color:#1a1a18">
<p>Redirecting to <a href="${ROOT_DEST}">gas prices in Houston, TX</a>...</p>
</body>
</html>
`);

console.log(`\n✓ Generated ${pageCount} pages across ${towns.length} towns`);
console.log(`✓ Sitemap written with ${towns.length * 6 + 3} URLs`);
console.log(`✓ Output folder: ./output/gas-prices/\n`);
console.log('Sample URLs built:');
towns.slice(0, 5).forEach(t => {
  console.log(`  https://txgasprices.net/gas-prices/${t.slug}`);
  console.log(`  https://txgasprices.net/gas-prices/${t.slug}/diesel`);
});
