// MeetScribe offscreen document: captures tab + mic audio, cuts it at pauses,
// sends each segment to OpenAI, and labels the speaker using the meeting UI timeline.
const RATE = 16000;
const BLOCK = 2048; // samples per worklet block (128 ms)
const BLOCK_MS = (BLOCK / RATE) * 1000;
const MAX_SEG_MS = 25000; // longer segments = more context = better accuracy
const MIN_SPEECH_MS = 800; // shorter blips are mostly noise/bleed and make the model hallucinate
const MIC_BLEED_GATE = 0.03; // while the meeting talks, only a clearly louder mic counts as my voice
const MIC_MIN_LEVEL = 0.012; // mean speech level below this on the mic = bleed or silence
const HOLD_MS = 2500; // a "speakers" event is trusted this long without a heartbeat
const LEAD_MS = 400; // UI indicators lag/lead the audio a bit
const LAG_MS = 400;
const CONCURRENCY = 2;

let cfg = null; // {tabId, sessionId, platform, settings}
let ctx = null;
let streams = [];
let playCtx = null;
let segs = {}; // src -> Segmenter
let timeline = []; // {ts, active: string[]}
let participants = [];
let selfName = '';
let queue = [];
let inflight = 0;
let diarizeOk = true;
let levelTimer = null;
const level = { tab: 0, mic: 0 };

const send = (m) => chrome.runtime.sendMessage({ target: 'background', ...m }).catch(() => {});
const notice = (text) => send({ type: 'notice', text });

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg && msg.target === 'offscreen') {
    if (sender.id !== chrome.runtime.id || sender.tab) return; // only our own extension pages may control capture
    const p = msg.type === 'start' ? start(msg) : msg.type === 'stop' ? stop() : Promise.resolve();
    p.then(() => respond({ ok: true }), (e) => respond({ ok: false, error: e.message || String(e) }));
    return true;
  }
  if (cfg && sender.tab && sender.tab.id === cfg.tabId) onContent(msg);
});

function onContent(m) {
  if (!m) return;
  const now = Date.now();
  if (m.type === 'speakers') {
    timeline.push({ ts: m.ts || now, active: (m.active || []).slice(0, 8).map(String) });
    if (timeline.length > 600 && timeline[0].ts < now - 180000) timeline = timeline.filter((e) => e.ts >= now - 180000);
  } else if (m.type === 'caption' && m.speaker) {
    timeline.push({ ts: m.ts || now, active: [m.speaker] });
  } else if (m.type === 'participants') {
    participants = m.names || [];
    if (m.self) selfName = m.self;
  }
}

// ---------- capture ----------

async function start(msg) {
  cfg = msg;
  const s = cfg.settings;
  selfName = s.selfName || '';
  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId } },
    video: false
  });
  streams.push(tabStream);
  tabStream.getAudioTracks()[0].addEventListener('ended', () => send({ type: 'ended' }));

  // keep the tab audible (tab capture mutes it otherwise)
  playCtx = new AudioContext();
  playCtx.createMediaStreamSource(tabStream).connect(playCtx.destination);
  playCtx.resume().catch(() => {});

  ctx = new AudioContext({ sampleRate: RATE });
  await ctx.resume();
  await ctx.audioWorklet.addModule('worklet.js');

  segs.tab = new Segmenter('tab', s, () => false);
  hook(tabStream, segs.tab);

  if (s.useMic) {
    try {
      const mic = await Promise.race([
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
          video: false
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
      ]);
      streams.push(mic);
      segs.mic = new Segmenter('mic', s, () => segs.tab && segs.tab.speech);
      hook(mic, segs.mic);
    } catch (e) {
      notice('Microfone indisponível: abra as Opções e clique em "Permitir microfone". Gravando só o áudio da aba.');
    }
  }
  levelTimer = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'level', tab: level.tab, mic: level.mic }).catch(() => {});
    level.tab *= 0.5;
    level.mic *= 0.5;
  }, 250);
}

function hook(stream, seg) {
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'capture', {
    numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit'
  });
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node);
  node.connect(mute).connect(ctx.destination);
  node.port.onmessage = (e) => seg.push(e.data);
}

