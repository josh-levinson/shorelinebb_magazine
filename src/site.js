// Static-site builder: turns the weekly markdown in summaries/ into a small
// magazine. Each week is an "issue": the AI article (summaries/<date>-article.md)
// is the feature column, and the deterministic summary (summaries/<date>.md) is
// reproduced as "The Record" (box scores, standings, stat leaders).
//
// Output is written to dist/ as plain static HTML + one stylesheet — ready to
// drop on GitHub Pages. Links are relative so it works under a project path
// like /shorelinebb/.
//
// Usage:  node src/site.js
import { mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const summariesDir = join(root, "summaries");
const distDir = join(root, "dist");

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

const SITE_TITLE = "The Shoreline Weekly";
const SITE_TAGLINE = "Shoreline Men's League Basketball";

// GoatCounter (jlevnhv.goatcounter.com) — page-view counts for the published
// site. Goes in the <head> of every generated page.
const ANALYTICS = `<script data-goatcounter="https://jlevnhv.goatcounter.com/count"
        async src="//gc.zgo.at/count.js"></script>`;

const fmtDate = (s) =>
  new Date(s + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

// ---- gather issues ---------------------------------------------------------
// An issue exists for any date that has an article and/or a summary file.
function loadIssues() {
  const files = existsSync(summariesDir) ? readdirSync(summariesDir) : [];
  const dates = new Set();
  for (const f of files) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})(?:-article)?\.md$/);
    if (m) dates.add(m[1]);
  }

  const issues = [];
  for (const date of [...dates].sort()) {
    const articlePath = join(summariesDir, `${date}-article.md`);
    const summaryPath = join(summariesDir, `${date}.md`);
    const article = existsSync(articlePath) ? readFileSync(articlePath, "utf8") : null;
    const summary = existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : null;

    // Prefer the article for the cover; fall back to the deterministic summary.
    const source = article || summary || "";
    const { title, dek, body } = splitHead(source);

    issues.push({
      date,
      slug: `issues/${date}.html`,
      title: title || `Week of ${fmtDate(date)}`,
      dek,
      articleBody: article ? body : null,
      // The Record: deterministic summary with its redundant H1 stripped.
      recordBody: summary ? splitHead(summary).body : null,
      // If there's no article, the summary already serves as the feature.
      featureBody: article ? body : (summary ? splitHead(summary).body : ""),
    });
  }
  return issues.reverse(); // newest first
}

// Split markdown into its leading H1 (title), the first paragraph (dek), and
// the remaining body (everything after the title).
function splitHead(markdown) {
  const lines = markdown.split("\n");
  let title = "";
  let i = 0;
  // skip leading blanks, capture first H1
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i < lines.length && /^#\s+/.test(lines[i])) {
    title = lines[i].replace(/^#\s+/, "").trim();
    i++;
  }
  const body = lines.slice(i).join("\n").trim();

  // first non-empty, non-blockquote paragraph → dek
  let dek = "";
  for (const para of body.split(/\n{2,}/)) {
    const t = para.trim();
    if (t && !t.startsWith(">") && !t.startsWith("#")) {
      dek = stripMd(t);
      break;
    }
  }
  return { title, dek, body };
}

const stripMd = (s) =>
  s.replace(/\*\*?|__?|`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();

// ---- draft board -----------------------------------------------------------
// The draft board is a hand-built, self-contained HTML fragment (its own
// <title>/<style>/<script>, data embedded inline) saved as
// summaries/<date>-draft-board.html whenever `npm run draft` output gets
// turned into a page. Publish the newest one, if any, as dist/draft.html.
//
// The board is generated in two steps (`draft` writes the JSON, `draft:page`
// renders it to HTML), so a board can lag its own data if the second step is
// skipped. Publishing the newest board unconditionally makes that silent: the
// page rebuilds with a fresh timestamp and stale numbers. Compare stamps and
// refuse instead, naming the command that closes the gap.
function loadLatestDraftBoard() {
  const files = existsSync(summariesDir) ? readdirSync(summariesDir) : [];
  const newestStamp = (re) =>
    files.reduce((best, f) => {
      const m = f.match(re);
      return m && (!best || m[1] > best) ? m[1] : best;
    }, null);

  const boardStamp = newestStamp(/^(\d{4}-\d{2}-\d{2})-draft-board\.html$/);
  const jsonStamp = newestStamp(/^(\d{4}-\d{2}-\d{2})-draft\.json$/);

  if (jsonStamp && (!boardStamp || jsonStamp > boardStamp)) {
    const had = boardStamp ? `newest board is ${boardStamp}` : "no board has been generated";
    throw new Error(
      `Draft board is stale: summaries/${jsonStamp}-draft.json exists but ${had}.\n`
      + `Run \`npm run draft:page\` (or \`npm run publish\` for the whole chain) before building the site.`,
    );
  }
  if (!boardStamp) return null;
  return {
    date: boardStamp,
    fragment: readFileSync(join(summariesDir, `${boardStamp}-draft-board.html`), "utf8"),
  };
}

