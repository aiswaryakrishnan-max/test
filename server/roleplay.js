// AI role-plays: a live, multi-turn practice call where Claude plays the buyer.
// The rep talks (typed or by voice), the buyer reacts in character, and at the end the
// whole conversation is graded with a skills scorecard. Without ANTHROPIC_API_KEY a
// scripted buyer and rubric keep the feature usable offline.
import { MODEL, getClient, scoreWithRubric } from './coach.js';
import { tx } from './db.js';
import { HttpError, bad } from './errors.js';
import { awardXp, dayOf, evaluateBadges } from './engagement.js';
import { matchDeal } from './integrations/calendar.js';
import { stageGuidance } from './integrations/crm.js';

export const MAX_REP_TURNS = 16;
const DAILY_XP_ROLEPLAYS = 3;
const END_TOKEN = '[END_CALL]';

const DIFFICULTY = {
  friendly: 'You are open and fairly forthcoming. Share information when asked reasonable questions. Raise at most one mild concern.',
  skeptical: 'You are guarded. Give short answers until the rep earns trust with sharp, relevant questions. Raise one or two realistic objections (status quo, priority, cost, competitor).',
  tough: 'You are busy and hard to impress. Push back firmly on value, price and timing. If the rep pitches features without understanding your situation, get impatient and threaten to end the call. Only agree to a next step if it is clearly worth your time.',
};

const SKILLS = ['discovery', 'listening', 'value', 'objection_handling', 'next_steps'];
const SKILL_LABELS = {
  discovery: 'Discovery questions', listening: 'Active listening & empathy', value: 'Value articulation',
  objection_handling: 'Objection handling', next_steps: 'Next steps & close',
};

const SCORECARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'summary', 'skills', 'strengths', 'improvements', 'key_points_covered', 'key_points_missed', 'best_moment', 'missed_opportunity', 'better_line'],
  properties: {
    score: { type: 'integer', description: 'Overall 0-100' },
    summary: { type: 'string', description: 'Two-sentence verdict' },
    skills: {
      type: 'object',
      additionalProperties: false,
      required: SKILLS,
      properties: Object.fromEntries(SKILLS.map((k) => [k, {
        type: 'object', additionalProperties: false, required: ['score', 'comment'],
        properties: { score: { type: 'integer', description: '0-10' }, comment: { type: 'string' } },
      }])),
    },
    strengths: { type: 'array', items: { type: 'string' } },
    improvements: { type: 'array', items: { type: 'string' } },
    key_points_covered: { type: 'array', items: { type: 'string' } },
    key_points_missed: { type: 'array', items: { type: 'string' } },
    best_moment: { type: 'string', description: "A short quote of the rep's strongest line" },
    missed_opportunity: { type: 'string', description: 'Where the rep should have done something different' },
    better_line: { type: 'string', description: 'What the rep could have said at that moment instead' },
  },
};

const buyerName = (persona) => (persona.match(/^([A-Z][a-z]+)\b/) || [null, 'the buyer'])[1];

function buyerSystem(rp) {
  return `You are role-playing a BUYER in a sales training simulation. A sales rep is practicing a live call with you.

<persona>${rp.persona}</persona>
<situation>${rp.situation}</situation>
<rep_goal_hidden>${rp.objective}</rep_goal_hidden>

How to play the buyer:
- ${DIFFICULTY[rp.difficulty]}
- Stay fully in character as this buyer. Never mention that this is training, that you are an AI, or coach the rep.
- Speak like a real person on a call: 1-4 short sentences, no lists, no markdown, no stage directions.
- Invent realistic, consistent details about your company (numbers, tools, team size, timeline) when asked, and stick to them.
- Reveal pain, budget, decision process and timeline only when the rep asks good questions. Don't volunteer everything.
- React to what the rep actually says. Reward specific, relevant points; push back on generic pitching.
- The rep's hidden goal is listed above so you can judge whether they've earned it. Only agree to it if they have.
- If the conversation reaches a natural end (agreement on next steps, or you decide to end the call), say your final words and then append ${END_TOKEN} on its own.`;
}

// ---------- Creating role-plays ----------

