// Pitch coaching: scores a rep's written (or transcribed) pitch against a scenario.
// Uses Claude when ANTHROPIC_API_KEY is set; otherwise falls back to a
// deterministic rubric so the platform works fully offline.
import Anthropic from '@anthropic-ai/sdk';

export const MODEL = process.env.COACH_MODEL || 'claude-opus-5-5';

const FEEDBACK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'summary', 'strengths', 'improvements', 'key_points_covered', 'key_points_missed', 'rewrite_suggestion'],
  properties: {
    score: { type: 'integer', description: 'Overall score from 0 to 100' },
    summary: { type: 'string', description: 'Two-sentence overall assessment' },
    strengths: { type: 'array', items: { type: 'string' } },
    improvements: { type: 'array', items: { type: 'string' } },
    key_points_covered: { type: 'array', items: { type: 'string' } },
    key_points_missed: { type: 'array', items: { type: 'string' } },
    rewrite_suggestion: { type: 'string', description: 'A stronger version of one weak sentence from the pitch' },
  },
};

const SYSTEM = `You are an experienced B2B sales coach reviewing a rep's practice pitch.
Grade it against the scenario's objective and key points, and against good discovery and value-selling practice:
tailoring to the persona, a clear business outcome, handling of likely objections, concision, and a concrete next step.
Be specific and encouraging; quote the rep's own words when pointing out what to change.
Scoring guide: 90+ ready for a real customer, 75-89 solid with minor gaps, 50-74 missing important elements, below 50 needs rework.`;

let client = null;
export function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  client ??= new Anthropic();
  return client;
}

export function aiEnabled() {
  return !!process.env.ANTHROPIC_API_KEY;
}

export async function scorePitch(scenario, pitch) {
  const keyPoints = JSON.parse(scenario.key_points);
  const anthropic = getClient();
  if (anthropic) {
    try {
      return { ...(await scoreWithClaude(anthropic, scenario, keyPoints, pitch)), source: 'ai' };
    } catch (err) {
      console.error('[coach] Claude scoring failed, using rubric fallback:', err.message);
    }
  }
  return { ...scoreWithRubric(keyPoints, pitch), source: 'rubric' };
}

async function scoreWithClaude(anthropic, scenario, keyPoints, pitch) {
  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: FEEDBACK_SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `<scenario>
Title: ${scenario.title}
Buyer persona: ${scenario.persona}
Situation: ${scenario.situation}
Rep's objective: ${scenario.objective}
Key points the rep should cover:
${keyPoints.map((k) => `- ${k}`).join('\n')}
</scenario>

<pitch>
${pitch}
</pitch>

Review this pitch.`,
    }],
  });

  if (response.stop_reason === 'refusal') throw new Error('model declined to score this pitch');
  if (response.stop_reason === 'max_tokens') throw new Error('response truncated');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = JSON.parse(text);
  parsed.score = Math.max(0, Math.min(100, Math.round(parsed.score)));
  return parsed;
}

// ---------- Offline rubric ----------

export const STOPWORDS = new Set('a an the and or of to for in on with your you our we is are be by how why what that this it as at from their them they'.split(' '));

function keywords(text) {
  return text.toLowerCase().match(/[a-z0-9%$]+/g)?.filter((w) => w.length > 2 && !STOPWORDS.has(w)) ?? [];
}

const stem = (w) => w.replace(/(ing|ed|es|s)$/, '');

// Abstract key points ("share a proof point") are recognised by what they look like in a pitch.
const CONCEPTS = [
  { when: /quantif|saving|roi|cost|value|impact|metric/i, signal: /\d|%|\$/ },
  { when: /proof|customer|case stud|reference|story/i, signal: /\b(customers?|clients?|teams? like|companies like|case study|helped|cut|reduced|increased)\b/i },
  { when: /question|discover|explore|ask about|uncover/i, signal: /\?/ },
  { when: /next (step|meeting)|propose|pilot|evaluation|follow[- ]?up|secure/i, signal: /\b(next step|schedule|book|calendar|follow[- ]?up|meeting|demo|pilot|trial|evaluation|call on)\b/i },
  { when: /acknowledg|empath|concern/i, signal: /\b(understand|hear you|makes sense|fair|appreciate|frustrat|i get|totally get|that's tough)\b/i },
  { when: /goal|reference her|reference his|their priorit/i, signal: /\b(you (mentioned|said|shared|want)|your goal|your priority|you're aiming)\b/i },
  { when: /trade|concession|instead of a (straight )?discount/i, signal: /\b(in exchange|in return|if you (can|could)|multi-year|longer term|two-year|2-year|commit)\b/i },
  { when: /time to value|faster|speed|quick/i, signal: /\b(weeks?|days?|faster|quick(ly)?|live in)\b/i },
  { when: /integrat/i, signal: /integrat/i },
];

export function scoreWithRubric(keyPoints, pitch) {
  const pitchStems = new Set(keywords(pitch).map(stem));
  const covered = [];
  const missed = [];
  for (const kp of keyPoints) {
    const kw = [...new Set(keywords(kp).map(stem))];
    const hits = kw.filter((w) => pitchStems.has(w)).length;
    const overlap = kw.length && hits / kw.length >= 0.5;
    const concept = CONCEPTS.some((c) => c.when.test(kp) && c.signal.test(pitch));
    (overlap || concept ? covered : missed).push(kp);
  }
  const words = pitch.trim().split(/\s+/).filter(Boolean).length;
  const asksQuestion = /\?/.test(pitch);
  const hasNextStep = /\b(next step|schedule|book|calendar|follow[- ]?up|meeting|demo|call on|pilot|trial)\b/i.test(pitch);
  const quantifies = /\d/.test(pitch);

  const coverage = keyPoints.length ? covered.length / keyPoints.length : 1;
  let score = 55 * coverage;
  score += asksQuestion ? 12 : 0;
  score += hasNextStep ? 13 : 0;
  score += quantifies ? 10 : 0;
  score += words >= 60 && words <= 260 ? 10 : words >= 30 ? 5 : 0;
  score = Math.round(Math.min(100, score));

  const strengths = [];
  const improvements = [];
  if (covered.length) strengths.push(`Covered ${covered.length} of ${keyPoints.length} key points.`);
  if (asksQuestion) strengths.push('Engaged the buyer with a question.'); else improvements.push('Ask at least one open discovery question to involve the buyer.');
  if (hasNextStep) strengths.push('Closed with a clear next step.'); else improvements.push('End with a concrete, time-bound next step (e.g. "Can we book 30 minutes Thursday?").');
  if (quantifies) strengths.push('Used numbers to make the value tangible.'); else improvements.push('Quantify the impact — a metric or customer proof point makes value real.');
  if (words < 60) improvements.push('Expand a little: the pitch is too thin to build conviction.');
  if (words > 260) improvements.push('Tighten it: aim for a pitch you could deliver in under two minutes.');
  for (const m of missed) improvements.push(`Work in: ${m}`);

  return {
    score,
    summary: score >= 75
      ? 'Solid pitch that hits most of what this buyer needs to hear.'
      : 'Good start — focus on the missing key points and a sharper close.',
    strengths,
    improvements,
    key_points_covered: covered,
    key_points_missed: missed,
    rewrite_suggestion: '',
  };
}
