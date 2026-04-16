/*
 * fetch-prices.js
 *
 * Pulls Texas gas-price averages from two free public sources:
 *   1. AAA  (gasprices.aaa.com)  - scraped from the Texas page HTML
 *   2. EIA  (api.eia.gov v2)     - weekly retail gasoline, Texas series
 *
 * Writes results to prices.json in the shape generate.js expects.
 *
 * EIA requires a free API key. Get one in 30 seconds at:
 *   https://www.eia.gov/opendata/register.php
 * Then set it before running:
 *   Windows PowerShell:  $env:EIA_API_KEY="your-key-here"
 *   Windows cmd.exe:     set EIA_API_KEY=your-key-here
 *   Git Bash / WSL:      export EIA_API_KEY=your-key-here
 *
 * The script still works without an EIA key - it will just skip that source.
 */

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

const AAA_URL = "https://gasprices.aaa.com/?state=TX";
const EIA_KEY = process.env.EIA_API_KEY || "";
const GASBUDDY_KEY = process.env.GASBUDDY_API_KEY || "";

// Per-chain offsets vs. the Texas state average, in dollars.
// These are rough estimates based on typical Texas retail patterns
// (Murphy/Buc-ee's/HEB cheaper than average, Shell/Chevron above).
// Used only until a real per-station source (e.g. GasBuddy) is wired in.
const CHAIN_OFFSETS = {
  "Murphy USA": { regular: -0.12, midgrade: -0.12, premium: -0.12, diesel: -0.10 },
  "Buc-ee's":   { regular: -0.08, midgrade: -0.08, premium: -0.08, diesel: -0.07 },
  "HEB Gas":    { regular: -0.05, midgrade: -0.05, premium: -0.05, diesel: -0.04 },
  "Shell":      { regular: +0.07, midgrade: +0.07, premium: +0.07, diesel: +0.05 },
  "Chevron":    { regular: +0.10, midgrade: +0.10, premium: +0.10, diesel: +0.07 },
};

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// -------- AAA (scrape the Texas state page) --------------------------------
async function fetchAAA() {
  console.log(`[AAA] GET ${AAA_URL}`);
  const res = await axios.get(AAA_URL, {
    headers: BROWSER_HEADERS,
    timeout: 20000,
    validateStatus: () => true,
  });
  console.log(`[AAA] HTTP ${res.status}, ${String(res.data).length} bytes`);

  if (res.status !== 200) {
    fs.writeFileSync("aaa-debug.html", String(res.data || ""));
    throw new Error(`AAA returned HTTP ${res.status} (see aaa-debug.html)`);
  }

  const $ = cheerio.load(res.data);

  // AAA's state page: grades are column headers (Regular, Mid-Grade, Premium,
  // Diesel) and the row we want starts with "Current Avg.". Find that row and
  // read the four price cells in order.
  const grades = { regular: null, midgrade: null, premium: null, diesel: null };
  const keys = ["regular", "midgrade", "premium", "diesel"];

  $("table tr").each((_, tr) => {
    const cells = $(tr).find("td");
    if (cells.length < 5) return;
    const label = $(cells[0]).text().trim().toLowerCase();
    if (!label.startsWith("current avg")) return;
    for (let i = 0; i < 4; i++) {
      const priceText = $(cells[i + 1]).text().trim().replace(/[^\d.]/g, "");
      const price = parseFloat(priceText);
      if (!isNaN(price) && price > 1 && price < 10) grades[keys[i]] = price;
    }
  });

  // Fallback: if table parsing found nothing, try a looser regex over the body.
  if (Object.values(grades).every((v) => v === null)) {
    fs.writeFileSync("aaa-debug.html", res.data);
    throw new Error("AAA page loaded but no prices parsed (see aaa-debug.html)");
  }

  console.log("[AAA] parsed:", grades);
  return grades;
}

// -------- EIA (v2 API, weekly retail gasoline, Texas) ----------------------
// EIA "duoarea" code STX = State of Texas.
// Products: EPMR = regular, EPMM = midgrade, EPMP = premium, EPD2D = diesel.
async function fetchEIA() {
  if (!EIA_KEY) {
    console.log("[EIA] skipped - no EIA_API_KEY environment variable set.");
    return null;
  }
  const products = {
    regular: "EPMR",
    midgrade: "EPMM",
    premium: "EPMP",
    diesel: "EPD2D",
  };
  const out = {};
  for (const [key, product] of Object.entries(products)) {
    const url =
      `https://api.eia.gov/v2/petroleum/pri/gnd/data/` +
      `?api_key=${EIA_KEY}` +
      `&frequency=weekly` +
      `&data[0]=value` +
      `&facets[duoarea][]=STX` +
      `&facets[product][]=${product}` +
      `&sort[0][column]=period&sort[0][direction]=desc` +
      `&length=1`;
    console.log(`[EIA] GET product=${product}`);
    const res = await axios.get(url, { timeout: 20000, validateStatus: () => true });
    if (res.status !== 200) {
      console.log(`[EIA] ${product} returned HTTP ${res.status} - skipping`);
      continue;
    }
    const row = res.data?.response?.data?.[0];
    if (row && typeof row.value === "number") {
      out[key] = { price: row.value, period: row.period };
    } else {
      console.log(`[EIA] ${product} returned no data rows`);
    }
  }
  console.log("[EIA] parsed:", out);
  return Object.keys(out).length ? out : null;
}