async function stop() {
  if (!cfg) return;
  clearInterval(levelTimer);
  Object.values(segs).forEach((s) => s.flush());
  streams.forEach((st) => st.getTracks().forEach((t) => t.stop()));
  streams = [];
  const deadline = Date.now() + 60000;
  while ((queue.length || inflight) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  try { await ctx.close(); } catch {}
  try { await playCtx.close(); } catch {}
  cfg = null;
}

// ---------- voice-activity segmenter ----------

class Segmenter {
  constructor(src, settings, otherActive) {
    this.src = src;
    this.silenceMs = Math.max(300, Number(settings.silenceMs) || 700);
    this.otherActive = otherActive;
    this.samples = 0;
    this.wallBase = Date.now(); // each source counts its own samples from its own start
    this.floor = 0.002;
    this.speech = false;
    this.pre = [];
    this.buf = [];
    this.speechBlocks = 0;
    this.otherBlocks = 0;
    this.rmsSum = 0;
    this.silentMs = 0;
    this.t0 = 0;
  }
  push(block) {
    let sum = 0;
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
    const rms = Math.sqrt(sum / block.length);
    level[this.src] = Math.max(level[this.src], Math.min(1, rms * 8));
    const tBlock = this.wallBase + (this.samples / RATE) * 1000;
    this.samples += block.length;
    const gate = this.src === 'mic' && this.otherActive() ? MIC_BLEED_GATE : 0.006;
    const loud = rms > Math.max(gate, this.floor * 2.5);
    // floor follows the quietest level and creeps up slowly, so steady noise is not "speech" forever
    this.floor = rms < this.floor ? this.floor * 0.9 + rms * 0.1 : Math.min(0.05, this.floor * 1.002);

    if (!this.speech) {
      this.pre.push(block);
      if (this.pre.length > 3) this.pre.shift();
      if (!loud) return;
      this.speech = true;
      this.buf = this.pre.slice();
      this.pre = [];
      this.t0 = tBlock - (this.buf.length - 1) * BLOCK_MS;
      this.speechBlocks = 0;
      this.otherBlocks = 0;
      this.rmsSum = 0;
      this.silentMs = 0;
      this.buf[this.buf.length - 1] = block;
    } else {
      this.buf.push(block);
    }
    if (loud) {
      this.speechBlocks++;
      this.rmsSum += rms;
      this.silentMs = 0;
      if (this.otherActive()) this.otherBlocks++;
    } else {
      this.silentMs += BLOCK_MS;
    }
    const lenMs = this.buf.length * BLOCK_MS;
    if (this.silentMs >= this.silenceMs || lenMs >= MAX_SEG_MS || (lenMs > 14000 && this.silentMs >= 400)) {
      this.cut();
    }
  }
  flush() {
    if (this.speech) this.cut();
  }
  cut() {
    const speechMs = this.speechBlocks * BLOCK_MS;
    const echo = this.speechBlocks && this.otherBlocks / this.speechBlocks >= 0.9;
    const buf = this.buf;
    const t0 = this.t0;
    this.speech = false;
    this.buf = [];
    this.silentMs = 0;
    const mean = this.speechBlocks ? this.rmsSum / this.speechBlocks : 0;
    if (speechMs < MIN_SPEECH_MS || echo || (this.src === 'mic' && mean < MIC_MIN_LEVEL)) return;
    enqueue({ src: this.src, t0, t1: t0 + buf.length * BLOCK_MS, wav: toWav(buf) });
  }
}

function toWav(blocks) {
  const n = blocks.length * BLOCK;
  const out = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); out.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, RATE, true); out.setUint32(28, RATE * 2, true);
  out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  w(36, 'data'); out.setUint32(40, n * 2, true);
  let peak = 0;
  for (const b of blocks) for (let i = 0; i < b.length; i++) peak = Math.max(peak, Math.abs(b[i]));
  const gain = peak > 0 ? Math.min(12, 0.9 / peak) : 1; // quiet mics transcribe much worse
  let o = 44;
  for (const b of blocks) {
    for (let i = 0; i < b.length; i++, o += 2) {
      const v = Math.max(-1, Math.min(1, b[i] * gain));
      out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
  }
  return out.buffer;
}

// ---------- transcription queue ----------

function enqueue(seg) {
  queue.push(seg);
  if (queue.length > 40) { queue.shift(); notice('A OpenAI está lenta: trechos antigos foram descartados.'); }
  pump();
}

function pump() {
  while (inflight < CONCURRENCY && queue.length) {
    const seg = queue.shift();
    inflight++;
    process(seg)
      .catch((e) => notice('Erro de transcrição: ' + (e.message || e)))
      .finally(() => { inflight--; pump(); });
  }
}

async function process(seg) {
  const s = cfg.settings;
  const useDiar = s.diarize && diarizeOk && seg.src === 'tab';
  let data;
  try {
    data = await callOpenAI(seg, useDiar ? 'gpt-4o-transcribe-diarize' : s.model, useDiar);
  } catch (e) {
    if (!useDiar || ![400, 403, 404].includes(e.status)) throw e; // only "model unusable" disables diarization
    diarizeOk = false;
    notice('Diarização OpenAI indisponível (' + e.message + '). Usando só o modelo rápido + nomes da reunião.');
    data = await callOpenAI(seg, s.model, false);
    return emitPlain(seg, data);
  }
  if (useDiar && Array.isArray(data.segments) && data.segments.length) return emitDiarized(seg, data);
  return emitPlain(seg, data);
}

async function callOpenAI(seg, model, diar) {
  const s = cfg.settings;
  const fd = new FormData();
  fd.append('file', new Blob([seg.wav], { type: 'audio/wav' }), 'segment.wav');
  fd.append('model', model);
  if (s.language && s.language !== 'auto') fd.append('language', s.language);
  if (diar) {
    fd.append('response_format', 'diarized_json');
    fd.append('chunking_strategy', 'auto');
  } else {
    fd.append('response_format', 'json');
    fd.append('prompt', promptFor(s));
  }
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + s.apiKey }, body: fd
      });
    } catch (e) {
      if (attempt < 2) { await sleep(800 * (attempt + 1)); continue; }
      throw new Error('rede: ' + e.message);
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(1000 * (attempt + 1)); continue; }
    let msg = res.status + '';
    try { msg = (await res.json()).error.message; } catch {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
}

