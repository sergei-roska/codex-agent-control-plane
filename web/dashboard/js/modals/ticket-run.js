// --- M3: RUN PANEL IN THE TICKET DETAIL (GET /runs/:runId, decisions, plan, candidate, settings) ---
// Every server string is untrusted and rendered with textContent only. The diff is text in a <pre>.
const TRR_STEPS = [
  { key: 'queued', label: 'Queued' },
  { key: 'intake', label: 'Intake' },
  { key: 'plan', label: 'Plan' },
  { key: 'branch', label: 'Branch' },
  { key: 'engineering', label: 'Engineering' },
  { key: 'candidate', label: 'Candidate' },
  { key: 'review', label: 'Review' }
];
const TRR_TABS = [
  { key: 'requirements', label: 'Requirements' },
  { key: 'plan', label: 'Plan' },
  { key: 'candidate', label: 'Candidate' },
  { key: 'settings', label: 'Settings' },
  { key: 'execution', label: 'Execution' },
  { key: 'run-log', label: 'Run Log' },
  { key: 'turns', label: 'Turns/events' },
  { key: 'attempts-activity', label: 'Attempts' },
  { key: 'tokens', label: 'Tokens' }
];
const TRR_DIFF_CHUNK = 2000;
const TRR_ANSWER_MAX = 4000;
const TRR_TERMINAL = ['completed', 'failed', 'stopped', 'cancelled'];
const TRR_INACTIVE_TICKET_STATUSES = ['backlog', 'done', 'cancelled'];

// sigs: per-section render signatures so polling never rebuilds (and so never resets) an untouched section.
const trr = {
  pick: null, runId: null, data: null, dataRunId: null, error: null, tab: 'requirements',
  sigs: {}, drafts: {}, answering: null, answerError: {}, reviewError: '', diff: null, usage: null,
  activity: null
};
const TRR_FINDINGS_MAX = 8000;
const TRD_MESSAGE_MAX = 2000;

// Delivery panel state (GET /tickets/:id/delivery). Inputs live here so a rebuild never resets them.
const trd = { ticketId: null, key: null, fetchedAt: 0, data: null, error: null, message: null, remote: null, loading: false };

function trdReset() {
  trd.ticketId = null;
  trd.key = null;
  trd.fetchedAt = 0;
  trd.data = null;
  trd.error = null;
  trd.message = null;
  trd.remote = null;
  trd.loading = false;
}

function trrReset() {
  trr.pick = null;
  trr.runId = null;
  trr.data = null;
  trr.dataRunId = null;
  trr.error = null;
  trr.tab = 'requirements';
  trr.usage = null;
  trr.sigs = {};
  trr.drafts = {};
  trr.answering = null;
  trr.answerError = {};
  trr.reviewError = '';
  trr.diff = null;
  trr.activity = null;
  trdReset();
}

function trrSelectedRun(d) {
  const runs = Array.isArray(d.runs) ? d.runs : [];
  const run = runs.find(r => r.runId === trr.pick)
    || (d.activeRun ? runs.find(r => r.runId === d.activeRun.runId) : null)
    || runs[0] || d.activeRun || null;
  return { runs, run };
}

function trrData(run) {
  return run && trr.data && trr.dataRunId === run.runId ? trr.data : null;
}

async function trrFetchRun(ticketId, seq) {
  const d = tr.detail;
  if (!d) return;
  const summary = trrSelectedRun(d).run;
  if (!summary) return;
  try {
    const res = await apiGet('/runs/' + encodeURIComponent(summary.runId));
    if (seq !== tr.loadSeq || ticketId !== tr.ticketId) return;
    trr.data = res;
    trr.dataRunId = summary.runId;
    trr.error = null;
  } catch (err) {
    if (seq !== tr.loadSeq || ticketId !== tr.ticketId) return;
    trr.error = err && err.message ? err.message : 'Could not load the run';
  }
  renderRunPanel();
  renderRecordActions(tr.detail);
}

// True when the "ready for review" banner (with its Accept / Request corrections controls) is on screen.
function trrReviewBannerShown() {
  const d = tr.detail;
  if (!d) return false;
  const run = trrSelectedRun(d).run;
  return Boolean(run && d.ticket.status === 'waiting_human' && run.waitReason === 'human_review');
}

function trrGuard(key, sig, el, build) {
  if (!el || trr.sigs[key] === sig) return;
  trr.sigs[key] = sig;
  el.textContent = '';
  build(el);
}

function trrKv(rows) {
  const box = h('div', { class: 'tr-kv' });
  rows.forEach(([k, v]) => {
    box.appendChild(h('div', { class: 'kv-row' }, [
      h('span', { class: 'kv-key', text: k }),
      h('span', { class: 'kv-value', text: v === null || v === undefined || v === '' ? 'none' : String(v) })
    ]));
  });
  return box;
}

function trrList(items, emptyText) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return h('span', { class: 'detail-empty', text: emptyText || 'None.' });
  const ul = h('ul', { class: 'detail-list' });
  list.forEach(i => ul.appendChild(h('li', { text: i })));
  return ul;
}

// Non-blocking acceptance warnings (self-reported changes the server did not observe), as display lines.
function trrWarningLines(acc) {
  const list = acc && Array.isArray(acc.warnings) ? acc.warnings : [];
  return list.map(w => (w && typeof w === 'object') ? (w.detail || w.message || w.code || JSON.stringify(w)) : String(w))
    .map(text => 'Self-reported change not observed by the server: ' + text);
}

function trrSection(title, node) {
  return h('div', { class: 'tr-sub' }, [h('div', { class: 'tr-sub-title', text: title }), node]);
}

// ---------- render entry ----------

function renderRunPanel() {
  const d = tr.detail;
  const section = document.getElementById('tr-run-section');
  if (!d || !section) return;
  const { runs, run: summary } = trrSelectedRun(d);
  if (!summary) {
    section.hidden = false;
    trrGuard('head', 'no-run', document.getElementById('tr-run-head'), (el) => {
      el.appendChild(h('div', { class: 'detail-empty', text: 'No run recorded.' }));
    });
    trrGuard('decisions', 'no-run', document.getElementById('tr-run-decisions'), () => {});
    if (tr.ticketId) trrEnsureActivity(tr.ticketId);
    renderRunTabs(d, null, null);
    renderDeliveryPanel(d);
    return;
  }
  section.hidden = false;
  if (trr.runId !== summary.runId) {
    trr.runId = summary.runId;
    trr.diff = null;
    trr.sigs = {};
  }
  const data = trrData(summary);
  const run = data && data.run ? Object.assign({}, summary, data.run) : summary;

  trrGuard('head', JSON.stringify([d.ticket.status, d.ticket.version, runs.map(r => r.runId), trr.pick, run,
    data ? [data.plan && data.plan.classification, data.candidate && data.candidate.acceptance, data.intake && data.intake.length] : null,
    trr.error, tr.busy, d.availableActions, d.review || null, trrReviewDraft().open, trr.reviewError]),
    document.getElementById('tr-run-head'), (el) => trrBuildHead(el, d, runs, run, data));
  trrGuard('decisions', JSON.stringify([data ? data.decisions : null, trr.answering, trr.answerError, tr.busy]),
    document.getElementById('tr-run-decisions'), (el) => trrBuildDecisions(el, run, data));
  renderRunTabs(d, run, data);
  renderDeliveryPanel(d);
}

// ---------- head: status, step indicator, wait info, truthfulness banner ----------

function trrStepStates(d, run, data) {
  const states = TRR_STEPS.map(() => ({ state: 'pending', note: '' }));
  const candidate = data && data.candidate;
  const cls = data && data.plan ? data.plan.classification : null;
  const disp = candidate && candidate.acceptance ? dispositionInfo(candidate.acceptance.disposition, cls) : null;
  const hasPlan = Boolean(run.planRevisionId);
  const settled = run.phase === 'settled' || TRR_TERMINAL.includes(run.status);
  const markDone = (n) => { for (let i = 0; i < n; i += 1) states[i].state = 'done'; };

  if (settled) {
    if (run.status === 'completed' && candidate) {
      markDone(6);
      states[5].state = disp && disp.passing ? 'done-ok' : 'stopped';
      if (!(disp && disp.passing)) states[5].note = 'checks did not pass';
      if (disp && disp.passing) {
        if (d.ticket.status === 'done') states[6].state = 'done';
        else if (d.ticket.status === 'waiting_human') { states[6].state = 'current'; states[6].note = 'ready for you'; }
      }
      return states;
    }
    let reached = 0;
    if (candidate || run.candidateId) reached = 5;
    else if (run.baseCommit || run.branchName) reached = 4;
    else if (hasPlan) reached = 3;
    else if ((data && data.intake && data.intake.length) || run.phase === 'intake') reached = 1;
    markDone(reached);
    states[reached].state = 'stopped';
    states[reached].note = run.status === 'cancelled' ? 'cancelled' : (run.status === 'stopped' ? 'stopped' : 'did not finish');
    return states;
  }

  let cur = 0;
  if (run.phase === 'intake' || run.phase === 'awaiting_answer') cur = hasPlan && run.phase === 'intake' ? 2 : 1;
  else if (run.phase === 'branch') cur = 3;
  else if (run.phase === 'engineering') cur = 4;
  else if (run.phase === 'candidate') cur = 5;
  markDone(cur);
  const paused = run.status === 'paused' || run.status === 'interrupted' || d.ticket.status === 'blocked';
  states[cur].state = paused ? 'stopped' : 'current';
  if (run.phase === 'awaiting_answer') states[cur].note = 'waiting for your answer';
  else if (paused) states[cur].note = run.status === 'running' || run.status === 'queued' ? 'blocked' : run.status;
  else if (run.phase === 'queued') states[cur].note = 'waiting for the repository';
  else states[cur].note = 'in progress';
  return states;
}

function trrBanner(d, run, data) {
  const status = d.ticket.status;
  const candidate = data && data.candidate;
  const cls = data && data.plan ? data.plan.classification : null;
  const dispRaw = (run.waitDetail && run.waitDetail.disposition) || (candidate && candidate.acceptance && candidate.acceptance.disposition) || null;
  const disp = dispRaw ? dispositionInfo(dispRaw, cls) : null;

  if (status === 'waiting_human' && run.waitReason === 'human_review') {
    if (disp && !disp.passing) {
      return { tone: 'bad', text: 'Checks did not pass - not ready for review', review: false };
    }
    if (!data) return { tone: 'neutral', text: 'Loading review evidence...', review: false };
    if (!disp) {
      return { tone: 'neutral', text: 'Ready for your review (no acceptance evidence was recorded for this candidate)', review: true };
    }
    return { tone: 'ok', text: 'Ready for your review', review: true };
  }
  if (status === 'blocked' || status === 'paused') {
    if (disp && !disp.passing) return { tone: 'bad', text: 'Checks did not pass - not ready for review', review: false };
    const why = (run.waitDetail && run.waitDetail.message) || waitReasonLabel(run.waitReason) || 'The run cannot continue';
    return { tone: 'warn', text: (status === 'paused' ? 'Paused: ' : 'Blocked: ') + why, review: false };
  }
  if (status === 'waiting_human') {
    return { tone: 'info', text: waitReasonLabel(run.waitReason) || 'Waiting for you', review: false };
  }
  return null;
}