export function createRoleplay(db, userId, { scenarioId, meetingId, difficulty = 'skeptical' }) {
  if (!DIFFICULTY[difficulty]) throw bad('difficulty must be friendly, skeptical or tough');
  let spec;
  if (meetingId) {
    const m = db.prepare('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?').get(meetingId, userId);
    if (!m) throw new HttpError(404, 'Meeting not found');
    spec = meetingSpec(db, userId, m);
  } else {
    const s = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(scenarioId);
    if (!s) throw new HttpError(404, 'Scenario not found');
    spec = { scenario_id: s.id, title: s.title, persona: s.persona, situation: s.situation, objective: s.objective, key_points: JSON.parse(s.key_points) };
  }
  const id = Number(db.prepare(`INSERT INTO roleplays (user_id, scenario_id, meeting_id, title, persona, situation, objective, key_points, difficulty, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, spec.scenario_id ?? null, meetingId ?? null, spec.title, spec.persona, spec.situation,
    spec.objective, JSON.stringify(spec.key_points), difficulty, getClient() ? 'ai' : 'scripted').lastInsertRowid);
  return getRoleplay(db, userId, id);
}

/** Build a buyer persona for a real upcoming meeting, enriched with the matched CRM deal. */
function meetingSpec(db, userId, m) {
  const domains = JSON.parse(m.external_domains);
  const company = domains[0] ? domains[0].split('.')[0].replace(/^\w/, (c) => c.toUpperCase()) : 'the customer';
  const deal = matchDeal(db, userId, { title: m.title, domains });
  const g = stageGuidance(deal?.stage);
  // Use the first external attendee's first name when the address looks personal (dana@, dana.lee@).
  const attendee = JSON.parse(m.attendees).find((e) => domains.includes(String(e).split('@')[1]?.toLowerCase()));
  const local = attendee ? attendee.split('@')[0].split(/[._-]/)[0] : '';
  const name = /^[a-z]{2,15}$/i.test(local) && !/^(info|sales|team|hello|contact|admin|support|ops|finance)$/i.test(local)
    ? local[0].toUpperCase() + local.slice(1).toLowerCase() : 'Alex';
  return {
    title: `Prep: ${m.title}`,
    persona: `${name}, a senior stakeholder at ${deal?.account || company} (${domains.join(', ')}). Busy, practical, and responsible for the outcome of this project.`,
    situation: `This is the meeting "${m.title}". ${deal
      ? `There is an open opportunity "${deal.name}" in the ${deal.stage} stage${deal.amount ? ` worth about $${Math.round(deal.amount).toLocaleString('en-US')}` : ''}${deal.close_date ? `, expected to close ${deal.close_date}` : ''}.`
      : 'There is no deal in the CRM yet. This may be an early conversation.'}`,
    objective: `${g.headline}: leave the meeting with a clear, agreed next step.`,
    key_points: g.keyPoints,
  };
}

export function getRoleplay(db, userId, id) {
  const rp = db.prepare('SELECT * FROM roleplays WHERE id = ? AND user_id = ?').get(id, userId);
  if (!rp) throw new HttpError(404, 'Role-play not found');
  return {
    id: rp.id, title: rp.title, persona: rp.persona, situation: rp.situation, objective: rp.objective,
    key_points: JSON.parse(rp.key_points), difficulty: rp.difficulty, status: rp.status, source: rp.source,
    transcript: JSON.parse(rp.transcript), score: rp.score, feedback: rp.feedback ? JSON.parse(rp.feedback) : null,
    buyerName: buyerName(rp.persona), maxTurns: MAX_REP_TURNS, created_at: rp.created_at,
  };
}

function loadRow(db, userId, id) {
  const rp = db.prepare('SELECT * FROM roleplays WHERE id = ? AND user_id = ?').get(id, userId);
  if (!rp) throw new HttpError(404, 'Role-play not found');
  return rp;
}

// ---------- Conversation ----------

/** The buyer picks up the call. Called once when the role-play starts. */
export async function openCall(db, userId, id) {
  const rp = loadRow(db, userId, id);
  const stage = '[The call connects. Open the call the way this buyer would: a short greeting, and if you are busy, say how much time you have.]';
  const { text, apiMessages } = await buyerTurn(rp, [], stage);
  save(db, rp.id, [{ role: 'buyer', text }], apiMessages);
  return { reply: text, ended: false };
}

export async function repSays(db, userId, id, text) {
  const rp = loadRow(db, userId, id);
  if (rp.status !== 'active') throw new HttpError(409, 'This role-play has ended');
  const line = String(text || '').trim();
  if (!line) throw bad('Say something to the buyer');
  if (line.length > 2000) throw bad('That turn is too long. Keep it conversational.');
  const transcript = JSON.parse(rp.transcript);
  if (transcript.filter((t) => t.role === 'rep').length >= MAX_REP_TURNS) throw new HttpError(409, 'Turn limit reached. End the call to get your scorecard.');

  const { text: reply, apiMessages, ended } = await buyerTurn(rp, transcript, line);
  transcript.push({ role: 'rep', text: line }, { role: 'buyer', text: reply });
  save(db, rp.id, transcript, apiMessages);
  const turnsLeft = MAX_REP_TURNS - transcript.filter((t) => t.role === 'rep').length;
  return { reply, ended: ended || turnsLeft <= 0, turnsLeft };
}

function save(db, id, transcript, apiMessages) {
  db.prepare('UPDATE roleplays SET transcript = ?, api_messages = ? WHERE id = ?').run(JSON.stringify(transcript), JSON.stringify(apiMessages), id);
}

async function buyerTurn(rp, transcript, userText) {
  const anthropic = rp.source === 'ai' ? getClient() : null;
  if (anthropic) {
    try {
      // History is append-only: assistant turns are replayed exactly as the API returned them.
      const messages = [...JSON.parse(rp.api_messages), { role: 'user', content: userText }];
      const response = await anthropic.beta.messages.create({
        model: MODEL,
        max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        system: buyerSystem(rp),
        messages,
      });
      if (response.stop_reason === 'refusal') throw new Error('model declined this turn');
      let text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      const ended = text.includes(END_TOKEN);
      text = text.replace(END_TOKEN, '').trim() || '(The buyer ends the call.)';
      return { text, ended, apiMessages: [...messages, { role: 'assistant', content: response.content }] };
    } catch (err) {
      console.error('[roleplay] Claude buyer failed, using scripted buyer for this turn:', err.message);
    }
  }
  const { text, ended } = scriptedBuyer(rp, transcript, userText);
  // Keep the AI history complete (append-only) so a later Claude turn still sees this exchange.
  const apiMessages = rp.source === 'ai'
    ? [...JSON.parse(rp.api_messages), { role: 'user', content: userText }, { role: 'assistant', content: [{ type: 'text', text }] }]
    : JSON.parse(rp.api_messages);
  return { text, ended, apiMessages };
}

// ---------- Offline scripted buyer ----------

const OBJECTIONS = {
  friendly: ['How long does it usually take to get up and running?', 'What would we need from my team to make this work?', 'Do you have customers similar to us?'],
  skeptical: ["We already have something that sort of does this. Why change?", "Honestly I'm not sure this is a priority this quarter.", 'How are you different from Competitor X?', "What's this going to cost us?"],
  tough: ["I've heard this pitch before. What's actually different?", "Your price is going to be a problem. We don't have budget for this.", "I've got five minutes. Why should I care?", 'Every vendor says that. Prove it.'],
};

const GENERIC_FACTS = [
  'A lot of our process is still manual and it slows the team down every month.',
  "We're looking at a couple of options, and I need to show my boss a clear business case.",
  'The final decision sits with me and our CFO. Procurement gets involved above a certain amount.',
  "Ideally we'd have something in place before next quarter.",
];

export function scriptedBuyer(rp, transcript, line) {
  const name = buyerName(rp.persona);
  if (line.startsWith('[The call connects')) {
    return { text: rp.difficulty === 'friendly' ? `Hi, this is ${name}. Thanks for making the time. What did you want to cover?` : `${name} here. I've got about 15 minutes. What's this about?`, ended: false };
  }
  const repTurns = transcript.filter((t) => t.role === 'rep').map((t) => t.text).concat(line);
  const questionsAsked = repTurns.filter((t) => t.includes('?')).length;
  // Only reveal buyer-voice facts; meeting role-plays carry CRM context the buyer wouldn't say out loud.
  const facts = rp.situation.split(/(?<=[.!?])\s+/).filter((f) => f && !/^(This is the meeting|There is (an open|no deal))/.test(f));
  if (!facts.length) facts.push(...GENERIC_FACTS);
  const lower = line.toLowerCase();
  const n = repTurns.length;

  if (/\b(next step|schedule|book|calendar|follow[- ]?up|meeting|demo|pilot|trial|evaluation)\b/.test(lower)) {
    if (questionsAsked >= 2 && n >= 3) return { text: "Okay, that's reasonable. Send me an invite and include my operations lead. Talk soon.", ended: true };
    return { text: "Let's not get ahead of ourselves. I still don't see why this matters for us specifically.", ended: false };
  }
  if (/\b(price|pricing|cost|budget|expensive|discount|\$)/.test(lower)) {
    return { text: rp.difficulty === 'tough' ? "That's well above what I had in mind. Why would I pay that?" : 'Budget is tight this year, so I would need to see clear ROI.', ended: false };
  }
  if (line.includes('?')) {
    const fact = facts[(questionsAsked - 1) % Math.max(1, facts.length)];
    return { text: fact ? `Fair question. ${fact.replace(/\bYou\b/g, 'Your team').replace(/\byou\b/g, 'your team')}` : "Good question. It's mostly about saving my team time.", ended: false };
  }
  const pool = OBJECTIONS[rp.difficulty];
  return { text: pool[(n - 1) % pool.length], ended: false };
}

// ---------- Scorecard ----------

export async function endRoleplay(db, userId, id, day = dayOf()) {
  const rp = loadRow(db, userId, id);
  if (rp.status === 'completed') return { ...getRoleplay(db, userId, id), xpGained: 0, newBadges: [] };
  const transcript = JSON.parse(rp.transcript);
  const repTurns = transcript.filter((t) => t.role === 'rep');
  if (repTurns.length < 2) throw bad('Have at least a couple of exchanges with the buyer before ending the call.');

  const keyPoints = JSON.parse(rp.key_points);
  let card = null;
  const anthropic = rp.source === 'ai' ? getClient() : null;
  if (anthropic) {
    try { card = await gradeWithClaude(anthropic, rp, transcript, keyPoints); } catch (err) { console.error('[roleplay] grading failed, using rubric:', err.message); }
  }
  card ??= gradeWithRubric(transcript, keyPoints);
  card.talk_ratio = talkRatio(transcript);
  card.skill_labels = SKILL_LABELS;

  return tx(db, () => {
    db.prepare("UPDATE roleplays SET status = 'completed', score = ?, feedback = ?, ended_at = datetime('now') WHERE id = ?")
      .run(card.score, JSON.stringify(card), rp.id);
    const rewardedToday = db.prepare("SELECT COUNT(*) AS n FROM xp_events WHERE user_id = ? AND day = ? AND reason LIKE 'AI role-play%'").get(userId, day).n;
    const xpGained = repTurns.length >= 3 && rewardedToday < DAILY_XP_ROLEPLAYS ? Math.round(rp.xp * (card.score >= 70 ? 1 : 0.6)) : 0;
    awardXp(db, userId, xpGained, `AI role-play: ${rp.title}`, day);
    return { ...getRoleplay(db, userId, id), xpGained, newBadges: evaluateBadges(db, userId, day) };
  });
}

export function talkRatio(transcript) {
  const words = (role) => transcript.filter((t) => t.role === role).reduce((s, t) => s + t.text.split(/\s+/).filter(Boolean).length, 0);
  const rep = words('rep');
  const total = rep + words('buyer');
  return total ? Math.round((rep / total) * 100) : 0;
}

async function gradeWithClaude(anthropic, rp, transcript, keyPoints) {
  const buyer = buyerName(rp.persona);
  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCORECARD_SCHEMA } },
    system: `You are an expert B2B sales coach grading a recorded practice call between a sales rep and a buyer (the buyer was simulated).
Grade only the REP. Be specific, quote the rep's words, and be encouraging but honest.
Skill scores are 0-10. Overall score 0-100: 90+ customer-ready, 75-89 solid, 50-74 important gaps, below 50 needs rework.
Consider: quality and depth of discovery, listening and reflecting back, linking value to the buyer's stated pain, how objections were handled, and whether a concrete next step was secured.`,
    messages: [{
      role: 'user',
      content: `<scenario>
Buyer persona: ${rp.persona}
Situation: ${rp.situation}
Rep's objective: ${rp.objective}
Buyer difficulty: ${rp.difficulty}
Key points the rep should cover:
${keyPoints.map((k) => `- ${k}`).join('\n')}
</scenario>

<transcript>
${transcript.map((t) => `${t.role === 'rep' ? 'REP' : buyer.toUpperCase()}: ${t.text}`).join('\n')}
</transcript>

Grade the rep's performance.`,
    }],
  });
  if (response.stop_reason === 'refusal') throw new Error('model declined to grade');
  if (response.stop_reason === 'max_tokens') throw new Error('grading truncated');
  const card = JSON.parse(response.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  card.score = Math.max(0, Math.min(100, Math.round(card.score)));
  card.source = 'ai';
  return card;
}

export function gradeWithRubric(transcript, keyPoints) {
  const repText = transcript.filter((t) => t.role === 'rep').map((t) => t.text).join('\n');
  const base = scoreWithRubric(keyPoints, repText);
  const repTurns = transcript.filter((t) => t.role === 'rep');
  const questions = repTurns.filter((t) => t.text.includes('?')).length;
  const ratio = talkRatio(transcript);
  const empathy = /\b(understand|makes sense|fair|appreciate|hear you|sounds like)\b/i.test(repText);
  const nextStep = /\b(next step|schedule|book|calendar|follow[- ]?up|meeting|demo|pilot|trial)\b/i.test(repText);
  const clamp = (x) => Math.max(0, Math.min(10, Math.round(x)));
  const skills = {
    discovery: { score: clamp(questions * 2.5), comment: `${questions} question${questions === 1 ? '' : 's'} asked across ${repTurns.length} turns.` },
    listening: { score: clamp((empathy ? 6 : 3) + (ratio <= 60 ? 3 : 0)), comment: `You spoke ${ratio}% of the time${ratio > 60 ? '. Aim for under 60% and let the buyer talk' : ''}.` },
    value: { score: clamp(/\d/.test(repText) ? 7 : 4), comment: /\d/.test(repText) ? 'Used concrete numbers.' : 'Quantify the impact with a metric or proof point.' },
    objection_handling: { score: clamp(empathy ? 7 : 4), comment: empathy ? 'Acknowledged concerns before responding.' : 'Acknowledge objections before answering them.' },
    next_steps: { score: nextStep ? 9 : 2, comment: nextStep ? 'Proposed a concrete next step.' : 'No next step proposed. Always leave with a dated commitment.' },
  };
  const skillAvg = SKILLS.reduce((s, k) => s + skills[k].score, 0) / SKILLS.length;
  const score = Math.round(base.score * 0.5 + skillAvg * 10 * 0.5);
  const best = repTurns.find((t) => t.text.includes('?'))?.text || repTurns[0]?.text || '';
  return {
    score,
    summary: score >= 75 ? 'Strong call: you guided the conversation and moved it forward.' : 'Good practice. Focus on more discovery and a clearer next step.',
    skills,
    strengths: base.strengths,
    improvements: base.improvements,
    key_points_covered: base.key_points_covered,
    key_points_missed: base.key_points_missed,
    best_moment: best.slice(0, 200),
    missed_opportunity: questions < 2 ? 'You moved to pitching before understanding the buyer\'s situation.' : nextStep ? '' : 'The call ended without a concrete next step.',
    better_line: questions < 2 ? '"Before I share anything, what\'s prompting you to look at this now?"' : '"Would it make sense to book 30 minutes next week with your team to map this out?"',
    source: 'rubric',
  };
}

// ---------- Routes ----------

export function registerRoleplays({ db, route, today }) {
  route('GET', '/api/roleplays', [], ({ user }) => db.prepare(`SELECT id, title, difficulty, status, score, source, created_at FROM roleplays
    WHERE user_id = ? ORDER BY id DESC LIMIT 20`).all(user.id));

  route('POST', '/api/roleplays', [], async ({ user, body }) => {
    if (!body.scenarioId && !body.meetingId) throw bad('Choose a scenario or a meeting');
    const rp = createRoleplay(db, user.id, { scenarioId: Number(body.scenarioId) || null, meetingId: Number(body.meetingId) || null, difficulty: body.difficulty || 'skeptical' });
    await openCall(db, user.id, rp.id);
    return getRoleplay(db, user.id, rp.id);
  });

  route('GET', '/api/roleplays/:id', [], ({ user, params }) => getRoleplay(db, user.id, params.id));
  route('POST', '/api/roleplays/:id/message', [], ({ user, params, body }) => repSays(db, user.id, params.id, body.text));
  route('POST', '/api/roleplays/:id/end', [], ({ user, params }) => endRoleplay(db, user.id, params.id, today()));
}
