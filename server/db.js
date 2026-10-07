import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('rep', 'manager', 'admin')),
  team_id INTEGER REFERENCES teams(id),
  daily_goal_xp INTEGER NOT NULL DEFAULT 50,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- Learning content
CREATE TABLE IF NOT EXISTS modules (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  topic TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  minutes INTEGER NOT NULL DEFAULT 5,
  xp INTEGER NOT NULL DEFAULT 30,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  module_id INTEGER REFERENCES modules(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  prompt TEXT NOT NULL,
  options TEXT NOT NULL,          -- JSON array of strings
  answer_index INTEGER NOT NULL,
  explanation TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS scenarios (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  persona TEXT NOT NULL,
  situation TEXT NOT NULL,
  objective TEXT NOT NULL,
  key_points TEXT NOT NULL,       -- JSON array of strings the rep should hit
  xp INTEGER NOT NULL DEFAULT 40
);

CREATE TABLE IF NOT EXISTS battlecards (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tips (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'Enablement'
);

-- Assignments (manager -> team or individual)
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  team_id INTEGER REFERENCES teams(id),
  user_id INTEGER REFERENCES users(id),
  due_date TEXT NOT NULL,
  assigned_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Activity & progress
CREATE TABLE IF NOT EXISTS module_completions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  completed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, module_id)
);

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  correct INTEGER NOT NULL,
  context TEXT NOT NULL,          -- 'daily' | 'module'
  day TEXT NOT NULL,
  answered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_challenges (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  question_ids TEXT NOT NULL,     -- JSON array
  completed_at TEXT,
  correct_count INTEGER,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS daily_answers (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  choice INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  PRIMARY KEY (user_id, day, question_id)
);

CREATE TABLE IF NOT EXISTS pitch_attempts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  pitch TEXT NOT NULL,
  score INTEGER NOT NULL,
  feedback TEXT NOT NULL,         -- JSON
  source TEXT NOT NULL,           -- 'ai' | 'rubric'
  manager_comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS xp_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  day TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS badges (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  earned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, code)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Integrations ----------
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,          -- 'sso' | 'calendar'
  verifier TEXT NOT NULL,         -- PKCE code_verifier
  nonce TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS crm_deals (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,         -- 'salesforce' | 'hubspot' | 'demo'
  external_id TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  owner_email TEXT,
  name TEXT NOT NULL,
  account TEXT,
  amount REAL,
  stage TEXT,
  close_date TEXT,
  is_closed INTEGER NOT NULL DEFAULT 0,
  is_won INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, external_id)
);

CREATE TABLE IF NOT EXISTS integration_runs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,             -- 'crm_sync' | 'chat_challenge' | 'calendar_sync'
  status TEXT NOT NULL,           -- 'ok' | 'error'
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS calendar_connections (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,         -- 'google'
  refresh_token_enc TEXT NOT NULL,
  connected_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,         -- ISO 8601
  end_at TEXT,
  attendees TEXT NOT NULL,        -- JSON array of emails
  external_domains TEXT NOT NULL, -- JSON array of non-company domains
  link TEXT,
  UNIQUE (user_id, external_id)
);

CREATE TABLE IF NOT EXISTS chat_links (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  space_name TEXT NOT NULL,       -- Google Chat DM space, e.g. spaces/AAAA
  linked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS roleplays (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scenario_id INTEGER REFERENCES scenarios(id) ON DELETE SET NULL,
  meeting_id INTEGER REFERENCES calendar_events(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  persona TEXT NOT NULL,
  situation TEXT NOT NULL,
  objective TEXT NOT NULL,
  key_points TEXT NOT NULL,       -- JSON array
  difficulty TEXT NOT NULL,       -- 'friendly' | 'skeptical' | 'tough'
  transcript TEXT NOT NULL DEFAULT '[]',   -- JSON [{role: 'rep'|'buyer', text}]
  api_messages TEXT NOT NULL DEFAULT '[]', -- JSON Messages API history, replayed verbatim
  status TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'completed'
  source TEXT NOT NULL,           -- 'ai' | 'scripted'
  score INTEGER,
  feedback TEXT,
  xp INTEGER NOT NULL DEFAULT 60,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_deals_user ON crm_deals(user_id);
CREATE INDEX IF NOT EXISTS idx_events_user_start ON calendar_events(user_id, start_at);
CREATE INDEX IF NOT EXISTS idx_roleplays_user ON roleplays(user_id, status);
CREATE INDEX IF NOT EXISTS idx_xp_user_day ON xp_events(user_id, day);
CREATE INDEX IF NOT EXISTS idx_answers_user ON answers(user_id, question_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);
`;

export function openDb(file = process.env.DB_FILE || 'data/pitchpulse.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Additive column migrations for databases created by earlier versions.
function migrate(db) {
  const addColumn = (table, column, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  addColumn('users', 'sso_subject', 'sso_subject TEXT');           // OIDC "sub" claim
  addColumn('users', 'last_login_at', 'last_login_at TEXT');
}

/** Run fn inside a transaction; rolls back on throw. */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