const LANG_NAME = { pt: 'português do Brasil', en: 'inglês', es: 'espanhol' };
function promptFor(s) {
  const lang = LANG_NAME[s.language] || 'o idioma falado';
  return ('Transcrição fiel de uma reunião de trabalho em ' + lang + ', com termos técnicos de engenharia e telecomunicações. ' +
    'Transcreva exatamente o que foi dito, sem traduzir, resumir ou inventar. ' + (s.vocabulary ? 'Termos: ' + s.vocabulary : '')).trim();
}

// wrong-language output from low quality audio: drop instead of showing nonsense
const PT_W = new Set('de que o a e é não para com um uma os as do da em eu você tá isso mas se por foi vai tem aqui então só muito já como mais está pra né ele ela nós gente'.split(' '));
const EN_W = new Set('the and is to of i you it that in for on with this so can my are was be have we but not what just like'.split(' '));
function wrongLanguage(text) {
  if (cfg.settings.language !== 'pt') return false;
  const w = text.toLowerCase().replace(/[^\p{L}\s']/gu, '').split(/\s+/).filter(Boolean);
  let pt = 0, en = 0;
  for (const x of w) { if (PT_W.has(x)) pt++; else if (EN_W.has(x)) en++; }
  return w.length >= 2 && en > pt;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- speaker resolution ----------

function votes(t0, t1) {
  const m = new Map();
  for (let i = 0; i < timeline.length; i++) {
    const e = timeline[i];
    const end = Math.min(i + 1 < timeline.length ? timeline[i + 1].ts : Infinity, e.ts + HOLD_MS);
    const a = Math.max(e.ts, t0 - LEAD_MS);
    const b = Math.min(end, t1 + LAG_MS);
    if (b > a) for (const n of e.active) m.set(n, (m.get(n) || 0) + (b - a));
  }
  const me = (selfName || '').toLowerCase();
  if (me) for (const k of [...m.keys()]) if (k.toLowerCase() === me) m.delete(k);
  return m;
}

function bestName(t0, t1) {
  const m = votes(t0, t1);
  let best = null, ms = 0;
  for (const [n, v] of m) if (v > ms) { best = n; ms = v; }
  if (best && ms >= Math.min(400, (t1 - t0) * 0.3)) return best;
  const others = participants.filter((p) => p.toLowerCase() !== (selfName || '').toLowerCase());
  return others.length === 1 ? others[0] : 'Participante';
}

const JUNK = /^(obrigad[oa]\.?|tchau\.?|legendas?.*|thanks for watching.*|thank you\.?|subtitles.*|\.+|…)$/i;

function emit(seg, speaker, text, t0, t1) {
  text = (text || '').trim();
  if (!text || (t1 - t0 < 3000 && JUNK.test(text)) || wrongLanguage(text)) return;
  send({
    type: 'line',
    sessionId: cfg.sessionId,
    line: { id: seg.src + '-' + Math.round(t0), ts: Math.round(t0), end: Math.round(t1), speaker, text, src: seg.src }
  });
}

function emitPlain(seg, data) {
  const speaker = seg.src === 'mic' ? selfName || 'Eu' : bestName(seg.t0, seg.t1);
  emit(seg, speaker, data.text, seg.t0, seg.t1);
}

function emitDiarized(seg, data) {
  // map each diarization label (A, B, ...) to the meeting name with most overlap, one name per label
  const byLabel = new Map();
  for (const sg of data.segments) {
    const a = seg.t0 + (sg.start || 0) * 1000;
    const b = seg.t0 + (sg.end || (seg.t1 - seg.t0) / 1000) * 1000;
    const l = byLabel.get(sg.speaker) || { votes: new Map() };
    for (const [n, v] of votes(a, b)) l.votes.set(n, (l.votes.get(n) || 0) + v);
    byLabel.set(sg.speaker, l);
  }
  const pairs = [];
  for (const [label, l] of byLabel) for (const [n, v] of l.votes) pairs.push({ label, n, v });
  pairs.sort((x, y) => y.v - x.v);
  const name = new Map();
  const used = new Set();
  for (const p of pairs) {
    if (name.has(p.label) || used.has(p.n) || p.v < 300) continue;
    name.set(p.label, p.n);
    used.add(p.n);
  }
  const others = participants.filter((p) => p.toLowerCase() !== (selfName || '').toLowerCase());
  for (const sg of data.segments) {
    const a = seg.t0 + (sg.start || 0) * 1000;
    const b = sg.end != null ? seg.t0 + sg.end * 1000 : seg.t1;
    // labels (A, B...) are only meaningful inside one response, so fall back to the timeline vote
    const speaker = name.get(sg.speaker) || bestName(a, b);
    emit(seg, speaker, sg.text, a, Math.max(b, a + 1));
  }
}
