const $ = (s) => document.querySelector(s);
const el = {
  shell: $('#shell'), log: $('#log'), sel: $('#sessions'), toggle: $('#toggle'), status: $('#status'),
  elapsed: $('#elapsed'), notice: $('#notice'), jump: $('#jump')
};
let rec = null;
let current = null; // session id shown
let session = null;
let pinned = true; // follow the live end of the log
let showRaw = false; // false = polished text when available
let unread = 0;
const rowEls = new Map(); // line id -> element (keyed update: only changed rows are touched)
let timer = null;
let raf = 0;

const mmss = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
};
const mdEsc = (t) => String(t).replace(/([\\`*_{}\[\]()#+!<>|~])/g, '\\$1'); // names/text come from other participants
const hue = (name) => {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};
const shown = (l) => (showRaw ? l.text : l.clean || l.text);
const store = { local: (k) => chrome.storage.local.get(k), session: (k) => chrome.storage.session.get(k) };

// ---------- transcript ----------

function emptyState() {
  const box = document.createElement('div');
  box.className = 'empty';
  const h = document.createElement('h2');
  h.textContent = 'Pronto para transcrever';
  const ol = document.createElement('ol');
  for (const t of [
    'Entre na reunião (Google Meet ou Teams).',
    'Clique no ícone do MeetScribe e em Iniciar transcrição.',
    'As legendas aparecem aqui, com o nome de quem fala.'
  ]) {
    const li = document.createElement('li');
    li.textContent = t;
    ol.append(li);
  }
  box.append(h, ol);
  return box;
}

function makeRow() {
  const row = document.createElement('div');
  const t = document.createElement('span');
  t.className = 't mono';
  const body = document.createElement('div');
  const who = document.createElement('div');
  who.className = 'who';
  const tx = document.createElement('p');
  tx.className = 'tx';
  body.append(who, tx);
  row.append(t, body);
  row._p = { t, who, tx, sig: '' };
  return row;
}

function fillRow(row, l, prev, fresh) {
  const text = shown(l);
  const cont = !!prev && prev.speaker === l.speaker && l.ts - prev.end < 20000;
  const pending = !showRaw && session.mode === 'captions' && !l.clean;
  const sig = [l.speaker, text, cont, pending].join('\u0001');
  const p = row._p;
  if (p.sig === sig) return;
  p.sig = sig;
  row.className = 'row' + (cont ? ' cont' : '') + (pending ? ' pending' : '') + (fresh ? ' fresh' : '');
  row.style.setProperty('--h', hue(l.speaker));
  p.t.textContent = mmss(l.ts - session.startedAt);
  p.who.textContent = l.speaker;
  p.tx.textContent = text;
}

function reconcile() {
  raf = 0;
  if (!session || !session.lines.length) {
    rowEls.clear();
    const first = el.log.firstElementChild;
    if (!first || !first.classList.contains('empty')) el.log.replaceChildren(emptyState());
    return;
  }
  const first = el.log.firstElementChild;
  if (first && first.classList.contains('empty')) el.log.replaceChildren();
  const lines = [...session.lines].sort((a, b) => a.ts - b.ts);
  const live = new Set();
  let added = 0;
  lines.forEach((l, i) => {
    live.add(l.id);
    let row = rowEls.get(l.id);
    const isNew = !row;
    if (isNew) { row = makeRow(); rowEls.set(l.id, row); added++; }
    fillRow(row, l, lines[i - 1], !isNew && !!rec);
    const at = el.log.children[i];
    if (at !== row) el.log.insertBefore(row, at || null);
  });
  for (const [id, row] of rowEls) if (!live.has(id)) { row.remove(); rowEls.delete(id); }
  if (pinned) el.log.scrollTop = el.log.scrollHeight;
  else if (added) { unread += added; el.jump.hidden = false; el.jump.textContent = 'Ir para o fim ↓ (' + unread + ')'; }
}

const schedule = () => { if (!raf) raf = requestAnimationFrame(reconcile); };

function resetLog() {
  rowEls.clear();
  el.log.replaceChildren();
  pinned = true;
  unread = 0;
  el.jump.hidden = true;
  reconcile();
}

// ---------- control strip ----------

function renderControl() {
  const on = !!rec;
  const cc = on && rec.mode === 'captions';
  document.body.classList.toggle('rec', on);
  document.body.classList.toggle('audio', on && !cc);
  el.toggle.textContent = on ? (rec.stopping ? 'Finalizando…' : 'Parar transcrição') : 'Iniciar transcrição';
  el.toggle.disabled = !!(rec && rec.stopping);
  el.status.textContent = on
    ? rec.stopping ? 'Finalizando…' : (cc ? 'Lendo legendas · ' : 'Gravando · ') + (rec.platform || 'aba')
    : 'Pronto';
  el.notice.hidden = !(rec && rec.notice);
  el.notice.textContent = (rec && rec.notice) || '';
  // the elapsed clock only ticks while recording
  clearInterval(timer);
  timer = null;
  if (on && rec.startedAt) {
    const tick = () => (el.elapsed.textContent = mmss(Date.now() - rec.startedAt));
    tick();
    timer = setInterval(tick, 1000);
  } else {
    el.elapsed.textContent = '';
    $('#lvTab').style.width = $('#lvMic').style.width = '0';
  }
}

// ---------- sessions ----------

async function renderSessions(keep) {
  const { sessionIndex = [] } = await store.local('sessionIndex');
  const data = await store.local(sessionIndex.map((i) => 's_' + i));
  const frag = document.createDocumentFragment();
  for (const id of sessionIndex) {
    const s = data['s_' + id];
    if (!s) continue;
    const o = document.createElement('option');
    o.value = id;
    o.textContent = new Date(s.startedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) + ' · ' + String(s.title || 'Reunião').slice(0, 40);
    frag.append(o);
  }
  el.sel.replaceChildren(frag);
  el.sel.hidden = !el.sel.options.length;
  const want = (rec && rec.sessionId) || keep || sessionIndex[0] || null;
  el.sel.value = want || '';
  await select(el.sel.value || null);
}

async function select(id) {
  current = id;
  session = id ? (await store.local('s_' + id))['s_' + id] || null : null;
  resetLog();
}

// ---------- export ----------

const text = (fmt) => {
  if (!session) return '';
  const lines = [...session.lines].sort((a, b) => a.ts - b.ts);
  if (fmt === 'md') {
    let out = '# ' + mdEsc(session.title) + '\n\n' + new Date(session.startedAt).toLocaleString('pt-BR') + '\n\n';
    let last = null;
    for (const l of lines) {
      if (l.speaker !== last) out += '\n**' + mdEsc(l.speaker) + '** (' + mmss(l.ts - session.startedAt) + ')\n';
      out += mdEsc(shown(l)) + '\n';
      last = l.speaker;
    }
    return out;
  }
  return lines.map((l) => '[' + mmss(l.ts - session.startedAt) + '] ' + l.speaker + ': ' + shown(l)).join('\n');
};
const download = (fmt) => {
  const blob = new Blob([text(fmt)], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (session.title || 'reuniao').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 60) + '.' + (fmt === 'md' ? 'md' : 'txt');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  $('#dlMenu').open = false;
};

// ---------- events ----------

el.toggle.addEventListener('click', async () => {
  el.toggle.disabled = true;
  el.notice.hidden = true;
  try {
    let r;
    if (rec) {
      r = await chrome.runtime.sendMessage({ target: 'background', type: 'stop' });
    } else {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) throw new Error('Nenhuma aba ativa.');
      r = await chrome.runtime.sendMessage({ target: 'background', type: 'start', tabId: tab.id });
    }
    if (r && r.ok === false) throw new Error(r.error);
  } catch (e) {
    el.notice.hidden = false;
    el.notice.textContent = e.message || String(e);
  }
  el.toggle.disabled = !!(rec && rec.stopping);
});

el.sel.addEventListener('change', () => select(el.sel.value));
$('#openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
const setRaw = (v) => {
  showRaw = v;
  $('#segClean').setAttribute('aria-pressed', String(!v));
  $('#segRaw').setAttribute('aria-pressed', String(v));
  for (const row of rowEls.values()) row._p.sig = ''; // force re-fill with the other version
  schedule();
};
$('#segClean').addEventListener('click', () => setRaw(false));
$('#segRaw').addEventListener('click', () => setRaw(true));

el.log.addEventListener('scroll', () => {
  pinned = el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 80;
  if (pinned) { unread = 0; el.jump.hidden = true; }
}, { passive: true });
el.jump.addEventListener('click', () => {
  pinned = true; unread = 0; el.jump.hidden = true;
  el.log.scrollTo({ top: el.log.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
});

$('#copy').addEventListener('click', async () => {
  if (!session) return;
  await navigator.clipboard.writeText(text('txt'));
  const b = $('#copy');
  b.textContent = 'Copiado';
  setTimeout(() => (b.textContent = 'Copiar'), 1200);
});
$('#dlTxt').addEventListener('click', () => session && download('txt'));
$('#dlMd').addEventListener('click', () => session && download('md'));
$('#del').addEventListener('click', async () => {
  if (!session || (rec && rec.sessionId === session.id)) return;
  if (!confirm('Apagar esta transcrição?')) return;
  await chrome.runtime.sendMessage({ target: 'background', type: 'delete', sessionId: session.id });
  await renderSessions();
});

// ---------- live updates ----------

chrome.storage.onChanged.addListener(async (ch, area) => {
  if (area === 'session' && ch.rec) {
    const was = rec;
    rec = ch.rec.newValue || null;
    renderControl();
    if (rec && (!was || was.sessionId !== rec.sessionId)) await renderSessions();
    return;
  }
  if (area !== 'local') return;
  if (ch.sessionIndex) await renderSessions(current);
  const c = current && ch['s_' + current];
  if (c && c.newValue) {
    // storage can be a couple of seconds behind the live updates: keep whichever copy of a line is newer
    const byId = new Map((session ? session.lines : []).map((l) => [l.id, l]));
    for (const l of c.newValue.lines) {
      const m = byId.get(l.id);
      if (!m || l.end > m.end || (l.end === m.end && l.clean && !m.clean)) byId.set(l.id, l);
    }
    session = { ...c.newValue, lines: [...byId.values()] };
    schedule();
  }
});

let talkTimer = 0;
chrome.runtime.onMessage.addListener((m, sender) => {
  if (sender.id !== chrome.runtime.id || !m) return;
  if (m.type === 'level') {
    $('#lvTab').style.width = Math.round(Math.min(1, m.tab) * 100) + '%';
    $('#lvMic').style.width = Math.round(Math.min(1, m.mic) * 100) + '%';
  } else if (m.type === 'cc-line' && session && m.sessionId === session.id && m.line) {
    const i = session.lines.findIndex((l) => l.id === m.line.id);
    if (i < 0) session.lines.push(m.line);
    else session.lines[i] = m.line;
    schedule();
    el.shell.classList.add('talk'); // the mark moves while captions arrive
    clearTimeout(talkTimer);
    talkTimer = setTimeout(() => el.shell.classList.remove('talk'), 1400);
  }
});

(async () => {
  rec = (await store.session('rec')).rec || null;
  renderControl();
  await renderSessions();
})();
