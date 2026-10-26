// Run a digest pipeline step without the web server (cron, Cloud Scheduler, CI).
//   npm run digest -- plan  [--week 2026-11-02]   Wednesday: topic plan for next week
//   npm run digest -- draft [--week …] [--day tue] Thursday: Claude drafts the cards, validators run
//   npm run digest -- preview [--week …] --out f.html  write the full web card (drafts included) to a file
//   npm run digest -- queue [--week …]             Sunday: queue approved cards, fallbacks for the rest
//   npm run digest -- deliver                      send cards that are due now (each rep's local time)
import { writeFileSync } from 'node:fs';
import { openDb } from './db.js';
import { weekStart } from './engagement.js';
import { deliverDue, draftWeek, getWeek, planWeek, queueWeek, upcomingWeek } from './digest/index.js';
import { weekPage } from './digest/page.js';

const [cmd, ...rest] = process.argv.slice(2);
const arg = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : null; };
const week = arg('week') ? weekStart(arg('week')) : upcomingWeek();
const db = openDb();

const summary = (w) => `Week of ${w.week} (${w.status}): ${w.cards.map((c) => `${c.day} ${c.status}${c.issues.some((i) => i.level === 'error') ? ' ⛔' : ''}`).join(', ') || 'no cards yet'}`;

try {
  if (cmd === 'plan') {
    const w = await planWeek(db, { week });
    console.log(JSON.stringify(w.plan, null, 2));
  } else if (cmd === 'draft') {
    const w = getWeek(db, week) || await planWeek(db, { week });
    const r = await draftWeek(db, w.id, arg('day') ? { days: [arg('day')] } : {});
    console.log(summary(r));
    for (const c of r.cards) for (const i of c.issues) console.log(`  ${c.day} ${i.level}: ${i.path}: ${i.message}`);
  } else if (cmd === 'preview') {
    const w = getWeek(db, week);
    if (!w) throw new Error(`No digest for the week of ${week}; run "plan" and "draft" first`);
    const cards = db.prepare('SELECT * FROM digest_cards WHERE week_id = ?').all(w.id).map((c) => ({ ...c, content: JSON.parse(c.content), issues: JSON.parse(c.issues) }));
    const out = arg('out') || `digest-${week}.html`;
    writeFileSync(out, weekPage({ week: w, cards, title: process.env.DIGEST_TITLE || 'GTM weekly digest', preview: true }));
    console.log(`Wrote ${out}`);
  } else if (cmd === 'queue') {
    console.log(summary(await queueWeek(db, week)));
  } else if (cmd === 'deliver') {
    const r = await deliverDue(db);
    console.log(`Delivered ${r.sent}, failed ${r.failed}`);
  } else {
    console.log('Usage: npm run digest -- plan|draft|preview|queue|deliver [--week YYYY-MM-DD] [--day mon..fri] [--out file.html]');
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`Digest ${cmd} failed: ${err.message}`);
  process.exitCode = 1;
}
