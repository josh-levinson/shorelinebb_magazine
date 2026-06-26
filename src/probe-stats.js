// Probe the full player-stats table: switch to the Players tab and capture
// whatever endpoint feeds #stats_table.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
const OUT = "data/probe";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await (await browser.newContext({ userAgent: "Mozilla/5.0 Chrome/120 Safari/537.36" })).newPage();

const hits = [];
page.on("response", async (res) => {
  const url = res.url();
  if (!/teamlinkt\.com\/leagues\//i.test(url)) return;
  let body = ""; try { body = await res.text(); } catch {}
  if (body.length < 20) return;
  hits.push({ url, bytes: body.length, body });
});

await page.goto("https://leagues.teamlinkt.com/shorelinebball/Statistics", { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(2000);

// click the player-stats tab
console.log("clicking player_stats_tab …");
try {
  await page.click("#player_stats_tab", { timeout: 8000 });
  await page.waitForTimeout(4000);
} catch (e) { console.log("  click warn:", e.message); }

// also try selecting first stat group if a select2 is present
const rows = await page.evaluate(() => {
  const t = document.querySelector("#stats_table");
  return t ? { rows: t.querySelectorAll("tr").length, text: t.innerText.slice(0, 300).replace(/\s+/g, " ") } : null;
});
console.log("stats_table:", JSON.stringify(rows));

await browser.close();
console.log(`\n=== ${hits.length} league responses ===`);
const seen = new Map();
for (const h of hits) { const k = h.url.split("?")[0]; if (!seen.has(k)) seen.set(k, h); }
let i = 0;
for (const [k, h] of seen) {
  i++;
  console.log(`[${i}] ${h.bytes}b  ${k}`);
  console.log(`     ${h.body.slice(0, 180).replace(/\s+/g, " ")}`);
  writeFileSync(`${OUT}/stats-resp-${i}.txt`, h.body);
}
