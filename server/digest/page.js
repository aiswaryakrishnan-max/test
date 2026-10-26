// The full web card behind "Open full card": the week's five days as tabs, in the team's digest design.
import { addDays } from '../engagement.js';
import { DAYS, DAY_INFO } from './defaults.js';
import { citedIds } from './validate.js';
import { BASE_CSS, esc, visualFigure } from './visuals.js';

const PAGE_CSS = `
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--sans); font-size: 16px; line-height: 1.55; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 28px 20px 64px; }
  .masthead h1 { font-family: var(--serif); font-weight: 700; font-size: clamp(30px, 6vw, 46px); line-height: 1.08; margin: 0 0 6px; letter-spacing: -0.01em; }
  .masthead .week { color: var(--muted); margin: 0 0 14px; font-size: 15px; }
  .masthead .promise { font-size: 17px; max-width: 60ch; margin: 0 0 16px; }
  .challenge { border: 1px solid var(--line); background: var(--card); border-radius: 10px; padding: 12px 16px; font-size: 14.5px; max-width: 66ch; }
  .daystrip { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin: 26px 0 18px; }
  .daytab { font: inherit; color: var(--ink); text-align: left; background: var(--card); border: 1px solid var(--line); border-bottom: 4px solid var(--tabcol); border-radius: 10px 10px 4px 4px; padding: 10px 12px 9px; cursor: pointer; }
  .daytab:hover, .daytab[aria-selected="true"] { background: var(--tabtint); }
  .daytab[aria-selected="true"] { border-color: var(--tabcol); }
  .daytab:focus-visible { outline: 3px solid var(--tabcol); outline-offset: 2px; }
  .daytab .dname { font-family: var(--serif); font-weight: 700; font-size: 18px; display: block; }
  .daytab .dtheme { font-size: 12.5px; color: var(--muted); display: block; line-height: 1.3; margin-top: 2px; }
  .panel { display: none; } .panel.active { display: block; }
  .daycard { background: var(--card); border: 1px solid var(--line); border-top: 6px solid var(--accent); border-radius: 6px 6px 14px 14px; padding: 24px 24px 26px; }
  .daymeta { color: var(--muted); font-size: 14px; margin: 0 0 6px; } .daymeta b { color: var(--ink); font-weight: 600; }
  .daycard h2 { font-family: var(--serif); font-size: clamp(25px, 4.6vw, 34px); line-height: 1.15; margin: 0 0 18px; max-width: 30ch; }
  .daycard h3 { font-family: var(--serif); font-size: 20px; margin: 28px 0 8px; }
  .daycard p { margin: 0 0 12px; max-width: 70ch; }
  .small { font-size: 14px; color: var(--muted); }
  .say { margin: 22px 0 6px; border-left: 5px solid var(--accent); background: var(--tint); border-radius: 4px 10px 10px 4px; padding: 14px 18px; }
  .say .lab { font-size: 13.5px; font-weight: 700; color: var(--muted); margin: 0 0 4px; }
  .say p { font-family: var(--serif); font-size: 19px; line-height: 1.4; margin: 0; max-width: 60ch; }
  .gloss { display: grid; gap: 8px; margin: 10px 0 4px; }
  .gloss details { border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  .gloss summary { cursor: pointer; padding: 10px 14px; font-weight: 600; list-style-position: inside; }
  .gloss details[open] summary { border-bottom: 1px solid var(--line); }
  .gloss .body { padding: 10px 14px 12px; font-size: 15px; } .gloss .body p { margin: 0 0 6px; }
  .gloss .call { color: var(--muted); } .gloss .call b { color: var(--ink); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 10px 0; }
  .grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 10px 0; }
  .mini { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; background: var(--card); font-size: 14.5px; }
  .mini h4 { font-family: var(--serif); font-size: 17px; margin: 0 0 6px; line-height: 1.25; }
  .mini p { margin: 0 0 7px; max-width: none; } .mini p:last-child { margin-bottom: 0; }
  .mini ul { margin: 0; padding-left: 18px; } .mini li { margin-bottom: 4px; }
  .mini .q { font-weight: 600; } .mini .k { color: var(--muted); font-size: 13.5px; } .mini .k b { color: var(--ink); }
  .tag { display: inline-block; font-size: 12.5px; font-weight: 600; background: var(--tint); border: 1px solid var(--accent); border-radius: 999px; padding: 2px 10px; margin: 0 6px 6px 0; }
  ol.steps { list-style: none; margin: 10px 0; padding: 0; display: grid; gap: 10px; counter-reset: s; }
  ol.steps li { display: grid; grid-template-columns: 38px 1fr; gap: 12px; align-items: start; border: 1px solid var(--line); background: var(--card); border-radius: 10px; padding: 12px 14px; counter-increment: s; }
  ol.steps li::before { content: counter(s); font-family: var(--serif); font-weight: 700; font-size: 20px; width: 34px; height: 34px; display: grid; place-items: center; border-radius: 50%; background: var(--tint); border: 2px solid var(--accent); }
  ol.steps b { display: block; font-size: 15px; } ol.steps span { font-size: 15px; }
  ol.timeline { list-style: none; margin: 8px 0; padding: 0 0 0 22px; border-left: 3px solid var(--accent); display: grid; gap: 14px; }
  ol.timeline > li { position: relative; }
  ol.timeline > li::before { content: ""; position: absolute; left: -31px; top: 5px; width: 14px; height: 14px; border-radius: 50%; background: var(--card); border: 3px solid var(--accent); }
  ol.timeline .when { font-family: var(--serif); font-weight: 700; font-size: 17px; }
  ol.timeline ul { margin: 4px 0 0; padding-left: 18px; font-size: 15px; }
  .stat .big { font-family: var(--serif); font-weight: 700; font-size: 34px; line-height: 1; margin: 0 0 4px; color: var(--accent); }
  .stat .lab { font-size: 14px; margin: 0 0 8px; } .stat .who { font-size: 13.5px; color: var(--muted); margin: 0; }
  .slot { border: 2px dashed var(--muted); border-radius: 12px; padding: 14px 16px; font-size: 14.5px; }
  .slot h4 { font-family: var(--serif); font-size: 17px; margin: 0 0 6px; } .slot p { margin: 0 0 6px; max-width: none; } .slot .ph { color: var(--muted); }
  .quizbox { margin-top: 28px; border-top: 1px solid var(--line); padding-top: 18px; } .quizbox > h3 { margin-top: 0; }
  .quiz { margin: 0 0 18px; } .quiz .qtext { font-weight: 600; margin: 0 0 8px; max-width: 64ch; }
  .opts { display: grid; gap: 8px; }
  .opt { font: inherit; text-align: left; color: var(--ink); background: var(--card); border: 1.5px solid var(--line); border-radius: 9px; padding: 10px 14px; cursor: pointer; }
  .opt:hover:not(:disabled) { border-color: var(--accent); background: var(--tint); }
  .opt:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; } .opt:disabled { cursor: default; }
  .opt.right { border-color: var(--good); background: var(--fri-t); } .opt.wrong { border-color: var(--bad); background: var(--wed-t); }
  .opt .mark { font-weight: 700; margin-right: 6px; }
  .why { margin: 10px 0 0; padding: 10px 14px; border-radius: 8px; background: var(--tint); font-size: 15px; max-width: 64ch; }
  .score { font-family: var(--serif); font-size: 20px; margin: 4px 0 0; font-weight: 700; }
  .sources { margin-top: 22px; font-size: 13px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 10px; }
  .sources p { margin: 0 0 4px; max-width: none; } .sources a { color: inherit; }
  .review { border: 2px solid var(--bad); border-radius: 10px; padding: 10px 14px; margin: 0 0 14px; font-size: 14px; }
  .review.ok { border-color: var(--good); }
  .footer { margin-top: 28px; font-size: 13.5px; color: var(--muted); } .footer p { max-width: 75ch; margin: 0 0 6px; }
  @media (max-width: 720px) {
    .daystrip { gap: 4px; } .daytab { padding: 8px 6px 7px; } .daytab .dname { font-size: 15px; } .daytab .dtheme { display: none; }
    .grid2, .grid3 { grid-template-columns: 1fr; } .daycard { padding: 18px 16px 20px; }
  }`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateParts = (day) => { const [y, m, d] = day.split('-').map(Number); return { y, m: MONTHS[m - 1], d }; };

