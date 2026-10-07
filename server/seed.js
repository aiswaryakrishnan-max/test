// Seeds demo content and users. Run `npm run seed` to reset the database.
// Content is generic B2B SaaS — replace it with your own product, personas and competitors
// via the Content Studio in the app (or by editing this file).
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openDb, tx } from './db.js';
import { hashPassword } from './auth.js';
import { addDays, awardXp, dayOf, evaluateBadges } from './engagement.js';

export const DEMO_PASSWORD = 'password123';

const MODULES = [
  {
    title: 'Discovery That Uncovers Real Pain', topic: 'Discovery', minutes: 6, xp: 40,
    summary: 'Ask questions that move buyers from symptoms to business impact.',
    body: `## Why discovery matters
Deals are won or lost in discovery. Reps who ask 11–14 targeted questions in a first call close noticeably more often than reps who pitch early.

## The funnel: Situation → Problem → Impact → Need
1. **Situation** – How do things work today? (Keep these brief; do your homework first.)
2. **Problem** – What's not working? Where is the friction?
3. **Impact** – What does that cost the business in time, money or risk? *This is where urgency lives.*
4. **Need-payoff** – If that were solved, what would it mean for you and your team?

## Habits of great discoverers
- Ask one question at a time, then **pause**.
- Use the buyer's own words when you summarise.
- Label emotions: "It sounds like this has been frustrating for the team."
- Always confirm: "Did I capture that correctly?"`,
    questions: [
      ['Which type of question is most likely to create urgency?', ['Situation', 'Problem', 'Impact', 'Product feature'], 2, 'Impact questions quantify the cost of inaction, which is what creates urgency.'],
      ['A buyer says "our reporting is slow". What is the best follow-up?', ['Our dashboards load in under a second.', 'What happens downstream when reports are late?', 'How many users do you have?', 'Would you like a demo?'], 1, 'Dig into impact before pitching a solution.'],
      ['What should you do right after asking a discovery question?', ['Suggest an answer', 'Ask a second question', 'Pause and let the buyer answer', 'Share a case study'], 2, 'Silence gives the buyer room to share more than they planned to.'],
    ],
  },
  {
    title: 'Handling Pricing Objections', topic: 'Objection Handling', minutes: 5, xp: 40,
    summary: 'Reframe price into value without discounting by reflex.',
    body: `## The LAER model
- **Listen** fully — don't interrupt.
- **Acknowledge** — "That's a fair question; budget matters."
- **Explore** — "When you say it's expensive, what are you comparing it to?"
- **Respond** — Tie back to the quantified impact uncovered in discovery.

## Don'ts
- Don't discount in the first conversation about price.
- Don't get defensive or over-explain.

## Useful reframes
- Cost of inaction: "What does it cost you each quarter this stays unsolved?"
- Unit value: break the price down per user, per day, or per outcome.
- Trade, don't give: any concession should come with something in return (longer term, case study, faster signature).`,
    questions: [
      ['What does the "E" in LAER stand for?', ['Educate', 'Explore', 'Escalate', 'Empathise'], 1, 'Explore the objection to understand what is really behind it.'],
      ['A prospect says "you\'re too expensive" in the first call. Best response?', ['Offer 15% off', 'Ask what they are comparing the price to', 'Explain your cost structure', 'Move on to features'], 1, 'Understand the comparison before responding.'],
      ['If you do give a concession, you should…', ['Give it freely to build goodwill', 'Trade it for something of value', 'Only give it at quarter end', 'Never give concessions'], 1, 'Concessions should always be traded, not given.'],
    ],
  },
  {
    title: 'Positioning Against Competitor X', topic: 'Competitive', minutes: 4, xp: 30,
    summary: 'Win head-to-head deals by leading with our differentiators.',
    body: `## Where we win
- **Time to value**: customers are live in ~2 weeks vs. a typical 3-month implementation.
- **Total cost**: no professional-services fees for standard onboarding.
- **Integrations**: 200+ native integrations, including the CRM and data warehouse.

## Where they push back
- "Competitor X is the market leader." → Ask what *leadership* means for the buyer's outcome; share a customer who switched.
- "They have more features." → Ask which of those features the team will actually use in the first 6 months.

## Landmines to set (ask early)
- "How long are you willing to wait to see the first results?"
- "Who will maintain the configuration after go-live?"`,
    questions: [
      ['What is our strongest differentiator vs. Competitor X?', ['Lower list price', 'Time to value', 'Bigger brand', 'More features'], 1, 'We are typically live in ~2 weeks versus ~3 months.'],
      ['"They have more features." Best response?', ['Agree and move on', 'List all our features', 'Ask which features the team will actually use in 6 months', 'Offer a discount'], 2, 'Re-focus on what drives the buyer\'s outcome.'],
    ],
  },
  {
    title: 'Writing Cold Emails That Get Replies', topic: 'Prospecting', minutes: 4, xp: 30,
    summary: 'Short, relevant, one clear ask.',
    body: `## The 3-sentence rule
1. **Relevance** — a trigger: new role, funding, hiring, a post they wrote.
2. **Value** — one outcome a similar company achieved, with a number.
3. **Ask** — low-friction interest question: "Worth a quick look?"

## Subject lines
Short (2–4 words), lowercase, specific: "reporting at {{company}}".

## Follow-ups
Send 3–5 touches over ~2 weeks, each adding *new* value (a resource, insight or proof point), never just "bumping this".`,
    questions: [
      ['What is the ideal ask in a first cold email?', ['A 60-minute demo', 'A low-friction interest question', 'A signed NDA', 'A pricing call'], 1, 'Lower friction = more replies.'],
      ['Best practice for follow-up emails?', ['"Just bumping this"', 'Add new value each time', 'Send daily until they reply', 'Copy their manager immediately'], 1, 'Each touch should earn attention with something new.'],
    ],
  },
  {
    title: 'Running a Mutual Action Plan', topic: 'Deal Management', minutes: 5, xp: 30,
    summary: 'Co-own the path to signature with your champion.',
    body: `## What is a Mutual Action Plan (MAP)?
A shared document listing every step, owner and date between today and go-live — built *with* the buyer.

## Why it works
- Surfaces hidden steps (security review, legal, procurement) early.
- Makes your champion look organised internally.
- Turns "we'll get back to you" into dated commitments.

## How to introduce it
"To make sure we hit your go-live date of June 1, would it help if we mapped the steps backwards together?"`,
    questions: [
      ['A mutual action plan is best built…', ['By the rep alone after the call', 'Together with the buyer', 'By legal', 'Only after the contract is signed'], 1, 'Co-creation creates commitment.'],
      ['A key benefit of a MAP is that it…', ['Removes the need for discovery', 'Surfaces hidden steps like security review early', 'Guarantees a discount', 'Replaces the CRM'], 1, 'Hidden steps are the most common cause of slipped deals.'],
    ],
  },
];

