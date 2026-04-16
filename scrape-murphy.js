const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

const URL = "https://www.murphyusa.com/";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept":
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function fetchMurphy() {
  console.log(`Requesting ${URL} ...`);
  const res = await axios.get(URL, {
    headers: BROWSER_HEADERS,
    timeout: 20000,
    validateStatus: () => true,
  });

  console.log(`HTTP status: ${res.status}`);
  console.log(`Bytes received: ${res.data ? res.data.length : 0}`);

  if (res.status !== 200) {
    return { ok: false, reason: `HTTP ${res.status}`, html: res.data };
  }

  const html = String(res.data);
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g, " ").trim();

  const priceRegex = /\$?\s?([1-5]\.\d{2,3})\b/g;
  const hits = [];
  let m;
  while ((m = priceRegex.exec(text)) !== null) hits.push(m[1]);

  const bodySnippet = text.slice(0, 400);
  return { ok: true, html, bodySnippet, priceHits: hits.slice(0, 20) };
}

(async () => {
  try {
    const result = await fetchMurphy();

    if (!result.ok) {
      console.log("\nScrape failed.");
      console.log(`Reason: ${result.reason}`);
      fs.writeFileSync("murphy-debug.html", String(result.html || ""));
      console.log("Saved raw response to murphy-debug.html for inspection.");
      return;
    }

    console.log("\n--- First 400 chars of page text ---");
    console.log(result.bodySnippet);
    console.log("\n--- Anything that looks like a price ($1.00-$5.999) ---");
    console.log(
      result.priceHits.length ? result.priceHits.join(", ") : "(none found)"
    );

    fs.writeFileSync("murphy-debug.html", result.html);
    console.log("\nSaved full HTML to murphy-debug.html for inspection.");

    console.log(
      "\nNOTE: This script only flags candidate numbers. It does NOT write " +
        "prices.json unless it can confirm which number is regular/midgrade/" +
        "premium/diesel. Fabricating a price would be worse than no data."
    );
  } catch (err) {
    console.log("\nScrape threw an error:");
    console.log(err.code || err.name || "Error");
    console.log(err.message);
  }
})();
