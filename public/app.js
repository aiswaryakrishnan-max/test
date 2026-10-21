// PitchPulse SPA — no build step, no framework.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let me = null;

// ---------- API ----------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pitchpulse' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { me = null; renderLogin(); throw new Error('Please sign in'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- Feedback: toasts, confetti, rewards ----------
function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 3800);
}

function confetti() {
  const canvas = $('#confetti');
  const ctx = canvas.getContext('2d');
  canvas.width = innerWidth; canvas.height = innerHeight;
  const colors = ['#5b4ef0', '#8a7dff', '#ff7a1a', '#14a660', '#ffd23f', '#ff5e62'];
  const parts = Array.from({ length: 140 }, () => ({
    x: innerWidth / 2 + (Math.random() - .5) * 200, y: innerHeight / 3,
    vx: (Math.random() - .5) * 14, vy: Math.random() * -12 - 4, r: Math.random() * 6 + 3,
    c: colors[Math.floor(Math.random() * colors.length)], rot: Math.random() * 6,
  }));
  let frame = 0;
  (function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of parts) {
      p.vy += .35; p.x += p.vx; p.y += p.vy; p.rot += .1;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.c;
      ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 1.6); ctx.restore();
    }
    if (++frame < 120) requestAnimationFrame(tick); else ctx.clearRect(0, 0, canvas.width, canvas.height);
  })();
}

function celebrate(result) {
  if (result.xpGained) toast(`+${result.xpGained} XP`, 'xp');
  for (const b of result.newBadges || []) {
    toast(`${b.icon} Badge unlocked: ${b.name}`, 'badge-toast');
  }
  if (result.newBadges?.length || result.completed) confetti();
}

// ---------- Helpers ----------
const COLORS = ['#5b4ef0', '#ff7a1a', '#14a660', '#e5484d', '#0091ff', '#c056e0', '#c98a00'];
const avatar = (name, id = 0) => `<span class="avatar" style="background:${COLORS[id % COLORS.length]}">${esc(name.split(' ').map((p) => p[0]).join('').slice(0, 2))}</span>`;
const pct = (n) => (n === null || n === undefined ? '—' : `${n}%`);
const tone = (n) => (n === null || n === undefined ? '' : n >= 75 ? 'good' : n >= 50 ? 'warn' : 'bad');
const bar = (n, cls = tone(n)) => `<div class="progress ${cls}"><span style="width:${Math.max(0, Math.min(100, n ?? 0))}%"></span></div>`;
const weekday = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'narrow', timeZone: 'UTC' });
const fmtDate = (day) => new Date(`${day.slice(0, 10)}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

function markdown(md) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/`(.+?)`/g, '<code>$1</code>');
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of md.split('\n')) {
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)/))) { close(); const l = Math.min(m[1].length + 1, 3); out.push(`<h${l}>${inline(m[2])}</h${l}>`); }
    else if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*\d+\.\s+(.*)/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (line.trim() === '') close();
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join('\n');
}

// ---------- Shell & routing ----------
const NAV = [
  { href: '#/today', icon: '🔥', label: 'Today' },
  { href: '#/learn', icon: '📚', label: 'Learn' },
  { href: '#/roleplay', icon: '🎭', label: 'AI Role-play' },
  { href: '#/practice', icon: '🎤', label: 'Pitch Practice' },
  { href: '#/leaderboard', icon: '🏆', label: 'Leaderboard' },
  { href: '#/knowledge', icon: '🗂️', label: 'Battlecards' },
  { href: '#/inbox', icon: '🔔', label: 'Inbox', badge: true },
  { href: '#/profile', icon: '👤', label: 'Profile' },
];
const LEAD_NAV = [
  { href: '#/team', icon: '📊', label: 'Team' },
  { href: '#/studio', icon: '✏️', label: 'Content Studio' },
  { href: '#/integrations', icon: '🔌', label: 'Integrations' },
];

let unread = 0;
function shell(content) {
  const path = location.hash.split('?')[0] || '#/today';
  const link = (n) => `<a href="${n.href}" class="${path.startsWith(n.href) ? 'active' : ''}"><span>${n.icon}</span>${n.label}${n.badge && unread ? `<span class="pill bad">${unread}</span>` : ''}</a>`;
  $('#app').innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="logo">🔥 PitchPulse</div>
        <nav class="nav">
          ${NAV.map(link).join('')}
          ${me.role !== 'rep' ? `<div class="section">Manage</div>${LEAD_NAV.map(link).join('')}` : ''}
        </nav>
        <div class="me">
          <div class="row">${avatar(me.name, me.id)}<div><b>${esc(me.name)}</b><div class="muted tiny">${esc(me.team || me.role)} · Lv ${me.level.level}</div></div></div>
          <button class="btn small ghost" id="logout" style="margin-top:.5rem">Sign out</button>
        </div>
      </aside>
      <main id="main">${content}</main>
    </div>`;
  $('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); me = null; location.hash = ''; renderLogin(); };
}

const ROUTES = {
  today: viewToday,
  learn: viewLearn,
  module: viewModule,
  practice: viewPractice,
  scenario: viewScenario,
  leaderboard: viewLeaderboard,
  knowledge: viewKnowledge,
  inbox: viewInbox,
  profile: viewProfile,
  team: viewTeam,
  studio: viewStudio,
  roleplay: viewRoleplays,
  call: viewCall,
  integrations: viewIntegrations,
};

async function router() {
  if (!me) return;
  const [, name = 'today', id] = (location.hash || '#/today').split('?')[0].split('/');
  const view = ROUTES[name] || viewToday;
  shell('<div class="empty">Loading…</div>');
  try {
    await refreshMe();
    await view(id ? Number(id) : undefined);
  } catch (err) {
    if (me) $('#main').innerHTML = `<div class="card empty">⚠️ ${esc(err.message)}</div>`;
  }
}

// ---------- Login ----------
async function renderLogin() {
  const cfg = await fetch('/api/auth/config').then((r) => r.json()).catch(() => ({ sso: { enabled: false }, passwordLogin: true }));
  const ssoError = new URLSearchParams(location.search).get('sso_error');
  if (ssoError) history.replaceState(null, '', '/');
  $('#app').innerHTML = `
    <div class="login">
      <form class="card stack" id="login-form">
        <div><div class="logo" style="padding:0">🔥 PitchPulse</div><p class="muted">Five minutes a day to sharper sales conversations.</p></div>
        ${ssoError ? `<div class="explain" style="background:var(--bad-soft)">⚠️ ${esc(ssoError)}</div>` : ''}
        ${cfg.sso.enabled ? `<a class="btn primary" style="width:100%" href="/auth/sso/start">🔐 Sign in with ${esc(cfg.sso.name)}</a>` : ''}
        ${cfg.sso.enabled && cfg.passwordLogin ? '<div class="muted small" style="text-align:center">or use your password</div>' : ''}
        ${cfg.passwordLogin ? `
        <div class="field"><label for="email">Work email</label><input id="email" type="email" required autocomplete="username" /></div>
        <div class="field"><label for="password">Password</label><input id="password" type="password" required autocomplete="current-password" /></div>
        <button class="btn ${cfg.sso.enabled ? '' : 'primary'}" style="width:100%">Sign in</button>
        <div class="demo-accounts small muted">Demo accounts (password <code>password123</code>):<br>
          <button type="button" class="btn small" data-email="rep@pitchpulse.dev">Rep</button>
          <button type="button" class="btn small" data-email="manager@pitchpulse.dev">Manager</button>
          <button type="button" class="btn small" data-email="admin@pitchpulse.dev">Admin</button>
        </div>` : ''}
      </form>
    </div>`;
  $$('[data-email]').forEach((b) => (b.onclick = () => { $('#email').value = b.dataset.email; $('#password').value = 'password123'; }));
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/login', { method: 'POST', body: { email: $('#email').value, password: $('#password').value } });
      await boot();
    } catch (err) { toast(err.message, 'error'); }
  };
}

async function refreshMe() {
  me = await api('/api/me');
}

