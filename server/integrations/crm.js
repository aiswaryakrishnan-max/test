// CRM sync: pulls opportunities/deals from Salesforce or HubSpot (read-only) and links them to reps by email.
// Used to (1) put win rate & pipeline next to readiness for managers and
// (2) recommend training for the stage each rep's live deals are in.
import { tx } from '../db.js';
import { HttpError } from '../errors.js';
import { addDays, dayOf, daysBetween, readiness } from '../engagement.js';
import { config } from './config.js';
import { tokenRequest } from './oauth.js';

async function getJson(url, headers) {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = Array.isArray(data) ? data[0]?.message : data.message || data.error;
    throw new HttpError(502, `CRM request failed (${res.status}): ${msg || url}`);
  }
  return data;
}

// ---------- HubSpot (private app access token) ----------
export async function fetchHubspotDeals(cfg) {
  if (!cfg.hubspotToken) throw new HttpError(400, 'HUBSPOT_ACCESS_TOKEN is not set');
  const auth = { Authorization: `Bearer ${cfg.hubspotToken}` };
  const base = cfg.hubspotBase;

  const owners = new Map();
  for (let after = ''; ;) {
    const page = await getJson(`${base}/crm/v3/owners?limit=100${after ? `&after=${after}` : ''}`, auth);
    for (const o of page.results || []) owners.set(String(o.id), String(o.email || '').toLowerCase());
    after = page.paging?.next?.after;
    if (!after) break;
  }

  const stages = new Map();
  const pipelines = await getJson(`${base}/crm/v3/pipelines/deals`, auth);
  for (const p of pipelines.results || []) {
    for (const s of p.stages || []) {
      stages.set(s.id, { label: s.label, isClosed: s.metadata?.isClosed === 'true', isWon: Number(s.metadata?.probability) === 1 });
    }
  }

  const props = 'dealname,amount,dealstage,closedate,hubspot_owner_id,hs_is_closed_won';
  const deals = [];
  for (let after = ''; ;) {
    const page = await getJson(`${base}/crm/v3/objects/deals?limit=100&archived=false&properties=${props}${after ? `&after=${after}` : ''}`, auth);
    for (const d of page.results || []) {
      const p = d.properties || {};
      const stage = stages.get(p.dealstage) || { label: p.dealstage, isClosed: false, isWon: false };
      const isWon = p.hs_is_closed_won != null ? p.hs_is_closed_won === 'true' : stage.isWon;
      deals.push({
        externalId: String(d.id),
        ownerEmail: owners.get(String(p.hubspot_owner_id)) || null,
        name: p.dealname || `Deal ${d.id}`,
        account: null,
        amount: p.amount ? Number(p.amount) : null,
        stage: stage.label,
        closeDate: p.closedate ? String(p.closedate).slice(0, 10) : null,
        isClosed: stage.isClosed || isWon,
        isWon,
      });
    }
    after = page.paging?.next?.after;
    if (!after) break;
  }
  return deals;
}

// ---------- Salesforce (OAuth client-credentials flow on a connected app) ----------
export async function fetchSalesforceDeals(cfg) {
  if (!cfg.salesforceDomain || !cfg.salesforceClientId || !cfg.salesforceClientSecret) {
    throw new HttpError(400, 'SALESFORCE_DOMAIN, SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET are required');
  }
  const token = await tokenRequest(`${cfg.salesforceDomain}/services/oauth2/token`, {
    grant_type: 'client_credentials',
    client_id: cfg.salesforceClientId,
    client_secret: cfg.salesforceClientSecret,
  });
  const instance = token.instance_url || cfg.salesforceDomain;
  const auth = { Authorization: `Bearer ${token.access_token}` };
  const soql = `SELECT Id, Name, Amount, StageName, CloseDate, IsClosed, IsWon, Owner.Email, Account.Name
    FROM Opportunity WHERE LastModifiedDate = LAST_N_DAYS:365`.replace(/\s+/g, ' ');

  const deals = [];
  let next = `/services/data/${cfg.salesforceApiVersion}/query?q=${encodeURIComponent(soql)}`;
  while (next) {
    const page = await getJson(`${instance}${next}`, auth);
    for (const r of page.records || []) {
      deals.push({
        externalId: r.Id,
        ownerEmail: r.Owner?.Email ? r.Owner.Email.toLowerCase() : null,
        name: r.Name,
        account: r.Account?.Name || null,
        amount: r.Amount ?? null,
        stage: r.StageName,
        closeDate: r.CloseDate,
        isClosed: !!r.IsClosed,
        isWon: !!r.IsWon,
      });
    }
    next = page.done ? null : page.nextRecordsUrl;
  }
  return deals;
}

