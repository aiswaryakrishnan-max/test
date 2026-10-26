// Wednesday: draft next week's topic list. Rotations keep the day themes fresh (persona, competitor,
// use case); Gong tracker trends can override them. The enablement lead reviews and edits the plan.
import { daysBetween } from '../engagement.js';
import { DEFAULT_COMPETITORS, DEFAULT_OBJECTION_TRACKERS, DEFAULT_PERSONAS, DEFAULT_USE_CASES, competitorNames } from './defaults.js';
import { trendingTrackers } from './sources.js';

export function rotations(cfg) {
  return {
    personas: cfg.personas.length ? cfg.personas : DEFAULT_PERSONAS,
    competitors: cfg.competitors.length ? cfg.competitors : DEFAULT_COMPETITORS,
    useCases: cfg.useCases.length ? cfg.useCases : DEFAULT_USE_CASES,
    objectionTrackers: cfg.gong.objectionTrackers.length ? cfg.gong.objectionTrackers : DEFAULT_OBJECTION_TRACKERS,
  };
}

/** Same item for the whole week, next item the following week. */
export function rotationPick(list, week) {
  const n = Math.floor(daysBetween('2026-01-05', week) / 7);
  return list[((n % list.length) + list.length) % list.length];
}

export function buildPlan({ week, cfg, trackers = null }) {
  const rot = rotations(cfg);
  let competitor = rotationPick(rot.competitors, week);
  let competitorReason = 'rotation';
  let objection = null;
  const candidates = { personas: rot.personas, competitors: rot.competitors, useCases: rot.useCases, objections: [], competitorMentions: [] };
  if (trackers) {
    candidates.objections = trendingTrackers(trackers, rot.objectionTrackers);
    const compTrackers = cfg.gong.competitorTrackers.length ? cfg.gong.competitorTrackers : competitorNames(rot.competitors);
    candidates.competitorMentions = trendingTrackers(trackers, compTrackers);
    // A competitor that is suddenly coming up on calls beats the rotation.
    const hot = candidates.competitorMentions.find((t) => t.current >= 2 && t.current > t.previous);
    const entry = hot && rot.competitors.find((c) => c.toLowerCase().includes(hot.name.toLowerCase()));
    if (entry) { competitor = entry; competitorReason = `${hot.name} came up ${hot.current} times on calls this week (${hot.previous} the week before)`; }
    const top = candidates.objections.find((t) => t.current > 0);
    if (top) objection = { name: top.name, reason: `${top.current} tracker hits this week, ${top.previous} the week before` };
  }
  return {
    week,
    focus: '',            // Monday's market focus, e.g. "ESMO 2026, oncology"; empty lets the writer pick from the research
    persona: rotationPick(rot.personas, week),
    competitor,
    competitorReason,
    useCase: rotationPick(rot.useCases, week),
    objection: objection?.name || '',
    objectionReason: objection?.reason || 'No Gong tracker data; the writer picks the most common objection in the sources',
    notes: '',            // anything else the lead wants the writer to know
    candidates,
  };
}

const EDITABLE = ['focus', 'persona', 'competitor', 'useCase', 'objection', 'notes'];

export function updatePlan(plan, patch) {
  const next = { ...plan };
  for (const k of EDITABLE) if (typeof patch[k] === 'string') next[k] = patch[k].trim().slice(0, 300);
  if (patch.competitor && patch.competitor !== plan.competitor) next.competitorReason = 'picked by the enablement lead';
  if (patch.objection && patch.objection !== plan.objection) next.objectionReason = 'picked by the enablement lead';
  return next;
}