// ---------- Today ----------
async function viewToday() {
  const [t, cal] = await Promise.all([api('/api/today'), api('/api/calendar/meetings').catch(() => null)]);
  unread = t.unread;
  const goalPct = Math.min(100, Math.round((t.xpToday / t.dailyGoal) * 100));
  const s = t.streak;
  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening';
  const streakLine = s.activeToday
    ? `You're on fire — streak secured for today.`
    : s.atRisk ? `Your streak is at risk! Finish one activity today to keep it.` : `Start a streak today with the Daily Challenge.`;

  shell(`
    <div class="page-head"><div><h1>${greeting}, ${esc(me.name.split(' ')[0])} 👋</h1><p>${new Date(`${t.day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })}</p></div>
      ${t.teamPulse ? `<span class="pill brand">👥 ${t.teamPulse.activeToday}/${t.teamPulse.total} teammates trained today</span>` : ''}</div>
    <div class="grid">
      <section class="card hero">
        <div class="flame ${s.current ? '' : 'cold'}">🔥</div>
        <div>
          <div class="row"><span class="streak-num">${s.current}</span><span>day streak</span>${s.longest > s.current ? `<span class="muted small">· best ${s.longest}</span>` : ''}</div>
          <div class="muted small">${streakLine}</div>
          <div class="week">${t.week.map((d) => `<div class="d"><div class="dot ${d.xp ? 'on' : ''} ${d.day === t.day ? 'today' : ''}">${d.xp ? '🔥' : ''}</div>${weekday(d.day)}</div>`).join('')}</div>
          <div class="row small" style="margin-top:.8rem"><b>Level ${t.level.level}</b><span class="muted">${t.level.intoLevel}/${t.level.levelSpan} XP to level ${t.level.level + 1}</span></div>
          <div style="max-width:320px;margin-top:.3rem">${bar((t.level.intoLevel / t.level.levelSpan) * 100, '')}</div>
        </div>
        <div class="ring" style="--p:${goalPct}"><div><b>${t.xpToday}</b>/ ${t.dailyGoal} XP<br>daily goal</div></div>
      </section>

      <div class="grid cols-2">
        ${meetingsCard(cal)}
        ${dealFocusCard(t.dealFocus)}
        <section class="card span-2" id="daily"></section>
        <section class="card">
          <div class="card-head"><h2>💡 Tip of the day</h2></div>
          ${t.tip ? `<p style="font-size:1.05rem">“${esc(t.tip.text)}”</p><div class="row"><span class="muted small">— ${esc(t.tip.author)}</span><span class="spacer"></span><button class="btn small" id="tip-read">👍 Got it (+5 XP)</button></div>` : '<p class="muted">No tips yet.</p>'}
        </section>
        <section class="card">
          <div class="card-head"><h2>🎤 Drill of the day</h2>${t.drill ? `<span class="pill brand">+${t.drill.xp} XP</span>` : ''}</div>
          ${t.drill ? `<h3>${esc(t.drill.title)}</h3><p class="muted small">${esc(t.drill.objective)}</p><div class="row"><button class="btn primary" data-roleplay-scenario="${t.drill.id}">🎭 Live role-play</button><a class="btn" href="#/scenario/${t.drill.id}">Write a pitch</a></div>` : '<p class="muted">No scenarios yet.</p>'}
        </section>
        <section class="card">
          <div class="card-head"><h2>📌 Assigned to you</h2></div>
          ${t.assignments.length ? `<ul class="list">${t.assignments.map((a) => `
            <li><div><a href="#/module/${a.module_id}"><b>${esc(a.title)}</b></a><div class="muted tiny">${a.minutes} min · +${a.xp} XP</div></div><span class="spacer"></span>
            <span class="pill ${a.overdue ? 'bad' : a.daysLeft <= 2 ? 'warn' : ''}">${a.overdue ? 'Overdue' : a.daysLeft === 0 ? 'Due today' : `Due in ${a.daysLeft}d`}</span></li>`).join('')}</ul>`
            : '<p class="muted">All caught up — nice work! ✅</p>'}
        </section>
        <section class="card">
          <div class="card-head"><h2>🎯 Recommended for you</h2></div>
          ${t.recommended ? `<h3>${esc(t.recommended.title)}</h3><p class="muted small">${esc(t.recommended.reason)} · ${t.recommended.minutes} min</p><a class="btn" href="#/module/${t.recommended.id}">Start module</a>` : '<p class="muted">You\'ve completed every module. 🎓</p>'}
        </section>
      </div>
    </div>`);

  renderDaily(t);
  bindRoleplayStarters();
  const tipBtn = $('#tip-read');
  if (tipBtn) tipBtn.onclick = async () => {
    const r = await api(`/api/tips/${t.tip.id}/read`, { method: 'POST' });
    tipBtn.disabled = true; tipBtn.textContent = '✓ Noted';
    if (r.xpGained) { celebrate(r); setTimeout(viewToday, 900); }
  };
}

function renderDaily(t) {
  const c = t.challenge;
  const el = $('#daily');
  const head = `<div class="card-head"><h2>⚡ Daily Challenge</h2><div class="q-dots">${c.questions.map((q) => `<span class="${q.answered ? (q.correct ? 'good' : 'bad') : ''}"></span>`).join('')}</div></div>`;
  if (!c.questions.length) { el.innerHTML = `${head}<p class="muted">No questions in the library yet.</p>`; return; }
  if (c.completed) {
    el.innerHTML = `${head}<div class="done-state"><div class="big">${c.correctCount === c.size ? '🎯' : '✅'}</div>
      <h3>${c.correctCount}/${c.size} correct — challenge complete!</h3>
      <p class="muted">Come back tomorrow for a fresh set. Questions you missed will come back to help them stick.</p>
      <div class="row" style="justify-content:center"><a class="btn" href="#/practice">Keep going: practice a pitch</a><a class="btn" href="#/learn">Browse modules</a></div></div>`;
    return;
  }
  const idx = c.questions.findIndex((q) => !q.answered);
  const q = c.questions[idx];
  el.innerHTML = `${head}
    <div class="muted small">Question ${idx + 1} of ${c.questions.length} · <span class="pill">${esc(q.topic)}</span> · 2 minutes to keep your streak alive</div>
    <div class="question">${esc(q.prompt)}</div>
    <div class="options">${q.options.map((o, i) => `<button class="option" data-i="${i}">${esc(o)}</button>`).join('')}</div>
    <div id="explain"></div>`;
  $$('.option', el).forEach((btn) => (btn.onclick = async () => {
    $$('.option', el).forEach((b) => (b.disabled = true));
    try {
      const r = await api('/api/daily/answer', { method: 'POST', body: { questionId: q.id, choice: Number(btn.dataset.i) } });
      $$('.option', el)[r.answer_index].classList.add('correct');
      if (!r.correct) btn.classList.add('wrong');
      Object.assign(q, { answered: true, correct: r.correct });
      $('.q-dots', el).children[idx].className = r.correct ? 'good' : 'bad';
      $('#explain').innerHTML = `<div class="explain"><b>${r.correct ? '✅ Correct!' : '❌ Not quite.'}</b> ${esc(r.explanation)}</div>
        <div class="row" style="margin-top:.8rem"><span class="spacer"></span><button class="btn primary" id="next">${r.completed ? 'See results' : 'Next question →'}</button></div>`;
      celebrate(r);
      $('#next').onclick = () => (r.completed ? viewToday() : renderDaily(t));
      if (r.completed) { c.completed = true; c.correctCount = r.correctCount; }
    } catch (err) { toast(err.message, 'error'); $$('.option', el).forEach((b) => (b.disabled = false)); }
  }));
}

const fmtTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtWhen = (iso) => {
  const d = new Date(iso);
  const day = d.toDateString() === new Date().toDateString() ? 'Today' : d.toDateString() === new Date(Date.now() + 864e5).toDateString() ? 'Tomorrow' : d.toLocaleDateString(undefined, { weekday: 'short' });
  return `${day} ${fmtTime(iso)}`;
};
const money = (n) => (n == null ? '—' : `$${Math.round(n).toLocaleString()}`);

function meetingsCard(cal) {
  if (!cal) return '';
  if (!cal.meetings.length) {
    if (cal.connected) return '';
    if (!cal.enabled) return '';
    return `<section class="card span-2"><div class="row"><div><h2 style="margin:0">📅 Prep for your customer meetings</h2>
      <p class="muted small" style="margin:.3rem 0 0">Connect Google Calendar and PitchPulse will line up a prep plan and a role-play before every customer call.</p></div>
      <span class="spacer"></span><a class="btn primary" href="/integrations/calendar/connect">Connect Google Calendar</a></div></section>`;
  }
  return `<section class="card span-2"><div class="card-head"><h2>📅 Upcoming customer meetings</h2>
      ${cal.connected ? '<span class="pill good">Google Calendar</span>' : '<span class="pill">Demo data</span>'}</div>
    <ul class="list">${cal.meetings.map((m) => `<li style="align-items:flex-start">
      <div style="min-width:92px"><b>${esc(fmtWhen(m.start))}</b><div class="muted tiny">${esc(m.domains.join(', '))}</div></div>
      <div style="flex:1"><b>${esc(m.title)}</b>
        ${m.deal ? `<div class="small muted">💼 ${esc(m.deal.name)} · <span class="pill brand">${esc(m.deal.stage)}</span> ${money(m.deal.amount)}${m.deal.close_date ? ` · closes ${fmtDate(m.deal.close_date)}` : ''}</div>` : '<div class="small muted">No matching CRM deal</div>'}
      </div>
      <div class="row" style="flex-wrap:nowrap"><button class="btn small primary" data-roleplay-meeting="${m.id}">🎭 Rehearse</button><a class="btn small" href="#/knowledge">Battlecards</a></div>
    </li>`).join('')}</ul>
    ${cal.syncError ? `<p class="small" style="color:var(--bad)">Calendar sync issue: ${esc(cal.syncError)}</p>` : ''}</section>`;
}

function dealFocusCard(f) {
  if (!f) return '';
  const d = f.deal;
  return `<section class="card span-2"><div class="card-head"><h2>💼 Deal focus: ${esc(f.headline)}</h2><span class="pill ${d.daysToClose <= 7 ? 'warn' : ''}">Closes in ${d.daysToClose}d</span></div>
    <p style="margin-top:0"><b>${esc(d.name)}</b> is in <b>${esc(d.stage)}</b>${d.amount ? ` (${money(d.amount)})` : ''}. Sharpen your <b>${esc(f.topic)}</b> skills before your next conversation.</p>
    <div class="row">${f.module ? `<a class="btn" href="#/module/${f.module.id}">📚 ${esc(f.module.title)}</a>` : ''}<a class="btn" href="#/roleplay">🎭 Role-play this stage</a></div></section>`;
}

function bindRoleplayStarters(root = document) {
  $$('[data-roleplay-meeting]', root).forEach((b) => (b.onclick = () => startRoleplay({ meetingId: Number(b.dataset.roleplayMeeting) }, b)));
  $$('[data-roleplay-scenario]', root).forEach((b) => (b.onclick = () => startRoleplay({ scenarioId: Number(b.dataset.roleplayScenario), difficulty: b.dataset.difficulty || $('#difficulty')?.value }, b)));
}

async function startRoleplay(body, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
  try {
    const rp = await api('/api/roleplays', { method: 'POST', body });
    location.hash = `#/call/${rp.id}`;
  } catch (err) { toast(err.message, 'error'); if (btn) { btn.disabled = false; btn.textContent = 'Try again'; } }
}

