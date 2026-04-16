/*
 * scheduler.js
 *
 * Runs the full price pipeline on a schedule:
 *   1. node fetch-prices.js  (AAA + EIA + GasBuddy stub → prices.json)
 *   2. If the fuel prices actually changed, node generate.js (rebuild pages)
 *
 * Schedule: top of every hour (e.g. 1:00, 2:00, 3:00 ...).
 * Also runs once immediately on startup so you don't have to wait up to an hour.
 *
 * Leave this running in a terminal:    node scheduler.js
 * On a server, wrap it with pm2 / systemd / Windows Task Scheduler so it
 * restarts on reboot.
 */

const cron = require("node-cron");
const { spawn } = require("child_process");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const PRICES_FILE = path.join(__dirname, "prices.json");

function ts() {
  return new Date().toISOString().replace("T", " ").replace("Z", "Z");
}

function log(...args) {
  console.log(`[${ts()}]`, ...args);
}

// Hash only the price-bearing fields, so an identical fetch does NOT trigger
// a rebuild just because the `updated` timestamp moved forward.
function pricesSignature() {
  if (!fs.existsSync(PRICES_FILE)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(PRICES_FILE, "utf8"));
    const core = {
      stateAverage: j.stateAverage || null,
      chains: (j.chains || []).map((c) => ({
        chain: c.chain,
        priceMode: c.priceMode,
        regular: c.regular,
        midgrade: c.midgrade,
        premium: c.premium,
        diesel: c.diesel,
      })),
    };
    return crypto
      .createHash("sha256")
      .update(JSON.stringify(core))
      .digest("hex");
  } catch (e) {
    log("prices.json unreadable:", e.message);
    return null;
  }
}

function runNode(script) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.execPath, [script], {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      resolve({
        code,
        stdout,
        stderr,
        ms: Date.now() - start,
      });
    });
  });
}

async function tick(reason) {
  log(`── run start (${reason}) ──`);
  const before = pricesSignature();

  const fetchRes = await runNode("fetch-prices.js");
  if (fetchRes.code !== 0) {
    log(`fetch-prices.js FAILED (exit ${fetchRes.code}) in ${fetchRes.ms}ms`);
    if (fetchRes.stderr.trim()) log("stderr:", fetchRes.stderr.trim());
    log("skipping rebuild — prices.json may be stale but was not overwritten");
    return;
  }
  log(`fetch-prices.js OK in ${fetchRes.ms}ms`);

  const after = pricesSignature();
  if (after && before && after === before) {
    log("prices unchanged — skipping generate.js");
    return;
  }

  const genRes = await runNode("generate.js");
  if (genRes.code !== 0) {
    log(`generate.js FAILED (exit ${genRes.code}) in ${genRes.ms}ms`);
    if (genRes.stderr.trim()) log("stderr:", genRes.stderr.trim());
    return;
  }
  const summary = genRes.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("✓"))
    .join(" | ");
  log(`generate.js OK in ${genRes.ms}ms — ${summary || "pages rebuilt"}`);
}

// ── main ──────────────────────────────────────────────────────────
log("scheduler started — will run at the top of every hour");
log("press Ctrl+C to stop");

// "0 * * * *" = at minute 0 of every hour. node-cron treats this as local time.
cron.schedule("0 * * * *", () => {
  tick("hourly cron").catch((e) => log("tick threw:", e.message));
});

// Kick off one run right now so the first fetch doesn't wait for the next hour.
tick("startup").catch((e) => log("startup tick threw:", e.message));