function trrCopyText(text, btn) {
  const done = () => {
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => { btn.textContent = 'Select and copy manually'; });
  } else {
    btn.textContent = 'Select and copy manually';
  }
}

// ---------- M7: pending control request, review controls, latest review ----------

const TRR_CONTROL_LABELS = {
  pause: 'Pause requested',
  stop: 'Stop requested',
  cancel: 'Cancel requested',
  return_to_backlog: 'Return to Backlog requested'
};

function trrControlKind(run) {
  const c = run && run.controlRequest;
  if (!c) return null;
  if (typeof c === 'string') return c;
  return String(c.kind || c.type || c.request || '') || null;
}

function trrControlBanner(run) {
  const kind = trrControlKind(run);
  if (!kind) return null;
  const label = TRR_CONTROL_LABELS[kind] || ('Control requested (' + kind + ')');
  const parts = [label + ' - waiting for active work to settle'];
  const wd = run.waitDetail && typeof run.waitDetail === 'object' ? run.waitDetail : null;
  if (run.waitReason === 'writer_unresolved') {
    parts.push((wd && wd.message) || 'Stop requested; writer outcome unresolved');
  }
  const box = h('div', { class: 'tr-banner tone-warn', attrs: { role: 'status' } }, [h('span', { text: parts.join('. ') })]);
  box.appendChild(h('span', { class: 'form-hint', text: 'Not settled yet. File changes already made are kept.' }));
  return box;
}

function trrReviewDraft() {
  if (!trr.drafts.review) trr.drafts.review = { open: false, text: '' };
  return trr.drafts.review;
}

function trrIsLatestRun(d, run) {
  const runs = Array.isArray(d.runs) ? d.runs : [];
  const latest = d.activeRun || runs[0];
  return Boolean(latest && latest.runId === run.runId);
}

// Accept / corrections are bound to the displayed run's candidate id and integrity hash.
function trrReviewState(d, run, data, key) {
  const avail = (Array.isArray(d.availableActions) ? d.availableActions : []).map(actionName);
  const candidate = data && data.candidate;
  if (!avail.includes(key)) {
    const u = (Array.isArray(d.unavailableActions) ? d.unavailableActions : []).find(x => actionName(x) === key);
    return { ok: false, reason: u && u.reason ? u.reason : 'Not available' };
  }
  if (!trrIsLatestRun(d, run)) return { ok: false, reason: 'Only the latest run can be reviewed' };
  if (!candidate || !candidate.candidateId || !candidate.integrityHash) return { ok: false, reason: 'No candidate evidence to bind the review to' };
  return { ok: true, reason: '' };
}

function trrReviewControls(d, run, data) {
  const btns = h('span', { class: 'tr-banner-actions' });
  const add = (key, label, handler) => {
    const st = trrReviewState(d, run, data, key);
    const b = h('button', { class: 'btn btn-secondary', title: st.ok ? '' : st.reason, attrs: { type: 'button', 'data-action': key } }, [h('span', { text: label })]);
    if (!st.ok) {
      b.disabled = true;
      b.setAttribute('aria-disabled', 'true');
      b.appendChild(h('span', { class: 'btn-milestone', text: st.reason }));
    } else {
      if (tr.busy) b.disabled = true;
      b.addEventListener('click', handler);
    }
    btns.appendChild(b);
  };
  add('accept', 'Accept result', () => trrSubmitReview(d, run, data, 'accept'));
  add('corrections', trrReviewDraft().open ? 'Cancel corrections' : 'Request corrections', () => {
    const draft = trrReviewDraft();
    draft.open = !draft.open;
    trr.sigs.head = null;
    renderRunPanel();
  });
  return btns;
}

function trrCorrectionsForm(d, run, data) {
  const draft = trrReviewDraft();
  const st = trrReviewState(d, run, data, 'corrections');
  const area = h('textarea', {
    class: 'form-textarea tr-answer-input',
    attrs: { rows: '5', maxlength: String(TRR_FINDINGS_MAX), 'aria-label': 'Review findings', placeholder: 'What must change? These findings go to the next run.' }
  });
  area.value = draft.text;
  const counter = h('span', { class: 'form-hint', text: draft.text.length + ' / ' + TRR_FINDINGS_MAX });
  const err = h('div', { class: 'tf-field-error', attrs: { role: 'alert' } });
  area.addEventListener('input', () => {
    draft.text = area.value;
    counter.textContent = area.value.length + ' / ' + TRR_FINDINGS_MAX;
    err.textContent = '';
  });
  const send = h('button', { class: 'btn btn-secondary', text: 'Send corrections', attrs: { type: 'button' } });
  if (!st.ok || tr.busy) { send.disabled = true; send.title = st.reason; }
  send.addEventListener('click', () => {
    const text = area.value.trim();
    if (!text) { err.textContent = 'Describe the corrections (1 to ' + TRR_FINDINGS_MAX + ' characters).'; return; }
    if (text.length > TRR_FINDINGS_MAX) { err.textContent = 'Findings are limited to ' + TRR_FINDINGS_MAX + ' characters.'; return; }
    trrSubmitReview(d, run, data, 'corrections', text);
  });
  return h('div', { class: 'tr-decision detail-block' }, [
    h('div', { class: 'tr-sub-title', text: 'Request corrections' }),
    h('div', { class: 'form-hint', text: 'A new rework run starts from this candidate on the same branch, with your findings added to its goal. At most 3 rework runs per revision.' }),
    area, h('div', { class: 'tr-answer-foot' }, [send, counter]), err
  ]);
}

async function trrSubmitReview(d, run, data, verdict, findings) {
  const st = trrReviewState(d, run, data, verdict === 'accept' ? 'accept' : 'corrections');
  if (!st.ok) return;
  if (verdict === 'accept' && !window.confirm('Accept this result?\n\nThe ticket becomes done. Nothing is committed or pushed yet; you do that from the delivery panel. Accepting is bound to the candidate you are viewing and fails if the checkout changed since.')) return;
  const extra = { runId: run.runId, candidateId: data.candidate.candidateId, integrityHash: data.candidate.integrityHash, verdict };
  if (verdict === 'corrections') extra.findings = findings;
  trText('tr-action-error', '');
  trr.reviewError = '';
  trr.sigs.head = null;
  renderRunPanel();
  const ok = await sendTicketCommand('review-' + verdict, '/review', extra, (m) => {
    trr.reviewError = m;
    trr.sigs.head = null;
    renderRunPanel();
    trText('tr-action-error', m);
  });
  if (ok && verdict === 'corrections') { const draft = trrReviewDraft(); draft.open = false; draft.text = ''; trr.sigs.head = null; }
}

function trrLatestReview(d) {
  const r = d.review;
  if (!r || typeof r !== 'object') return null;
  const accepted = r.verdict === 'accepted';
  const box = h('div', { class: 'tr-banner tone-' + (accepted ? 'ok' : 'warn'), attrs: { role: 'status' } }, [
    h('span', { text: 'Latest review: ' + (accepted ? 'accepted' : 'corrections requested') + ' on ' + formatAbsTime(r.createdAt)
      + (r.runId ? ' (run ' + String(r.runId).slice(0, 12) + ')' : '') })
  ]);
  if (r.findings) box.appendChild(h('div', { class: 'detail-pre detail-block', text: r.findings }));
  return box;
}

function trrCurrentWaitVisible(d, run) {
  const ticketStatus = d && d.ticket && d.ticket.status;
  return Boolean(run && run.waitReason && !TRR_INACTIVE_TICKET_STATUSES.includes(ticketStatus));
}

