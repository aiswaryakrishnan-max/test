import { createServer } from 'node:http';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { scheduleReminders } from './reminders.js';
import { extensions } from './extensions.js';
import { scheduleCrmSync } from './integrations/crm.js';
import { scheduleChatChallenges } from './integrations/googlechat.js';
import { scheduleDigest } from './digest/index.js';
import { DEMO_PASSWORD, seed } from './seed.js';

const db = openDb();
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  seed(db);
  console.log(`Empty database — seeded demo data. Sign in as rep@pitchpulse.dev / ${DEMO_PASSWORD}`);
}
scheduleReminders(db);
scheduleCrmSync(db);
scheduleChatChallenges(db);
scheduleDigest(db);

const port = Number(process.env.PORT || 3000);
createServer(createApp(db, { extensions })).listen(port, () => {
  console.log(`PitchPulse running at http://localhost:${port}`);
});