const ADAPTERS = { hubspot: fetchHubspotDeals, salesforce: fetchSalesforceDeals };

export function logRun(db, kind, status, detail) {
  db.prepare('INSERT INTO integration_runs (kind, status, detail) VALUES (?, ?, ?)').run(kind, status, detail);
}

/** Pull deals from the configured CRM and upsert them. Deals for unknown emails are kept but unlinked. */
export async function syncCrm(db, cfg = config.crm()) {
  const adapter = ADAPTERS[cfg.provider];
  if (!adapter) throw new HttpError(400, 'No CRM configured. Set CRM_PROVIDER to "salesforce" or "hubspot".');
  try {
    const deals = await adapter(cfg);
    const users = new Map(db.prepare('SELECT id, email FROM users').all().map((u) => [u.email.toLowerCase(), u.id]));
    let linked = 0;
    tx(db, () => {
      const upsert = db.prepare(`
        INSERT INTO crm_deals (provider, external_id, user_id, owner_email, name, account, amount, stage, close_date, is_closed, is_won, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT (provider, external_id) DO UPDATE SET
          user_id = excluded.user_id, owner_email = excluded.owner_email, name = excluded.name, account = excluded.account,
          amount = excluded.amount, stage = excluded.stage, close_date = excluded.close_date,
          is_closed = excluded.is_closed, is_won = excluded.is_won, synced_at = excluded.synced_at`);
      for (const d of deals) {
        const userId = d.ownerEmail ? users.get(d.ownerEmail) ?? null : null;
        if (userId) linked++;
        upsert.run(cfg.provider, d.externalId, userId, d.ownerEmail, d.name, d.account, d.amount, d.stage, d.closeDate, d.isClosed ? 1 : 0, d.isWon ? 1 : 0);
      }
    });
    const detail = `Synced ${deals.length} deals from ${cfg.provider} (${linked} linked to PitchPulse users)`;
    logRun(db, 'crm_sync', 'ok', detail);
    return { provider: cfg.provider, deals: deals.length, linked, detail };
  } catch (err) {
    logRun(db, 'crm_sync', 'error', err.message);
    throw err;
  }
}

// ---------- Insights ----------

/** Pipeline and win-rate stats per rep over a trailing window. */
export function repCrmStats(db, userId, today = dayOf(), windowDays = 180) {
  const since = addDays(today, -windowDays);
  const r = db.prepare(`
    SELECT
      SUM(CASE WHEN is_closed = 0 THEN 1 ELSE 0 END) AS openDeals,
      COALESCE(SUM(CASE WHEN is_closed = 0 THEN amount END), 0) AS pipeline,
      SUM(CASE WHEN is_closed = 1 AND is_won = 1 AND close_date >= ? THEN 1 ELSE 0 END) AS won,
      COALESCE(SUM(CASE WHEN is_closed = 1 AND is_won = 1 AND close_date >= ? THEN amount END), 0) AS wonAmount,
      SUM(CASE WHEN is_closed = 1 AND close_date >= ? THEN 1 ELSE 0 END) AS closed
    FROM crm_deals WHERE user_id = ?`).get(since, since, since, userId);
  return {
    openDeals: r.openDeals || 0,
    pipeline: Math.round(r.pipeline),
    won: r.won || 0,
    wonAmount: Math.round(r.wonAmount),
    winRate: r.closed ? Math.round((r.won / r.closed) * 100) : null,
  };
}