// -------- GasBuddy (stub) --------------------------------------------------
// GasBuddy does not publish a free public API. Access is via their business
// program (Fleet / Station Finder API). When a key is available, set:
//   GASBUDDY_API_KEY=your-key-here
// This function is a stub: it returns null when no key is set. The request
// URL, headers, and response shape below are placeholders based on typical
// partner-API conventions - verify against real docs when onboarding.
async function fetchGasBuddy() {
  if (!GASBUDDY_KEY) {
    console.log("[GasBuddy] skipped - no GASBUDDY_API_KEY set (stub).");
    return null;
  }
  try {
    const url = "https://api.gasbuddy.com/v3/stations/search";
    console.log(`[GasBuddy] GET ${url} (state=TX)`);
    const res = await axios.get(url, {
      params: { state: "TX", fuel: "all" },
      headers: { "Authorization": `Bearer ${GASBUDDY_KEY}` },
      timeout: 20000,
      validateStatus: () => true,
    });
    if (res.status !== 200) {
      console.log(`[GasBuddy] HTTP ${res.status} - skipping`);
      return null;
    }
    // Expected (placeholder) shape: { stations: [{ brand, prices: { regular, midgrade, premium, diesel } }] }
    // Aggregate to per-chain medians once the real shape is confirmed.
    console.log("[GasBuddy] received response - parsing not yet implemented.");
    return null;
  } catch (e) {
    console.log("[GasBuddy] FAILED:", e.message);
    return null;
  }
}

// -------- main -------------------------------------------------------------
function round3(n) {
  return n == null ? null : Math.round(n * 1000) / 1000;
}

function applyOffsets(avg, offsets) {
  return {
    regular:  avg.regular  != null ? round3(avg.regular  + offsets.regular)  : null,
    midgrade: avg.midgrade != null ? round3(avg.midgrade + offsets.midgrade) : null,
    premium:  avg.premium  != null ? round3(avg.premium  + offsets.premium)  : null,
    diesel:   avg.diesel   != null ? round3(avg.diesel   + offsets.diesel)   : null,
  };
}

(async () => {
  let aaa = null;
  let eia = null;
  let gb = null;

  try { aaa = await fetchAAA(); }
  catch (e) { console.log("[AAA] FAILED:", e.message); }

  try { eia = await fetchEIA(); }
  catch (e) { console.log("[EIA] FAILED:", e.message); }

  try { gb = await fetchGasBuddy(); }
  catch (e) { console.log("[GasBuddy] FAILED:", e.message); }

  if (!aaa && !eia && !gb) {
    console.log("\nAll sources failed. prices.json NOT overwritten.");
    process.exit(1);
  }

  // Prefer AAA (today's average); fall back to EIA (last week) per grade.
  const avg = {
    regular:  aaa?.regular  ?? eia?.regular?.price  ?? null,
    midgrade: aaa?.midgrade ?? eia?.midgrade?.price ?? null,
    premium:  aaa?.premium  ?? eia?.premium?.price  ?? null,
    diesel:   aaa?.diesel   ?? eia?.diesel?.price   ?? null,
  };

  // Build per-chain estimates by applying offsets to the state average.
  // If GasBuddy returns real per-chain data later, it overrides these.
  const chains = Object.entries(CHAIN_OFFSETS).map(([name, offsets]) => {
    const real = gb?.[name];
    const est = applyOffsets(avg, offsets);
    return {
      chain: name,
      priceMode: real ? "live" : "estimated",
      regular:  real?.regular  ?? est.regular,
      midgrade: real?.midgrade ?? est.midgrade,
      premium:  real?.premium  ?? est.premium,
      diesel:   real?.diesel   ?? est.diesel,
    };
  });

  // Preserve the Apify `cities` block and its timestamp across hourly runs —
  // fetch-apify-prices.js populates those less frequently (daily) and we
  // don't want the hourly state-average refresh to wipe them.
  let prior = {};
  if (fs.existsSync("prices.json")) {
    try { prior = JSON.parse(fs.readFileSync("prices.json", "utf8")); }
    catch { prior = {}; }
  }

  const payload = {
    updated: new Date().toISOString(),
    stateAverage: { ...avg },
    source: {
      ...(prior.source || {}),
      aaa: aaa ? "gasprices.aaa.com (TX state avg, today)" : null,
      eia: eia ? "api.eia.gov v2 (TX weekly retail)" : null,
      gasbuddy: gb ? "api.gasbuddy.com (per-chain live)" : null,
    },
    note:
      "Per-chain prices are ESTIMATES derived from the Texas state average " +
      "plus fixed per-chain offsets (see CHAIN_OFFSETS in fetch-prices.js). " +
      "Set GASBUDDY_API_KEY to replace estimates with live per-station data.",
    chains,
    ...(prior.cities       ? { cities: prior.cities }             : {}),
    ...(prior.apifyUpdated ? { apifyUpdated: prior.apifyUpdated } : {}),
  };

  fs.writeFileSync("prices.json", JSON.stringify(payload, null, 2));
  console.log("\nWrote prices.json:");
  console.log(JSON.stringify(payload, null, 2));
})();