// ---------- Learn ----------
async function viewLearn() {
  const modules = await api('/api/modules');
  const done = modules.filter((m) => m.completed).length;
  shell(`
    <div class="page-head"><div><h1>📚 Learn</h1><p>Bite-sized modules. ${done}/${modules.length} completed.</p></div>
      <div style="min-width:220px">${bar((done / Math.max(1, modules.length)) * 100, '')}</div></div>
    <div class="grid cols-3">
      ${modules.map((m) => `
        <a class="card module-card" href="#/module/${m.id}" style="color:inherit">
          <div class="row"><span class="pill brand">${esc(m.topic)}</span><span class="spacer"></span>
            ${m.completed ? `<span class="pill good">✓ ${Math.round(m.score)}%</span>` : m.assignment ? `<span class="pill ${m.assignment.overdue ? 'bad' : 'warn'}">${m.assignment.overdue ? 'Overdue' : `Due ${fmtDate(m.assignment.due_date)}`}</span>` : ''}</div>
          <h3>${esc(m.title)}</h3>
          <p class="muted small" style="margin:0">${esc(m.summary)}</p>
          <div class="muted tiny" style="margin-top:auto">⏱ ${m.minutes} min · ${m.questionCount} questions · +${m.xp} XP</div>
        </a>`).join('') || '<div class="card empty">No modules yet.</div>'}
    </div>`);
}

async function viewModule(id) {
  const m = await api(`/api/modules/${id}`);
  const answers = new Array(m.questions.length).fill(null);
  shell(`
    <div class="page-head"><div><a href="#/learn" class="small">← All modules</a><h1>${esc(m.title)}</h1>
      <p><span class="pill brand">${esc(m.topic)}</span> ⏱ ${m.minutes} min · +${m.xp} XP ${m.completion ? `· <span class="pill good">Completed · ${Math.round(m.completion.score)}%</span>` : ''}</p></div></div>
    <div class="grid cols-2">
      <article class="card prose">${markdown(m.body)}</article>
      <section class="card" id="quiz">
        <div class="card-head"><h2>✍️ Check your understanding</h2><span class="muted small">Pass with 60%+</span></div>
        ${m.questions.map((q, qi) => `
          <div class="stack" style="margin-bottom:1.2rem" data-q="${qi}">
            <div class="question" style="margin:0">${qi + 1}. ${esc(q.prompt)}</div>
            <div class="options">${q.options.map((o, i) => `<button class="option" data-i="${i}">${esc(o)}</button>`).join('')}</div>
            <div class="explain-slot"></div>
          </div>`).join('') || '<p class="muted">No quiz for this module.</p>'}
        <button class="btn primary" id="submit" ${m.questions.length ? 'disabled' : ''}>${m.questions.length ? 'Submit answers' : 'Mark complete'}</button>
      </section>
    </div>`);

  $$('[data-q]').forEach((block) => {
    const qi = Number(block.dataset.q);
    $$('.option', block).forEach((btn) => (btn.onclick = () => {
      $$('.option', block).forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      answers[qi] = Number(btn.dataset.i);
      $('#submit').disabled = answers.some((a) => a === null);
    }));
  });
  $('#submit').onclick = async () => {
    try {
      const r = await api(`/api/modules/${id}/complete`, { method: 'POST', body: { answers } });
      r.results.forEach((res, qi) => {
        const block = $(`[data-q="${qi}"]`);
        $$('.option', block).forEach((b, i) => { b.disabled = true; if (i === res.answer_index) b.classList.add('correct'); else if (i === answers[qi]) b.classList.add('wrong'); });
        $('.explain-slot', block).innerHTML = res.explanation ? `<div class="explain">${res.correct ? '✅' : '❌'} ${esc(res.explanation)}</div>` : '';
      });
      $('#submit').outerHTML = `<div class="explain"><b>${r.passed ? `🎉 Passed with ${r.score}%!` : `You scored ${r.score}%. Review the material and try again.`}</b>
        <div class="row" style="margin-top:.6rem">${r.passed ? '<a class="btn primary" href="#/today">Back to Today</a>' : '<button class="btn" id="retry">Try again</button>'}<a class="btn" href="#/learn">All modules</a></div></div>`;
      if ($('#retry')) $('#retry').onclick = () => viewModule(id);
      celebrate({ ...r, completed: r.passed && r.xpGained > 0 });
    } catch (err) { toast(err.message, 'error'); }
  };
}

// ---------- Practice ----------
async function viewPractice() {
  const [scenarios, history] = await Promise.all([api('/api/scenarios'), api('/api/pitches')]);
  shell(`
    <div class="page-head"><div><h1>🎤 Pitch Practice</h1><p>Rehearse real conversations and get instant coaching${me.aiCoach ? ' from your AI coach' : ''}. Managers can add their own feedback too.</p></div></div>
    <div class="grid cols-3">
      ${scenarios.map((s) => `
        <a class="card module-card" href="#/scenario/${s.id}" style="color:inherit">
          <div class="row"><span class="pill brand">+${s.xp} XP</span><span class="spacer"></span>${s.bestScore !== null ? `<span class="pill ${tone(s.bestScore)}">Best ${s.bestScore}</span>` : '<span class="pill">New</span>'}</div>
          <h3>${esc(s.title)}</h3><p class="muted small" style="margin:0">${esc(s.objective)}</p>
          <div class="muted tiny" style="margin-top:auto">${s.attempts} attempt${s.attempts === 1 ? '' : 's'}</div>
        </a>`).join('')}
    </div>
    <section class="card" style="margin-top:1rem">
      <div class="card-head"><h2>Your recent attempts</h2></div>
      ${history.length ? `<ul class="list">${history.map((p) => `
        <li style="align-items:flex-start"><span class="pill ${tone(p.score)}" style="min-width:3rem;justify-content:center">${p.score}</span>
          <div><b>${esc(p.scenario)}</b> <span class="muted tiny">${fmtDate(p.created_at)}</span>
            <div class="muted small">${esc(p.feedback.summary)}</div>
            ${p.manager_comment ? `<div class="explain small">💬 <b>Manager:</b> ${esc(p.manager_comment)}</div>` : ''}</div></li>`).join('')}</ul>`
        : '<p class="muted">No attempts yet — pick a scenario above.</p>'}
    </section>`);
}

async function viewScenario(id) {
  const scenarios = await api('/api/scenarios');
  const s = scenarios.find((x) => x.id === id);
  if (!s) throw new Error('Scenario not found');
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  shell(`
    <div class="page-head"><div><a href="#/practice" class="small">← All scenarios</a><h1>${esc(s.title)}</h1><p>Objective: ${esc(s.objective)}</p></div></div>
    <div class="grid cols-2">
      <section class="card stack">
        <div class="persona"><b>👤 Buyer:</b> ${esc(s.persona)}</div>
        <div class="persona"><b>📍 Situation:</b> ${esc(s.situation)}</div>
        <details><summary class="small muted" style="cursor:pointer">Show the key points the coach looks for</summary>
          <ul class="small">${s.key_points.map((k) => `<li>${esc(k)}</li>`).join('')}</ul></details>
        <div class="field">
          <label for="pitch">Your pitch — write it, or speak it${SpeechRec ? '' : ' (voice needs Chrome/Edge)'}</label>
          <textarea id="pitch" placeholder="Type exactly what you'd say to the buyer…"></textarea>
        </div>
        <div class="row">
          ${SpeechRec ? '<button class="btn" id="mic">🎙️ Record</button>' : ''}
          <span class="muted tiny" id="wc">0 words</span><span class="spacer"></span>
          <button class="btn primary" id="score">Get coaching</button>
        </div>
      </section>
      <section class="card" id="feedback"><div class="empty">Your coaching feedback will appear here.<br><span class="small">Tip: aim for 60–200 words, ask a question, and close with a next step.</span></div></section>
    </div>`);

  const ta = $('#pitch');
  ta.oninput = () => ($('#wc').textContent = `${ta.value.trim().split(/\s+/).filter(Boolean).length} words`);
  if (SpeechRec) {
    let rec = null;
    $('#mic').onclick = () => {
      if (rec) { rec.stop(); return; }
      rec = new SpeechRec();
      rec.continuous = true; rec.interimResults = false; rec.lang = navigator.language || 'en-US';
      const base = ta.value ? `${ta.value.trim()} ` : '';
      let said = '';
      rec.onresult = (e) => { said = [...e.results].map((r) => r[0].transcript).join(' '); ta.value = base + said; ta.oninput(); };
      rec.onend = () => { rec = null; $('#mic').innerHTML = '🎙️ Record'; };
      rec.onerror = (e) => toast(`Mic: ${e.error}`, 'error');
      rec.start();
      $('#mic').innerHTML = '<span class="rec">●</span> Stop';
    };
  }
  $('#score').onclick = async () => {
    const btn = $('#score');
    btn.disabled = true; btn.textContent = 'Coaching…';
    $('#feedback').innerHTML = '<div class="empty">🧠 Reviewing your pitch…</div>';
    try {
      const r = await api(`/api/scenarios/${id}/attempt`, { method: 'POST', body: { pitch: ta.value } });
      renderFeedback(r);
      celebrate(r);
      if (r.score >= 85) confetti();
    } catch (err) {
      toast(err.message, 'error');
      $('#feedback').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    } finally { btn.disabled = false; btn.textContent = 'Try again'; }
  };
}

