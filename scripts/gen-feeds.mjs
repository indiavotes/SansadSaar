#!/usr/bin/env node
// scripts/gen-feeds.mjs
//
// Generate one RSS 2.0 feed per corpus ("section") into feeds/<id>.xml,
// plus a feeds/index.html listing. Runs daily (and on manual dispatch)
// via .github/workflows/feeds.yml; the committed XML is served statically
// at https://sansadsaar.naklitechie.com/feeds/<id>.xml.
//
// Source of truth is the live data mirror — the same JSON the browser app
// fetches. We pull each corpus's primary file(s), take the most-recent N
// items by date, and emit metadata-only items (title, date, link to the
// upstream document, corpus-specific categories). No full text.
//
// Data layouts diverge per corpus exactly as the app accepts them:
//   • flat reports.json (drsc/cag/fc/lc)
//   • sharded index-meta.json + index-NN.json (bills)
//   • sharded reports-meta.json + reports-*.json (debates/questions/gazettes)
// so each corpus has a small loader + field map below. Field names were
// read off the live mirror on 2026-09-11; they mirror app/corpora/*/index.js.

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'feeds');

const APP = 'https://sansadsaar.naklitechie.com';
const DATA = 'https://sansadsaar-data.naklitechie.com/';
const PROC = 'https://sansadsaar-proceedings.naklitechie.com/';
const GAZ  = 'https://sansadsaar-gazettes.naklitechie.com/';

const ITEMS_PER_FEED = 50;

// ── HTTP ──────────────────────────────────────────────────────────
async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'sansadsaar-feeds' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// ── Date parsing — the six formats seen across corpora ────────────
const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
// Returns a Date or null. Handles:
//   "2026-06-05" / "2026-03-13 00:00:00.0"  (ISO, optional time)
//   "07-Aug-2026"                            (drsc/fc)
//   "Wed 02 Sep, 2026"                       (cag)
//   "02/04/2026"                             (debates, dd/mm/yyyy)
//   "20.07.2026"                             (questions, dd.mm.yyyy)
function parseDate(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)))            // ISO
    return mk(+m[1], +m[2] - 1, +m[3]);
  if ((m = s.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/)))      // 07-Aug-2026
    return mk(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  if ((m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)))          // 02/04/2026 dd/mm/yyyy
    return mk(+m[3], +m[2] - 1, +m[1]);
  if ((m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/)))          // 20.07.2026 dd.mm.yyyy
    return mk(+m[3], +m[2] - 1, +m[1]);
  if ((m = s.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*,?\s+(\d{4})/))) // Wed 02 Sep, 2026
    return mk(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}
function mk(y, mon, d) {
  if (mon == null || Number.isNaN(mon)) return null;
  const dt = new Date(Date.UTC(y, mon, d, 12, 0, 0));
  if (Number.isNaN(dt.getTime())) return null;
  // Upstream records occasionally carry a mistyped future year (e.g. a CAG
  // report tabled "2030"). Treat anything more than a week ahead as an
  // unreliable date: null it so it neither becomes pubDate nor hijacks the
  // most-recent sort. A week of skew covers timezone slop on genuine items.
  if (dt.getTime() > Date.now() + 7 * 864e5) return null;
  return dt;
}

// ── XML helpers ───────────────────────────────────────────────────
function xml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function rfc822(dt) { return dt ? dt.toUTCString() : ''; }
// Upstream PDF URLs sometimes contain raw spaces/commas in the path (e.g.
// .../Coal, Mines and Steel/...pdf), which are invalid in an RSS <link>.
// encodeURI leaves already-valid URL syntax intact and percent-encodes the
// unsafe characters (space → %20) so feed readers resolve the link.
function cleanUrl(u) {
  if (!u || typeof u !== 'string') return u;
  try { return encodeURI(u); } catch { return u; }
}