const SCENARIOS = [
  {
    title: 'Elevator pitch to a CFO', xp: 40,
    persona: 'Dana, CFO at a 500-person logistics company. Busy, numbers-driven, sceptical of new software spend.',
    situation: 'You have 90 seconds with Dana after a conference panel. Her team closes the books in 12 days and she has said publicly she wants it under 5.',
    objective: 'Earn a 30-minute follow-up meeting.',
    key_points: ['Reference her goal of faster close', 'Quantify time or cost savings', 'Share a relevant customer proof point', 'Ask a discovery question', 'Propose a specific next meeting'],
  },
  {
    title: 'Pricing pushback from a champion', xp: 40,
    persona: 'Marcus, Head of RevOps. Loves the product, but procurement says you are 30% over budget.',
    situation: 'Marcus calls to say procurement will not approve the current price and asks if you can "do something".',
    objective: 'Protect price by reinforcing value, and agree on next steps with procurement.',
    key_points: ['Acknowledge the budget concern', 'Explore what procurement is comparing against', 'Restate the quantified business value', 'Offer a trade instead of a straight discount', 'Agree a next step with procurement'],
  },
  {
    title: 'Displacing Competitor X', xp: 50,
    persona: 'Priya, VP Operations. Her team has been on Competitor X for 3 years and the implementation still is not finished.',
    situation: 'Priya agreed to a 20-minute intro call because her renewal is in 4 months.',
    objective: 'Position our time-to-value advantage and secure a technical evaluation.',
    key_points: ['Empathise with the implementation pain', 'Highlight faster time to value', 'Mention integrations', 'Ask about renewal timeline and decision process', 'Propose a technical evaluation or pilot'],
  },
];