function renderFeedback(r) {
  const list = (items) => (items?.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p class="muted small">—</p>');
  $('#feedback').innerHTML = `
    <div class="row"><div class="feedback-score" style="color:var(--${tone(r.score) || 'text'})">${r.score}</div><div><b>/ 100</b><div class="muted tiny">${r.source === 'ai' ? 'AI coach' : 'Rubric coach'}</div></div>
      <span class="spacer"></span>${r.xpGained ? `<span class="pill brand">+${r.xpGained} XP</span>` : ''}</div>
    ${bar(r.score)}
    <p>${esc(r.summary)}</p>
    <div class="kv"><div><h3>💪 Strengths</h3>${list(r.strengths)}</div><div><h3>🛠 Improve</h3>${list(r.improvements)}</div></div>
    <div class="kv"><div><h3 class="small">✅ Key points hit</h3>${list(r.key_points_covered)}</div><div><h3 class="small">⚠️ Key points missed</h3>${list(r.key_points_missed)}</div></div>
    ${r.rewrite_suggestion ? `<div class="explain"><b>✨ Try this instead:</b> ${esc(r.rewrite_suggestion)}</div>` : ''}`;
}

// ---------- Leaderboard ----------
async function viewLeaderboard() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const period = params.get('period') || 'week';
  const team = params.get('team') || 'all';
  const lb = await api(`/api/leaderboard?period=${period}&team=${team}`);
  const medal = (r) => ({ 1: '🥇', 2: '🥈', 3: '🥉' }[r] || r);
  const link = (p, t) => `#/leaderboard?period=${p}&team=${t}`;
  shell(`
    <div class="page-head"><div><h1>🏆 Leaderboard</h1><p>${period === 'week' ? `This week (since ${fmtDate(lb.since)}) — resets every Monday, so everyone has a shot.` : 'All-time XP.'}</p></div>
      <div class="row">
        <div class="tabs"><button class="${period === 'week' ? 'on' : ''}" data-go="${link('week', team)}">This week</button><button class="${period === 'all' ? 'on' : ''}" data-go="${link('all', team)}">All time</button></div>
        ${me.team_id ? `<div class="tabs"><button class="${team === 'all' ? 'on' : ''}" data-go="${link(period, 'all')}">Everyone</button><button class="${team === 'mine' ? 'on' : ''}" data-go="${link(period, 'mine')}">My team</button></div>` : ''}
      </div></div>
    <div class="grid cols-2">
      <section class="card span-2 table-wrap"><table>
        <thead><tr><th>#</th><th>Rep</th><th>Team</th><th>Streak</th><th style="text-align:right">XP</th></tr></thead>
        <tbody>${lb.reps.map((r) => `<tr class="${r.me ? 'me' : ''}"><td class="rank">${medal(r.rank)}</td>
          <td><div class="row">${avatar(r.name, r.id)}<b>${esc(r.name)}</b>${r.me ? '<span class="pill brand">You</span>' : ''}</div></td>
          <td class="muted">${esc(r.team || '')}</td><td>${r.streak ? `<span class="pill fire">🔥 ${r.streak}</span>` : '<span class="muted">—</span>'}</td>
          <td style="text-align:right"><b>${r.xp}</b></td></tr>`).join('')}</tbody></table></section>
      <section class="card"><div class="card-head"><h2>Team vs team</h2><span class="muted small">XP per rep</span></div>
        ${lb.teams.map((t, i) => `<div style="margin-bottom:.8rem"><div class="row small"><b>${medal(i + 1)} ${esc(t.team)}</b><span class="spacer"></span>${t.xpPerRep} XP/rep</div>
          ${bar((t.xpPerRep / Math.max(1, lb.teams[0].xpPerRep)) * 100, '')}</div>`).join('')}</section>
    </div>`);
  $$('[data-go]').forEach((b) => (b.onclick = () => (location.hash = b.dataset.go)));
}

// ---------- Knowledge ----------
async function viewKnowledge() {
  shell(`
    <div class="page-head"><div><h1>🗂️ Battlecards</h1><p>Quick answers before your next call.</p></div>
      <input type="text" id="search" placeholder="Search: competitor, objection, pricing…" style="max-width:340px" /></div>
    <div class="grid cols-2" id="cards"></div>`);
  const load = async () => {
    const cards = await api(`/api/battlecards?q=${encodeURIComponent($('#search').value)}`);
    $('#cards').innerHTML = cards.map((c) => `<article class="card battlecard"><div class="card-head"><h3>${esc(c.title)}</h3><span class="pill brand">${esc(c.category)}</span></div><pre>${esc(c.content)}</pre></article>`).join('')
      || '<div class="card empty">No matches.</div>';
  };
  let timer;
  $('#search').oninput = () => { clearTimeout(timer); timer = setTimeout(load, 200); };
  await load();
}

// ---------- Inbox ----------
async function viewInbox() {
  const items = await api('/api/notifications');
  const icon = { nudge: '👋', kudos: '🎉', assignment: '📌', coaching: '💬', reminder: '🔥', digest: '📊' };
  shell(`
    <div class="page-head"><div><h1>🔔 Inbox</h1><p>Nudges, kudos, assignments and coaching.</p></div></div>
    <section class="card">${items.length ? items.map((n) => `<div class="notif ${n.read ? '' : 'unread'}"><span>${icon[n.kind] || '•'}</span><div><div>${esc(n.message)}</div><div class="muted tiny">${fmtDate(n.created_at)}</div></div></div>`).join('') : '<div class="empty">Nothing here yet.</div>'}</section>`);
  if (items.some((n) => !n.read)) { await api('/api/notifications/read', { method: 'POST' }); unread = 0; }
}

