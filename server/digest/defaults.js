// The weekly rhythm (execution guide §3) and the default rotations. Day themes stay fixed so reps
// learn the format; the content inside them rotates. Every list can be overridden in the environment.

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];

export const DAY_INFO = {
  mon: { name: 'Monday', short: 'Mon', theme: 'Speak the language', color: '#5B3DF5', tint: '#ECE8FF', dark: '#9B86FF', darkTint: '#231F4F',
    pillars: ['Industry knowledge', "What's new (market)", 'Congress and event calendar', 'Regulatory and compliance context'],
    blurb: "Industry knowledge and what's new in the market." },
  tue: { name: 'Tuesday', short: 'Tue', theme: 'Know the buyer', color: '#0B8F9C', tint: '#DDF3F5', dark: '#47C4D0', darkTint: '#11353C',
    pillars: ['Personas and pain points', 'Discovery', 'Customer language'],
    blurb: 'Persona pain points and discovery.' },
  wed: { name: 'Wednesday', short: 'Wed', theme: 'Win the room', color: '#D93F4C', tint: '#FDE6E8', dark: '#FF7A85', darkTint: '#4A1F27',
    pillars: ['Objection handling', 'Competitor knowledge', 'Packaging and services'],
    blurb: 'Objection handling and competitor knowledge.' },
  thu: { name: 'Thursday', short: 'Thu', theme: 'See it in use', color: '#B87D00', tint: '#FFF1CC', dark: '#F2B84B', darkTint: '#3F3010',
    pillars: ['Use cases', "What's new (product)"],
    blurb: "Use cases and what's new in the product." },
  fri: { name: 'Friday', short: 'Fri', theme: 'Learn from the field', color: '#188A5E', tint: '#DDF3EA', dark: '#4CCB9A', darkTint: '#12382B',
    pillars: ['Win and loss stories', 'Customer proof points', 'Clip of the week', 'Weekly recap'],
    blurb: 'Win and loss stories, plus the weekly recap.' },
};

// Prezent's own solution pages, comparison pages and use cases (guide §3, "Rotation").
export const DEFAULT_PERSONAS = ['Medical Affairs', 'Commercial and Marketing', 'Research and Development', 'Data and Analytics', 'Learning and Development', 'Chief of Staff'];
export const DEFAULT_COMPETITORS = [
  'Microsoft Copilot',
  'General AI deck builders (Gamma, Beautiful.ai, Canva, Pitch)',
  'Enablement and brand tools (Seismic, Templafy, Matik)',
  'Agencies and design services (24Slides, freelancers, in-house design)',
];
export const DEFAULT_USE_CASES = ['Publications to presentations', 'MSL decks', 'Advisory boards', 'Launch readiness', 'National sales meeting'];
export const DEFAULT_OBJECTION_TRACKERS = ['Agency', 'MLR', 'Budget', 'Security'];

// Approved Drive library: subfolder (or file) names map to a category; each day draws on its categories first.
export const DRIVE_CATEGORIES = [
  ['glossary', /glossar|terms/i],
  ['calendar', /calendar|congress|event/i],
  ['compliance', /regulat|complian|legal|mlr|governance/i],
  ['persona', /persona/i],
  ['battle_card', /battle|competit/i],
  ['packaging', /packag|pricing|services|credits/i],
  ['use_case', /use.?case/i],
  ['release', /release|what.?s.?new|product/i],
  ['case_study', /case.?stud|customer.?stor|proof|reference/i],
];

export const DAY_CATEGORIES = {
  mon: ['glossary', 'calendar', 'compliance'],
  tue: ['persona', 'use_case'],
  wed: ['battle_card', 'packaging', 'compliance'],
  thu: ['use_case', 'release', 'case_study'],
  fri: ['case_study'],
};

/** Competitor names to look for in text: "General AI deck builders (Gamma, Canva)" -> ["Gamma", "Canva"]. */
export function competitorNames(entries) {
  return entries.flatMap((e) => {
    const inner = e.match(/\(([^)]+)\)/);
    return inner ? inner[1].split(',').map((s) => s.trim()) : [e.replace(/^Microsoft\s+/i, '').trim(), e.trim()];
  }).filter((n) => n.length >= 3 && !/freelancers|in-house/i.test(n));
}

/** Deal size bands shown instead of amounts (guide §6, customer data). */
export function sizeBand(amount) {
  if (amount == null) return 'Unknown size';
  if (amount < 25_000) return 'Under $25K';
  if (amount < 100_000) return '$25K to $100K';
  if (amount < 250_000) return '$100K to $250K';
  return '$250K+';
}