/**
 * Compare reps with high vs low readiness on win rate, a simple, honest way to show
 * whether training lines up with results (correlation, not proof of causation).
 */
export function readinessVsResults(db, userIds, today = dayOf()) {
  const rows = userIds.map((id) => ({ id, readiness: readiness(db, id, today).score, ...repCrmStats(db, id, today) }))
    .filter((r) => r.readiness !== null && r.winRate !== null);
  if (rows.length < 2) return null;
  const sorted = [...rows].sort((a, b) => b.readiness - a.readiness);
  const half = Math.ceil(sorted.length / 2);
  const avg = (xs) => Math.round(xs.reduce((s, x) => s + x.winRate, 0) / xs.length);
  return { topHalfWinRate: avg(sorted.slice(0, half)), bottomHalfWinRate: avg(sorted.slice(half)), reps: rows.length };
}

// Deal stage -> the skill that matters most at that stage, and what "good" looks like in a call.
const STAGE_TOPICS = [
  [/prospect|qualif|discover|lead|new|appointment|connect/i, 'Discovery', 'Run sharp discovery',
    ['Uncover the business problem and its impact', 'Ask about decision process and timeline', 'Agree a concrete next step']],
  [/demo|present|evaluat|technical|solution|value|proof|poc|trial/i, 'Competitive', 'Win the evaluation',
    ['Tie capabilities to their stated pain', 'Differentiate against alternatives', 'Confirm success criteria', 'Agree a concrete next step']],
  [/propos|quote|pric|negotiat|review/i, 'Objection Handling', 'Hold your price',
    ['Acknowledge and explore pricing concerns', 'Restate quantified business value', 'Trade rather than discount', 'Agree a concrete next step']],
  [/contract|clos|commit|legal|procure|signature|decision/i, 'Deal Management', 'Land the close',
    ['Confirm remaining steps and owners', 'Surface hidden blockers (legal, security, procurement)', 'Agree a signature date']],
];

export function stageGuidance(stage) {
  const m = STAGE_TOPICS.find(([re]) => re.test(stage || '')) || STAGE_TOPICS[0];
  return { topic: m[1], headline: m[2], keyPoints: m[3] };
}

/** The rep's most urgent open deal and the training that best prepares them for its stage. */
export function dealFocus(db, userId, today = dayOf()) {
  const deal = db.prepare(`SELECT * FROM crm_deals WHERE user_id = ? AND is_closed = 0 AND close_date IS NOT NULL
    ORDER BY close_date ASC, amount DESC LIMIT 1`).get(userId);
  if (!deal) return null;
  const g = stageGuidance(deal.stage);
  const module = db.prepare(`SELECT id, title FROM modules WHERE topic = ? ORDER BY
      (id IN (SELECT module_id FROM module_completions WHERE user_id = ?)) ASC, id LIMIT 1`).get(g.topic, userId);
  return {
    deal: { id: deal.id, name: deal.name, account: deal.account, stage: deal.stage, amount: deal.amount, closeDate: deal.close_date, daysToClose: daysBetween(today, deal.close_date) },
    topic: g.topic,
    headline: g.headline,
    module,
  };
}

export function scheduleCrmSync(db) {
  const cfg = config.crm();
  if (!ADAPTERS[cfg.provider]) return null;
  const run = () => syncCrm(db).catch((err) => console.error('[crm] sync failed:', err.message));
  const timer = setInterval(run, cfg.syncMinutes * 60e3);
  timer.unref();
  setTimeout(run, 5e3).unref();
  return timer;
}

export function registerCrm({ db, route, today }) {
  route('POST', '/api/integrations/crm/sync', ['admin'], () => syncCrm(db));

  route('GET', '/api/crm/deals', [], ({ user }) => ({
    stats: repCrmStats(db, user.id, today()),
    focus: dealFocus(db, user.id, today()),
    deals: db.prepare(`SELECT id, name, account, amount, stage, close_date, is_closed, is_won FROM crm_deals
      WHERE user_id = ? ORDER BY is_closed ASC, close_date ASC LIMIT 25`).all(user.id),
  }));
}