// ---------- Profile ----------
async function viewProfile() {
  const [p, crm] = await Promise.all([api('/api/profile'), api('/api/crm/deals')]);
  const r = p.readiness;
  const ig = me.integrations;
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  if (qs.get('calendar_error')) toast(qs.get('calendar_error'), 'error');
  shell(`
    <div class="page-head"><div><h1>${esc(me.name)}</h1><p>${esc(me.team || '')} · Level ${p.level.level} · ${p.level.totalXp} XP total</p></div></div>
    <div class="grid cols-4">
      <div class="card tile"><div class="num">🔥 ${p.streak.current}</div><div class="label">Current streak (best ${p.streak.longest})</div></div>
      <div class="card tile"><div class="num">${r.score ?? '—'}</div><div class="label">Readiness score</div></div>
      <div class="card tile"><div class="num">${p.badges.filter((b) => b.earned).length}/${p.badges.length}</div><div class="label">Badges earned</div></div>
      <div class="card tile"><div class="num">Lv ${p.level.level}</div><div class="label">${p.level.levelSpan - p.level.intoLevel} XP to next level</div></div>
    </div>
    <div class="grid cols-2" style="margin-top:1rem">
      <section class="card"><div class="card-head"><h2>Readiness breakdown</h2></div>
        ${[['Knowledge (quiz accuracy, 30d)', r.knowledge], ['Assigned modules completed', r.completion], ['Pitch drills (last 5)', r.pitch]].map(([l, v]) => `
          <div style="margin-bottom:.8rem"><div class="row small"><span>${l}</span><span class="spacer"></span><b>${pct(v)}</b></div>${bar(v)}</div>`).join('')}
        <h3 style="margin-top:1rem">Accuracy by topic</h3>
        ${p.topics.length ? p.topics.map((t) => `<div style="margin-bottom:.6rem"><div class="row small"><span>${esc(t.topic)}</span><span class="spacer"></span>${t.accuracy}% <span class="muted tiny">(${t.attempts})</span></div>${bar(t.accuracy)}</div>`).join('') : '<p class="muted small">Answer some questions to see your strengths.</p>'}
      </section>
      <section class="card"><div class="card-head"><h2>Daily goal</h2></div>
        <p class="muted small">How much XP do you want to earn each day? Small, consistent goals beat big ones.</p>
        <div class="row">${[30, 50, 80, 120].map((g) => `<button class="btn ${p.dailyGoal === g ? 'primary' : ''}" data-goal="${g}">${g} XP<br><span class="tiny">${{ 30: 'Casual', 50: 'Regular', 80: 'Serious', 120: 'Intense' }[g]}</span></button>`).join('')}</div>
        <h3 style="margin-top:1.3rem">Recent XP</h3>
        <ul class="list small">${p.recentXp.map((x) => `<li><span class="pill brand">+${x.amount}</span>${esc(x.reason)}<span class="spacer"></span><span class="muted tiny">${fmtDate(x.day)}</span></li>`).join('') || '<li class="muted">No XP yet.</li>'}</ul>
      </section>
      <section class="card"><div class="card-head"><h2>🔌 Connected apps</h2></div>
        <ul class="list">
          <li><span style="font-size:1.4rem">📅</span><div style="flex:1"><b>Google Calendar</b><div class="muted tiny">Prep plans and role-plays for upcoming customer meetings</div></div>
            ${!ig.calendar.enabled ? '<span class="pill">Not set up by admin</span>'
              : ig.calendar.connected ? '<span class="pill good">Connected</span><button class="btn small" id="cal-disconnect">Disconnect</button>'
              : '<a class="btn small primary" href="/integrations/calendar/connect">Connect</a>'}</li>
          <li><span style="font-size:1.4rem">💬</span><div style="flex:1"><b>Google Chat</b><div class="muted tiny">${ig.googleChat.linked ? 'Your Daily Challenge arrives in Chat every morning' : 'Find the <b>PitchPulse</b> app in Google Chat and send it a message to get your Daily Challenge there'}</div></div>
            ${!ig.googleChat.enabled ? '<span class="pill">Not set up by admin</span>' : ig.googleChat.linked ? '<span class="pill good">Linked</span>' : '<span class="pill warn">Not linked</span>'}</li>
          <li><span style="font-size:1.4rem">💼</span><div style="flex:1"><b>CRM</b><div class="muted tiny">${ig.crm.provider ? `Synced from ${esc(ig.crm.provider)}` : ig.crm.hasDeals ? 'Demo pipeline data' : 'Your pipeline personalises recommendations'}</div></div>
            ${ig.crm.hasDeals ? '<span class="pill good">Deals linked</span>' : '<span class="pill">No deals</span>'}</li>
        </ul>
      </section>
      <section class="card"><div class="card-head"><h2>💼 My pipeline</h2><span class="muted small">last 180 days</span></div>
        <div class="grid cols-2" style="gap:.6rem">
          <div><div class="muted tiny">Open pipeline</div><b style="font-size:1.3rem">${money(crm.stats.pipeline)}</b><div class="muted tiny">${crm.stats.openDeals} open deals</div></div>
          <div><div class="muted tiny">Win rate</div><b style="font-size:1.3rem">${pct(crm.stats.winRate)}</b><div class="muted tiny">${crm.stats.won} won · ${money(crm.stats.wonAmount)}</div></div>
        </div>
        ${crm.deals.filter((d) => !d.is_closed).length ? `<ul class="list small" style="margin-top:.6rem">${crm.deals.filter((d) => !d.is_closed).slice(0, 5).map((d) => `<li><div style="flex:1"><b>${esc(d.name)}</b><div class="muted tiny">${esc(d.stage)} · closes ${d.close_date ? fmtDate(d.close_date) : '—'}</div></div>${money(d.amount)}</li>`).join('')}</ul>` : ''}
      </section>
      <section class="card span-2"><div class="card-head"><h2>Badges</h2></div>
        <div class="badges">${p.badges.map((b) => `<div class="badge ${b.earned ? '' : 'locked'}" title="${esc(b.description)}"><div class="icon">${b.icon}</div><b>${esc(b.name)}</b><div class="muted tiny">${esc(b.description)}</div></div>`).join('')}</div>
      </section>
    </div>`);
  if ($('#cal-disconnect')) $('#cal-disconnect').onclick = async () => { await api('/api/calendar/disconnect', { method: 'POST' }); toast('Calendar disconnected'); viewProfile(); };
  $$('[data-goal]').forEach((b) => (b.onclick = async () => {
    await api('/api/me', { method: 'PATCH', body: { daily_goal_xp: Number(b.dataset.goal) } });
    toast('Daily goal updated');
    viewProfile();
  }));
}

// ---------- Manager: Team ----------
async function viewTeam() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const teamId = params.get('teamId') || '';
  const [d, modules, pitches] = await Promise.all([
    api(`/api/manager/team${teamId ? `?teamId=${teamId}` : ''}`), api('/api/modules'), api('/api/pitches?scope=team'),
  ]);
  const s = d.summary;
  const today = new Date().toLocaleDateString('en-CA');
  shell(`
    <div class="page-head"><div><h1>📊 Team Readiness</h1><p>Who's building the habit, who needs a nudge, and where the team is weakest.</p></div>
      ${me.role === 'admin' ? `<select id="team-filter" style="max-width:220px"><option value="">All teams</option>${d.teams.map((t) => `<option value="${t.id}" ${String(t.id) === teamId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>` : ''}</div>
    <div class="grid cols-4">
      <div class="card tile"><div class="num">${s.activeToday}/${s.reps}</div><div class="label">Active today (${s.dailyActiveRate}%)</div></div>
      <div class="card tile"><div class="num">${s.weeklyActiveRate}%</div><div class="label">Active in last 7 days</div></div>
      <div class="card tile"><div class="num">${s.avgReadiness ?? '—'}</div><div class="label">Avg readiness score</div></div>
      <div class="card tile"><div class="num">🔥 ${s.avgStreak}</div><div class="label">Avg streak (days)</div></div>
    </div>

    <section class="card table-wrap" style="margin-top:1rem"><div class="card-head"><h2>Reps</h2></div>
      <table><thead><tr><th>Rep</th><th>Readiness</th><th>Knowledge</th><th>Modules</th><th>Pitch</th><th>Streak</th><th>Active (7d)</th><th>Week XP</th>${d.hasCrm ? '<th>Win rate</th><th>Pipeline</th>' : ''}<th></th></tr></thead>
      <tbody>${d.reps.map((r) => `<tr>
        <td><div class="row">${avatar(r.name, r.id)}<div><b>${esc(r.name)}</b><div class="muted tiny">${r.lastActive ? (r.daysInactive === 0 ? 'Active today' : `Last active ${r.daysInactive}d ago`) : 'Never active'}</div></div></div></td>
        <td style="min-width:110px"><b>${r.readiness.score ?? '—'}</b>${bar(r.readiness.score)}</td>
        <td>${pct(r.readiness.knowledge)}</td><td>${pct(r.readiness.completion)}</td><td>${r.readiness.pitch ?? '—'}</td>
        <td>${r.streak ? `<span class="pill fire">🔥 ${r.streak}</span>` : '—'}</td><td>${r.activeDays7}/7</td><td>${r.weekXp}</td>${d.hasCrm ? `<td>${pct(r.crm.winRate)}</td><td>${money(r.crm.pipeline)}</td>` : ''}
        <td><div class="row" style="flex-wrap:nowrap"><button class="btn small" data-nudge="${r.id}" title="Send a reminder">👋 Nudge</button><button class="btn small" data-kudos="${r.id}" data-name="${esc(r.name)}" title="Recognise effort (+10 XP)">🎉 Kudos</button></div></td>
      </tr>`).join('')}</tbody></table></section>

    <div class="grid cols-2" style="margin-top:1rem">
      <section class="card"><div class="card-head"><h2>⚠️ Needs attention</h2><span class="muted small">Inactive 2+ days</span></div>
        ${d.atRisk.length ? `<ul class="list">${d.atRisk.map((r) => `<li>${avatar(r.name, r.id)}<div><b>${esc(r.name)}</b><div class="muted tiny">${r.lastActive ? `${r.daysInactive} days inactive` : 'Never started'}</div></div><span class="spacer"></span><button class="btn small" data-nudge="${r.id}">👋 Nudge</button></li>`).join('')}</ul>
          <button class="btn small" id="nudge-all" style="margin-top:.6rem">Nudge all ${d.atRisk.length}</button>` : '<p class="muted">Everyone is engaged. 🙌</p>'}
      </section>
      ${d.readinessVsResults ? `<section class="card span-2"><div class="card-head"><h2>📈 Readiness vs. results</h2><span class="muted small">CRM win rate, last 180 days</span></div>
        <div class="grid cols-2"><div><div class="muted small">Top-half readiness reps</div><div class="tile"><div class="num">${d.readinessVsResults.topHalfWinRate}%</div><div class="label">average win rate</div></div></div>
        <div><div class="muted small">Bottom-half readiness reps</div><div class="tile"><div class="num">${d.readinessVsResults.bottomHalfWinRate}%</div><div class="label">average win rate</div></div></div></div>
        <p class="muted small">${d.readinessVsResults.topHalfWinRate > d.readinessVsResults.bottomHalfWinRate ? `Reps who train more are winning ${d.readinessVsResults.topHalfWinRate - d.readinessVsResults.bottomHalfWinRate} points more often.` : 'No positive gap yet. Keep an eye on this as more data comes in.'} This is a correlation across ${d.readinessVsResults.reps} reps, not proof of cause.</p></section>` : ''}
      <section class="card"><div class="card-head"><h2>🎯 Focus areas</h2><span class="muted small">Team accuracy by topic</span></div>
        ${d.focusAreas.length ? d.focusAreas.map((t) => `<div style="margin-bottom:.7rem"><div class="row small"><span>${esc(t.topic)}</span><span class="spacer"></span><b>${t.accuracy}%</b></div>${bar(t.accuracy)}</div>`).join('') : '<p class="muted">No answers yet.</p>'}
        ${d.focusAreas[0] && d.focusAreas[0].accuracy < 75 ? `<p class="small explain">💡 Consider assigning a <b>${esc(d.focusAreas[0].topic)}</b> module this week.</p>` : ''}
      </section>
      <section class="card"><div class="card-head"><h2>📌 Assignments</h2></div>
        ${d.assignments.length ? d.assignments.map((a) => `<div style="margin-bottom:.8rem"><div class="row small"><b>${esc(a.title)}</b><span class="spacer"></span><span class="pill ${a.done === a.total ? 'good' : a.overdue ? 'bad' : ''}">${a.done}/${a.total} · due ${fmtDate(a.due_date)}</span></div>${bar((a.done / Math.max(1, a.total)) * 100)}</div>`).join('') : '<p class="muted">No assignments yet.</p>'}
        <form id="assign" class="row" style="margin-top:1rem;align-items:flex-end">
          <div style="flex:2;min-width:180px"><label>Module</label><select name="moduleId">${modules.map((m) => `<option value="${m.id}">${esc(m.title)}</option>`).join('')}</select></div>
          <div style="flex:1;min-width:140px"><label>Due</label><input type="date" name="dueDate" required min="${today}" /></div>
          ${me.role === 'admin' ? `<div style="flex:1;min-width:140px"><label>Team</label><select name="teamId">${d.teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>` : ''}
          <button class="btn primary">Assign to team</button>
        </form>
      </section>
      <section class="card"><div class="card-head"><h2>🎤 Recent pitches</h2><span class="muted small">Add coaching notes</span></div>
        ${pitches.length ? `<ul class="list">${pitches.slice(0, 8).map((p) => `<li style="align-items:flex-start"><span class="pill ${tone(p.score)}">${p.score}</span>
          <div style="flex:1"><b>${esc(p.rep)}</b> · ${esc(p.scenario)} <span class="muted tiny">${fmtDate(p.created_at)}</span>
            <details><summary class="small muted" style="cursor:pointer">Read pitch</summary><p class="small">${esc(p.pitch)}</p></details>
            ${p.manager_comment ? `<div class="explain small">💬 ${esc(p.manager_comment)}</div>` : `<button class="btn small" data-comment="${p.id}">💬 Coach</button>`}</div></li>`).join('')}</ul>`
          : '<p class="muted">No pitch attempts yet.</p>'}
      </section>
    </div>`);

  if ($('#team-filter')) $('#team-filter').onchange = (e) => (location.hash = `#/team${e.target.value ? `?teamId=${e.target.value}` : ''}`);
  const nudge = async (id) => api('/api/manager/nudge', { method: 'POST', body: { userId: id } });
  $$('[data-nudge]').forEach((b) => (b.onclick = async () => { await nudge(Number(b.dataset.nudge)); b.disabled = true; b.textContent = '✓ Sent'; toast('Nudge sent'); }));
  if ($('#nudge-all')) $('#nudge-all').onclick = async (e) => { for (const r of d.atRisk) await nudge(r.id); e.target.disabled = true; toast(`Nudged ${d.atRisk.length} reps`); };
  $$('[data-kudos]').forEach((b) => (b.onclick = async () => {
    const message = prompt(`Kudos for ${b.dataset.name}:`, 'Great consistency this week — keep it up!');
    if (!message) return;
    await api('/api/manager/kudos', { method: 'POST', body: { userId: Number(b.dataset.kudos), message } });
    toast('Kudos sent 🎉');
  }));
  $$('[data-comment]').forEach((b) => (b.onclick = async () => {
    const comment = prompt('Coaching note for the rep:');
    if (!comment) return;
    await api(`/api/pitches/${b.dataset.comment}/comment`, { method: 'POST', body: { comment } });
    toast('Coaching note sent'); viewTeam();
  }));
  $('#assign').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const r = await api('/api/manager/assign', { method: 'POST', body: f });
      toast(`Assigned — ${r.notified} reps notified`); viewTeam();
    } catch (err) { toast(err.message, 'error'); }
  };
}