function trrBuildHead(el, d, runs, run, data) {
  if (runs.length > 1) {
    const select = h('select', { class: 'form-select tr-run-select', attrs: { 'aria-label': 'Choose run' } });
    runs.forEach((r, i) => {
      const opt = h('option', {
        text: 'Run ' + (runs.length - i) + ' - ' + r.status + ' - ' + formatAbsTime(r.createdAt),
        attrs: { value: r.runId }
      });
      if (r.runId === run.runId) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => {
      trr.pick = select.value;
      trr.data = null;
      trr.dataRunId = null;
      trr.diff = null;
      trr.sigs = {};
      renderRunPanel();
      trrFetchRun(tr.ticketId, tr.loadSeq);
    });
    el.appendChild(h('div', { class: 'tr-run-pick' }, [select]));
  }

  const meta = h('div', { class: 'tr-run-meta' }, [
    h('span', { class: 'badge tr-run-status ' + cssToken(run.status), text: 'Run: ' + (run.status || 'unknown') })
  ]);
  if (run.phase) meta.appendChild(h('span', { class: 'badge', text: 'Phase: ' + runPhaseLabel(run.phase), title: run.phase }));
  const showWait = trrCurrentWaitVisible(d, run);
  if (showWait) meta.appendChild(h('span', { class: 'badge badge-status blocked', text: waitReasonLabel(run.waitReason), title: run.waitReason }));
  meta.appendChild(h('span', { class: 'tr-marker', text: 'run ' + String(run.runId).slice(0, 12), title: String(run.runId) }));
  meta.appendChild(h('span', { class: 'tr-marker', text: 'updated ' + formatAbsTime(run.updatedAt) }));
  el.appendChild(meta);
  if (trr.reviewError) el.appendChild(h('div', { class: 'tf-field-error', text: trr.reviewError, attrs: { role: 'alert' } }));

  const control = trrControlBanner(run);
  if (control) el.appendChild(control);

  const banner = trrBanner(d, run, data);
  if (banner) {
    const box = h('div', { class: 'tr-banner tone-' + banner.tone, attrs: { role: 'status' } }, [h('span', { text: banner.text })]);
    if (banner.review) box.appendChild(trrReviewControls(d, run, data));
    el.appendChild(box);
    if (banner.review && trrReviewDraft().open) el.appendChild(trrCorrectionsForm(d, run, data));
  }
  const reviewBox = trrLatestReview(d);
  if (reviewBox) el.appendChild(reviewBox);

  const steps = trrStepStates(d, run, data);
  const ol = h('ol', { class: 'tr-steps', attrs: { 'aria-label': 'Run progress' } });
  steps.forEach((s, i) => {
    const li = h('li', { class: 'tr-step ' + s.state }, [
      h('span', { class: 'tr-step-dot', text: String(i + 1) }),
      h('span', { class: 'tr-step-label', text: TRR_STEPS[i].label }),
      s.note ? h('span', { class: 'tr-step-note', text: s.note }) : null
    ]);
    if (s.state === 'current' || s.state === 'stopped') li.setAttribute('aria-current', 'step');
    ol.appendChild(li);
  });
  el.appendChild(ol);

  if (run.branchName || run.baseCommit) {
    el.appendChild(trrKv([
      ['branch', run.branchName || 'not created'],
      ['base', run.baseCommit ? shortSha(run.baseCommit) : 'unknown']
    ]));
  }

  const wd = run.waitDetail;
  if (showWait && wd && typeof wd === 'object') {
    const box = h('div', { class: 'tr-wait detail-block' });
    box.appendChild(h('div', { class: 'tr-wait-title', text: (waitReasonLabel(run.waitReason) || 'Wait detail') + (wd.code ? ' [' + wd.code + ']' : '') }));
    if (wd.message) box.appendChild(h('div', { text: wd.message }));
    if (wd.disposition) {
      const di = dispositionInfo(wd.disposition, data && data.plan ? data.plan.classification : null);
      box.appendChild(h('div', {}, [h('span', { class: 'tr-disp-chip tone-' + di.tone, text: 'Disposition: ' + di.label })]));
    }
    if (Array.isArray(wd.problems) && wd.problems.length) {
      const ul = h('ul', { class: 'detail-list' });
      wd.problems.forEach(p => ul.appendChild(h('li', {}, [
        h('span', { class: 'tr-token', text: p && p.code ? p.code : 'problem' }),
        h('span', { text: ' ' + (p && p.message ? p.message : '') })
      ])));
      box.appendChild(ul);
    }
    const resumeListed = Array.isArray(d.availableActions) && d.availableActions.map(actionName).includes('resume');
    if (wd.resumeCommand && !resumeListed) {
      const pre = h('pre', { class: 'tr-cmd', text: String(wd.resumeCommand) });
      const copy = h('button', { class: 'btn btn-secondary tr-copy', text: 'Copy', attrs: { type: 'button' } });
      copy.addEventListener('click', () => trrCopyText(String(wd.resumeCommand), copy));
      box.appendChild(h('div', { class: 'tr-cmd-row' }, [pre, copy]));
      box.appendChild(h('div', { class: 'form-hint', text: 'Resume is not available from the dashboard for this run. Run this command on the orchestrator host.' }));
    }
    el.appendChild(box);
  }
  if (trr.error) el.appendChild(h('div', { class: 'tf-field-error', text: 'Run details unavailable: ' + trr.error, attrs: { role: 'alert' } }));
}

// ---------- decisions ----------

function trrAnswersFor(decision) {
  const a = decision.answer;
  if (!a) return { list: [], choice: null, note: null };
  if (Array.isArray(a)) return { list: a, choice: null, note: null };
  return { list: Array.isArray(a.answers) ? a.answers : [], choice: a.choice || null, note: typeof a.answer === 'string' ? a.answer : null };
}

function trrDraft(decisionId) {
  if (!trr.drafts[decisionId]) trr.drafts[decisionId] = { answers: {}, choice: null, note: '' };
  return trr.drafts[decisionId];
}

function trrBuildDecisions(el, run, data) {
  if (!data) return;
  const all = Array.isArray(data.decisions) ? data.decisions : [];
  const pending = all.filter(x => x.state === 'pending');
  const history = all.filter(x => x.state !== 'pending');
  pending.forEach(dec => {
    if (dec.kind === 'intake_clarification') el.appendChild(trrIntakeForm(dec));
    else if (dec.kind === 'lead_decision') el.appendChild(trrLeadForm(dec));
    else el.appendChild(h('div', { class: 'tr-decision detail-block' }, [
      h('div', { class: 'tr-sub-title', text: 'Unrecognized pending decision (' + dec.kind + ')' }),
      h('div', { class: 'detail-empty', text: 'This dashboard cannot answer this decision kind.' })
    ]));
  });
  if (history.length) {
    const box = h('details', { class: 'tr-history' }, [h('summary', { text: 'Decision history (' + history.length + ')' })]);
    history.forEach(dec => box.appendChild(trrHistoryItem(dec)));
    el.appendChild(box);
  }
}

function trrDecisionFrame(dec, title, sub) {
  const box = h('div', { class: 'tr-decision detail-block', attrs: { 'data-decision': dec.decisionId } });
  box.appendChild(h('div', { class: 'tr-sub-title', text: title }));
  if (sub) box.appendChild(h('div', { class: 'form-hint', text: sub }));
  return box;
}

function trrAnswerFooter(dec, button, hint) {
  const err = trr.answerError[dec.decisionId];
  const row = h('div', { class: 'tr-answer-foot' }, [button]);
  if (hint) row.appendChild(h('span', { class: 'form-hint', text: hint }));
  const out = [row];
  if (err) out.push(h('div', { class: 'tf-field-error', text: err, attrs: { role: 'alert' } }));
  return out;
}

function trrIntakeForm(dec) {
  const questions = dec.request && Array.isArray(dec.request.questions) ? dec.request.questions : [];
  const draft = trrDraft(dec.decisionId);
  const box = trrDecisionFrame(dec, 'The PM needs your answers before planning',
    'Answer each question. Answers are saved with the run and the PM plans from them.');
  const busy = trr.answering === dec.decisionId;
  const areas = [];
  questions.forEach((q, i) => {
    const id = 'trr-q-' + cssToken(dec.decisionId) + '-' + i;
    const ta = h('textarea', {
      class: 'form-textarea tr-answer-input',
      attrs: { id, rows: '3', 'data-question': String(q.id) }
    });
    ta.value = draft.answers[q.id] || '';
    if (busy) ta.disabled = true;
    ta.addEventListener('input', () => { draft.answers[q.id] = ta.value; });
    const fieldErr = h('div', { class: 'tf-field-error', attrs: { role: 'alert' } });
    areas.push({ q, ta, fieldErr });
    box.appendChild(h('div', { class: 'form-group tr-question' }, [
      h('label', { class: 'form-label', text: (i + 1) + '. ' + (q.question || ''), attrs: { for: id } }),
      q.why ? h('div', { class: 'form-hint', text: 'Why it matters: ' + q.why }) : null,
      ta, fieldErr
    ]));
  });
  if (!questions.length) box.appendChild(h('div', { class: 'detail-empty', text: 'No questions were recorded for this decision.' }));
  const btn = h('button', { class: 'btn btn-primary', text: busy ? 'Sending...' : 'Answer', attrs: { type: 'button' } });
  btn.disabled = busy || !questions.length;
  btn.addEventListener('click', () => {
    let bad = false;
    areas.forEach(a => {
      const v = a.ta.value.trim();
      a.fieldErr.textContent = !v ? 'An answer is required.' : (v.length > TRR_ANSWER_MAX ? 'Answers are limited to ' + TRR_ANSWER_MAX + ' characters (now ' + v.length + ').' : '');
      if (a.fieldErr.textContent) bad = true;
    });
    if (bad) return;
    trrSubmitAnswer(dec, { answers: areas.map(a => ({ questionId: a.q.id, answer: a.ta.value.trim() })) });
  });
  trrAnswerFooter(dec, btn, 'Every question needs an answer (1-' + TRR_ANSWER_MAX + ' characters).').forEach(n => box.appendChild(n));
  return box;
}

function trrLeadForm(dec) {
  const req = dec.request || {};
  const options = Array.isArray(req.options) ? req.options : [];
  const draft = trrDraft(dec.decisionId);
  const busy = trr.answering === dec.decisionId;
  const box = trrDecisionFrame(dec, 'Decision needed from you', null);
  box.appendChild(h('div', { class: 'tr-question-text', text: req.question || '(no question text)' }));
  if (req.reason) box.appendChild(h('div', { class: 'form-hint', text: 'Reason: ' + req.reason }));
  const recId = req.recommendation;
  const group = h('div', { class: 'tr-options', attrs: { role: 'radiogroup', 'aria-label': 'Options' } });
  const name = 'trr-opt-' + cssToken(dec.decisionId);
  options.forEach((o, i) => {
    const id = name + '-' + i;
    const radio = h('input', { attrs: { type: 'radio', name, id, value: String(o.id) } });
    radio.checked = draft.choice === o.id;
    if (busy) radio.disabled = true;
    radio.addEventListener('change', () => { draft.choice = o.id; });
    const label = h('label', { class: 'tr-option', attrs: { for: id } }, [
      radio,
      h('span', { class: 'tr-option-body' }, [
        h('span', { class: 'tr-token', text: String(o.id) }),
        h('span', { text: ' ' + (o.description || '') }),
        o.id === recId ? h('span', { class: 'tr-recommended', text: 'Recommended' }) : null
      ])
    ]);
    group.appendChild(label);
  });
  box.appendChild(group);
  if (!options.length) box.appendChild(h('div', { class: 'detail-empty', text: 'No options were offered.' }));
  const noteId = 'trr-note-' + cssToken(dec.decisionId);
  const note = h('textarea', { class: 'form-textarea tr-answer-input', attrs: { id: noteId, rows: '2' } });
  note.value = draft.note || '';
  if (busy) note.disabled = true;
  note.addEventListener('input', () => { draft.note = note.value; });
  const choiceErr = h('div', { class: 'tf-field-error', attrs: { role: 'alert' } });
  const noteErr = h('div', { class: 'tf-field-error', attrs: { role: 'alert' } });
  box.appendChild(choiceErr);
  box.appendChild(h('div', { class: 'form-group' }, [
    h('label', { class: 'form-label', text: 'Note (optional)', attrs: { for: noteId } }), note, noteErr
  ]));
  const btn = h('button', { class: 'btn btn-primary', text: busy ? 'Sending...' : 'Send decision', attrs: { type: 'button' } });
  btn.disabled = busy || !options.length;
  btn.addEventListener('click', () => {
    const opt = options.find(o => o.id === draft.choice);
    const text = (note.value || '').trim();
    choiceErr.textContent = opt ? '' : 'Pick an option to continue.';
    noteErr.textContent = text.length > TRR_ANSWER_MAX ? 'The note is limited to ' + TRR_ANSWER_MAX + ' characters (now ' + text.length + ').' : '';
    if (!opt || noteErr.textContent) return;
    // The lead resume needs non-empty text: an empty note becomes an explicit statement of the selection.
    const answer = text || ('Selected option ' + opt.id + ': ' + (opt.description || '')).slice(0, TRR_ANSWER_MAX);
    trrSubmitAnswer(dec, { choice: opt.id, answer });
  });
  trrAnswerFooter(dec, btn, 'Pick an option; a note is optional.').forEach(n => box.appendChild(n));
  return box;
}

async function trrSubmitAnswer(dec, payload) {
  const ticketId = tr.ticketId;
  const id = dec.decisionId;
  trr.answering = id;
  trr.answerError[id] = '';
  trr.sigs.decisions = null;
  renderRunPanel();
  const path = '/decisions/' + encodeURIComponent(id) + '/answer';
  const ok = await sendTicketCommand('answer:' + id, path, payload, (m) => { trr.answerError[id] = m; });
  if (ticketId !== tr.ticketId) return;
  trr.answering = null;
  if (ok) delete trr.drafts[id];
  trr.sigs.decisions = null;
  renderRunPanel();
}

function trrHistoryItem(dec) {
  const kind = dec.kind === 'intake_clarification' ? 'PM clarification' : (dec.kind === 'lead_decision' ? 'Decision' : String(dec.kind));
  const stateText = dec.state === 'answered' ? 'answered ' + formatAbsTime(dec.answeredAt) : (dec.state === 'stale' ? 'superseded (no longer current)' : String(dec.state));
  const box = h('div', { class: 'tr-hist-item' }, [
    h('div', { class: 'tr-sub-title', text: kind + ' - ' + stateText })
  ]);
  const req = dec.request || {};
  const ans = trrAnswersFor(dec);
  if (dec.kind === 'intake_clarification') {
    (Array.isArray(req.questions) ? req.questions : []).forEach(q => {
      const a = ans.list.find(x => x && x.questionId === q.id);
      box.appendChild(h('div', { class: 'tr-qa' }, [
        h('div', { class: 'tr-qa-q', text: q.question || '' }),
        h('div', { class: 'tr-qa-a', text: a ? a.answer : (dec.state === 'answered' ? '(no answer recorded)' : '(unanswered)') })
      ]));
    });
  } else {
    box.appendChild(h('div', { class: 'tr-qa-q', text: req.question || '' }));
    const opt = (Array.isArray(req.options) ? req.options : []).find(o => o.id === ans.choice);
    if (ans.choice) box.appendChild(h('div', { class: 'tr-qa-a', text: 'Chosen: ' + ans.choice + (opt && opt.description ? ' - ' + opt.description : '') }));
    if (ans.note) box.appendChild(h('div', { class: 'tr-qa-a', text: 'Note: ' + ans.note }));
    if (!ans.choice && dec.state === 'answered') box.appendChild(h('div', { class: 'detail-empty', text: 'No answer details recorded.' }));
  }
  return box;
}

// ---------- tabs ----------


// ----- activity fetch (GET /tickets/:id/activity) -----

function trrEnsureActivity(ticketId) {
  if (trr.activity && trr.activity.ticketId === ticketId) return;
  trr.activity = { ticketId, state: 'loading', data: null, error: null, loadingMore: false, loadMoreError: null };
  const key = ticketId;
  apiGet('/tickets/' + encodeURIComponent(ticketId) + '/activity').then(function(res) {
    if (!trr.activity || trr.activity.ticketId !== key) return;
    trr.activity = { ticketId, state: 'ok', data: res, error: null };
    trr.sigs.panel = null;
    renderRunPanel();
  }, function(err) {
    if (!trr.activity || trr.activity.ticketId !== key) return;
    trr.activity = { ticketId, state: 'error', data: null, error: err && err.message ? err.message : 'Activity unavailable' };
    trr.sigs.panel = null;
    renderRunPanel();
  });
}

function trrLoadMoreActivity(ticketId) {
  const activity = trr.activity;
  const runLog = activity && activity.data && activity.data.runLog;
  if (!activity || activity.ticketId !== ticketId || activity.loadingMore || !runLog || !runLog.hasMore) return;
  activity.loadingMore = true;
  activity.loadMoreError = null;
  trr.sigs.panel = null;
  renderRunPanel();
  const query = '?after=' + encodeURIComponent(runLog.nextAfter || 0) + '&limit=' + encodeURIComponent(runLog.limit || 100);
  apiGet('/tickets/' + encodeURIComponent(ticketId) + '/activity' + query).then(function(res) {
    if (trr.activity !== activity || trr.activity.ticketId !== ticketId) return;
    const pageLog = res && res.runLog;
    if (!res || res.available === false || (pageLog && pageLog.status === 'unavailable')) {
      activity.loadingMore = false;
      activity.loadMoreError = (pageLog && pageLog.reason) || (res && res.reason) || 'Activity unavailable';
      trr.sigs.panel = null;
      renderRunPanel();
      return;
    }
    const current = activity.data.runLog || {};
    const seen = new Set((Array.isArray(current.entries) ? current.entries : []).map(function(ev) { return ev.sequence; }));
    const incoming = pageLog && Array.isArray(pageLog.entries) ? pageLog.entries : [];
    const merged = (Array.isArray(current.entries) ? current.entries : []).concat(incoming.filter(function(ev) {
      if (seen.has(ev.sequence)) return false;
      seen.add(ev.sequence);
      return true;
    }));
    merged.sort(function(a, b) { return a.sequence - b.sequence; });
    activity.data.runLog = Object.assign({}, current, pageLog || {}, {
      entries: merged,
      status: pageLog && pageLog.hasMore ? 'partial' : (merged.length ? 'available' : 'empty')
    });
    activity.loadingMore = false;
    activity.loadMoreError = null;
    trr.sigs.panel = null;
    renderRunPanel();
  }, function(err) {
    if (trr.activity !== activity || trr.activity.ticketId !== ticketId) return;
    activity.loadingMore = false;
    activity.loadMoreError = err && err.message ? err.message : 'Activity unavailable';
    trr.sigs.panel = null;
    renderRunPanel();
  });
}

function trrActivityRunLog(el, activity, run) {
  if (!activity || activity.state === 'loading') { el.appendChild(h('div', { class: 'detail-empty', text: 'Loading run log...' })); return; }
  if (activity.state === 'error') { el.appendChild(h('div', { class: 'tf-field-error', text: 'Run log unavailable: ' + activity.error, attrs: { role: 'alert' } })); return; }
  const d = activity.data;
  if (!d || !d.available) { el.appendChild(h('div', { class: 'detail-empty', text: 'Run log unavailable: ' + (d && d.reason ? d.reason : 'unknown error') })); return; }
  const rl = d.runLog || {};
  if (rl.status === 'unavailable') { el.appendChild(h('div', { class: 'detail-empty', text: 'Run log: ' + (rl.reason || 'unavailable') })); return; }
  const entries = Array.isArray(rl.entries) ? rl.entries : [];
  if (!entries.length && !rl.hasMore) { el.appendChild(h('div', { class: 'detail-empty', text: 'No run log events recorded.' })); return; }
  const runId = run && run.runId;
  const filtered = runId ? entries.filter(function(ev) { return !ev.runId || ev.runId === runId; }) : entries;
  if (!filtered.length) el.appendChild(h('div', { class: 'detail-empty', text: 'No run log events for this run in the loaded page.' }));
  filtered.forEach(function(ev) {
    const who = [ev.role, ev.attemptId ? 'attempt ' + String(ev.attemptId).slice(0, 8) : null].filter(Boolean).join(' / ');
    el.appendChild(h('div', { class: 'event-row' }, [
      h('span', { class: 'event-time', text: formatAbsTime(ev.occurredAt) }),
      h('span', { class: 'event-type', text: ev.type || 'event' }),
      h('span', { class: 'event-who', text: who }),
    ]));
  });
  if (rl.hasMore) {
    el.appendChild(h('div', { class: 'detail-empty', text: 'More run log events are available. The events shown are a partial view.' }));
    if (activity.loadingMore) {
      el.appendChild(h('div', { class: 'detail-empty', text: 'Loading more run log events...' }));
    } else {
      const more = h('button', { class: 'btn btn-sm', text: activity.loadMoreError ? 'Retry loading events' : 'Load more events' });
      more.addEventListener('click', function() { trrLoadMoreActivity(activity.ticketId); });
      el.appendChild(more);
    }
    if (activity.loadMoreError) el.appendChild(h('div', { class: 'tf-field-error', text: 'More run log events unavailable: ' + activity.loadMoreError, attrs: { role: 'alert' } }));
  }
}

function trrFormatShare(cs) {
  if (!cs || cs.status === 'unavailable' || cs.share === null || cs.share === undefined) return 'unavailable';
  var pct = (cs.share * 100).toFixed(1) + '%';
  return cs.status === 'partial' ? pct + ' (partial)' : pct;
}

function trrActivityTurns(el, activity, run) {
  if (!activity || activity.state === 'loading') { el.appendChild(h('div', { class: 'detail-empty', text: 'Loading turns...' })); return; }
  if (activity.state === 'error') { el.appendChild(h('div', { class: 'tf-field-error', text: 'Turns unavailable: ' + activity.error, attrs: { role: 'alert' } })); return; }
  const d = activity.data;
  if (!d || !d.available) { el.appendChild(h('div', { class: 'detail-empty', text: 'Turns unavailable: ' + (d && d.reason ? d.reason : 'unknown error') })); return; }
  const turns = d.turns || {};
  if (turns.status === 'unavailable') { el.appendChild(h('div', { class: 'detail-empty', text: 'Turns: ' + (turns.reason || 'unavailable') })); return; }
  const runId = run && run.runId;
  const entries = (Array.isArray(turns.entries) ? turns.entries : []).filter(function(e) { return !runId || e.productRunId === runId; });
  if (!entries.length) { el.appendChild(h('div', { class: 'detail-empty', text: 'No usage rows for this run.' })); return; }
  el.appendChild(h('div', { class: 'form-hint', text: 'Operational metadata only. Model reasoning and prompt content are not exposed.' }));
  const table = h('table', { class: 'attempts-table tr-table' });
  table.appendChild(h('thead', {}, [h('tr', {}, ['Kind', 'Role', 'Model', 'Turns', 'Elapsed', 'Outcome', 'Tokens'].map(function(t) { return h('th', { text: t }); }))]));
  const body = h('tbody');
  const cell = function(v) { return h('td', { text: (v === null || v === undefined || v === '') ? 'n/a' : String(v) }); };
  entries.forEach(function(a) {
    body.appendChild(h('tr', {}, [
      cell(a.kind), cell(a.role), cell(a.model),
      cell(isNumber(a.turns) ? String(a.turns) : null),
      cell(isNumber(a.elapsedMs) ? formatMaybeDuration(a.elapsedMs) : null),
      cell(a.outcome),
      cell(a.hasTokens ? 'yes' : 'no'),
    ]));
  });
  table.appendChild(body);
  el.appendChild(h('div', { class: 'attempts-table-wrapper' }, [table]));
}

function trrActivityAttempts(el, activity, run) {
  if (!activity || activity.state === 'loading') { el.appendChild(h('div', { class: 'detail-empty', text: 'Loading attempts...' })); return; }
  if (activity.state === 'error') { el.appendChild(h('div', { class: 'tf-field-error', text: 'Attempts unavailable: ' + activity.error, attrs: { role: 'alert' } })); return; }
  const d = activity.data;
  if (!d || !d.available) { el.appendChild(h('div', { class: 'detail-empty', text: 'Attempts unavailable: ' + (d && d.reason ? d.reason : 'unknown error') })); return; }
  const att = d.attempts || {};
  if (att.status === 'unavailable') { el.appendChild(h('div', { class: 'detail-empty', text: 'Attempts: ' + (att.reason || 'unavailable') })); return; }
  const runId = run && run.runId;
  const entries = (Array.isArray(att.entries) ? att.entries : []).filter(function(e) { return !runId || e.productRunId === runId; });
  if (!entries.length) { el.appendChild(h('div', { class: 'detail-empty', text: 'No dispatch attempts for this run.' })); return; }
  const table = h('table', { class: 'attempts-table tr-table' });
  table.appendChild(h('thead', {}, [h('tr', {}, ['Role', 'State', 'Outcome', 'Started', 'Updated'].map(function(t) { return h('th', { text: t }); }))]));
  const body = h('tbody');
  const cell = function(v) { return h('td', { text: (v === null || v === undefined || v === '') ? 'n/a' : String(v) }); };
  entries.forEach(function(a) {
    body.appendChild(h('tr', {}, [cell(a.role), cell(a.journalState), cell(a.outcome), cell(formatAbsTime(a.createdAt)), cell(formatAbsTime(a.updatedAt))]));
  });
  table.appendChild(body);
  el.appendChild(h('div', { class: 'attempts-table-wrapper' }, [table]));
}

function trrActivityTokens(el, activity, run) {
  if (!activity || activity.state === 'loading') { el.appendChild(h('div', { class: 'detail-empty', text: 'Loading tokens...' })); return; }
  if (activity.state === 'error') { el.appendChild(h('div', { class: 'tf-field-error', text: 'Tokens unavailable: ' + activity.error, attrs: { role: 'alert' } })); return; }
  const d = activity.data;
  if (!d || !d.available) { el.appendChild(h('div', { class: 'detail-empty', text: 'Tokens unavailable: ' + (d && d.reason ? d.reason : 'unknown error') })); return; }
  const tokens = d.tokens || {};
  const runId = run && run.runId;

  if (tokens.status === 'unavailable') {
    // Show reason if present; if there is simply no usage, no sentence is added.
    if (tokens.reason) {
      el.appendChild(h('div', { class: 'detail-empty', text: 'Token data unavailable: ' + tokens.reason }));
    }
    // Fall through to render monetary cost and execution binding even when no token rows.
  } else {
    const measured = tokens.measured || {};
    const tk = measured.tokens;
    el.appendChild(trrKv([
      ['Total tokens', formatMaybeNumber(tk && tk.totalTokens)],
      ['Input tokens', formatMaybeNumber(tk && tk.inputTokens)],
      ['Cached input tokens', formatMaybeNumber(tk && tk.cachedInputTokens)],
      ['Output tokens', formatMaybeNumber(tk && tk.outputTokens)],
      ['Turns', formatMaybeNumber(measured.turns)],
      ['Elapsed', formatMaybeDuration(measured.elapsedMs)],
    ]));
  }

  // Cache shares: ticket, selected run, and each role.
  const cacheShare = tokens.cacheShare || null;
  if (cacheShare) {
    const ticketCs = cacheShare.ticket || null;
    const runCs = runId && cacheShare.byRun ? cacheShare.byRun[runId] || null : null;
    const shareRows = [];
    if (ticketCs) {
      shareRows.push(['Cache share (ticket)', trrFormatShare(ticketCs)]);
    }
    if (runCs) {
      const runLabel = 'Cache share (this run' + (runCs.status === 'partial' ? ', partial' : '') + ')';
      shareRows.push([runLabel, trrFormatShare(runCs)]);
    }
    if (shareRows.length) el.appendChild(trrKv(shareRows));
    if (cacheShare.byRole && typeof cacheShare.byRole === 'object') {
      const roleIds = Object.keys(cacheShare.byRole);
      if (roleIds.length) {
        const roleShareRows = roleIds.map(function(roleId) {
          const rcs = cacheShare.byRole[roleId];
          const label = 'Cache share (' + roleId + (rcs && rcs.status === 'partial' ? ', partial' : '') + ')';
          return [label, trrFormatShare(rcs)];
        });
        el.appendChild(trrKv(roleShareRows));
      }
    }
    // Meaning string from ticket-level cache share.
    const meaning = (ticketCs && ticketCs.meaning) || (runCs && runCs.meaning) || null;
    if (meaning) el.appendChild(h('div', { class: 'form-hint', text: meaning }));
    // Coverage note for partial run share.
    const covCs = runCs || ticketCs;
    if (covCs && covCs.status === 'partial' && covCs.coverageNote) {
      el.appendChild(h('div', { class: 'form-hint', text: covCs.coverageNote }));
    }
  }

  // Monetary cost: unavailable unless amount is finite; never invent 0.
  const mcost = tokens.monetaryCost || null;
  const mcostText = (mcost && isNumber(mcost.amount))
    ? mcost.currency + ' ' + mcost.amount.toFixed(4)
    : 'unavailable (subscription; not metered per call)';
  el.appendChild(h('div', { class: 'detail-block' }, [h('span', { class: 'kv-key', text: 'Monetary cost: ' }), h('span', { text: mcostText })]));

  const hyp = tokens.hypotheticalApiCost;
  if (hyp) {
    const hypText = isNumber(hyp.estimatedCost) ? 'USD ' + hyp.estimatedCost.toFixed(4) : 'not computed';
    el.appendChild(h('div', { class: 'detail-block' }, [
      h('span', { class: 'kv-key', text: 'Hypothetical API cost: ' }),
      h('span', { text: hypText }),
      h('div', { class: 'form-hint', text: hyp.label || 'hypothetical API pricing estimate; not measured spend' }),
    ]));
  }

  // Execution binding block: always rendered even when there are no token rows.
  const exec = d.executions && runId ? d.executions.find(function(e) { return e.runId === runId; }) : null;
  if (exec) {
    const parts = [];
    if (exec.review) parts.push('Review: ' + (exec.review.verdict || 'unknown'));
    if (exec.acceptance) parts.push('Acceptance: ' + (exec.acceptance.disposition || 'unknown'));
    if (exec.rework && exec.rework.parentRunId) parts.push('Rework parent: ' + String(exec.rework.parentRunId).slice(0, 12));
    if (exec.rework && exec.rework.childRunIds && exec.rework.childRunIds.length) parts.push('Rework children: ' + exec.rework.childRunIds.length);
    if (parts.length) el.appendChild(trrSection('Execution bindings', trrList(parts, 'None.')));
  }
}

function renderRunTabs(d, run, data) {
  const tabs = document.getElementById('tr-run-tabs');
  const panel = document.getElementById('tr-run-panel');
  const activityTabs = ['run-log', 'turns', 'attempts-activity', 'tokens'];
  const noRun = !run;
  if (noRun && activityTabs.indexOf(trr.tab) === -1) trr.tab = 'run-log';
  const tabList = noRun ? TRR_TABS.filter(t => activityTabs.indexOf(t.key) !== -1) : TRR_TABS;
  trrGuard('tabs', JSON.stringify([trr.tab, noRun]), tabs, (el) => {
    tabList.forEach(t => {
      const btn = h('button', {
        class: 'sub-tab-btn tr-tab-btn' + (t.key === trr.tab ? ' active' : ''), text: t.label,
        attrs: { type: 'button', role: 'tab', 'aria-selected': t.key === trr.tab ? 'true' : 'false' }
      });
      btn.addEventListener('click', () => {
        trr.tab = t.key;
        trr.sigs.tabs = null;
        trr.sigs.panel = null;
        renderRunPanel();
      });
      el.appendChild(btn);
    });
  });
  const candidate = data ? data.candidate : null;
  if (trr.tab === 'candidate' && candidate) trrEnsureDiff(candidate);
  if (trr.tab === 'settings' && data && data.leadTaskCardId) trrEnsureUsage(data);
  if (activityTabs.indexOf(trr.tab) !== -1 && tr.ticketId) trrEnsureActivity(tr.ticketId);
  const activitySig = trr.activity ? [trr.activity.ticketId, trr.activity.state, trr.activity.data && trr.activity.data.available,
    trr.activity.data && trr.activity.data.runLog && trr.activity.data.runLog.entries && trr.activity.data.runLog.entries.length,
    trr.activity.data && trr.activity.data.runLog && trr.activity.data.runLog.hasMore, trr.activity.loadingMore, trr.activity.loadMoreError] : null;
  const sig = JSON.stringify([trr.tab, run && run.runId, data ? { i: data.intake, p: data.plan, s: data.stages, c: data.candidate, st: data.settings, l: data.leadTaskCardId } : null,
    trr.diff ? [trr.diff.key, trr.diff.state, trr.diff.error] : null, trr.usage ? [trr.usage.key, trr.usage.state, trr.usage.attempts.length] : null, trr.error, activitySig]);
  trrGuard('panel', sig, panel, (el) => {
    const activity = trr.activity;
    if (trr.tab === 'run-log') { trrActivityRunLog(el, activity, run); return; }
    if (trr.tab === 'turns') { trrActivityTurns(el, activity, run); return; }
    if (trr.tab === 'attempts-activity') { trrActivityAttempts(el, activity, run); return; }
    if (trr.tab === 'tokens') { trrActivityTokens(el, activity, run); return; }
    if (!run || !data) { el.appendChild(h('div', { class: 'detail-empty', text: trr.error ? 'Run details unavailable.' : 'Loading run details...' })); return; }
    if (trr.tab === 'requirements') trrTabRequirements(el, data);
    else if (trr.tab === 'plan') trrTabPlan(el, data);
    else if (trr.tab === 'candidate') trrTabCandidate(el, data);
    else if (trr.tab === 'settings') trrTabSettings(el, data);
    else trrTabExecution(el, data);
  });
}

function trrTabRequirements(el, data) {
  const intake = (Array.isArray(data.intake) ? data.intake : []).slice().sort((a, b) => a.turn - b.turn);
  const valid = intake.filter(x => x.valid && x.requirements);
  const latest = valid.length ? valid[valid.length - 1] : null;
  if (!latest) {
    el.appendChild(h('div', { class: 'detail-empty', text: intake.length ? 'No valid Intake result yet.' : 'Intake has not produced a result yet.' }));
  } else {
    const r = latest.requirements || {};
    const meta = h('div', { class: 'tr-run-meta' }, [
      h('span', { class: 'badge', text: 'Turn ' + latest.turn }),
      latest.classification ? h('span', { class: 'badge badge-role', text: 'Classification: ' + latest.classification }) : null,
      latest.readiness ? h('span', { class: 'badge', text: 'Readiness: ' + latest.readiness }) : null
    ]);
    el.appendChild(meta);
    el.appendChild(trrSection('Summary', h('div', { class: 'detail-block detail-pre', text: r.summary || 'No summary.' })));
    el.appendChild(trrSection('Scope', trrList(r.scope, 'Nothing listed.')));
    el.appendChild(trrSection('Out of scope', trrList(r.outOfScope, 'Nothing listed.')));
    el.appendChild(trrSection('Unknowns', trrList(r.unknowns, 'No open unknowns.')));
    el.appendChild(trrSection('Expected outcomes', trrList(r.expectedOutcomes, 'Nothing listed.')));
    if (latest.unsupportedReason) el.appendChild(trrSection('Unsupported', h('div', { class: 'detail-block', text: latest.unsupportedReason })));
  }
  const invalid = intake.filter(x => !x.valid);
  if (invalid.length) {
    const box = h('div', { class: 'tr-invalid' });
    invalid.forEach(x => {
      box.appendChild(h('div', { class: 'tr-sub-title', text: 'Turn ' + x.turn + ' was rejected (' + formatAbsTime(x.createdAt) + ')' }));
      const errs = Array.isArray(x.errors) ? x.errors : [];
      const ul = h('ul', { class: 'detail-list' });
      errs.forEach(e => ul.appendChild(h('li', {}, [
        h('span', { class: 'tr-token', text: e && e.path ? e.path : '(root)' }),
        h('span', { text: ' ' + (e && e.message ? e.message : '') })
      ])));
      if (!errs.length) ul.appendChild(h('li', { text: 'No error details recorded.' }));
      box.appendChild(ul);
    });
    el.appendChild(trrSection('Invalid Intake turns', box));
  }
}

function trrStageStatusClass(status) {
  return 'tr-stage-' + cssToken(status || 'pending');
}

function trrTabPlan(el, data) {
  const plan = data.plan;
  if (!plan) { el.appendChild(h('div', { class: 'detail-empty', text: 'No plan has been saved for this run yet.' })); return; }
  el.appendChild(h('div', { class: 'tr-run-meta' }, [
    h('span', { class: 'badge badge-role', text: 'Classification: ' + plan.classification }),
    h('span', { class: 'tr-marker', text: 'plan ' + String(plan.planRevisionId).slice(0, 12) + ' - ' + (plan.validatorVersion || 'unknown validator') }),
    h('span', { class: 'tr-marker', text: formatAbsTime(plan.createdAt) })
  ]));
  const live = Array.isArray(data.stages) ? data.stages : [];
  const table = h('table', { class: 'attempts-table tr-table' });
  table.appendChild(h('thead', {}, [h('tr', {}, ['Stage', 'Role', 'Required', 'Depends on', 'Allowed files', 'Status', 'Attempts'].map(t => h('th', { text: t })))]));
  const body = h('tbody');
  (Array.isArray(plan.stages) ? plan.stages : []).forEach(st => {
    const ls = live.find(x => x.stageId === st.stageId) || null;
    const status = ls ? ls.status : 'pending';
    const attempts = ls && Array.isArray(ls.attempts) ? ls.attempts : [];
    const files = Array.isArray(st.allowedFiles) ? st.allowedFiles : [];
    const deps = Array.isArray(st.dependencies) ? st.dependencies : [];
    const attemptCell = h('td', {}, [h('span', { text: String(attempts.length) })]);
    attempts.forEach(a => attemptCell.appendChild(h('div', { class: 'tr-marker', text: [a.role, a.journalState, a.outcome].filter(Boolean).join(' / ') })));
    body.appendChild(h('tr', {}, [
      h('td', {}, [h('div', { class: 'tr-token', text: st.stageId }), h('div', { class: 'tr-stage-obj', text: st.objective || '' })]),
      h('td', {}, [h('span', { class: 'tr-token', text: st.roleId || '' })]),
      h('td', { text: st.required ? 'required' : 'optional' }),
      h('td', { text: deps.length ? deps.join(', ') : 'none' }),
      h('td', {}, files.length ? files.map(f => h('div', { class: 'tr-token tr-block', text: f })) : [h('span', { class: 'detail-empty', text: 'read-only' })]),
      h('td', {}, [h('span', { class: 'badge tr-stage ' + trrStageStatusClass(status), text: status })]),
      attemptCell
    ]));
  });
  table.appendChild(body);
  el.appendChild(h('div', { class: 'attempts-table-wrapper' }, [table]));
  if (!live.length) el.appendChild(h('div', { class: 'form-hint', text: 'Stage progress is not available yet; all stages show as pending.' }));

  const checks = Array.isArray(plan.checks) ? plan.checks : [];
  const box = h('div', { class: 'tr-checks' });
  checks.forEach(c => {
    const argv = Array.isArray(c.argv) ? c.argv : [];
    box.appendChild(h('div', { class: 'tr-check' }, [
      h('div', {}, [h('span', { class: 'tr-token', text: c.id }), h('span', { text: ' ' + (c.description || '') }),
        h('span', { class: 'tr-marker', text: ' timeout ' + formatMaybeDuration(c.timeoutMs) })]),
      h('div', { class: 'tr-argv' }, argv.map(a => h('span', { class: 'tr-token tr-argv-token', text: a === '' ? '(empty)' : a })))
    ]));
  });
  el.appendChild(trrSection('Acceptance checks', checks.length ? box : h('span', { class: 'detail-empty', text: 'No checks in this plan.' })));
}

// Diff fetch: cached per candidate; late responses for a different candidate are dropped.
function trrEnsureDiff(candidate) {
  const key = candidate.candidateId + '|' + (candidate.integrityHash || '');
  if (trr.diff && trr.diff.key === key) return;
  if (!candidate.diffArtifactId) { trr.diff = { key, state: 'none' }; return; }
  const entry = { key, state: 'loading', text: '', error: null };
  trr.diff = entry;
  const ticketId = tr.ticketId;
  const runId = trr.runId;
  apiGetText('/runs/' + encodeURIComponent(runId) + '/candidate/diff').then(text => {
    if (ticketId !== tr.ticketId || trr.diff !== entry) return;
    entry.state = 'ready';
    entry.text = text;
    trr.sigs.panel = null;
    renderRunPanel();
  }, err => {
    if (ticketId !== tr.ticketId || trr.diff !== entry) return;
    entry.state = 'error';
    entry.error = err && err.message ? err.message : 'Could not load the diff';
    trr.sigs.panel = null;
    renderRunPanel();
  });
}

function trrDiffLineClass(line, ctx) {
  if (line.startsWith('diff ')) { ctx.inHunk = false; return 'file'; }
  if (line.startsWith('@@')) { ctx.inHunk = true; return 'hunk'; }
  if (!ctx.inHunk) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

function trrRenderDiff(text) {
  const wrap = h('div', { class: 'tr-diff', attrs: { tabindex: '0', role: 'region', 'aria-label': 'Candidate diff' } });
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) { wrap.appendChild(h('div', { class: 'detail-empty', text: 'The stored diff is empty.' })); return wrap; }
  const pre = h('pre', { class: 'tr-diff-pre' });
  const ctx = { inHunk: false, shown: 0 };
  const more = h('button', { class: 'btn btn-secondary tr-diff-more', attrs: { type: 'button' } });
  const addChunk = () => {
    const frag = document.createDocumentFragment();
    const end = Math.min(lines.length, ctx.shown + TRR_DIFF_CHUNK);
    for (let i = ctx.shown; i < end; i += 1) {
      frag.appendChild(h('span', { class: 'tr-diff-line ' + trrDiffLineClass(lines[i], ctx), text: lines[i] }));
    }
    ctx.shown = end;
    pre.appendChild(frag);
    if (ctx.shown >= lines.length) more.style.display = 'none';
    else more.textContent = 'Show more (' + (lines.length - ctx.shown) + ' lines remaining)';
  };
  more.addEventListener('click', addChunk);
  addChunk();
  wrap.appendChild(pre);
  wrap.appendChild(more);
  return wrap;
}

function trrTabCandidate(el, data) {
  const c = data.candidate;
  if (!c) { el.appendChild(h('div', { class: 'detail-empty', text: 'No candidate has been captured yet.' })); return; }
  const cls = data.plan ? data.plan.classification : null;
  el.appendChild(h('div', { class: 'form-hint', text: 'The candidate is uncommitted changes on the task branch. Nothing is committed or pushed.' }));
  el.appendChild(trrKv([
    ['branch', c.branch],
    ['base -> head', shortSha(c.baseCommit) + ' -> ' + shortSha(c.head)],
    ['captured', formatAbsTime(c.createdAt)],
    ['integrity', c.integrityHash ? String(c.integrityHash).slice(0, 16) : 'unavailable']
  ]));
  if (c.headMoved) {
    el.appendChild(h('div', { class: 'tr-banner tone-warn', attrs: { role: 'alert' } }, [
      h('span', { text: 'The branch head moved while this candidate was produced. The diff is shown against the recorded base; review it with that in mind.' })
    ]));
  }

  const acc = c.acceptance;
  if (acc) {
    const di = dispositionInfo(acc.disposition, cls);
    const box = h('div', { class: 'tr-accept' }, [
      h('div', { class: 'tr-disp-big tone-' + di.tone, text: di.label, attrs: { role: 'status' } })
    ]);
    const reasons = Array.isArray(acc.reasons) ? acc.reasons : [];
    if (reasons.length) box.appendChild(trrList(reasons.map(r => (r && typeof r === 'object') ? (r.message || r.code || JSON.stringify(r)) : r)));
    const warningLines = trrWarningLines(acc);
    if (warningLines.length) {
      box.appendChild(h('div', { class: 'tr-marker', text: 'Warnings (non-blocking)' }));
      box.appendChild(trrList(warningLines));
    }
    (Array.isArray(acc.checks) ? acc.checks : []).forEach(ch => {
      const ok = ch.exitCode === 0 && !ch.timedOut;
      const row = h('div', { class: 'tr-check-result' }, [
        h('div', {}, [
          h('span', { class: 'tr-token', text: ch.id }),
          h('span', { class: 'badge tr-exit ' + (ok ? 'ok' : 'bad'), text: ch.timedOut ? 'timed out' : ('exit ' + (ch.exitCode === null || ch.exitCode === undefined ? 'unknown' : ch.exitCode)) }),
          h('span', { class: 'tr-marker', text: formatMaybeDuration(ch.durationMs) })
        ])
      ]);
      if (ch.outputTail) row.appendChild(h('pre', { class: 'tr-output', text: ch.outputTail }));
      box.appendChild(row);
    });
    el.appendChild(trrSection('Acceptance evidence', box));
  } else {
    el.appendChild(trrSection('Acceptance evidence', h('div', { class: 'tr-disp-big tone-warn', text: 'No acceptance result recorded' })));
  }

  const manifest = Array.isArray(c.manifest) ? c.manifest : [];
  const table = h('table', { class: 'attempts-table tr-table' });
  table.appendChild(h('thead', {}, [h('tr', {}, ['Path', 'Status', 'Size', 'sha256'].map(t => h('th', { text: t })))]));
  const body = h('tbody');
  manifest.forEach(m => body.appendChild(h('tr', {}, [
    h('td', {}, [h('span', { class: 'tr-token', text: m.path })]),
    h('td', { text: m.status }),
    h('td', { text: isNumber(m.size) ? formatBytes(m.size) : 'n/a' }),
    h('td', {}, [h('span', { class: 'tr-marker', text: m.sha256 ? String(m.sha256).slice(0, 12) : 'n/a', title: m.sha256 || '' })])
  ])));
  table.appendChild(body);
  el.appendChild(trrSection('Changed files (' + manifest.length + ')', manifest.length
    ? h('div', { class: 'attempts-table-wrapper' }, [table]) : h('span', { class: 'detail-empty', text: 'No changed files.' })));

  const diffBox = h('div');
  if (c.truncated) {
    diffBox.appendChild(h('div', { class: 'tr-banner tone-warn', attrs: { role: 'alert' } }, [
      h('span', { text: 'Diff truncated: the stored diff was cut at its size limit. The file manifest above lists every changed file.' })
    ]));
  }
  const dd = trr.diff;
  if (!dd || dd.state === 'loading') diffBox.appendChild(h('div', { class: 'detail-empty', text: 'Loading diff...' }));
  else if (dd.state === 'none') diffBox.appendChild(h('div', { class: 'detail-empty', text: 'No diff was stored for this candidate.' }));
  else if (dd.state === 'error') diffBox.appendChild(h('div', { class: 'tf-field-error', text: 'Diff unavailable: ' + dd.error, attrs: { role: 'alert' } }));
  else diffBox.appendChild(trrRenderDiff(dd.text));
  el.appendChild(trrSection('Diff', diffBox));
}

function trrFlatten(value, prefix, out) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (!keys.length && prefix) out.push([prefix, '{}']);
    keys.forEach(k => trrFlatten(value[k], prefix ? prefix + '.' + k : k, out));
  } else if (Array.isArray(value)) {
    out.push([prefix, value.map(v => (v && typeof v === 'object') ? JSON.stringify(v) : String(v)).join(', ')]);
  } else {
    out.push([prefix, value === null || value === undefined ? 'null' : String(value)]);
  }
  return out;
}

