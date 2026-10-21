// Run the weekly digest once, without the web server (cron, Cloud Scheduler, CI).
//   npm run digest              build (or reuse this week's draft) and post it
//   npm run digest -- --dry-run build a draft and print it, post nothing
//   npm run digest -- --force   post again even if this week's digest was already sent
import { openDb } from './db.js';
import { buildDigest, digestCard, sendWeeklyDigest } from './integrations/digest.js';

const args = new Set(process.argv.slice(2));
const db = openDb();
try {
  if (args.has('--dry-run')) {
    const row = await buildDigest(db);
    console.log(JSON.stringify({ week: row.week, source: row.source, sources: row.sources, digest: row.content }, null, 2));
    if (args.has('--card')) console.log(JSON.stringify(digestCard(row.content, { week: row.week, stats: row.sources, recap: row.sources.recap }), null, 2));
  } else {
    const r = await sendWeeklyDigest(db, { force: args.has('--force') });
    console.log(r.skipped ? `Already sent for the week of ${r.week} (use --force to send again).` : `Sent the digest for the week of ${r.week}.`);
  }
} catch (err) {
  console.error(`Digest failed: ${err.message}`);
  process.exitCode = 1;
}
