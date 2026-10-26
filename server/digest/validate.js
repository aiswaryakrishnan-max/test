// Validators (execution guide §6 and §8): every fact maps to a known source, word limits hold,
// quiz answers are traceable, proof figures match the case study, competitor content is phrased as
// questions, and no customer account is named unless it is an approved reference.

const words = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean).length;
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, name) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(name.toLowerCase())}($|[^\\p{L}\\p{N}])`, 'u').test(text.toLowerCase());

function strings(node, path = '', out = []) {
  if (typeof node === 'string') out.push({ path, text: node });
  else if (Array.isArray(node)) node.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) strings(v, path ? `${path}.${k}` : k, out);
  return out;
}

/** Every source_ids / source_id in the card, with where it sits. */
function citations(node, path = '', out = []) {
  if (Array.isArray(node)) node.forEach((v, i) => citations(v, `${path}[${i}]`, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const p = path ? `${path}.${k}` : k;
      if (k === 'source_ids' || k === 'strength_source_ids') out.push({ path: p, ids: Array.isArray(v) ? v : [], key: k, owner: node });
      else if (k === 'source_id') out.push({ path: p, ids: v ? [v] : [], key: k, owner: node });
      else citations(v, p, out);
    }
  }
  return out;
}

export function citedIds(card) {
  return [...new Set(citations(card).flatMap((c) => c.ids))];
}

/**
 * @param ctx.catalog       {id: {type, category, text?}} sources this week's cards may cite
 * @param ctx.accountNames  CRM account names (never shown unless approved)
 * @param ctx.allowedNames  approved reference customers (may be named in text, never in a public image)
 */
export function validateCard(day, card, ctx) {
  const issues = [];
  const err = (path, message) => issues.push({ level: 'error', path, message });
  const warn = (path, message) => issues.push({ level: 'warn', path, message });
  if (!card || typeof card !== 'object') return [{ level: 'error', path: '', message: 'Card is empty' }];

  // Length (guide §6)
  if (!card.headline?.trim()) err('headline', 'Missing headline');
  else if (words(card.headline) > 12) err('headline', `Headline is ${words(card.headline)} words; the limit is 12`);
  const points = card.body_points || [];
  if (points.length < 2 || points.length > 3) warn('body_points', `Use 2 or 3 points (has ${points.length})`);
  const bodyWords = points.reduce((n, p) => n + words(p.text), 0);
  if (bodyWords > 120) err('body_points', `Body is ${bodyWords} words; the limit is 120`);
  if (!card.say_it?.trim()) err('say_it', 'Missing "say it on your next call" line');
  else if (words(card.say_it) > 30) err('say_it', `"Say it" line is ${words(card.say_it)} words; the limit is 30`);

  // Sources: every fact has a source id, and only known sources are cited
  for (const c of citations(card)) {
    if (c.key === 'strength_source_ids' && !c.owner.strength?.trim()) continue;
    if (!c.ids.length) { err(c.path, 'No source: facts without a source are rejected'); continue; }
    for (const id of c.ids) if (!ctx.catalog[id]) err(c.path, `Unknown source "${id}"`);
  }

  // Quiz
  const quiz = card.quiz || [];
  const wanted = day === 'fri' ? 3 : 1;
  if (quiz.length !== wanted) err('quiz', `Needs exactly ${wanted} question${wanted > 1 ? 's' : ''} (has ${quiz.length})`);
  const cited = new Set(citations({ ...card, quiz: [] }).flatMap((c) => c.ids));
  quiz.forEach((q, i) => {
    const p = `quiz[${i}]`;
    if (!q.question?.trim()) err(p, 'Missing question');
    if (!Array.isArray(q.options) || q.options.length < 3 || q.options.length > 6) err(`${p}.options`, 'Needs 3 to 6 options');
    else if (!Number.isInteger(q.answer_index) || q.answer_index < 0 || q.answer_index >= q.options.length) err(`${p}.answer_index`, 'Answer index is out of range');
    if (!q.explanation?.trim()) err(`${p}.explanation`, 'Missing explanation');
    if (day !== 'fri' && q.source_id && ctx.catalog[q.source_id] && !cited.has(q.source_id)) warn(`${p}.source_id`, 'The answer\'s source is not cited elsewhere on the card, so it may not be answerable from the card');
  });

  // Day-specific rules
  if (day === 'mon' && (card.terms || []).length !== 5) warn('terms', `Use 5 terms (has ${(card.terms || []).length})`);
  if (day === 'tue') {
    if ((card.discovery || []).length !== 4) warn('discovery', `Use 4 discovery questions (has ${(card.discovery || []).length})`);
    (card.customer_language || []).forEach((c, i) => {
      if (c.source_ids?.some((id) => ctx.catalog[id] && ctx.catalog[id].type !== 'gong')) err(`customer_language[${i}]`, 'Customer language must come from Gong calls');
    });
    const n = card.visual?.steps?.length || 0;
    const v = card.visual || {};
    if ((v.loop_from !== -1 && (v.loop_from < 0 || v.loop_from >= n)) || (v.loop_to !== -1 && (v.loop_to < 0 || v.loop_to >= n))) err('visual', 'Rework loop points to a step that does not exist');
    (v.friction || []).forEach((f, i) => { if (f.step < 0 || f.step >= n) err(`visual.friction[${i}]`, 'Friction point is on a step that does not exist'); });
  }
  if (day === 'wed') {
    (card.competitors || []).forEach((c, i) => {
      if (!String(c.question || '').trim().endsWith('?')) err(`competitors[${i}].question`, 'Competitor content must be a discovery question');
      if (c.strength?.trim() && !(c.strength_source_ids || []).some((id) => ctx.catalog[id]?.category === 'battle_card')) {
        err(`competitors[${i}].strength`, 'A statement about a competitor needs an approved battle card as its source');
      }
    });
  }
  if (day === 'fri') {
    (card.proof_points || []).forEach((p, i) => {
      const src = ctx.catalog[p.source_id];
      if (!src) return;
      if (src.category !== 'case_study') err(`proof_points[${i}]`, 'Customer numbers must come from an approved case study');
      else if (!norm(src.text).includes(norm(p.figure))) err(`proof_points[${i}].figure`, `"${p.figure}" is not worded as published in "${src.title}"`);
    });
    (card.stories || []).forEach((s, i) => {
      if (ctx.catalog[s.source_id] && ctx.catalog[s.source_id].type !== 'sfdc') err(`stories[${i}]`, 'Win and loss stories must come from Salesforce');
    });
  }
  if (day === 'mon' && (card.visual?.series || []).some((s) => (s.points || []).length < 2)) err('visual.series', 'Each chart series needs at least 2 points');

  // Customer data: no account names (guide §6); never in a visual, which may be served at a public URL (§7)
  const allowed = new Set((ctx.allowedNames || []).map((n) => n.toLowerCase()));
  for (const { path, text } of strings(card)) {
    for (const name of ctx.accountNames || []) {
      if (name.length < 4 || !mentions(text, name)) continue;
      if (path.startsWith('visual')) err(path, `Names customer "${name}" in the visual, which is published as an image`);
      else if (!allowed.has(name.toLowerCase())) err(path, `Names customer account "${name}"; use segment and deal size, or add them as an approved reference`);
    }
  }
  return issues;
}

/** Cards that always need a human: competitor content and win/loss stories (guide §5). */
export function isSensitive(day, card, competitorNames) {
  if (day === 'wed' || day === 'fri') return true;
  const text = strings(card).map((s) => s.text).join('\n');
  return competitorNames.some((n) => mentions(text, n));
}