// A null tier means nothing was sent to the App Server; the model's own default (if advertised) applies.
function trrTierLabel(v, model) {
  if (v) return String(v);
  const entry = model && typeof cmFindModel === 'function' ? cmFindModel(model) : null;
  const dflt = entry && entry.defaultServiceTier ? entry.defaultServiceTier : null;
  return dflt ? 'Default (not sent; model default ' + dflt + ')' : 'Default (not sent)';
}

function trrEnsureUsage(data) {
  const cardId = data.leadTaskCardId;
  const key = cardId + '|' + JSON.stringify((data.stages || []).map(s => [s.stageId, s.status, (s.attempts || []).length]));
  if (trr.usage && trr.usage.key === key) return;
  const prev = trr.usage && trr.usage.cardId === cardId ? trr.usage.attempts : [];
  trr.usage = { key, cardId, state: prev.length ? 'ok' : 'loading', attempts: prev };
  apiGet('/cards/' + encodeURIComponent(cardId) + '/usage').then(res => {
    if (!trr.usage || trr.usage.key !== key) return;
    trr.usage = { key, cardId, state: 'ok', attempts: Array.isArray(res && res.attempts) ? res.attempts : [] };
    renderRunPanel();
  }, () => {
    if (!trr.usage || trr.usage.key !== key) return;
    trr.usage = { key, cardId, state: 'error', attempts: [] };
    renderRunPanel();
  });
}