function renderDraftPage(draft) {
  // Give the fragment a way back to the magazine; its own masthead has no nav.
  const backLink = `<p style="margin:14px 0 0;font-size:12px;letter-spacing:.08em;`
    + `text-transform:uppercase"><a href="./index.html" `
    + `style="color:var(--ink-3);text-decoration:none">&larr; The Shoreline Weekly</a></p>`;
  const content = draft.fragment.replace(
    /<div class="wrap">/,
    `<div class="wrap">\n  ${backLink}`,
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${ANALYTICS}
</head>
<body>
${content}
</body>
</html>
`;
}

// ---- HTML rendering --------------------------------------------------------
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function page({ relCss, relHome, relDraft, bodyClass, content }) {
  const nav = relDraft
    ? `\n  <nav class="masthead-nav"><a href="${relDraft}">Draft Board</a></nav>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(SITE_TITLE)}</title>
${ANALYTICS}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,700;0,900;1,500&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&family=Oswald:wght@500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${relCss}">
</head>
<body class="${bodyClass}">
<header class="masthead">
  <a class="masthead-link" href="${relHome}">
    <div class="masthead-title">${esc(SITE_TITLE)}</div>
    <div class="masthead-tagline">${esc(SITE_TAGLINE)}</div>
  </a>${nav}
</header>
<main>
${content}
</main>
<footer class="site-footer">
  <div>${esc(SITE_TITLE)}</div>
  <div class="muted">Recaps written from real box-score data. Stats via Hoopsalytics.</div>
</footer>
</body>
</html>
`;
}

function renderIssue(issue, hasDraft) {
  const feature = md.render(issue.featureBody || "");
  const record = issue.articleBody && issue.recordBody
    ? `<section class="record">
  <div class="record-rule"><span>The Record</span></div>
  ${md.render(issue.recordBody)}
</section>`
    : "";

  const content = `<article class="issue">
  <p class="dateline">Issue · ${esc(fmtDate(issue.date))}</p>
  <h1 class="headline">${esc(issue.title)}</h1>
  ${issue.dek ? `<p class="dek">${esc(issue.dek)}</p>` : ""}
  <div class="byline">The Shoreline Weekly</div>
  <div class="feature prose">${feature}</div>
  ${record}
  <p class="back"><a href="../index.html">← All issues</a></p>
</article>`;

  return page({
    relCss: "../style.css", relHome: "../index.html",
    relDraft: hasDraft ? "../draft.html" : null,
    bodyClass: "issue-page", content,
  });
}

function renderIndex(issues, hasDraft) {
  if (issues.length === 0) {
    return page({
      relCss: "./style.css", relHome: "./index.html",
      relDraft: hasDraft ? "./draft.html" : null,
      bodyClass: "cover",
      content: `<p class="empty">No issues yet. Run <code>npm run weekly</code> to generate one.</p>`,
    });
  }

  const [latest, ...rest] = issues;
  const lead = `<a class="lead" href="${latest.slug}">
  <p class="dateline">Latest Issue · ${esc(fmtDate(latest.date))}</p>
  <h1 class="lead-headline">${esc(latest.title)}</h1>
  ${latest.dek ? `<p class="lead-dek">${esc(latest.dek)}</p>` : ""}
  <span class="read-link">Read the issue →</span>
</a>`;

  const archive = rest.length
    ? `<section class="archive">
  <div class="record-rule"><span>From the Archive</span></div>
  <ul class="archive-list">
  ${rest.map((it) => `<li>
    <a href="${it.slug}">
      <span class="archive-date">${esc(fmtDate(it.date))}</span>
      <span class="archive-title">${esc(it.title)}</span>
    </a>
  </li>`).join("\n  ")}
  </ul>
</section>`
    : "";

  return page({
    relCss: "./style.css", relHome: "./index.html",
    relDraft: hasDraft ? "./draft.html" : null,
    bodyClass: "cover",
    content: `${lead}\n${archive}`,
  });
}

// ---- build -----------------------------------------------------------------
const issues = loadIssues();
const draft = loadLatestDraftBoard();

mkdirSync(join(distDir, "issues"), { recursive: true });
writeFileSync(join(distDir, "index.html"), renderIndex(issues, !!draft));
for (const issue of issues) {
  writeFileSync(join(distDir, issue.slug), renderIssue(issue, !!draft));
}
if (draft) writeFileSync(join(distDir, "draft.html"), renderDraftPage(draft));
copyFileSync(join(root, "src", "magazine.css"), join(distDir, "style.css"));
// Tell Pages not to run the output through Jekyll.
writeFileSync(join(distDir, ".nojekyll"), "");

console.log(`Built ${issues.length} issue(s) → dist/`);
for (const it of issues) console.log(`  ${it.date}  ${it.title}`);
if (draft) console.log(`Draft board (${draft.date}) → dist/draft.html`);