// ---------- Content studio ----------
async function viewStudio() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const tab = params.get('tab') || 'module';
  const tabs = { module: 'Module + quiz', scenario: 'Pitch scenario', battlecard: 'Battlecard', tip: 'Daily tip' };
  const forms = {
    module: `
      <div class="grid cols-2"><div class="field"><label>Title</label><input type="text" name="title" required /></div>
        <div class="field"><label>Topic</label><input type="text" name="topic" required placeholder="e.g. Discovery, Competitive" /></div></div>
      <div class="field"><label>One-line summary</label><input type="text" name="summary" required /></div>
      <div class="field"><label>Content (Markdown: ## headings, - bullets, **bold**)</label><textarea name="body" required style="min-height:200px"></textarea></div>
      <div class="grid cols-2"><div class="field"><label>Minutes</label><input type="number" name="minutes" value="5" min="1" /></div><div class="field"><label>XP reward</label><input type="number" name="xp" value="30" min="5" /></div></div>
      <h3 style="margin-top:1rem">Quiz questions</h3><p class="muted small">These also feed the Daily Challenge, so reps keep revisiting them with spaced repetition.</p>
      <div id="qs"></div><button type="button" class="btn small" id="add-q">+ Add question</button>`,
    scenario: `
      <div class="field"><label>Title</label><input type="text" name="title" required /></div>
      <div class="field"><label>Buyer persona</label><textarea name="persona" required style="min-height:70px"></textarea></div>
      <div class="field"><label>Situation</label><textarea name="situation" required style="min-height:70px"></textarea></div>
      <div class="field"><label>Rep's objective</label><input type="text" name="objective" required /></div>
      <div class="field"><label>Key points to cover (one per line)</label><textarea name="key_points" required style="min-height:110px"></textarea></div>
      <div class="field"><label>XP reward</label><input type="number" name="xp" value="40" min="5" /></div>`,
    battlecard: `
      <div class="field"><label>Title</label><input type="text" name="title" required /></div>
      <div class="field"><label>Category</label><input type="text" name="category" required placeholder="Competitive, Objections, Positioning, Proof points" /></div>
      <div class="field"><label>Content</label><textarea name="content" required></textarea></div>`,
    tip: '<div class="field"><label>Tip</label><textarea name="text" required style="min-height:80px" placeholder="A short, actionable tip reps can use today."></textarea></div>',
  };
  shell(`
    <div class="page-head"><div><h1>✏️ Content Studio</h1><p>Create the content your reps train on every day.</p></div>
      <div class="tabs">${Object.entries(tabs).map(([k, v]) => `<button class="${k === tab ? 'on' : ''}" data-tab="${k}">${v}</button>`).join('')}</div></div>
    <form class="card stack" id="studio">${forms[tab]}<div class="row"><span class="spacer"></span><button class="btn primary">Publish</button></div></form>`);
  $$('[data-tab]').forEach((b) => (b.onclick = () => (location.hash = `#/studio?tab=${b.dataset.tab}`)));

  const addQ = () => {
    const n = $$('.qblock').length;
    const div = document.createElement('div');
    div.className = 'card flat qblock stack';
    div.style.marginBottom = '.7rem';
    div.innerHTML = `<div class="field"><label>Question ${n + 1}</label><input type="text" class="q-prompt" required /></div>
      ${[0, 1, 2, 3].map((i) => `<div class="row"><input type="radio" name="ans${n}" value="${i}" ${i === 0 ? 'checked' : ''} title="Correct answer" /><input type="text" class="q-opt" placeholder="Option ${i + 1}${i < 2 ? ' (required)' : ''}" ${i < 2 ? 'required' : ''} style="flex:1" /></div>`).join('')}
      <div class="field"><input type="text" class="q-exp" placeholder="Explanation shown after answering" /></div><p class="muted tiny" style="margin:0">Select the radio button next to the correct answer.</p>`;
    $('#qs').append(div);
  };
  if (tab === 'module') { addQ(); $('#add-q').onclick = addQ; }

  $('#studio').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    let body = f;
    if (tab === 'module') {
      body = { ...f, questions: $$('.qblock').map((b, n) => {
        const opts = $$('.q-opt', b).map((i) => i.value.trim());
        const chosen = Number(b.querySelector(`input[name=ans${n}]:checked`).value);
        const keep = opts.map((o, i) => ({ o, i })).filter((x) => x.o);
        return { prompt: $('.q-prompt', b).value, options: keep.map((x) => x.o), answer_index: keep.findIndex((x) => x.i === chosen), explanation: $('.q-exp', b).value };
      }) };
      if (body.questions.some((q) => q.answer_index < 0)) return toast('The correct answer must be a filled-in option', 'error');
      for (const k of Object.keys(body)) if (k.startsWith('ans')) delete body[k];
    }
    if (tab === 'scenario') body = { ...f, key_points: f.key_points.split('\n').map((s) => s.trim()).filter(Boolean) };
    try {
      await api(`/api/content/${tab === 'module' ? 'modules' : `${tab}s`}`, { method: 'POST', body });
      toast('Published ✅');
      viewStudio();
    } catch (err) { toast(err.message, 'error'); }
  };
}