function trrSettingsLine(model, effort, tier) {
  return [model || 'unknown', effort || 'unknown', trrTierLabel(tier, model)].join(' / ');
}

function trrRolesTable(roles) {
  const ids = Object.keys(roles);
  const table = h('table', { class: 'attempts-table' });
  table.appendChild(h('thead', {}, [h('tr', {}, ['Role', 'Model', 'Effort', 'Speed', 'Source'].map(t => h('th', { text: t })))]));
  const body = h('tbody');
  ids.forEach(id => {
    const r = roles[id] && typeof roles[id] === 'object' ? roles[id] : {};
    body.appendChild(h('tr', {}, [
      h('td', {}, [h('span', { class: 'tr-token', text: id })]),
      h('td', { text: r.model || 'n/a' }),
      h('td', { text: r.effort || 'n/a' }),
      h('td', { text: trrTierLabel(r.serviceTier, r.model) }),
      h('td', { text: r.source || 'n/a', title: r.settingsRevisionId ? 'Revision ' + r.settingsRevisionId : '' })
    ]));
  });
  table.appendChild(body);
  return h('div', { class: 'attempts-table-wrapper' }, [table]);
}

function trrAttemptsSettings(usage) {
  if (!usage || usage.state === 'loading') return h('span', { class: 'detail-empty', text: 'Loading attempt settings...' });
  if (usage.state === 'error') return h('span', { class: 'detail-empty', text: 'Attempt settings unavailable.' });
  const withData = usage.attempts.filter(a => a && (a.requested || a.reported));
  if (!withData.length) {
    return h('span', { class: 'detail-empty', text: usage.attempts.length
      ? 'Requested and reported settings are not exposed for these attempts.' : 'No attempts recorded yet.' });
  }
  const table = h('table', { class: 'attempts-table' });
  table.appendChild(h('thead', {}, [h('tr', {}, ['Role', 'Requested', 'Reported', ''].map(t => h('th', { text: t })))]));
  const body = h('tbody');
  withData.forEach(a => {
    const rq = a.requested || null;
    const rp = a.reported || null;
    const differs = rq && rp && ((rq.model || null) !== (rp.model || null)
      || (rq.effort || null) !== (rp.reasoningEffort || null) || (rq.serviceTier || null) !== (rp.serviceTier || null));
    body.appendChild(h('tr', {}, [
      h('td', { text: a.role || 'n/a' }),
      h('td', { text: rq ? trrSettingsLine(rq.model, rq.effort, rq.serviceTier) : 'not recorded' }),
      h('td', { text: rp ? trrSettingsLine(rp.model, rp.reasoningEffort, rp.serviceTier) : 'not reported' }),
      h('td', {}, [differs ? h('span', { class: 'badge tone-warn', text: 'differs' }) : null])
    ]));
  });
  table.appendChild(body);
  return h('div', { class: 'attempts-table-wrapper' }, [table]);
}

