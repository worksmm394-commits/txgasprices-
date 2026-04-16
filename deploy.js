/*
 * deploy.js
 *
 * One-shot: rebuild static pages from the latest prices.json and push to
 * Cloudflare Pages. Use any time you want to ship an update manually:
 *
 *   node deploy.js
 *
 * Chain of commands:
 *   1. node generate.js                             (rebuild ./output)
 *   2. npx wrangler pages deploy output             (push to CF Pages)
 *      --project-name=txgasprices
 *
 * Both children stream their output straight to this terminal (stdio
 * inherit). Exits with the first non-zero code it sees.
 */

const { spawn } = require("child_process");
const fs        = require("fs");
const path      = require("path");

const PROJECT = "txgasprices";

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd:   __dirname,
      stdio: "inherit",
      shell: true, // required so `npx` resolves correctly on Windows
    });
    child.on("close", resolve);
  });
}

(async () => {
  // 1. rebuild
  console.log("\n─── Step 1/2: regenerating static pages ───");
  const genCode = await run("node", ["generate.js"]);
  if (genCode !== 0) {
    console.error(`\n✗ generate.js failed (exit ${genCode}). Aborting deploy.`);
    process.exit(genCode);
  }

  // sanity-check output folder exists and is non-empty
  const outDir = path.join(__dirname, "output");
  if (!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0) {
    console.error("\n✗ ./output is empty after generate.js — nothing to deploy.");
    process.exit(1);
  }

  // 2. deploy
  console.log("\n─── Step 2/2: deploying to Cloudflare Pages ───");
  const depCode = await run("npx", [
    "wrangler",
    "pages",
    "deploy",
    "output",
    `--project-name=${PROJECT}`,
  ]);
  if (depCode !== 0) {
    console.error(`\n✗ wrangler deploy failed (exit ${depCode}).`);
    process.exit(depCode);
  }

  console.log(`\n✓ Deploy complete. Production alias: https://${PROJECT}.pages.dev`);
})();