// ── Corpus loaders → flat list of raw records ─────────────────────
async function loadFlat(base, id) {            // drsc/cag/fc/lc
  const obj = await getJSON(`${base}${id}/reports.json`);
  const out = [];
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) out.push(...v);
    else if (v && typeof v === 'object') out.push(v);
  }
  return out;
}
async function loadBills(base) {
  const meta = await getJSON(`${base}bills/index-meta.json`);
  const shards = meta.shards || [];
  // Newest-year shard carries the most recent bills.
  const pick = shards.slice().sort((a, b) =>
    (b.newest_billYear || 0) - (a.newest_billYear || 0))[0];
  if (!pick) return [];
  const shard = await getJSON(`${base}bills/${pick.file}`);
  return shard.records || [];
}
async function loadSharded(base, id) {         // debates/questions/gazettes
  const meta = await getJSON(`${base}${id}/reports-meta.json`);
  const groups = meta.shards || {};
  const out = [];
  // meta lists each house/category's shards newest-first; the first shard
  // of each group holds the most recent records.
  for (const list of Object.values(groups)) {
    const first = Array.isArray(list) ? list[0] : null;
    if (!first?.file) continue;
    try {
      const shard = await getJSON(`${base}${id}/${first.file}`);
      if (Array.isArray(shard.records)) out.push(...shard.records);
    } catch (e) { console.warn(`  shard ${first.file}: ${e.message}`); }
  }
  return out;
}

