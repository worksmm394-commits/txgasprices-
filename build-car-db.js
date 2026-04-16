/*
 * build-car-db.js
 *
 * One-time build: walks fueleconomy.gov's public menu API for every
 * (year, make) pair in 1984..2025 and records each (make, model, years[])
 * combination. Output is a single JSON file the front-end can load to
 * populate the Make / Model / Year dropdowns instantly without hitting
 * the live API.
 *
 * Endpoints used (all return {menuItem: [{text, value}, ...] | {text, value}}):
 *   /vehicle/menu/make?year=Y
 *   /vehicle/menu/model?year=Y&make=M
 *
 * MPG lookup is still done live by the front-end at year-selection time;
 * that's a single fast call and we don't cache it here.
 */

const axios = require('axios');
const fs    = require('fs');

const FEGOV       = 'https://www.fueleconomy.gov/ws/rest';
const START_YEAR  = 1984;
const END_YEAR    = 2025;
const CONCURRENCY = 6;
const RETRIES     = 3;
const OUT_PATH    = './car-db.json';

function toArr(v) {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

async function feFetch(url, attempt = 0) {
  try {
    const r = await axios.get(url, {
      headers: { Accept: 'application/json' },
      timeout: 20000,
    });
    return r.data;
  } catch (e) {
    if (attempt >= RETRIES) throw e;
    await new Promise(res => setTimeout(res, 600 * (attempt + 1)));
    return feFetch(url, attempt + 1);
  }
}

async function runPool(tasks, concurrency) {
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < tasks.length) {
      const i = idx++;
      await tasks[i]();
    }
  });
  await Promise.all(workers);
}

(async () => {
  const startedAt = Date.now();
  const years = [];
  for (let y = START_YEAR; y <= END_YEAR; y++) years.push(y);

  console.log(`Fetching makes for ${years.length} years (${START_YEAR}..${END_YEAR})...`);
  const makesByYear = {};
  await runPool(
    years.map(y => async () => {
      try {
        const d = await feFetch(`${FEGOV}/vehicle/menu/make?year=${y}`);
        makesByYear[y] = toArr(d.menuItem).map(m => m.value).filter(Boolean);
      } catch (e) {
        console.warn(`  ! year ${y} makes failed: ${e.message}`);
        makesByYear[y] = [];
      }
    }),
    CONCURRENCY
  );

  const allMakesSet = new Set();
  for (const y of years) makesByYear[y].forEach(m => allMakesSet.add(m));
  const allMakes = [...allMakesSet].sort((a, b) => a.localeCompare(b));
  console.log(`  ${allMakes.length} unique makes across all years`);

  const modelTasks = [];
  for (const y of years) {
    for (const make of makesByYear[y]) {
      modelTasks.push({ year: y, make });
    }
  }
  console.log(`Fetching models for ${modelTasks.length} (year, make) pairs...`);

  // makeModelYears[make][model] = Set<year>
  const makeModelYears = {};
  for (const m of allMakes) makeModelYears[m] = {};

  let done = 0;
  let failed = 0;
  await runPool(
    modelTasks.map(({ year, make }) => async () => {
      try {
        const url = `${FEGOV}/vehicle/menu/model?year=${year}&make=${encodeURIComponent(make)}`;
        const d = await feFetch(url);
        const models = toArr(d.menuItem).map(m => m.value).filter(Boolean);
        for (const model of models) {
          if (!makeModelYears[make][model]) makeModelYears[make][model] = new Set();
          makeModelYears[make][model].add(year);
        }
      } catch (e) {
        failed++;
      }
      done++;
      if (done % 100 === 0 || done === modelTasks.length) {
        const pct = ((done / modelTasks.length) * 100).toFixed(1);
        process.stdout.write(`  ${done}/${modelTasks.length} (${pct}%) — ${failed} failed\r`);
      }
    }),
    CONCURRENCY
  );
  process.stdout.write('\n');

  // Materialize: Sets → sorted arrays. Drop makes with no models at all.
  const models = {};
  let makeCount = 0;
  let modelCount = 0;
  for (const make of allMakes) {
    const entries = makeModelYears[make];
    const modelNames = Object.keys(entries).sort((a, b) => a.localeCompare(b));
    if (!modelNames.length) continue;
    models[make] = {};
    for (const m of modelNames) {
      models[make][m] = [...entries[m]].sort((a, b) => a - b);
      modelCount++;
    }
    makeCount++;
  }

  const out = {
    generated: new Date().toISOString(),
    yearRange: [START_YEAR, END_YEAR],
    makeCount,
    modelCount,
    models,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(out));
  const sizeKb = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`\n✓ Wrote ${OUT_PATH} (${sizeKb} KB) in ${elapsed}s`);
  console.log(`  Makes:  ${makeCount}`);
  console.log(`  Models: ${modelCount}`);
  if (failed) console.log(`  ! ${failed} model-list fetches failed (retried ${RETRIES}x each)`);
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
