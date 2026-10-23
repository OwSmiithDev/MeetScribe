const DEFAULTS = { source: 'captions', refine: true, refineModel: 'gpt-4.1-mini', autoCC: true, apiKey: '', model: 'gpt-4o-transcribe', diarize: true, language: 'pt', useMic: true, selfName: '', silenceMs: 1000, vocabulary: '' };
const $ = (id) => document.getElementById(id);
const fields = Object.keys(DEFAULTS);

const say = (id, text, cls = '') => { const e = $(id); e.textContent = text; e.className = 'msg ' + cls; };

(async () => {
  const s = { ...DEFAULTS, ...((await chrome.storage.local.get('settings')).settings || {}) };
  for (const k of fields) {
    if (k === 'apiKey') continue; // never write the saved key back into the page
    if (typeof DEFAULTS[k] === 'boolean') $(k).checked = s[k];
    else $(k).value = s[k];
  }
  if (s.apiKey) $('apiKey').placeholder = 'Chave salva (…' + s.apiKey.slice(-4) + '). Digite para trocar.';
})();

$('showKey').addEventListener('click', () => {
  const show = $('apiKey').type === 'password';
  $('apiKey').type = show ? 'text' : 'password';
  $('showKey').textContent = show ? 'Ocultar' : 'Mostrar';
  $('showKey').setAttribute('aria-pressed', String(show));
});

$('save').addEventListener('click', async () => {
  const s = {};
  const old = (await chrome.storage.local.get('settings')).settings || {};
  for (const k of fields) {
    s[k] = typeof DEFAULTS[k] === 'boolean' ? $(k).checked : typeof DEFAULTS[k] === 'number' ? Number($(k).value) || DEFAULTS[k] : $(k).value.trim();
  }
  if (!s.apiKey) s.apiKey = old.apiKey || ''; // empty field = keep the saved key
  s.v = 3;
  if (s.apiKey && !/^sk-[\w\-]{10,}$/.test(s.apiKey)) return say('saveMsg', 'A chave deve começar com sk-.', 'err');
  if (!/^[\w.:\-]{2,64}$/.test(s.refineModel)) return say('saveMsg', 'Nome de modelo inválido.', 'err');
  await chrome.storage.local.set({ settings: s });
  say('saveMsg', 'Salvo.', 'ok');
  setTimeout(() => say('saveMsg', ''), 2500);
});

$('wipe').addEventListener('click', async () => {
  if (!confirm('Apagar TODAS as transcrições salvas neste navegador?')) return;
  await chrome.runtime.sendMessage({ target: 'background', type: 'delete-all' });
  say('wipeMsg', 'Apagado.', 'ok');
});

$('test').addEventListener('click', async () => {
  say('testMsg', 'Testando…');
  try {
    const key = $('apiKey').value.trim() || ((await chrome.storage.local.get('settings')).settings || {}).apiKey || '';
    const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer ' + key } });
    say('testMsg', r.ok ? 'Chave válida.' : 'Chave recusada (' + r.status + ').', r.ok ? 'ok' : 'err');
  } catch (e) {
    say('testMsg', 'Sem conexão: ' + e.message, 'err');
  }
});

$('mic').addEventListener('click', async () => {
  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio: true });
    st.getTracks().forEach((t) => t.stop());
    say('micMsg', 'Microfone liberado.', 'ok');
  } catch (e) {
    say('micMsg', 'Negado: ' + e.message + '. Libere em chrome://settings/content/microphone.', 'err');
  }
});
