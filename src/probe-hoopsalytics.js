// Probe Hoopsalytics: figure out the email-only login flow and how the
// advanced-stats page (offense/defense/key-stats views) actually delivers its
// data — separate JSON endpoints per view, or server-rendered tabs that need
// DOM scraping. Dumps everything to data/probe/hoopsalytics/ for inspection.
//
// Usage: node src/probe-hoopsalytics.js
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

const captured = [];
const browser = await chromium.launch();
const context = await browser.newContext({ userAgent: UA });
const page = await context.newPage();

page.on("response", async (res) => {
  const url = res.url();
  if (!/hoopsalytics\.com/i.test(url)) return;
  const ct = (res.headers()["content-type"] || "").toLowerCase();
  if (/\.(png|jpe?g|gif|svg|woff2?|ttf|css|ico|webp|mp4)(\?|$)/i.test(url)) return;
  if (ct.includes("image") || ct.includes("font")) return;
  let body = "";
  try { body = await res.text(); } catch { body = "<unreadable>"; }
  captured.push({ url, status: res.status(), ct, bytes: body.length, body });
});

// ---- step 1: load the login page and inspect the form ---------------------
console.log("### Loading login page …");
await page.goto("https://hoopsalytics.com/login", { waitUntil: "networkidle", timeout: 45000 }).catch(async (e) => {
  console.log(`  direct /login nav warn: ${e.message}; trying the stats URL and following the redirect instead`);
  await page.goto("https://hoopsalytics.com/stats/show-league.php?season_id=19", { waitUntil: "networkidle", timeout: 45000 });
});
await page.waitForTimeout(1500);
writeFileSync(`${OUT}/00-login-page.html`, await page.content());
console.log(`  landed on: ${page.url()}`);

// Inspect every input/button on the page so we know what to fill/click.
const formInfo = await page.evaluate(() => ({
  inputs: [...document.querySelectorAll("input")].map((i) => ({
    type: i.type, name: i.name, id: i.id, placeholder: i.placeholder,
  })),
  buttons: [...document.querySelectorAll("button, input[type=submit]")].map((b) => ({
    text: b.innerText || b.value, id: b.id, type: b.type,
  })),
  forms: [...document.querySelectorAll("form")].map((f) => ({ action: f.action, method: f.method })),
}));
console.log("  form fields:", JSON.stringify(formInfo, null, 2));
writeFileSync(`${OUT}/00-form-info.json`, JSON.stringify(formInfo, null, 2));

// ---- step 2: fill email + submit -------------------------------------------
const emailSelector = 'input[type="email"], input[name*="email" i], input[id*="email" i], input[name*="login" i], input[id*="login" i], input[type="text"]';
try {
  await page.fill(emailSelector, EMAIL, { timeout: 8000 });
  console.log(`  filled email field with ${EMAIL}`);
} catch (e) {
  console.log(`  could not find/fill an email field: ${e.message}`);
}

const submitSelector = 'button[type="submit"], input[type="submit"], button:has-text("Continue"), button:has-text("Log In"), button:has-text("Login"), button:has-text("Sign In")';
try {
  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {}),
    page.click(submitSelector, { timeout: 8000 }),
  ]);
} catch (e) {
  console.log(`  could not find/click a submit button: ${e.message}`);
}
await page.waitForTimeout(2500);
console.log(`  after submit, url: ${page.url()}`);
writeFileSync(`${OUT}/01-after-submit.html`, await page.content());

// If there's a second step (e.g. a password or code field appeared), report it
// instead of guessing further — this is exactly the thing we need a human to
// look at before writing the real collector.
const secondStep = await page.evaluate(() => ({
  inputs: [...document.querySelectorAll("input")].map((i) => ({
    type: i.type, name: i.name, id: i.id, placeholder: i.placeholder,
  })),
  bodyText: document.body.innerText.slice(0, 500),
}));
console.log("  second-step check:", JSON.stringify(secondStep, null, 2));
writeFileSync(`${OUT}/01-second-step.json`, JSON.stringify(secondStep, null, 2));

// ---- step 3: try the stats page --------------------------------------------
console.log("\n### Loading stats page …");
await page.goto("https://hoopsalytics.com/stats/show-league.php?season_id=19", { waitUntil: "networkidle", timeout: 45000 }).catch((e) => {
  console.log(`  nav warning: ${e.message}`);
});
await page.waitForTimeout(3000);
writeFileSync(`${OUT}/02-stats-page.html`, await page.content());
console.log(`  landed on: ${page.url()}`);

const pageInfo = await page.evaluate(() => ({
  tables: [...document.querySelectorAll("table")].map((t) => ({
    id: t.id, className: t.className,
    headers: [...t.querySelectorAll("thead th, tr:first-child th, tr:first-child td")].map((h) => h.innerText.trim()),
    rowCount: t.querySelectorAll("tbody tr, tr").length,
  })),
  tabs: [...document.querySelectorAll('[role="tab"], .nav-tabs a, .tab, a[href*="view"], a[href*="tab"]')].map((t) => ({
    text: t.innerText?.trim(), href: t.getAttribute("href"), id: t.id,
  })),
  bodyPreview: document.body.innerText.slice(0, 300),
}));
console.log("  page info:", JSON.stringify(pageInfo, null, 2));
writeFileSync(`${OUT}/02-stats-page-info.json`, JSON.stringify(pageInfo, null, 2));

await browser.close();

// ---- dump network captures --------------------------------------------------
console.log(`\n=== ${captured.length} hoopsalytics.com responses ===`);
const seen = new Map();
for (const c of captured) { const k = c.url.split("?")[0]; if (!seen.has(k)) seen.set(k, c); }
let i = 0;
for (const [k, c] of seen) {
  i++;
  console.log(`[${i}] ${c.status} ${c.ct} ${c.bytes}b  ${k}`);
  writeFileSync(`${OUT}/resp-${i}.txt`, c.body);
}
console.log(`\nAll captures written to ${OUT}/`);