// ── Corpus config: loader + field map ─────────────────────────────
// map(r) → { id, title, date, link, categories[], desc }
const CORPORA = [
  {
    id: 'drsc', label: 'DRSC Committee Reports',
    desc: 'Department-Related Standing Committee reports',
    load: () => loadFlat(DATA, 'drsc'),
    map: (r) => ({
      id: `drsc:${r.committee}|${r.lok_sabha}|${r.report_number}`,
      title: r.title,
      date: parseDate(r.date_of_presentation || r.presented_in_ls || r.laid_in_rs),
      link: r.pdf_url || APP,
      categories: [r.committee_name].filter(Boolean),
      desc: `${r.committee_name || 'Committee'} · Report No. ${r.report_number} · ${r.lok_sabha}th Lok Sabha`,
    }),
  },
  {
    id: 'cag', label: 'CAG Audit Reports',
    desc: 'Comptroller and Auditor General audit reports',
    load: () => loadFlat(DATA, 'cag'),
    map: (r) => ({
      id: `cag:${r.id}`,
      title: r.title,
      date: parseDate(r.date_tabled || r.date_sent),
      link: r.detail_url || r.pdf_url || APP,
      categories: [r.gov_type].filter(Boolean),
      desc: `${r.gov_type || ''} audit${r.year ? ` · ${r.year}` : ''}`.trim(),
    }),
  },
  {
    id: 'bills', label: 'Bills',
    desc: 'Bills introduced in Parliament',
    load: () => loadBills(DATA),
    map: (r) => ({
      id: `bills:${r.billType}:${r.billNumber}:${r.billYear}`,
      title: r.billName,
      date: parseDate(r.billIntroducedDate),
      link: r.billIntroducedFile || APP,
      categories: [r.billType, r.ministryName].filter(Boolean),
      desc: `${r.billType || 'Bill'} · introduced in ${r.billIntroducedInHouse || 'Parliament'}${r.ministryName ? ` · ${r.ministryName}` : ''}`,
    }),
  },
  {
    id: 'fc', label: 'Financial Committee Reports',
    desc: 'Estimates, Public Accounts and Public Undertakings committee reports',
    load: () => loadFlat(DATA, 'fc'),
    map: (r) => ({
      id: `fc:${r.committee}|${r.lok_sabha}|${r.report_number}`,
      title: r.title,
      date: parseDate(r.presented_in_ls || r.date_of_presentation || r.laid_in_rs),
      link: r.pdf_url || APP,
      categories: [r.committee_name].filter(Boolean),
      desc: `${r.committee_name || 'Committee'} · Report No. ${r.report_number} · ${r.lok_sabha}th Lok Sabha`,
    }),
  },
  {
    id: 'lc', label: 'Law Commission Reports',
    desc: 'Law Commission of India reports',
    load: () => loadFlat(DATA, 'lc'),
    map: (r) => ({
      id: `lc:${r.report_number}`,
      title: r.title,
      date: parseDate(r.date_submitted),
      link: r.pdf_url || APP,
      categories: r.commission_term ? [`${r.commission_term}th Law Commission`] : [],
      desc: `Report No. ${r.report_number}${r.commission_term ? ` · ${r.commission_term}th Law Commission` : ''}`,
    }),
  },
  {
    id: 'debates', label: 'Parliamentary Debates',
    desc: 'Lok Sabha and Rajya Sabha debates',
    load: () => loadSharded(PROC, 'debates'),
    // LS debates are per-item (db_slno, debate_type, members); RS debates
    // are session/date-level PDFs (file_versions, date_iso, no db_slno).
    map: (r) => {
      const ls = r.house === 'ls';
      const house = ls ? 'Lok Sabha' : 'Rajya Sabha';
      return {
        id: ls
          ? `debates:ls|${r.lok_sabha}|${r.session}|${r.db_slno}`
          : `debates:rs|${r.session}|${r.date_iso || r.date}`,
        title: r.title,
        date: parseDate(r.date_iso || r.debate_date || r.date),
        link: ls
          ? `https://sansad.in/ls/debates/view-debate?ls=${r.lok_sabha}&session=${r.session}&dbslno=${r.db_slno}`
          : (r.file_versions?.[0]?.url || 'https://sansad.in/rs/debates/verbatim'),
        categories: [r.debate_type_desc, house].filter(Boolean),
        desc: [
          r.debate_type_desc || 'Debate',
          house,
          Array.isArray(r.members) && r.members.length ? `${r.members.length} member(s)` : null,
        ].filter(Boolean).join(' · '),
      };
    },
  },
  {
    id: 'questions', label: 'Parliamentary Questions',
    desc: 'Starred and unstarred questions',
    load: () => loadSharded(PROC, 'questions'),
    // LS questions are per-question (question_no, ministry, members); RS
    // questions are per-session question-list PDFs (date_iso, subject is a
    // composed label, no question_no/ministry).
    map: (r) => {
      const ls = r.house === 'ls';
      const house = ls ? 'Lok Sabha' : 'Rajya Sabha';
      const parts = [];
      if (r.type) parts.push(ls && r.question_no ? `${r.type} Q${r.question_no}` : r.type);
      if (r.ministry) parts.push(`Min. of ${r.ministry}`);
      if (Array.isArray(r.members) && r.members.length) parts.push(r.members.join(', '));
      parts.push(house);
      return {
        id: ls
          ? `questions:ls|${r.lok_sabha}|${r.session}|${r.question_no}`
          : `questions:rs|${r.session}|${r.date_iso || r.date}|${r.type}`,
        title: r.subject,
        date: parseDate(r.date_iso || r.date),
        link: r.pdf_url || APP,
        categories: [r.ministry, r.type, house].filter(Boolean),
        desc: parts.join(' · '),
      };
    },
  },
  {
    id: 'gazettes', label: 'Central Gazette',
    desc: 'Gazette of India (Central) notifications',
    load: () => loadSharded(GAZ, 'gazettes'),
    map: (r) => ({
      id: `gazettes:${r.identifier}`,
      title: r.subject || r.title,
      date: parseDate(r.issue_date),
      link: r.pdf_url || r.gazette_source_url || APP,
      categories: [r.ministry, r.category].filter(Boolean),
      desc: `${r.category || 'Gazette'}${r.ministry ? ` · ${r.ministry}` : ''}${r.department ? ` · ${r.department}` : ''}`,
    }),
  },
];