function trrTabSettings(el, data) {
  if (!data.settings || typeof data.settings !== 'object') {
    el.appendChild(h('div', { class: 'detail-empty', text: 'No settings snapshot recorded for this run.' }));
    return;
  }
  el.appendChild(h('div', { class: 'form-hint', text: 'Settings pinned when the run was submitted. Later changes do not affect this run.' }));
  const rest = Object.assign({}, data.settings);
  const roles = rest.roles && typeof rest.roles === 'object' && !Array.isArray(rest.roles) ? rest.roles : null;
  if (roles) delete rest.roles;
  el.appendChild(h('div', { class: 'detail-block' }, [trrKv(trrFlatten(rest, '', []))]));
  if (roles) el.appendChild(trrSection('Pinned role settings', trrRolesTable(roles)));
  if (data.leadTaskCardId) el.appendChild(trrSection('Requested vs reported, per attempt', trrAttemptsSettings(trr.usage)));
}

function trrTabExecution(el, data) {
  if (!data.leadTaskCardId) {
    el.appendChild(h('div', { class: 'detail-empty', text: 'Engineering has not started, so there is no execution to open.' }));
    return;
  }
  el.appendChild(h('div', { class: 'form-hint', text: 'The lead execution behind this run, with its events, attempts and usage.' }));
  const btn = h('button', { class: 'btn btn-secondary', text: 'Open execution detail', attrs: { type: 'button' } });
  btn.addEventListener('click', () => {
    const cardId = data.leadTaskCardId;
    closeTicketRecord();
    openTicketDetailModal(cardId);
  });
  el.appendChild(btn);
}