// ---------- AI Role-play ----------
async function viewRoleplays() {
  const [scenarios, history, cal] = await Promise.all([api('/api/scenarios'), api('/api/roleplays'), api('/api/calendar/meetings').catch(() => null)]);
  shell(`
    <div class="page-head"><div><h1>🎭 AI Role-play</h1><p>Practise a live call with a realistic buyer${me.aiCoach ? ' played by AI' : ''}. Talk or type, then get a scorecard on your discovery, objection handling and close.</p></div>
      <div><label for="difficulty">Buyer difficulty</label><select id="difficulty" style="min-width:200px">
        <option value="friendly">😊 Friendly: open and forthcoming</option><option value="skeptical" selected>🤨 Skeptical: make them trust you</option><option value="tough">😤 Tough: busy and pushes back</option></select></div></div>
    ${cal && cal.meetings.length ? `<section class="card" style="margin-bottom:1rem"><div class="card-head"><h2>📅 Rehearse a real meeting</h2></div>
      <ul class="list">${cal.meetings.map((m) => `<li><div style="flex:1"><b>${esc(m.title)}</b><div class="muted tiny">${esc(fmtWhen(m.start))}${m.deal ? ` · ${esc(m.deal.stage)}` : ''}</div></div><button class="btn small primary" data-roleplay-meeting="${m.id}">🎭 Rehearse</button></li>`).join('')}</ul></section>` : ''}
    <div class="grid cols-3">
      ${scenarios.map((s) => `<div class="card module-card" style="cursor:default">
        <span class="pill brand" style="align-self:flex-start">+60 XP</span>
        <h3>${esc(s.title)}</h3><p class="muted small" style="margin:0">${esc(s.persona)}</p>
        <p class="small" style="margin:.2rem 0"><b>Goal:</b> ${esc(s.objective)}</p>
        <button class="btn primary" style="margin-top:auto" data-roleplay-scenario="${s.id}">Start call 📞</button></div>`).join('')}
    </div>
    <section class="card" style="margin-top:1rem"><div class="card-head"><h2>Your recent calls</h2></div>
      ${history.length ? `<ul class="list">${history.map((h) => `<li><span class="pill ${h.score == null ? '' : tone(h.score)}" style="min-width:3rem;justify-content:center">${h.score ?? '…'}</span>
        <div style="flex:1"><a href="#/call/${h.id}"><b>${esc(h.title)}</b></a><div class="muted tiny">${esc(h.difficulty)} buyer · ${fmtDate(h.created_at)} · ${h.status === 'active' ? 'in progress' : 'completed'}</div></div></li>`).join('')}</ul>`
        : '<p class="muted">No calls yet. Pick a scenario above.</p>'}
    </section>`);
  bindRoleplayStarters();
}

let speakBuyer = localStorage.getItem('pp_voice') === '1';
function speak(text) {
  if (!speakBuyer || !window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.03;
  speechSynthesis.speak(u);
}

async function viewCall(id) {
  const rp = await api(`/api/roleplays/${id}`);
  if (rp.status === 'completed') return renderScorecard(rp);
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const repTurns = () => rp.transcript.filter((t) => t.role === 'rep').length;
  shell(`
    <div class="page-head"><div><a href="#/roleplay" class="small">← All role-plays</a><h1>📞 ${esc(rp.title)}</h1>
      <p><span class="pill">${esc(rp.difficulty)} buyer</span> ${rp.source === 'ai' ? '<span class="pill brand">AI buyer</span>' : '<span class="pill">Scripted buyer</span>'} · Goal: ${esc(rp.objective)}</p></div>
      <div class="row">${window.speechSynthesis ? `<label class="row small" style="margin:0;font-weight:500"><input type="checkbox" id="voice" ${speakBuyer ? 'checked' : ''}/> 🔊 Buyer speaks aloud</label>` : ''}
        <button class="btn" id="end">End call &amp; get scorecard</button></div></div>
    <div class="grid cols-2">
      <section class="card call">
        <div id="thread" class="thread"></div>
        <form id="say" class="row" style="margin-top:.8rem;flex-wrap:nowrap">
          ${SpeechRec ? '<button type="button" class="btn" id="mic" title="Hold a conversation by voice">🎙️</button>' : ''}
          <input type="text" id="line" placeholder="Say something to ${esc(rp.buyerName)}…" autocomplete="off" style="flex:1" />
          <button class="btn primary" id="send">Send</button>
        </form>
        <div class="muted tiny" style="margin-top:.4rem" id="turns"></div>
      </section>
      <section class="card stack">
        <div class="persona"><b>👤 Buyer:</b> ${esc(rp.persona)}</div>
        <div class="persona"><b>📍 Situation:</b> ${esc(rp.situation)}</div>
        <details><summary class="small muted" style="cursor:pointer">What the scorecard looks for</summary>
          <ul class="small">${rp.key_points.map((k) => `<li>${esc(k)}</li>`).join('')}</ul></details>
        <div class="explain small">💡 Real calls are conversations: ask questions, listen, then link value to what you hear. Aim to talk less than 60% of the time and finish with a concrete next step.</div>
      </section>
    </div>`);

  const thread = $('#thread');
  const bubble = (t) => `<div class="bubble ${t.role}"><div class="who">${t.role === 'rep' ? 'You' : esc(rp.buyerName)}</div>${esc(t.text)}</div>`;
  const render = () => {
    thread.innerHTML = rp.transcript.map(bubble).join('');
    thread.scrollTop = thread.scrollHeight;
    $('#turns').textContent = `${repTurns()}/${rp.maxTurns} turns`;
  };
  render();
  if (rp.transcript.length === 1) speak(rp.transcript[0].text);

  if ($('#voice')) $('#voice').onchange = (e) => { speakBuyer = e.target.checked; localStorage.setItem('pp_voice', speakBuyer ? '1' : '0'); if (!speakBuyer) speechSynthesis.cancel(); };
  const endCall = async () => {
    $('#end').disabled = true; $('#end').textContent = 'Scoring your call…';
    try {
      const done = await api(`/api/roleplays/${id}/end`, { method: 'POST' });
      celebrate({ ...done, completed: done.score >= 80 });
      renderScorecard(done);
    } catch (err) { toast(err.message, 'error'); $('#end').disabled = false; $('#end').textContent = 'End call & get scorecard'; }
  };
  $('#end').onclick = endCall;

  $('#say').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('#line').value.trim();
    if (!text) return;
    $('#line').value = '';
    $('#send').disabled = true;
    rp.transcript.push({ role: 'rep', text });
    render();
    thread.insertAdjacentHTML('beforeend', `<div class="bubble buyer typing"><div class="who">${esc(rp.buyerName)}</div>…</div>`);
    thread.scrollTop = thread.scrollHeight;
    try {
      const r = await api(`/api/roleplays/${id}/message`, { method: 'POST', body: { text } });
      rp.transcript.push({ role: 'buyer', text: r.reply });
      render();
      speak(r.reply);
      if (r.ended) {
        toast(`${rp.buyerName} has wrapped up the call`);
        $('#line').disabled = true;
        $('#end').classList.add('primary');
      }
    } catch (err) {
      rp.transcript.pop(); render(); $('#line').value = text; toast(err.message, 'error');
    } finally { $('#send').disabled = false; $('#line').focus(); }
  };

  if (SpeechRec) {
    let rec = null;
    $('#mic').onclick = () => {
      if (rec) { rec.stop(); return; }
      speechSynthesis?.cancel();
      rec = new SpeechRec();
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = true;
      rec.onresult = (ev) => { $('#line').value = [...ev.results].map((x) => x[0].transcript).join(' '); };
      rec.onend = () => { rec = null; $('#mic').innerHTML = '🎙️'; if ($('#line').value.trim()) $('#say').requestSubmit(); };
      rec.onerror = (ev) => toast(`Mic: ${ev.error}`, 'error');
      rec.start();
      $('#mic').innerHTML = '<span class="rec">●</span>';
    };
  }
  $('#line').focus();
}

