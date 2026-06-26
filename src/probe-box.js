// Probe a single game's Summary page to find the box-score data source.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const EVENT_URL = "https://leagues.teamlinkt.com/Leagues/event/10372/3717976";
const OUT = "data/probe";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await (await browser.newContext({ userAgent: "Mozilla/5.0 Chrome/120 Safari/537.36" })).newPage();

const hits = [];
page.on("response", async (res) => {
  const url = res.url();
  if (/\.(png|jpg|jpeg|gif|svg|woff2?|ttf|css|ico|webp|mp4|js)(\?|$)/i.test(url)) return;
  const ct = (res.headers()["content-type"] || "").toLowerCase();
  if (ct.includes("image") || ct.includes("javascript") || ct.includes("css")) return;
  let body = ""; try { body = await res.text(); } catch {}
  if (body.length < 20) return;
  hits.push({ url, status: res.status(), ct, bytes: body.length, body });
});

await page.goto(EVENT_URL, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(3000);

writeFileSync(`${OUT}/event-dom.html`, await page.content());
const tables = await page.evaluate(() =>
  [...document.querySelectorAll("table")].map(t => ({ rows: t.querySelectorAll("tr").length, head: t.innerText.slice(0, 200).replace(/\s+/g, " ") }))
);
console.log("TABLES ON EVENT PAGE:", JSON.stringify(tables, null, 2));

await browser.close();
console.log(`\n=== ${hits.length} data responses ===`);
let i = 0;
for (const h of hits) {
  i++;
  console.log(`[${i}] ${h.status} ${h.ct} ${h.bytes}b  ${h.url}`);
  writeFileSync(`${OUT}/event-resp-${i}.txt`, h.body);
}
