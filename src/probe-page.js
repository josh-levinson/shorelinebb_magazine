// Inspect the player-stats table pagination controls.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await (await browser.newContext({ userAgent: "Mozilla/5.0 Chrome/120 Safari/537.36" })).newPage();
await page.goto("https://leagues.teamlinkt.com/shorelinebball/Statistics", { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(1500);
await page.click("#player_stats_tab").catch(() => {});
await page.waitForTimeout(3000);

const info = await page.evaluate(() => {
  const grab = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return {
      tag: el.tagName, text: el.innerText.slice(0, 60).replace(/\s+/g, " "),
      disabled: el.disabled || el.classList.contains("disabled") || el.getAttribute("disabled") != null,
      cls: el.className, html: el.outerHTML.slice(0, 160),
    };
  };
  const lenSel = document.querySelector('select[name="stats_table_length"], #stats_table_length, select[id*="length"]');
  return {
    rows: document.querySelectorAll("#stats_table tbody tr").length,
    next: grab("#stats_next_btn"),
    prev: grab("#stats_prev_btn"),
    lengthSelect: lenSel ? { id: lenSel.id, name: lenSel.name, options: [...lenSel.options].map(o => o.value) } : null,
    pageInfo: grab("#stats_col_div"),
    // any element mentioning "of" / page counts
    infoText: [...document.querySelectorAll("[id*='stats']")].map(e => e.id + ":" + e.innerText.slice(0, 40).replace(/\s+/g, " ")).filter(s => s.length > 10).slice(0, 20),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
