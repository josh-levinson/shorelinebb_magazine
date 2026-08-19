// Probe #2: now that login + the stats page are understood (see
// probe-hoopsalytics.js), walk every "View" (Offense/Defense/Key Stats/...)
// via the plain GET query param the site itself uses (?season_id=19&view=X)
// and capture #league-table's real header/row structure for each.
//
// Usage: node src/probe-hoopsalytics-views.js
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

process.loadEnvFile?.();
const EMAIL = process.env.HOOPSALYTICS_EMAIL;
if (!EMAIL) {
  console.error("Set HOOPSALYTICS_EMAIL in .env first.");
  process.exit(1);
}

const OUT = "data/probe/hoopsalytics";
mkdirSync(OUT, { recursive: true });

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const VIEWS = ["Offense", "Defense", "Key Stats", "Scouting", "Shooting", "Deluxe Stats", "Shooting (from Sets)"];

const browser = await chromium.launch();
const context = await browser.newContext({ userAgent: UA });
const page = await context.newPage();

// ---- log in (same flow validated in probe-hoopsalytics.js) ----------------
console.log("### Logging in …");
await page.goto("https://hoopsalytics.com/program/login.php", { waitUntil: "networkidle", timeout: 45000 });
await page.fill('input[name="login"]', EMAIL, { timeout: 8000 });
await Promise.all([
  page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {}),
  page.click("#submit-button", { timeout: 8000 }),
]);
await page.waitForTimeout(1500);
console.log(`  logged in, at: ${page.url()}`);

const extractTable = () =>
  page.evaluate(() => {
    const t = document.querySelector("#league-table");
    if (!t) return null;
    const headerRow = t.querySelector("thead tr") || t.querySelector("tr");
    const headers = headerRow
      ? [...headerRow.querySelectorAll("th, td")].map((c) => c.innerText.trim())
      : [];
    const bodyRows = [...t.querySelectorAll("tbody tr")];
    const rows = bodyRows.slice(0, 3).map((tr) => [...tr.querySelectorAll("td, th")].map((c) => c.innerText.trim()));
    return { headers, rowCount: bodyRows.length, sampleRows: rows };
  });

const results = {};
for (const view of VIEWS) {
  const url = `https://hoopsalytics.com/stats/show-league.php?season_id=19&view=${encodeURIComponent(view)}`;
  console.log(`\n### View: ${view}`);
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(2000);
  } catch (e) {
    console.log(`  nav warn: ${e.message}`);
  }
  const info = await extractTable();
  console.log(`  landed: ${page.url()}`);
  console.log(`  table:`, JSON.stringify(info, null, 2));
  results[view] = { url: page.url(), ...info };
  writeFileSync(`${OUT}/view-${view.replace(/\W+/g, "_")}.html`, await page.content());
}

await browser.close();
writeFileSync(`${OUT}/views-summary.json`, JSON.stringify(results, null, 2));
console.log(`\nSummary written to ${OUT}/views-summary.json`);