function sourcesFooter(card, catalog, note) {
  const items = citedIds(card).map((id) => catalog[id]).filter(Boolean);
  if (!items.length && !note) return '';
  const link = (s) => (s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>` : esc(s.title));
  return `<div class="sources">${items.length ? `<p>Sources: ${items.map(link).join('; ')}.</p>` : ''}${note ? `<p>${esc(note)}</p>` : ''}</div>`;
}

const say = (line) => (line ? `<div class="say"><p class="lab">Say it on your next call</p><p>“${esc(line)}”</p></div>` : '');

function quizHtml(cardId, quiz, { recap = false } = {}) {
  return quiz.map((q, i) => `<div class="quiz" data-card="${cardId}" data-q="${i}" data-answer="${Number(q.answer_index)}">
    <p class="qtext">${recap ? `${i + 1}. ` : ''}${esc(q.question)}</p>
    <div class="opts">${(q.options || []).map((o, j) => `<button class="opt" data-i="${j}">${esc(o)}</button>`).join('')}</div>
    <p class="why" hidden>${esc(q.explanation)}</p></div>`).join('');
}

const DAY_BODY = {
  mon: (c) => `
    <h3>Tap a term to see how to use it</h3>
    <div class="gloss">${(c.terms || []).map((t) => `<details><summary>${esc(t.term)}</summary><div class="body"><p>${esc(t.definition)}</p><p class="call"><b>In a call:</b> ${esc(t.in_a_call)}</p></div></details>`).join('')}</div>
    ${(c.happening || []).length ? `<h3>What's happening</h3>${c.happening.map((p) => `<p>${esc(p.text)}</p>`).join('')}` : ''}
    ${c.why_it_matters?.text ? `<p><b>Why it matters to us:</b> ${esc(c.why_it_matters.text)}</p>` : ''}
    ${(c.events || []).length ? `<h3>On the calendar</h3><div class="grid2">${c.events.map((e) => `<div class="mini"><h4>${esc(e.name)}</h4><p class="k">${esc(e.dates)}</p><p>${esc(e.why)}</p></div>`).join('')}</div>` : ''}`,
  tue: (c) => `
    ${c.persona ? `<h3>Who you're talking to</h3><div class="grid2">
      <div class="mini"><h4>${esc(c.persona.role)}</h4><p>${esc(c.persona.description)}</p></div>
      <div class="mini"><h4>What they're judged on</h4><ul>${(c.persona.judged_on || []).map((j) => `<li>${esc(j)}</li>`).join('')}</ul></div></div>` : ''}
    ${(c.pains || []).length ? `<p>${c.pains.map((p) => `<span class="tag">${esc(p.text)}</span>`).join('')}</p>` : ''}
    ${(c.discovery || []).length ? `<h3>${c.discovery.length === 4 ? 'Four discovery questions' : 'Discovery questions'} that find the pain</h3><div class="grid2">${c.discovery.map((d) => `<div class="mini"><h4>${esc(d.label)}</h4><p class="q">“${esc(d.question)}”</p><p class="k"><b>Listen for:</b> ${esc(d.listen_for)}</p><p class="k"><b>Our answer:</b> ${esc(d.our_answer)}</p></div>`).join('')}</div>` : ''}
    ${(c.customer_language || []).length ? `<h3>In their words</h3><div class="grid2">${c.customer_language.map((l) => `<div class="mini"><p class="q">“${esc(l.phrase)}”</p><p class="k">${esc(l.meaning)}</p></div>`).join('')}</div>` : ''}`,
  wed: (c) => `
    ${c.objection ? `<h3>“${esc(c.objection.quote)}” Four moves, in order</h3><ol class="steps">
      ${[['Acknowledge', c.objection.acknowledge], ['Reframe', c.objection.reframe], ['Prove', c.objection.prove], ['Ask', c.objection.ask]].map(([l, t]) => `<li><div><b>${l}</b><span>${esc(t)}</span></div></li>`).join('')}</ol>` : ''}
    ${c.second_objection?.quote ? `<h3>Second objection: “${esc(c.second_objection.quote)}”</h3><p>${esc(c.second_objection.answer)}</p>` : ''}
    ${(c.competitors || []).length ? `<h3>Who else shows up, and what to ask</h3><div class="grid2">${c.competitors.map((k) => `<div class="mini"><h4>${esc(k.category)}</h4><p class="k">${esc(k.examples)}</p><p class="q">“${esc(k.question)}”</p>${k.strength ? `<p class="k"><b>Honest strength:</b> ${esc(k.strength)}</p>` : ''}</div>`).join('')}</div>
      <p class="small">These are discovery questions, not claims about competitors. Check a competitor's current product before saying anything specific about it.</p>` : ''}
    ${c.packaging?.text ? `<h3>Which package to lead with</h3><p>${esc(c.packaging.text)}</p>` : ''}`,
  thu: (c) => `
    ${c.use_case ? `<h3>Use case: ${esc(c.use_case.name)}</h3><p><b>Buyer:</b> ${esc(c.use_case.buyer)}. <b>Trigger:</b> ${esc(c.use_case.trigger)}.</p><p><b>Outcome:</b> ${esc(c.use_case.outcome)}</p>` : ''}
    ${(c.releases || []).length ? `<h3>What shipped, newest first</h3><ol class="timeline">${c.releases.map((r) => `<li><span class="when">${esc(r.when)}${r.title ? `: ${esc(r.title)}` : ''}</span><ul>${(r.items || []).map((i) => `<li>${esc(i)}</li>`).join('')}</ul></li>`).join('')}</ol>` : ''}
    ${(c.more_use_cases || []).length ? `<h3>Use cases and when they usually come up</h3><div class="grid2">${c.more_use_cases.map((u) => `<div class="mini"><h4>${esc(u.name)}</h4><p class="k"><b>Buyer:</b> ${esc(u.buyer)}. <b>Trigger:</b> ${esc(u.trigger)}.</p></div>`).join('')}</div>` : ''}`,
  fri: (c, catalog) => {
    const stories = (c.stories || []).map((s) => ({ ...s, src: catalog[s.source_id] })).filter((s) => s.src);
    const clip = c.clip;
    return `
    ${(c.proof_points || []).length ? `<h3>Published proof points you can use today</h3><div class="grid3">${c.proof_points.map((p) => `<div class="mini stat"><p class="big">${esc(p.figure)}</p><p class="lab">${esc(p.label)}</p><p class="who">${esc(p.who)}</p></div>`).join('')}</div>` : ''}
    ${(c.win_reasons || []).length ? `<p><b>Reasons to win:</b></p><p>${c.win_reasons.map((r) => `<span class="tag">${esc(r.text)}</span>`).join('')}</p>` : ''}
    <h3>From our own pipeline</h3>
    <div class="grid3">
      ${stories.map((s) => `<div class="mini"><h4>${s.src.outcome === 'won' ? 'Closed-won' : s.src.outcome === 'lost' ? 'Closed-lost' : 'Last four weeks'}</h4>
        <p class="k">${esc(s.src.title.replace(/^Closed (won|lost): /, ''))}</p>
        ${s.src.reason ? `<p class="k"><b>${s.src.outcome === 'won' ? 'Reason to win' : 'Reason lost'}:</b> ${esc(s.src.reason)}</p>` : ''}
        ${s.src.competitor ? `<p class="k"><b>Competitor:</b> ${esc(s.src.competitor)}</p>` : ''}
        <p><b>Lesson:</b> ${esc(s.lesson)}</p></div>`).join('') || '<div class="slot"><h4>Win and loss</h4><p class="ph">No closed deals with recorded reasons this week.</p></div>'}
      ${clip ? `<div class="mini"><h4>Clip of the week</h4><p class="q">${esc(clip.title)}</p><p class="k"><b>Why it works:</b> ${esc(c.clip_why || clip.why)}</p><p class="k"><b>Skill:</b> ${esc(clip.skill)}</p>${clip.url ? `<p><a href="${esc(clip.url)}" target="_blank" rel="noopener">Watch in Gong</a></p>` : ''}</div>`
        : '<div class="slot"><h4>Clip of the week</h4><p class="ph">No manager-approved clip this week. Managers can nominate one in PitchPulse.</p></div>'}
    </div>`;
  },
};

function fallbackBody(c) {
  return `${(c.body_points || []).map((p) => `<p>${esc(p.text)}</p>`).join('')}`;
}

function panel(day, card, { week, catalog, preview }) {
  const info = DAY_INFO[day];
  const date = dateParts(addDays(week.week, DAYS.indexOf(day)));
  if (!card) return `<section class="panel d-${day}" id="p-${day}" role="tabpanel" aria-labelledby="tab-${day}"><article class="daycard"><p class="daymeta"><b>${info.name}.</b> ${esc(info.blurb)}</p><h2>Coming ${info.name}</h2></article></section>`;
  // Reviewers see the draft behind a fallback, with the validator findings that kept it out.
  const c = preview && card.content.replaced_draft ? card.content.replaced_draft : card.content;
  const minutes = day === 'fri' ? 3 : 2;
  const review = preview ? `<div class="review ${card.issues.some((i) => i.level === 'error') ? '' : 'ok'}"><b>${esc(card.status)}</b>${card.content.replaced_draft ? ' · a refresher goes out instead of this draft unless it is fixed and approved' : ''}${card.sensitive ? ' · needs human approval' : ''}
    ${card.issues.length ? `<ul>${card.issues.map((i) => `<li>${i.level === 'error' ? '⛔' : '⚠️'} ${esc(i.path)}: ${esc(i.message)}</li>`).join('')}</ul>` : ' · validators passed'}</div>` : '';
  const quizTitle = day === 'fri' ? 'Weekly recap' : 'One question';
  return `<section class="panel d-${day}" id="p-${day}" role="tabpanel" aria-labelledby="tab-${day}">
    <article class="daycard">${review}
      <p class="daymeta"><b>${info.name} ${date.d}.</b> ${esc(c.fallback ? 'A quick refresher.' : info.blurb)} About ${minutes} minutes.</p>
      <h2>${esc(c.headline)}</h2>
      ${c.fallback ? fallbackBody(c) : `${visualFigure(day, c)}${DAY_BODY[day](c, catalog)}`}
      ${say(c.say_it)}
      ${(c.quiz || []).length ? `<div class="quizbox"><h3>${quizTitle}</h3><div class="${day === 'fri' ? 'recap' : ''}">${quizHtml(card.id, c.quiz, { recap: day === 'fri' })}${day === 'fri' ? '<p class="score" hidden></p>' : ''}</div></div>` : ''}
      ${sourcesFooter(c, catalog, day === 'fri' ? 'Win and loss stories are anonymized: segment and deal size band only. Figures are as published in approved case studies.' : '')}
    </article></section>`;
}

const SCRIPT = `(function () {
  var tabs = [].slice.call(document.querySelectorAll('.daytab')), panels = [].slice.call(document.querySelectorAll('.panel'));
  function show(i, focus) {
    tabs.forEach(function (t, j) { var on = i === j; t.setAttribute('aria-selected', on); t.setAttribute('tabindex', on ? '0' : '-1'); panels[j].classList.toggle('active', on); });
    if (focus) tabs[i].focus();
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { show(i); });
    t.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); show((i + 1) % tabs.length, true); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); show((i + tabs.length - 1) % tabs.length, true); }
    });
  });
  var days = ['mon', 'tue', 'wed', 'thu', 'fri'], start = document.body.getAttribute('data-start');
  var wanted = days.indexOf(location.hash.slice(1));
  if (wanted < 0) { var diff = Math.round((new Date() - new Date(start + 'T00:00:00')) / 864e5); if (diff >= 0 && diff < 5) wanted = diff; }
  show(wanted < 0 ? 0 : wanted);
  window.addEventListener('hashchange', function () { var i = days.indexOf(location.hash.slice(1)); if (i >= 0) show(i); });
  [].forEach.call(document.querySelectorAll('.recap'), function (recap) {
    var total = recap.querySelectorAll('.quiz').length, answered = 0, correct = 0;
    recap.addEventListener('answered', function (e) {
      answered++; if (e.detail) correct++;
      if (answered === total) { var s = recap.querySelector('.score'); s.hidden = false;
        s.textContent = 'Recap score: ' + correct + ' of ' + total + '. ' + (correct === total ? 'Clean sweep. Go use it on a call.' : 'Re-read the days you missed, and try again next Friday.'); }
    });
  });
  [].forEach.call(document.querySelectorAll('.quiz'), function (q) {
    var ans = +q.getAttribute('data-answer'), btns = q.querySelectorAll('.opt');
    [].forEach.call(btns, function (b) {
      b.addEventListener('click', function () {
        var pick = +b.getAttribute('data-i');
        [].forEach.call(btns, function (x) {
          x.disabled = true; var i = +x.getAttribute('data-i');
          if (i === ans) { x.classList.add('right'); x.insertAdjacentHTML('afterbegin', '<span class="mark">Correct.</span>'); }
          else if (i === pick) { x.classList.add('wrong'); x.insertAdjacentHTML('afterbegin', '<span class="mark">Not quite.</span>'); }
        });
        q.querySelector('.why').hidden = false;
        q.parentNode.dispatchEvent(new CustomEvent('answered', { detail: pick === ans }));
        fetch('/api/digest/answers', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pitchpulse' },
          body: JSON.stringify({ cardId: +q.getAttribute('data-card'), questionIndex: +q.getAttribute('data-q'), choice: pick }) }).catch(function () {});
      });
    });
  });
})();`;

export function weekPage({ week, cards, title, preview = false }) {
  const byDay = Object.fromEntries(cards.map((c) => [c.day, c]));
  const catalog = week.sources || {};
  const first = dateParts(week.week);
  const last = dateParts(addDays(week.week, 4));
  const range = first.m === last.m ? `${first.m} ${first.d} to ${last.d}, ${last.y}` : `${first.m} ${first.d} to ${last.m} ${last.d}, ${last.y}`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}: week of ${esc(range)}</title><style>${BASE_CSS}${PAGE_CSS}</style></head>
<body data-start="${esc(week.week)}"><div class="wrap">
  <header class="masthead">
    <h1>${esc(title)}</h1>
    <p class="week">Week of ${esc(range)}.${week.plan?.focus ? ` This week's focus: ${esc(week.plan.focus)}.` : ''}${preview ? ' <b>Reviewer preview: includes cards that are not approved yet.</b>' : ''}</p>
    <p class="promise">One idea a day. Two minutes to read. One line you can say on your next call.</p>
    ${week.challenge ? `<div class="challenge"><strong>This week's challenge:</strong> ${esc(week.challenge)}</div>` : ''}
  </header>
  <nav class="daystrip" role="tablist" aria-label="Days of the week">
    ${DAYS.map((d, i) => `<button class="daytab t-${d}" role="tab" id="tab-${d}" aria-controls="p-${d}" aria-selected="${i === 0}" ${i ? 'tabindex="-1"' : ''}><span class="dname">${DAY_INFO[d].short} ${dateParts(addDays(week.week, i)).d}</span><span class="dtheme">${esc(DAY_INFO[d].theme)}</span></button>`).join('')}
  </nav>
  <main>${DAYS.map((d) => panel(d, byDay[d], { week, catalog, preview })).join('')}</main>
  <footer class="footer"><p>Built for the GTM team from approved sources only: the Approved Drive library, Gong, Salesforce and a short list of outside sites. Every fact links to its source.</p></footer>
</div><script>${SCRIPT}</script></body></html>`;
}