// ── Feed assembly ─────────────────────────────────────────────────
function buildRss(corpus, items, buildDate) {
  const self = `${APP}/feeds/${corpus.id}.xml`;
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
  lines.push('  <channel>');
  lines.push(`    <title>SansadSaar — ${xml(corpus.label)}</title>`);
  lines.push(`    <link>${xml(APP)}</link>`);
  lines.push(`    <description>${xml(corpus.desc)}. Most recent ${items.length} items.</description>`);
  lines.push('    <language>en-in</language>');
  lines.push(`    <lastBuildDate>${rfc822(buildDate)}</lastBuildDate>`);
  lines.push('    <generator>sansadsaar feeds (scripts/gen-feeds.mjs)</generator>');
  lines.push(`    <atom:link href="${xml(self)}" rel="self" type="application/rss+xml"/>`);
  for (const it of items) {
    lines.push('    <item>');
    lines.push(`      <title>${xml(it.title || '(untitled)')}</title>`);
    lines.push(`      <link>${xml(cleanUrl(it.link))}</link>`);
    lines.push(`      <guid isPermaLink="false">${xml(it.id)}</guid>`);
    if (it.date) lines.push(`      <pubDate>${rfc822(it.date)}</pubDate>`);
    if (it.desc) lines.push(`      <description>${xml(it.desc)}</description>`);
    for (const c of it.categories) lines.push(`      <category>${xml(c)}</category>`);
    lines.push('    </item>');
  }
  lines.push('  </channel>');
  lines.push('</rss>');
  return lines.join('\n') + '\n';
}

function buildIndexHtml(results, buildDate) {
  const rows = results.map((r) => r.ok
    ? `    <li><a href="${r.id}.xml">${xml(r.label)}</a> <span class="n">${r.count} items</span></li>`
    : `    <li class="err">${xml(r.label)} <span class="n">failed: ${xml(r.error)}</span></li>`
  ).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SansadSaar — RSS feeds</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.4rem; }
  ul { list-style: none; padding: 0; }
  li { padding: .55rem 0; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
  a { text-decoration: none; font-weight: 600; }
  .n { opacity: .6; font-weight: 400; font-size: .85em; margin-left: .4rem; }
  .err { opacity: .7; }
  footer { margin-top: 2rem; font-size: .85em; opacity: .6; }
</style>
</head>
<body>
  <h1>SansadSaar — RSS feeds</h1>
  <p>One feed per section. Each lists the most recent items; regenerated daily.</p>
  <ul>
${rows}
  </ul>
  <footer>
    Updated ${xml(buildDate.toISOString())} ·
    <a href="${xml(APP)}">SansadSaar</a>
  </footer>
</body>
</html>
`;
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const buildDate = new Date();
  const results = [];
  for (const corpus of CORPORA) {
    try {
      const raw = await corpus.load();
      const items = raw
        .map(corpus.map)
        .filter((it) => it && it.title)
        .sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0))
        .slice(0, ITEMS_PER_FEED);
      const xmlStr = buildRss(corpus, items, buildDate);
      await writeFile(join(OUT_DIR, `${corpus.id}.xml`), xmlStr);
      console.log(`${corpus.id}: ${items.length} items from ${raw.length} records`);
      results.push({ id: corpus.id, label: corpus.label, ok: true, count: items.length });
    } catch (e) {
      console.error(`${corpus.id}: FAILED — ${e.message}`);
      results.push({ id: corpus.id, label: corpus.label, ok: false, error: e.message });
    }
  }
  await writeFile(join(OUT_DIR, 'index.html'), buildIndexHtml(results, buildDate));
  const failed = results.filter((r) => !r.ok);
  console.log(`\nDone: ${results.length - failed.length}/${results.length} feeds written.`);
  if (failed.length) process.exitCode = 1;   // surface failures in CI, feeds still written
}

main();
