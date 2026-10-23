// MeetScribe service worker: start/stop, session storage.
// Source 'captions': live captions scraped from the meeting page (captions.js). Source 'audio': offscreen.js + OpenAI.
importScripts('captions.js');

const DEFAULTS = {
  source: 'captions',
  refine: true,
  refineModel: 'gpt-4.1-mini',
  autoCC: true,
  apiKey: '',
  model: 'gpt-4o-transcribe',
  diarize: true,
  language: 'pt',
  useMic: true,
  selfName: '',
  silenceMs: 1000,
  vocabulary: ''
};
const MAX_SESSIONS = 20;
const ID_RE = /^\d{10,16}$/;
const str = (v, n) => String(v == null ? '' : v).slice(0, n);

// keep the API key away from content scripts running on meeting pages
try { chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {}); } catch {}

// serialize all storage read-modify-write
let chain = Promise.resolve();
const run = (fn) => {
  const r = chain.then(fn);
  chain = r.catch(() => {});
  return r;
};

const getSettings = async () => {
  const saved = (await chrome.storage.local.get('settings')).settings || {};
  // v3: captions-first (the platform's own captions are more accurate than chunked ASR)
  if (saved.v !== 3) {
    Object.assign(saved, { v: 3, source: 'captions', refine: true, refineModel: DEFAULTS.refineModel, autoCC: true,
      model: DEFAULTS.model, silenceMs: DEFAULTS.silenceMs, language: DEFAULTS.language });
    await chrome.storage.local.set({ settings: saved });
  }
  return { ...DEFAULTS, ...saved };
};
const redact = (t) => String(t || '').replace(/sk-[A-Za-z0-9_\-*]{4,}/g, 'sk-…');
const getRec = async () => (await chrome.storage.session.get('rec')).rec || null;
const setRec = (rec) => chrome.storage.session.set({ rec });

const platformOf = (url = '') => {
  try {
    const h = new URL(url).hostname;
    if (h === 'meet.google.com') return 'meet';
    if (/(^|\.)(teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft)$/.test(h)) return 'teams';
  } catch {}
  return 'other';
};

const updateSession = (id, fn) => {
  if (eng && eng.session.id === id) { fn(eng.session); ccDirty(); return Promise.resolve(); } // live caption session is cached
  return run(async () => {
    const key = 's_' + id;
    const s = (await chrome.storage.local.get(key))[key];
    if (!s) return;
    fn(s);
    await chrome.storage.local.set({ [key]: s });
  });
};

function safeUrl(u) {
  try { const x = new URL(u); return x.origin + x.pathname; } catch { return ''; }
}

async function createSession(tab, platform, mode = 'audio') {
  const id = String(Date.now());
  const s = {
    id,
    title: tab.title || 'Reunião',
    platform,
    mode,
    url: safeUrl(tab.url), // no query string: Teams links can carry tenant/meeting identifiers
    startedAt: Date.now(),
    endedAt: null,
    participants: [],
    self: null,
    lines: []
  };
  await run(async () => {
    const { sessionIndex = [] } = await chrome.storage.local.get('sessionIndex');
    sessionIndex.unshift(id);
    const drop = sessionIndex.splice(MAX_SESSIONS);
    await chrome.storage.local.set({ ['s_' + id]: s, sessionIndex });
    if (drop.length) await chrome.storage.local.remove(drop.map((d) => 's_' + d));
  });
  return id;
}

async function ensureOffscreen() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctxs.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'], // AUDIO_PLAYBACK would make Chrome close the document after 30 s of silence
    justification: 'Capturar o áudio da aba e do microfone para transcrição.'
  });
}

function badge(on) {
  chrome.action.setBadgeText({ text: on ? 'REC' : '' });
  if (on) chrome.action.setBadgeBackgroundColor({ color: '#D93025' });
}

let starting = false;
async function start(tabId) {
  if (starting) throw new Error('Iniciando…');
  starting = true;
  try { return await doStart(tabId); } finally { starting = false; }
}

async function doStart(tabId) {
  if (await getRec()) throw new Error('Já existe uma gravação em andamento.');
  const settings = await getSettings();
  const tab = await chrome.tabs.get(tabId);
  const platform = platformOf(tab.url);
  if (settings.source === 'captions') return startCaptions(tab, platform, settings);
  if (!settings.apiKey) throw new Error('Configure a chave da OpenAI nas Opções.');
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (e) {
    throw new Error('Clique no ícone da extensão com a aba da reunião ativa e tente de novo. (' + e.message + ')');
  }
  await ensureOffscreen();
  const sessionId = await createSession(tab, platform);
  let notice = '';
  if (platform !== 'other') {
    try { await chrome.tabs.sendMessage(tabId, { type: 'ping' }); }
    catch { notice = 'Recarregue a aba da reunião (F5) para identificar quem está falando.'; }
  }
  const rec = { tabId, sessionId, platform, startedAt: Date.now(), notice };
  await setRec(rec);
  if (platform !== 'other') chrome.tabs.sendMessage(tabId, { type: 'activate', mode: 'audio' }).catch(() => {});
  const r = await chrome.runtime.sendMessage({
    target: 'offscreen', type: 'start', streamId, tabId, sessionId, platform, settings
  });
  if (!r || !r.ok) {
    await finish(r && r.error);
    throw new Error((r && r.error) || 'Falha ao iniciar a captura.');
  }
  badge(true);
  return { sessionId };
}

