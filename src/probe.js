// Validation probe v2: capture ALL non-asset responses, inspect rendered DOM,
// and look for inline hydration data (Next.js __NEXT_DATA__, Nuxt, etc).
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = "https://leagues.teamlinkt.com/shorelinebball";
const PAGES = ["/Standings", "/Scores", "/Statistics"];
const OUT = "data/probe";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
});
const page = await context.newPage();

const captured = [];
page.on("response", async (res) => {
  const url = res.url();
  const ct = (res.headers()["content-type"] || "").toLowerCase();
  // skip obvious static assets
  if (/\.(png|jpg|jpeg|gif|svg|woff2?|ttf|css|ico|webp|mp4)(\?|$)/i.test(url)) return;
  if (ct.includes("image") || ct.includes("font") || ct.includes("css")) return;
  const isDoc = url.includes("teamlinkt.com/shorelinebball");
  if (isDoc) return; // skip the page docs themselves
  let body = "";
  try { body = await res.text(); } catch { body = "<unreadable>"; }
  captured.push({ url, status: res.status(), ct, bytes: body.length, body });
});

for (const path of PAGES) {
  const url = BASE + path;
  console.log(`\n### Loading ${url}`);
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(3500);
  } catch (e) {
    console.log(`  nav warning: ${e.message}`);
  }
  const slug = path.replace(/\W+/g, "_") || "home";

  // dump full rendered HTML
  const html = await page.content();
  writeFileSync(`${OUT}/dom${slug}.html`, html);

  // look for hydration data
  const hydration = await page.evaluate(() => {
    const out = {};
    const next = document.getElementById("__NEXT_DATA__");
    if (next) out.__NEXT_DATA__ = next.textContent.length;
    if (window.__NUXT__) out.__NUXT__ = true;
    if (window.__APOLLO_STATE__) out.__APOLLO_STATE__ = true;
    // any large inline JSON scripts
    out.jsonScripts = [...document.querySelectorAll('script[type="application/json"]')].map(s => s.textContent.length);
    return out;
  });
  console.log(`  hydration:`, JSON.stringify(hydration));

  // does a data table actually have rows?
  const tableInfo = await page.evaluate(() => {
    const tables = [...document.querySelectorAll("table")];
    return tables.map(t => ({ rows: t.querySelectorAll("tr").length, text: t.innerText.slice(0, 120).replace(/\s+/g, " ") }));
  });
  console.log(`  tables:`, JSON.stringify(tableInfo));
}

await browser.close();

console.log(`\n=== ${captured.length} non-asset network responses ===`);
const seen = new Map();
for (const c of captured) { const k = c.url.split("?")[0]; if (!seen.has(k)) seen.set(k, c); }
let i = 0;
for (const [k, c] of seen) {
  i++;
  console.log(`[${i}] ${c.status} ${c.ct} ${c.bytes}b  ${k}`);
  writeFileSync(`${OUT}/resp-${i}.txt`, c.body);
}
console.log(`\nDOM + responses written to ${OUT}/`);