// ---------- M7: delivery panel (GET /tickets/:id/delivery, commit, push, release repository) ----------

const TRD_STATE_TEXT = {
  intended: 'In progress',
  succeeded: 'Succeeded',
  failed: 'Failed',
  unknown: 'Unknown - outcome could not be confirmed; retry is safe'
};

function trdShown(d) {
  const accepted = d.review && d.review.verdict === 'accepted';
  return d.ticket.status === 'done' || Boolean(accepted) || trdReleaseOnlyShown(d);
}

function trdReleaseOnlyShown(d) {
  return Boolean(d && d.ticket && d.ticket.status === 'backlog' && trdAvailable(d, 'release_repository'));
}

function trdAvailable(d, key) {
  return (Array.isArray(d.availableActions) ? d.availableActions : []).map(actionName).includes(key);
}

function trdReason(d, key) {
  const u = (Array.isArray(d.unavailableActions) ? d.unavailableActions : []).find(x => actionName(x) === key);
  return u && u.reason ? u.reason : 'Not available';
}

async function trdFetch(ticketId, key) {
  trd.loading = true;
  let res = null;
  let error = null;
  try {
    res = await apiGet('/tickets/' + encodeURIComponent(ticketId) + '/delivery');
  } catch (err) {
    error = err && err.message ? err.message : 'Could not load delivery state';
  }
  trd.loading = false;
  if (ticketId !== tr.ticketId || trd.key !== key) { if (ticketId === tr.ticketId) renderDeliveryPanel(tr.detail); return; }
  if (error) trd.error = error; else { trd.data = res; trd.error = null; }
  trd.fetchedAt = Date.now();
  renderDeliveryPanel(tr.detail);
}