async function startCaptions(tab, platform, settings) {
  if (platform === 'other') throw new Error('Abra uma reunião do Google Meet ou do Teams nesta aba.');
  if (settings.refine && !settings.apiKey) throw new Error('Configure a chave da OpenAI nas Opções (ou desligue o refino com IA).');
  let notice = '';
  try { await chrome.tabs.sendMessage(tab.id, { type: 'ping' }); }
  catch { throw new Error('Recarregue a aba da reunião (F5) e tente de novo.'); }
  const sessionId = await createSession(tab, platform, 'captions');
  await setRec({ tabId: tab.id, sessionId, platform, mode: 'captions', startedAt: Date.now(), notice, ccOn: null });
  await chrome.tabs.sendMessage(tab.id, { type: 'activate', mode: 'captions' }).catch(() => {});
  if (settings.autoCC) chrome.tabs.sendMessage(tab.id, { type: 'enable-captions' }).catch(() => {});
  badge(true);
  return { sessionId };
}

async function finish(error) {
  const rec = await getRec();
  if (rec) chrome.tabs.sendMessage(rec.tabId, { type: 'deactivate' }).catch(() => {});
  if (rec && rec.mode === 'captions') { try { await ccStop(); } catch {} }
  await chrome.storage.session.remove('rec');
  badge(false);
  if (rec) await updateSession(rec.sessionId, (s) => { s.endedAt = Date.now(); if (error) s.error = error; });
  try { await chrome.offscreen.closeDocument(); } catch {}
}

async function stop() {
  const rec = await getRec();
  if (!rec) return;
  await setRec({ ...rec, stopping: true });
  if (rec.mode !== 'captions') { try { await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }); } catch {} }
  await finish();
}

async function handle(msg) {
  switch (msg.type) {
    case 'start': return start(msg.tabId);
    case 'stop': return stop();
    case 'delete-all':
      return run(async () => {
        const rec = await getRec();
        const { sessionIndex = [] } = await chrome.storage.local.get('sessionIndex');
        const keep = rec ? [rec.sessionId] : [];
        await chrome.storage.local.remove(sessionIndex.filter((i) => !keep.includes(i)).map((i) => 's_' + i));
        await chrome.storage.local.set({ sessionIndex: sessionIndex.filter((i) => keep.includes(i)) });
      });
    case 'delete':
      if (!ID_RE.test(String(msg.sessionId))) return;
      return run(async () => {
        const { sessionIndex = [] } = await chrome.storage.local.get('sessionIndex');
        await chrome.storage.local.set({ sessionIndex: sessionIndex.filter((i) => i !== msg.sessionId) });
        await chrome.storage.local.remove('s_' + msg.sessionId);
      });
    case 'line': {
      const l = msg.line || {};
      if (!ID_RE.test(String(msg.sessionId))) return;
      return updateSession(msg.sessionId, (s) => s.lines.push({
        id: str(l.id, 40), ts: Number(l.ts) || 0, end: Number(l.end) || 0,
        speaker: str(l.speaker, 80), text: str(l.text, 4000), src: l.src === 'mic' ? 'mic' : 'tab'
      }));
    }
    case 'notice': {
      const rec = await getRec();
      if (rec) await setRec({ ...rec, notice: redact(msg.text) });
      return;
    }
    case 'ended': return stop(); // tab stream ended (tab closed / reloaded)
  }
}

const fromExtensionPage = (sender) => sender.id === chrome.runtime.id && !sender.tab;
const fromMeetingTab = (sender) => sender.id === chrome.runtime.id && sender.tab && platformOf(sender.tab.url) !== 'other';

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (msg && msg.type === 'hello' && fromMeetingTab(sender)) {
    getRec().then((rec) => send(rec && rec.tabId === sender.tab.id && !rec.stopping ? { active: true, mode: rec.mode === 'captions' ? 'captions' : 'audio' } : { active: false }));
    return true;
  }
  if (msg && msg.target === 'background') {
    if (!fromExtensionPage(sender)) return; // content scripts / other contexts cannot drive the recorder
    handle(msg).then((r) => send(r || { ok: true }), (e) => send({ ok: false, error: e.message || String(e) }));
    return true;
  }
  // content scripts: captions + meeting metadata
  if (fromMeetingTab(sender) && msg && (msg.type === 'caption' || msg.type === 'ccstate')) {
    getRec().then(async (rec) => {
      if (!rec || rec.tabId !== sender.tab.id || rec.mode !== 'captions' || rec.stopping) return;
      if (msg.type === 'caption') return onCaption(msg, rec);
      const notice = msg.on ? '' : 'Ligue as legendas (botão CC) na reunião e escolha o idioma falado.';
      if (rec.ccOn !== msg.on) await setRec({ ...rec, ccOn: msg.on, notice });
    });
    return;
  }
  if (fromMeetingTab(sender) && msg && (msg.type === 'meeting' || msg.type === 'participants')) {
    getRec().then((rec) => {
      if (!rec || rec.tabId !== sender.tab.id) return;
      updateSession(rec.sessionId, (s) => {
        if (msg.type === 'meeting' && msg.title) s.title = msg.title;
        if (msg.type === 'participants') {
          s.participants = msg.names || [];
          if (msg.self) s.self = msg.self;
        }
      });
    });
  }
});

chrome.action.onClicked.addListener((tab) => chrome.sidePanel.open({ tabId: tab.id }));

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rec = await getRec();
  if (rec && rec.tabId === tabId) stop();
});

// Service worker restart with a stale recording flag but no offscreen document: clean up.
(async () => {
  const rec = await getRec();
  if (!rec) return;
  if (rec.mode === 'captions') return badge(true);
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!ctxs.length) await finish();
  else badge(true);
})();