function renderScorecard(rp) {
  const f = rp.feedback;
  const list = (items) => (items?.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p class="muted small">—</p>');
  shell(`
    <div class="page-head"><div><a href="#/roleplay" class="small">← All role-plays</a><h1>📋 Scorecard: ${esc(rp.title)}</h1>
      <p><span class="pill">${esc(rp.difficulty)} buyer</span> ${f.source === 'ai' ? '<span class="pill brand">Graded by AI coach</span>' : '<span class="pill">Rubric grading</span>'}</p></div>
      <div class="row"><button class="btn primary" id="again">🔁 Run it again</button></div></div>
    <div class="grid cols-2">
      <section class="card">
        <div class="row"><div class="feedback-score" style="color:var(--${tone(rp.score) || 'text'})">${rp.score}</div><div><b>/ 100</b></div><span class="spacer"></span>
          <div style="text-align:right"><div class="muted tiny">You talked</div><b class="${f.talk_ratio > 60 ? '' : ''}">${f.talk_ratio}%</b> <span class="muted tiny">of the call ${f.talk_ratio > 60 ? '(aim < 60%)' : '👍'}</span></div></div>
        ${bar(rp.score)}
        <p>${esc(f.summary)}</p>
        ${Object.entries(f.skills).map(([k, v]) => `<div style="margin-bottom:.7rem"><div class="row small"><b>${esc(f.skill_labels?.[k] || k)}</b><span class="spacer"></span>${v.score}/10</div>${bar(v.score * 10)}<div class="muted tiny" style="margin-top:.2rem">${esc(v.comment)}</div></div>`).join('')}
      </section>
      <section class="card stack">
        <div class="kv"><div><h3>💪 Strengths</h3>${list(f.strengths)}</div><div><h3>🛠 Improve</h3>${list(f.improvements)}</div></div>
        <div class="kv"><div><h3 class="small">✅ Key points hit</h3>${list(f.key_points_covered)}</div><div><h3 class="small">⚠️ Key points missed</h3>${list(f.key_points_missed)}</div></div>
        ${f.best_moment ? `<div class="explain"><b>⭐ Best moment:</b> “${esc(f.best_moment)}”</div>` : ''}
        ${f.missed_opportunity ? `<div class="explain"><b>🎯 Missed opportunity:</b> ${esc(f.missed_opportunity)}${f.better_line ? `<br><b>Try:</b> ${esc(f.better_line)}` : ''}</div>` : ''}
      </section>
      <section class="card span-2"><div class="card-head"><h2>Transcript</h2></div>
        <div class="thread" style="max-height:none">${rp.transcript.map((t) => `<div class="bubble ${t.role}"><div class="who">${t.role === 'rep' ? 'You' : esc(rp.buyerName)}</div>${esc(t.text)}</div>`).join('')}</div>
      </section>
    </div>`);
  $('#again').onclick = () => (location.hash = '#/roleplay');
}

// ---------- Admin: Integrations ----------
async function viewIntegrations() {
  const st = await api('/api/integrations/status');
  const pill = (on, onText = 'Connected', offText = 'Not configured') => `<span class="pill ${on ? 'good' : ''}">${on ? onText : offText}</span>`;
  const code = (v) => `<code style="word-break:break-all">${esc(v)}</code>`;
  const run = (r) => (r ? `<div class="small ${r.status === 'error' ? '' : 'muted'}" style="${r.status === 'error' ? 'color:var(--bad)' : ''}">Last run ${esc(r.created_at)} UTC: ${esc(r.detail)}</div>` : '<div class="muted small">No runs yet.</div>');
  const isAdmin = me.role === 'admin';
  shell(`
    <div class="page-head"><div><h1>🔌 Integrations</h1><p>Connect PitchPulse to the tools your team already uses. Configured with environment variables; see the README for step-by-step setup.</p></div></div>
    <div class="grid cols-2">
      <section class="card stack"><div class="card-head"><h2>🔐 Single sign-on</h2>${pill(st.sso.enabled, st.sso.name)}</div>
        <p class="small muted" style="margin:0">OpenID Connect: Google Workspace, Okta, Microsoft Entra ID and others. New users are created on first sign-in as reps.</p>
        <div class="small">Redirect URI: ${code(st.sso.redirectUri)}</div>
        ${st.sso.enabled ? `<div class="small">Issuer: ${code(st.sso.issuer)}<br>Allowed domains: ${st.sso.allowedDomains.length ? esc(st.sso.allowedDomains.join(', ')) : 'any'} · Password login: ${st.sso.ssoOnly ? 'disabled' : 'enabled'} · ${st.sso.ssoUsers} SSO users</div>` : '<div class="small muted">Set <code>OIDC_ISSUER</code>, <code>OIDC_CLIENT_ID</code>, <code>OIDC_CLIENT_SECRET</code>.</div>'}
      </section>
      <section class="card stack"><div class="card-head"><h2>💼 CRM sync</h2>${pill(!!st.crm.provider, st.crm.provider || '')}</div>
        <p class="small muted" style="margin:0">Read-only sync of opportunities from Salesforce or HubSpot, matched to reps by email. Powers win-rate vs readiness and deal-stage coaching.</p>
        <div class="small">${st.crm.deals} deals stored · ${st.crm.linkedDeals} linked to reps${st.crm.provider ? ` · auto-sync every ${st.crm.syncMinutes} min` : ''}</div>
        ${run(st.crm.lastRun)}
        ${st.crm.provider ? (isAdmin ? '<button class="btn small" id="crm-sync" style="align-self:flex-start">🔄 Sync now</button>' : '') : '<div class="small muted">Set <code>CRM_PROVIDER</code> to <code>salesforce</code> or <code>hubspot</code> plus credentials. Showing demo pipeline data until then.</div>'}
      </section>
      <section class="card stack"><div class="card-head"><h2>📅 Google Calendar</h2>${pill(st.calendar.enabled, 'Available to reps')}</div>
        <p class="small muted" style="margin:0">Each rep connects their own calendar (read-only). Upcoming customer meetings get a prep card and a one-click role-play.</p>
        <div class="small">Redirect URI: ${code(st.calendar.redirectUri)}</div>
        <div class="small">${st.calendar.connectedUsers} reps connected</div>
        ${st.calendar.enabled ? '' : '<div class="small muted">Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>.</div>'}
      </section>
      <section class="card stack"><div class="card-head"><h2>💬 Google Chat</h2>${pill(st.googleChat.enabled, st.googleChat.canSend ? 'Live' : 'Receiving only')}</div>
        <p class="small muted" style="margin:0">Reps take the Daily Challenge with interactive cards in a Chat DM. The app sends it every morning at ${st.googleChat.hour}:00.</p>
        <div class="small">Endpoint URL: ${code(st.googleChat.endpoint)}</div>
        <div class="small">${st.googleChat.linkedUsers} reps linked</div>
        ${run(st.googleChat.lastRun)}
        ${st.googleChat.canSend && isAdmin ? '<button class="btn small" id="chat-send" style="align-self:flex-start">📨 Send today\'s challenge now</button>' : ''}
        ${st.googleChat.enabled ? '' : '<div class="small muted">Set <code>GOOGLE_CHAT_AUDIENCE</code> and <code>GOOGLE_CHAT_SERVICE_ACCOUNT</code>.</div>'}
      </section>
      <section class="card stack"><div class="card-head"><h2>📚 Weekly GTM digest</h2>${pill(st.digest.enabled, st.digest.delivery === 'webhook' ? 'Chat webhook' : 'Chat space')}</div>
        <p class="small muted" style="margin:0">Every ${['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][st.digest.day] || 'Monday'} at ${st.digest.hour}:00, 3-5 short lessons from the week's Gong calls, Drive updates and web news are posted to your team's Chat space. Its quiz questions join the Daily Challenge.</p>
        <div class="small">Sources: ${pill(st.digest.gong, 'Gong', 'Gong off')} ${pill(st.digest.drive, `Drive (${st.digest.driveFolders} folders)`, 'Drive off')} ${pill(st.digest.web, 'Web', 'Web off')} · ${st.digest.sent} sent</div>
        ${st.digest.web ? `<div class="small muted">Web topics: ${esc(st.digest.webTopics.join('; '))}</div>` : ''}
        ${run(st.digest.lastRun)}
        ${isAdmin ? '<div class="row" style="gap:8px"><button class="btn small" id="digest-preview">👀 Preview this week</button>' + (st.digest.enabled ? '<button class="btn small primary" id="digest-send">📨 Send now</button>' : '') + '</div>' : ''}
        ${st.digest.enabled ? '' : '<div class="small muted">Set <code>GOOGLE_CHAT_DIGEST_WEBHOOK</code> (or <code>GOOGLE_CHAT_DIGEST_SPACE</code>) plus at least one source: <code>GONG_ACCESS_KEY</code>, <code>GOOGLE_DRIVE_FOLDER_IDS</code> or <code>DIGEST_WEB_TOPICS</code>.</div>'}
        <div id="digest-out" class="stack"></div>
      </section>
      <section class="card stack"><div class="card-head"><h2>🧠 AI coach &amp; role-play buyer</h2>${pill(st.ai.enabled, 'Claude')}</div>
        <p class="small muted" style="margin:0">${st.ai.enabled ? 'Pitch feedback, role-play buyers and scorecards use Claude.' : 'Using the scripted buyer and rubric scoring. Set <code>ANTHROPIC_API_KEY</code> for AI buyers and coaching.'}</p>
      </section>
    </div>`);
  if ($('#crm-sync')) $('#crm-sync').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Syncing…';
    try { const r = await api('/api/integrations/crm/sync', { method: 'POST' }); toast(r.detail); } catch (err) { toast(err.message, 'error'); }
    viewIntegrations();
  };
  const showDigest = (d) => {
    $('#digest-out').innerHTML = `<div class="small"><b>${esc(d.content.headline)}</b> · ${esc(d.week)} · ${esc(d.status)}${d.sources.errors.length ? ` · <span style="color:var(--bad)">${esc(d.sources.errors.join('; '))}</span>` : ''}</div>
      ${d.content.items.map((it) => `<div class="small"><b>${esc(it.title)}</b><br>${esc(it.takeaway)}${it.try_this ? `<br><i>Try this: ${esc(it.try_this)}</i>` : ''}</div>`).join('')}
      ${d.content.quiz.map((q) => `<div class="small muted">🧠 ${esc(q.prompt)}</div>`).join('')}`;
  };
  if ($('#digest-preview')) $('#digest-preview').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Building… (up to a minute)';
    try { showDigest(await api('/api/digests/preview', { method: 'POST' })); toast('Draft saved. "Send now" posts this version.'); } catch (err) { toast(err.message, 'error'); }
    e.target.disabled = false; e.target.textContent = '👀 Preview this week';
  };
  if ($('#digest-send')) $('#digest-send').onclick = async (e) => {
    e.target.disabled = true;
    try {
      let r = await api('/api/digests/send', { method: 'POST', body: {} });
      if (r.skipped && confirm(`This week's digest was already sent. Send it again?`)) r = await api('/api/digests/send', { method: 'POST', body: { force: true } });
      if (!r.skipped) toast('Digest posted to Google Chat');
    } catch (err) { toast(err.message, 'error'); }
    viewIntegrations();
  };
  if ($('#chat-send')) $('#chat-send').onclick = async (e) => {
    e.target.disabled = true;
    try { const r = await api('/api/integrations/google-chat/send', { method: 'POST' }); toast(`Sent ${r.sent}, failed ${r.failed}`); } catch (err) { toast(err.message, 'error'); }
    viewIntegrations();
  };
}

// ---------- Boot ----------
async function boot() {
  try { await refreshMe(); } catch { return renderLogin(); }
  if (!location.hash) { location.hash = me.role === 'rep' ? '#/today' : '#/team'; return; } // hashchange renders
  await router();
}
addEventListener('hashchange', router);
boot();