const BATTLECARDS = [
  ['Competitor X — quick facts', 'Competitive', 'Strengths: brand, breadth of features.\nWeaknesses: ~3-month implementations, services-heavy, rigid pricing.\nWin theme: "Live in 2 weeks, not 2 quarters."\nTrap question: "Who maintains the configuration after go-live?"'],
  ['Objection: "We\'re building it in-house"', 'Objections', 'Explore: Who owns it in 12 months? What is the roadmap cost?\nRespond: Show total cost of ownership incl. maintenance; offer an API-first approach that complements their build.'],
  ['Objection: "Not a priority right now"', 'Objections', 'Explore: What are the priorities this quarter? How does this problem affect them?\nRespond: Tie to their stated priority; offer a low-effort pilot.'],
  ['Ideal Customer Profile', 'Positioning', '200–5,000 employees; operations-heavy; uses a modern CRM; has a RevOps or Ops lead; pain around reporting latency or manual workflows.'],
  ['Pricing & packaging', 'Positioning', 'Starter / Growth / Enterprise. Annual contracts. Multi-year: up to 10% for 2-year prepay. Discounts above 15% need VP approval.'],
  ['Customer story: Northwind Freight', 'Proof points', 'Cut month-end close from 11 days to 4. Live in 15 days. 3.2x ROI in year one. Reference-able: yes (contact CSM).'],
];

const TIPS = [
  'Before every call, write down the one outcome you want. If you only get one thing, what is it?',
  'Mirror the last three words a buyer says — it invites them to keep talking.',
  '"What would have to be true for you to move forward?" surfaces hidden blockers fast.',
  'Send your recap email within an hour of the call while the buyer still remembers it.',
  'Multi-thread early: aim for three contacts in every opportunity by stage 2.',
  'Replace "Does that make sense?" with "How does that land for you?"',
  'Ask about the decision process before you talk about price.',
];

const TEAMS = ['Enterprise East', 'Mid-Market West'];

const USERS = [
  ['admin@pitchpulse.dev', 'Avery Admin', 'admin', null],
  ['manager@pitchpulse.dev', 'Morgan Manager', 'manager', 'Enterprise East'],
  ['rep@pitchpulse.dev', 'Riley Rep', 'rep', 'Enterprise East'],
  ['sam@pitchpulse.dev', 'Sam Patel', 'rep', 'Enterprise East'],
  ['jordan@pitchpulse.dev', 'Jordan Lee', 'rep', 'Enterprise East'],
  ['casey@pitchpulse.dev', 'Casey Kim', 'rep', 'Mid-Market West'],
  ['taylor@pitchpulse.dev', 'Taylor Nguyen', 'rep', 'Mid-Market West'],
  ['wm@pitchpulse.dev', 'Wren Martinez', 'manager', 'Mid-Market West'],
];