// Refetch when the ticket changed, after our own commands (key reset), and while a delivery is in progress.
function trdSync(d) {
  const pending = trd.data && Array.isArray(trd.data.deliveries) && trd.data.deliveries.some(x => x && x.state === 'intended');
  const key = [d.ticket.ticketId || tr.ticketId, d.ticket.version, d.ticket.updatedAt, d.review ? d.review.reviewId : ''].join('|');
  const stale = pending && Date.now() - trd.fetchedAt > 2500;
  if (trd.loading || (trd.key === key && !stale)) return;
  trd.ticketId = tr.ticketId;
  trd.key = key;
  trdFetch(tr.ticketId, key);
}

function trdOwnSig(d) {
  return JSON.stringify([trd.data, trd.error, trd.loading, d.availableActions, d.unavailableActions, tr.busy, d.revision && d.revision.title]);
}

function renderDeliveryPanel(d) {
  const el = document.getElementById('tr-run-delivery');
  if (!el || !d) return;
  if (!trdShown(d)) {
    trrGuard('delivery', 'hidden', el, () => {});
    return;
  }
  if (trdReleaseOnlyShown(d)) {
    trrGuard('delivery', trdOwnSig(d), el, (box) => trdBuildReleaseOnly(box, d));
    return;
  }
  trdSync(d);
  trrGuard('delivery', trdOwnSig(d), el, (box) => trdBuild(box, d));
}

function trdCommand(slot, path, extra, confirmText) {
  if (confirmText && !window.confirm(confirmText)) return;
  trText('tr-action-error', '');
  trd.key = null;
  sendTicketCommand(slot, path, extra, (m) => trText('tr-action-error', m));
}

function trdRemoteSelect(remotes) {
  const select = h('select', { class: 'form-select', attrs: { 'aria-label': 'Remote' } });
  remotes.forEach(r => {
    select.appendChild(h('option', { text: (r.name || '?') + (r.url ? ' - ' + r.url : ''), attrs: { value: r.name || '' } }));
  });
  if (!remotes.some(r => r.name === trd.remote)) trd.remote = remotes[0] ? remotes[0].name : null;
  select.value = trd.remote || '';
  select.addEventListener('change', () => { trd.remote = select.value; });
  return select;
}

function trdAppendReleaseAction(el, d) {
  if (!trdAvailable(d, 'release_repository')) return;
  const btn = h('button', { class: 'btn btn-secondary', attrs: { type: 'button', 'data-action': 'release_repository' } }, [h('span', { text: 'Release repository' })]);
  if (tr.busy) btn.disabled = true;
  btn.addEventListener('click', () => trdCommand('release_repository', '/release-repository', {},
    'Release the repository without committing?\n\nThe changes stay in the checkout, uncommitted. The repository becomes available to other tickets, which will see those changes as a dirty checkout.'));
  el.appendChild(h('div', { class: 'tr-answer-foot' }, [btn,
    h('span', { class: 'form-hint', text: 'Gives up the repository without committing. Changes stay in the checkout.' })]));
}

function trdBuildReleaseOnly(el, d) {
  el.appendChild(h('div', { class: 'tr-sub-title', text: 'Delivery' }));
  el.appendChild(h('div', { class: 'form-hint', text: 'This draft holds the repository. Release it to make the checkout available to other tickets.' }));
  trdAppendReleaseAction(el, d);
}

function trdBuild(el, d) {
  el.appendChild(h('div', { class: 'tr-sub-title', text: 'Delivery' }));
  const data = trd.data;
  if (trd.error) el.appendChild(h('div', { class: 'tf-field-error', text: 'Delivery state unavailable: ' + trd.error, attrs: { role: 'alert' } }));
  if (!data) {
    if (!trd.error) el.appendChild(h('div', { class: 'detail-empty', text: 'Loading delivery state...' }));
    return;
  }
  const plan = data.commitPlan;
  const candidate = data.candidate || null;
  const deliveries = Array.isArray(data.deliveries) ? data.deliveries : [];
  const remotes = (Array.isArray(data.remotes) ? data.remotes : []).filter(r => r && r.name);
  const commit = deliveries.filter(x => x && x.kind === 'commit' && x.state === 'succeeded')[0] || null;
  const committing = deliveries.some(x => x && x.kind === 'commit' && x.state === 'intended');
  const pushing = deliveries.some(x => x && x.kind === 'push' && x.state === 'intended');

  el.appendChild(h('div', { class: 'form-hint', text: 'Commit and push run in a deterministic Git step, never through agents. No force push and no pull request is created. Release repository leaves all changes in the checkout.' }));
  if (plan) {
    el.appendChild(trrKv([
      ['branch', plan.branch],
      ['base -> head', shortSha(plan.baseCommit) + ' -> ' + shortSha(plan.head)],
      ['files', isNumber(plan.files) ? plan.files : null],
      ['remote ref', plan.remoteRef]
    ]));
    if (plan.manifestTruncated) {
      el.appendChild(h('div', { class: 'tr-banner tone-warn', attrs: { role: 'status' } }, [
        h('span', { text: 'The file manifest was truncated; the file count above may be lower than the real number of changed files.' })
      ]));
    }
  } else if (!commit) {
    el.appendChild(h('div', { class: 'detail-empty', text: 'No commit plan is available for this ticket.' }));
  }

  // Commit
  const canCommit = trdAvailable(d, 'commit') && candidate && candidate.candidateId && candidate.integrityHash && !committing;
  if (!commit) {
    if (trd.message === null) trd.message = (d.revision && d.revision.title) || '';
    const input = h('input', { class: 'form-input', attrs: { type: 'text', maxlength: String(TRD_MESSAGE_MAX), 'aria-label': 'Commit message' } });
    input.value = trd.message;
    const err = h('div', { class: 'tf-field-error', attrs: { role: 'alert' } });
    input.addEventListener('input', () => { trd.message = input.value; err.textContent = ''; });
    const btn = h('button', { class: 'btn btn-secondary', attrs: { type: 'button', 'data-action': 'commit' } }, [h('span', { text: 'Commit' })]);
    if (!canCommit || tr.busy) {
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
      const why = committing ? 'A commit is in progress' : (trdAvailable(d, 'commit') ? 'No candidate evidence to bind the commit to' : trdReason(d, 'commit'));
      btn.title = why;
      if (!tr.busy) btn.appendChild(h('span', { class: 'btn-milestone', text: why }));
    }
    btn.addEventListener('click', () => {
      const msg = input.value;
      if (!msg.trim() || msg.length > TRD_MESSAGE_MAX || msg.indexOf('\u0000') !== -1) { err.textContent = 'Enter a commit message of 1 to ' + TRD_MESSAGE_MAX + ' characters.'; return; }
      trdCommand('commit', '/commit', { candidateId: candidate.candidateId, integrityHash: candidate.integrityHash, message: msg },
        'Commit the accepted changes on branch ' + (plan && plan.branch ? plan.branch : 'the task branch') + '?\n\nThis creates a local commit. Nothing is pushed.');
    });
    el.appendChild(h('div', { class: 'tr-decision detail-block' }, [
      h('div', { class: 'form-hint', text: 'Commit message' }), input, h('div', { class: 'tr-answer-foot' }, [btn]), err
    ]));
  }

  // Push
  if (commit) {
    const canPush = trdAvailable(d, 'push') && remotes.length > 0 && !pushing;
    const select = trdRemoteSelect(remotes);
    const btn = h('button', { class: 'btn btn-secondary', attrs: { type: 'button', 'data-action': 'push' } }, [h('span', { text: 'Push' })]);
    if (!canPush || tr.busy) {
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
      const why = pushing ? 'A push is in progress' : (!remotes.length ? 'No remote is configured' : trdReason(d, 'push'));
      btn.title = why;
      if (!tr.busy) btn.appendChild(h('span', { class: 'btn-milestone', text: why }));
    }
    btn.addEventListener('click', () => {
      const remote = select.value;
      if (!remote) return;
      trdCommand('push', '/push', { deliveryId: commit.deliveryId, commitSha: commit.commitSha, remote },
        'Push commit ' + shortSha(commit.commitSha) + ' to remote "' + remote + '"?\n\nThis is a normal push, never forced.');
    });
    el.appendChild(h('div', { class: 'tr-decision detail-block' }, [
      h('div', { class: 'form-hint', text: 'Committed ' + shortSha(commit.commitSha) + ' on ' + (commit.branch || 'the task branch') + '. Push to a remote:' }),
      remotes.length ? select : h('span', { class: 'detail-empty', text: 'No remote is configured.' }),
      h('div', { class: 'tr-answer-foot' }, [btn])
    ]));
  }

  // Release repository
  trdAppendReleaseAction(el, d);

  // History
  if (deliveries.length) {
    const hist = h('details', { class: 'tr-history', attrs: { open: 'open' } }, [h('summary', { text: 'Delivery history (' + deliveries.length + ')' })]);
    deliveries.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).forEach(x => {
      const row = h('div', { class: 'tr-hist-item' }, [
        h('span', { class: 'tr-token', text: x.kind || 'delivery' }),
        h('span', { class: 'badge tone-' + (x.state === 'succeeded' ? 'ok' : (x.state === 'failed' ? 'bad' : 'warn')), text: x.state || 'unknown' }),
        h('span', { class: 'tr-marker', text: [x.commitSha ? shortSha(x.commitSha) : null, x.remote, formatAbsTime(x.updatedAt || x.createdAt)].filter(Boolean).join(' | ') })
      ]);
      const explain = x.state === 'unknown' ? TRD_STATE_TEXT.unknown : (x.state === 'intended' ? 'The Git step is running or was interrupted; it is reconciled automatically.' : null);
      if (explain) row.appendChild(h('div', { class: 'form-hint', text: explain }));
      if (x.error && (x.error.message || x.error.code)) {
        row.appendChild(h('div', { class: 'tf-field-error', text: (x.error.code ? '[' + x.error.code + '] ' : '') + (x.error.message || '') }));
      }
      hist.appendChild(row);
    });
    el.appendChild(hist);
  }
}
