// MeetScribe - Google Meet detector (read-only content script).
// Reports speakers, participants, own name, meeting title and captions to the background.
(() => {
  'use strict';
  if (window.__meetscribe_meet) return;
  window.__meetscribe_meet = true;

  const PLATFORM = 'meet';
  const POLL_MS = 300;
  const HEARTBEAT_MS = 1000;

  // Selectors. Hashed classes are fragile; they are fallbacks behind stable signals.
  const SEL = {
    indicator: '.IisKdb.GF8M7d', // speaking indicator (class toggles when talking)
    silentCls: 'gjg47c', // present on indicator while tile is silent
    tile: '[data-participant-id], [data-requested-participant-id]',
    selfName: '[data-self-name]',
    tileName: '[data-self-name], .notranslate, [jsname="EydYod"], .zWGUib, .XWGOtd',
    peopleList: '[role="list"][aria-label], [role="listbox"][aria-label]',
    listItem: '[role="listitem"]',
    captionRow: '.nMcdL', // hashed fallbacks; structure (first span = name, last child = text) is tried first
    captionName: '.NWpY1d',
    captionText: '.ygicle',
    titleAttr: '[data-meeting-title]:not([data-meeting-title=""])',
    titleAlt: '.Jyj1Td',
  };

  // Suffixes appended to display names: "(You)", "(Você)", "(Presenting)", "(Host)", "(Organizador)"...
  const SUFFIX_RE = /\s*[(（]\s*(you|voc[eê]|tu|t[uú]|vous|du|presenting|apresentando|presentando|host|organizador(?:a)?|anfitri[oó]n|anfitri[aã]o|organizer|co-?host|co-?organizador(?:a)?|moderator|moderador(?:a)?|guest|convidado)\s*[)）]\s*$/i;
  const NOISE = /^(you|voc[eê]|tu|t[uú]|presentation|apresenta[cç][aã]o|unknown|desconhecido|meeting|reuni[aã]o)$/i;

  let dead = false;
  let observer = null;
  let pollTimer = null;
  let heartbeatTimer = null;

  const state = {
    speakers: '[]',
    participants: '',
    title: null,
    sent: new WeakMap(), // caption row element -> last text sent
    ccOn: null,
    lastActive: [],
  };

  function normalize(raw) {
    if (typeof raw !== 'string') return '';
    let s = raw.replace(/\s+/g, ' ').trim();
    for (let i = 0; i < 3; i++) {
      const next = s.replace(SUFFIX_RE, '').trim();
      if (next === s) break;
      s = next;
    }
    return s;
  }

  function valid(name) {
    return !!name && name.length <= 120 && !NOISE.test(name);
  }

  function uniq(list) {
    const seen = new Set();
    const out = [];
    for (const n of list) {
      if (valid(n) && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
    return out;
  }

  function teardown() {
    dead = true;
    try { observer && observer.disconnect(); } catch (_) { /* ignore */ }
    observer = null;
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
  }

  function send(msg) {
    if (dead) return;
    try {
      if (!chrome.runtime || !chrome.runtime.id) { teardown(); return; }
      const p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') {
        p.catch((e) => { if (/invalidated/i.test(String(e && e.message))) teardown(); });
      }
    } catch (e) {
      // "Extension context invalidated" -> stop everything.
      teardown();
    }
  }

  // ---- own name -----------------------------------------------------------
  let selfCache = { at: 0, name: null };
  function getSelf() {
    if (selfCache.name && Date.now() - selfCache.at < 10000) return selfCache.name;
    const n = findSelf();
    selfCache = { at: Date.now(), name: n };
    return n;
  }
  function findSelf() {
    const el = document.querySelector(SEL.selfName);
    if (el) {
      const n = normalize(el.getAttribute('data-self-name') || el.textContent || '');
      if (valid(n)) return n;
    }
    // Fallback: label ending with a "(You)"-like suffix.
    const SELF_RE = /[(（]\s*(you|voc[eê]|tu|t[uú]|vous|du)\s*[)）]\s*$/i;
    for (const e of document.querySelectorAll('[aria-label], .notranslate')) {
      const t = (e.getAttribute('aria-label') || e.textContent || '').trim();
      if (!SELF_RE.test(t)) continue;
      const n = normalize(t);
      if (valid(n)) return n;
    }
    return null;
  }

  // ---- participants -------------------------------------------------------
  function tileName(tile) {
    const self = tile.matches(SEL.selfName) ? tile : tile.querySelector(SEL.selfName);
    if (self) {
      const n = normalize(self.getAttribute('data-self-name') || '');
      if (valid(n)) return n;
    }
    for (const el of tile.querySelectorAll(SEL.tileName)) {
      const n = normalize(el.textContent || '');
      if (valid(n)) return n;
    }
    const al = tile.getAttribute('aria-label');
    if (al) {
      const n = normalize(al);
      if (valid(n)) return n;
    }
    return '';
  }

  function getParticipants() {
    const names = [];
    // 1) People panel list (works even when tiles are paginated away).
    document.querySelectorAll(SEL.peopleList).forEach((list) => {
      if (!/particip|pessoa|people|persona|teilnehmer|membres/i.test(list.getAttribute('aria-label') || '')) return;
      list.querySelectorAll(SEL.listItem).forEach((li) => {
        const lbl = li.getAttribute('aria-label');
        let n = lbl ? normalize(lbl) : '';
        if (!valid(n)) {
          const nn = li.querySelector('.notranslate, [jsname="EydYod"]');
          n = nn ? normalize(nn.textContent || '') : '';
        }
        if (n) names.push(n);
      });
    });
    // 2) Video tiles.
    document.querySelectorAll(SEL.tile).forEach((t) => {
      const n = tileName(t);
      if (n) names.push(n);
    });
    return uniq(names);
  }

  // ---- speakers -----------------------------------------------------------
  function isSpeaking(ind) {
    return !ind.classList.contains(SEL.silentCls);
  }

  function getSpeakers() {
    const out = [];
    document.querySelectorAll(SEL.indicator).forEach((ind) => {
      if (!isSpeaking(ind)) return;
      const tile = ind.closest(SEL.tile);
      let n = tile ? tileName(tile) : '';
      if (!n) {
        // Climb until some ancestor yields a name.
        let p = ind.parentElement;
        for (let i = 0; i < 6 && p && !n; i++, p = p.parentElement) n = tileName(p);
      }
      if (n) out.push(n);
    });
    return uniq(out).sort();
  }

  // ---- title --------------------------------------------------------------
  const GENERIC_TITLES = /^(meet|meeting details|detalhes da reuni[aã]o|detalles de la reuni[oó]n|besprechungsdetails|d[eé]tails de la r[eé]union)$/i;

  function getTitle() {
    let t =
      (document.querySelector(SEL.titleAttr + ' [role="tooltip"]') || {}).textContent ||
      (document.querySelector(SEL.titleAttr) || { getAttribute: () => '' }).getAttribute('data-meeting-title') ||
      (document.querySelector(SEL.titleAlt) || {}).textContent ||
      document.title.replace(/^Meet\s*[-–:]\s*/, '').replace(/\s*[-–]\s*Google Meet$/, '');
    t = (t || '').replace(/\s+/g, ' ').trim();
    if (!t || GENERIC_TITLES.test(t)) return null;
    return t;
  }

  // ---- captions -------------------------------------------------------------
  // Meet renders live captions in <div role="region" aria-label="Captions">: one child row per speaker
  // turn (avatar + name + text). Rows grow in place and Meet may revise earlier words, so every change
  // is sent with a stable row id and the receiver overwrites. (Evidence: .local/handoffs/ms-cc-meet-out.md)
  const CAPTION_LABEL = /caption|legenda|subt[ií]tulo|sous-titre|untertitel|sottotitoli|ondertiteling|napisy|субтитр|字幕|자막/i;
  const rowIds = new WeakMap();
  let rowSeq = 0;
  const squash = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function findRegion() {
    for (const el of document.querySelectorAll('[role="region"][aria-label]')) {
      if (CAPTION_LABEL.test(el.getAttribute('aria-label')) && !el.closest('[role="dialog"]')) return el;
    }
    return null;
  }

  function readRow(row) {
    if (row.querySelector('button, [role="button"]')) return null; // "jump to latest" control, not speech
    const nameEl = row.querySelector(SEL.captionName) || row.querySelector('span') || row.firstElementChild;
    const textEl = row.querySelector(SEL.captionText) || row.lastElementChild;
    if (!nameEl || !textEl || textEl.contains(nameEl)) return null;
    const speaker = squash(nameEl.textContent);
    const text = squash(textEl.textContent);
    return speaker && text ? { speaker, text } : null;
  }

  function captionRows(region) {
    const parse = (els) => els.flatMap((el) => { const r = readRow(el); return r ? [{ ...r, el }] : []; });
    let out = parse([...region.children]);
    if (!out.length && region.children.length === 1) out = parse([...region.children[0].children]); // scroller wrapper
    if (!out.length) out = parse([...region.querySelectorAll(SEL.captionRow)]);
    return out;
  }

  // CC toolbar toggle: icon text "closed_caption" = on, "closed_caption_off" = off (not inside dialogs/tabs).
  function findToggle() {
    for (const icon of document.querySelectorAll('button i.google-symbols, button i.google-material-icons')) {
      const glyph = squash(icon.textContent);
      if (!glyph.startsWith('closed_caption')) continue;
      const button = icon.closest('button');
      if (button && !button.closest('[role="dialog"], [role="tab"]')) return { button, on: glyph === 'closed_caption' };
    }
    return null;
  }

  function scanCaptions() {
    const region = findRegion();
    const toggle = findToggle();
    // The region only exists once someone has spoken, so "no region" alone does not mean captions are off.
    const on = region ? true : toggle ? toggle.on : null;
    if (on !== null && on !== state.ccOn) {
      state.ccOn = on;
      send({ type: 'ccstate', platform: PLATFORM, on, ts: Date.now() });
    }
    if (!region) return;
    for (const r of captionRows(region)) {
      if (state.sent.get(r.el) === r.text) continue;
      state.sent.set(r.el, r.text);
      let id = rowIds.get(r.el);
      if (!id) rowIds.set(r.el, (id = 'm' + ++rowSeq));
      send({ type: 'caption', platform: PLATFORM, speaker: r.speaker, text: r.text, rowId: id, ts: Date.now() });
    }
  }

  // Turn captions on by clicking the toolbar toggle (never when it already reads ON: that would turn them off).
  let enabling = null;
  function enableCaptions() {
    if (enabling) return;
    let tries = 0;
    enabling = setInterval(() => {
      const t = findToggle();
      if ((t && t.on) || state.ccOn === true || ++tries > 15 || dead) { clearInterval(enabling); enabling = null; return; }
      if (t) t.button.click();
    }, 2500);
  }

  // ---- main tick ----------------------------------------------------------
  // Idle until the background activates us (recording on this tab): no observers, no polling, no scraping.
  let active = false;
  let heavy = false; // audio mode also needs per-tile speaker detection
  let slowAt = 0;

  function tick() {
    if (dead || !active) return;
    try {
      const now = Date.now();
      if (heavy) {
        const speakers = getSpeakers();
        const key = JSON.stringify(speakers);
        if (key !== state.speakers) {
          state.speakers = key;
          state.lastActive = speakers;
          send({ type: 'speakers', platform: PLATFORM, active: speakers, ts: now });
        }
      }
      // names, own name and title change rarely: check at most every 1.5 s
      if (heavy || now - slowAt > 1500) {
        slowAt = now;
        const names = getParticipants();
        const self = getSelf();
        const pkey = JSON.stringify([names, self]);
        if (pkey !== state.participants) {
          state.participants = pkey;
          send({ type: 'participants', platform: PLATFORM, names, self, ts: now });
        }
        const title = getTitle();
        if (title && title !== state.title) {
          state.title = title;
          send({ type: 'meeting', platform: PLATFORM, title, url: location.href, ts: now });
        }
      }
      scanCaptions();
    } catch (_) {
      // DOM shape surprises must never kill the loop.
    }
  }

  function activate(mode) {
    heavy = mode === 'audio';
    state.sent = new WeakMap(); // re-send what is on screen
    state.ccOn = null;
    state.participants = '';
    state.title = null;
    if (active) { tick(); return; }
    active = true;
    let scheduled = false;
    observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => { scheduled = false; tick(); }, 150);
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    pollTimer = setInterval(tick, POLL_MS);
    heartbeatTimer = setInterval(() => {
      if (dead || !heavy || !state.lastActive.length) return;
      send({ type: 'speakers', platform: PLATFORM, active: state.lastActive, ts: Date.now() });
    }, HEARTBEAT_MS);
    tick();
  }

  function deactivate() {
    active = false;
    try { observer && observer.disconnect(); } catch (_) { /* ignore */ }
    observer = null;
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    clearInterval(enabling);
    enabling = null;
  }

  // ---- wiring -------------------------------------------------------------
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id || !msg) return false; // only our own extension
      if (msg.type === 'ping') sendResponse({ ok: true, platform: PLATFORM });
      else if (msg.type === 'activate') activate(msg.mode);
      else if (msg.type === 'deactivate') deactivate();
      else if (msg.type === 'enable-captions') enableCaptions();
      return false;
    });
    // page reloaded while recording: ask whether this tab is being recorded
    chrome.runtime.sendMessage({ type: 'hello' }).then((r) => { if (r && r.active) activate(r.mode); }).catch(() => {});
  } catch (_) {
    teardown();
  }
})();