// Deterministic PRNG so demo data is stable between seeds.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seed(db, { history = true } = {}) {
  tx(db, () => {
    const teamIds = {};
    for (const t of TEAMS) teamIds[t] = Number(db.prepare('INSERT INTO teams (name) VALUES (?)').run(t).lastInsertRowid);

    const pw = hashPassword(DEMO_PASSWORD);
    const userIds = {};
    for (const [email, name, role, team] of USERS) {
      userIds[email] = Number(db.prepare('INSERT INTO users (email, name, password_hash, role, team_id) VALUES (?, ?, ?, ?, ?)')
        .run(email, name, pw, role, team ? teamIds[team] : null).lastInsertRowid);
    }
    const adminId = userIds['admin@pitchpulse.dev'];

    const moduleIds = [];
    for (const m of MODULES) {
      const id = Number(db.prepare('INSERT INTO modules (title, topic, summary, body, minutes, xp, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(m.title, m.topic, m.summary, m.body, m.minutes, m.xp, adminId).lastInsertRowid);
      moduleIds.push(id);
      for (const [prompt, options, answer, explanation] of m.questions) {
        db.prepare('INSERT INTO questions (module_id, topic, prompt, options, answer_index, explanation) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, m.topic, prompt, JSON.stringify(options), answer, explanation);
      }
    }
    for (const s of SCENARIOS) {
      db.prepare('INSERT INTO scenarios (title, persona, situation, objective, key_points, xp) VALUES (?, ?, ?, ?, ?, ?)')
        .run(s.title, s.persona, s.situation, s.objective, JSON.stringify(s.key_points), s.xp);
    }
    for (const [title, category, content] of BATTLECARDS) {
      db.prepare('INSERT INTO battlecards (title, category, content) VALUES (?, ?, ?)').run(title, category, content);
    }
    for (const t of TIPS) db.prepare('INSERT INTO tips (text) VALUES (?)').run(t);

    const today = dayOf();
    const managerId = userIds['manager@pitchpulse.dev'];
    db.prepare('INSERT INTO assignments (module_id, team_id, due_date, assigned_by) VALUES (?, ?, ?, ?)')
      .run(moduleIds[1], teamIds['Enterprise East'], addDays(today, 3), managerId);
    db.prepare('INSERT INTO assignments (module_id, team_id, due_date, assigned_by) VALUES (?, ?, ?, ?)')
      .run(moduleIds[2], teamIds['Enterprise East'], addDays(today, 7), managerId);
    db.prepare('INSERT INTO assignments (module_id, team_id, due_date, assigned_by) VALUES (?, ?, ?, ?)')
      .run(moduleIds[0], teamIds['Mid-Market West'], addDays(today, 5), userIds['wm@pitchpulse.dev']);

    if (history) seedHistory(db, userIds, moduleIds, today);
  });
}

// Plausible past activity so dashboards and leaderboards aren't empty on day one.
function seedHistory(db, userIds, moduleIds, today) {
  const rand = mulberry32(42);
  const questionIds = db.prepare('SELECT id FROM questions').all().map((r) => r.id);
  // [email, activity probability per day, accuracy, streak ending yesterday]
  const profiles = [
    ['rep@pitchpulse.dev', 0.6, 0.7, 4],
    ['sam@pitchpulse.dev', 0.9, 0.85, 12],
    ['jordan@pitchpulse.dev', 0.25, 0.55, 0],
    ['casey@pitchpulse.dev', 0.75, 0.8, 6],
    ['taylor@pitchpulse.dev', 0.5, 0.65, 2],
  ];
  for (const [email, p, accuracy, streak] of profiles) {
    const uid = userIds[email];
    for (let back = 20; back >= 1; back--) {
      const day = addDays(today, -back);
      const inStreak = back <= streak;
      const gapBeforeStreak = back === streak + 1;
      if (!inStreak && (gapBeforeStreak || rand() > p)) continue;
      const qs = [...questionIds].sort(() => rand() - 0.5).slice(0, 3);
      let correct = 0;
      for (const q of qs) {
        const ok = rand() < accuracy ? 1 : 0;
        correct += ok;
        db.prepare('INSERT INTO answers (user_id, question_id, correct, context, day, answered_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(uid, q, ok, 'daily', day, `${day} 09:00:00`);
      }
      db.prepare('INSERT INTO daily_challenges (user_id, day, question_ids, completed_at, correct_count) VALUES (?, ?, ?, ?, ?)')
        .run(uid, day, JSON.stringify(qs), `${day} 09:05:00`, correct);
      awardXp(db, uid, correct * 10 + 20 + (correct === 3 ? 15 : 0), 'Daily Challenge', day);
    }
    const modulesDone = Math.floor(rand() * 3) + (p > 0.7 ? 1 : 0);
    for (const mid of moduleIds.slice(0, modulesDone)) {
      const day = addDays(today, -Math.ceil(rand() * 10));
      db.prepare('INSERT INTO module_completions (user_id, module_id, score, completed_at) VALUES (?, ?, ?, ?)')
        .run(uid, mid, Math.round(accuracy * 100), `${day} 12:00:00`);
      awardXp(db, uid, 30, 'Module completed', day);
    }
    evaluateBadges(db, uid, today);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.env.DB_FILE || 'data/pitchpulse.db';
  if (process.argv.includes('--reset')) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
  }
  const db = openDb(file);
  seed(db);
  console.log(`Seeded ${file}. Log in with any demo account, password "${DEMO_PASSWORD}":`);
  for (const [email, , role] of USERS) console.log(`  ${role.padEnd(8)} ${email}`);
}
