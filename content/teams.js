// MeetScribe - Microsoft Teams (web v2, teams.live.com, teams.cloud.microsoft) detector.
// Read-only content script. Reports speakers, participants, self, meeting title, captions.
(function () {
  'use strict';
  if (window.__meetscribe_teams) return;
  window.__meetscribe_teams = true;

  var PLATFORM = 'teams';
  var POLL_MS = 300;
  var HEARTBEAT_MS = 1000;
  var dead = false;
  var observer = null;
  var pollTimer = null;

  // ---------- messaging ----------
  function stop() {
    dead = true;
    try { if (observer) observer.disconnect(); } catch (e) {}
    if (pollTimer) clearInterval(pollTimer);
  }
  function send(msg) {
    if (dead) return;
    try {
      if (!chrome.runtime || !chrome.runtime.id) { stop(); return; }
      var p = chrome.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(function (e) { if (/context invalidated/i.test(String(e && e.message))) stop(); });
    } catch (e) {
      if (/context invalidated/i.test(String(e && e.message))) stop();
    }
  }

  // ---------- helpers ----------
  var SUFFIX_RE = /\s*[\(\[]\s*(you|voc[eê]|presenting|apresentando|host|organizador|organizer|guest|convidado|external|externo|unverified|n[aã]o verificado|muted|mutado|sem [aá]udio)[^\)\]]*[\)\]]\s*/gi;

  function clean(name) {
    if (!name) return '';
    var n = String(name).replace(/[​-‏‪-‮⁦-⁩﻿]/g, '').replace(SUFFIX_RE, ' ');
    // "Ana Souza, Muted" / "Ana Souza - Unmuted" style aria-labels
    n = n.split(/\s*[,–—]\s*(?:muted|unmuted|mutado|desmutado|microphone|microfone|video|v[ií]deo|pinned|fixado|raised hand|m[aã]o levantada|speaking|falando)/i)[0];
    return n.replace(/\s+/g, ' ').trim();
  }
  function dedupe(list) {
    var seen = Object.create(null), out = [];
    for (var i = 0; i < list.length; i++) {
      var n = clean(list[i]);
      if (!n || n.length > 120) continue;
      var k = n.toLowerCase();
      if (!seen[k]) { seen[k] = 1; out.push(n); }
    }
    return out;
  }
  function $(sel, root) { try { return (root || document).querySelector(sel); } catch (e) { return null; } }
  function $$(sel, root) { try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); } catch (e) { return []; } }
  function txt(el) { return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
  function sameArr(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function inCall() {
    return !!(
      $('[data-tid="calling-roster-button"], [data-tid="toggle-mute"], [data-tid="hangup-button"], #hangup-button, [data-tid="call-control-bar"], #roster-button, [data-tid="calling-unified-bar"]') ||
      $('[data-tid="closed-captions-renderer"], [data-tid="closed-caption-renderer-wrapper"]') ||
      $('[data-tid^="calling-participant-stream"], [data-tid="video-tile"], [data-tid="voice-level-stream-outline"]')
    );
  }

  // ---------- tile name extraction ----------
  function tileName(tile) {
    var el = tile.querySelector('[data-tid="display-name"], [data-tid="participant-name"], [data-tid="tile-name"], [class*="displayName"], [class*="display-name"]');
    var n = txt(el);
    if (n) return n;
    var lab = tile.getAttribute('aria-label') || '';
    if (!lab) { var l = tile.querySelector('[aria-label]'); lab = l ? l.getAttribute('aria-label') : ''; }
    if (lab) return lab;
    return '';
  }
  function tileOf(el) {
    return el.closest('[data-tid^="calling-participant-stream"], [data-tid="video-tile"], [data-tid^="participant-"], [role="listitem"], [data-stream-type], [data-cid*="tile"], [class*="video-tile"], [class*="participant"]') || el.parentElement;
  }

  // ---------- speakers ----------
  function isSpeakingOutline(el) {
    // Teams toggles the voice-level outline: visible/active only while speaking.
    var cs; try { cs = getComputedStyle(el); } catch (e) { return false; }
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    var cls = String((el.className && el.className.baseVal !== undefined) ? el.className.baseVal : el.className || '');
    if (/speaking|talking|vdi-frame-occlusion/i.test(cls)) return true;
    if (el.getAttribute('data-speaking') === 'true' || el.getAttribute('aria-hidden') === 'false') return true;
    var op = parseFloat(cs.opacity);
    if (!isNaN(op) && op > 0.05 && (parseFloat(cs.borderTopWidth) > 1 || cs.outlineStyle !== 'none' || /rgb/.test(cs.boxShadow || ''))) return true;
    return false;
  }
  function detectSpeakers() {
    var names = [];
    // Strategy 1: voice-level outline inside stage tiles
    var outlines = $$('[data-tid="voice-level-stream-outline"], [data-tid*="voice-level"], [data-tid*="speaking-indicator"]');
    var hot = outlines.filter(isSpeakingOutline);
    // 3+ outlines all "active" means the style heuristic is not discriminating (static border): ignore it
    if (!(outlines.length >= 3 && hot.length === outlines.length)) {
      hot.forEach(function (o) { var t = tileOf(o); if (t) names.push(tileName(t)); });
    }
    // Strategy 2: tiles flagged speaking via attribute/class
    $$('[data-tid^="calling-participant-stream"][data-is-speaking="true"], [data-tid="video-tile"][data-speaking="true"], [data-is-speaking="true"]').forEach(function (t) {
      names.push(tileName(t) || (t.getAttribute('aria-label') || '').replace(/\s+(is speaking|est[aá] falando).*$/i, ''));
    });
    // Strategy 3: roster rows with the speaking waveform icon
    $$('[data-tid^="participantsInCall"], [data-tid="roster-participant"], [role="listitem"][data-tid*="participant"]').forEach(function (row) {
      var w = row.querySelector('[data-tid*="speaking"], [data-tid*="voice-level"], [class*="speaking"]');
      if (w && isSpeakingOutline(w)) names.push(rosterName(row));
    });
    // Strategy 4: caption author shown within the last 2 s (set by caption watcher)
    if (!names.length && Date.now() - lastCaptionTs < 2000 && lastCaptionSpeaker) names.push(lastCaptionSpeaker);
    return dedupe(names).sort();
  }

  // ---------- participants ----------
  function rosterName(row) {
    var el = row.querySelector('[data-tid="participant-name"], [data-tid="display-name"], [class*="displayName"], [class*="display-name"]');
    var n = txt(el);
    if (n) return n;
    var lab = row.getAttribute('aria-label') || '';
    if (lab) return lab;
    return txt(row).split(/\s{2,}/)[0];
  }
  function detectParticipants() {
    var names = [];
    $$('[data-tid^="participantsInCall"] , [data-tid="roster-participant"], [data-tid^="roster-participant"], [role="listitem"][data-tid*="participant"], #roster-list [role="treeitem"], [data-tid="roster-list"] [role="listitem"]').forEach(function (r) {
      names.push(rosterName(r));
    });
    // Fallback: stage tiles only show part of the roster, so keep names already seen this call
    if (!names.length) {
      $$('[data-tid^="calling-participant-stream"], [data-tid="video-tile"]').forEach(function (t) { names.push(tileName(t)); });
      names = last.names.concat(names);
    }
    return dedupe(names);
  }
  function detectSelf() {
    var el = $('[data-tid="me-control-avatar"], [data-tid="me-control"] button, #me-control-avatar, button[data-tid="me-control-avatar-trigger"]');
    var lab = el ? (el.getAttribute('aria-label') || el.getAttribute('title') || '') : '';
    if (lab) {
      var m = lab.match(/^(?:profile|perfil|your profile|seu perfil)[^,:\-]*[,:\-]\s*(.+?)(?:[,\.]|$)/i);
      var n = clean(m ? m[1] : lab);
      if (n && !/^(profile|perfil)$/i.test(n)) return n;
    }
    // roster row marked "(You)" / "(Você)"
    var rows = $$('[data-tid^="participantsInCall"], [data-tid="roster-participant"], [role="listitem"][data-tid*="participant"]');
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i].getAttribute('aria-label') || txt(rows[i]);
      if (/\((you|voc[eê])\)/i.test(t)) return clean(rosterName(rows[i]));
    }
    // stage tile of the local user: "Name (You)" / "Nome (Você)"
    var tiles = $$('[data-tid^="calling-participant-stream"], [data-tid="video-tile"], [data-tid^="participant-"]');
    for (var j = 0; j < tiles.length; j++) {
      var tl = tileName(tiles[j]);
      if (/\((you|voc[eê])\)/i.test(tl)) return clean(tl) || null;
    }
    var img = $('[data-tid="me-control-avatar"] img[alt], #me-control-avatar img[alt]');
    if (img && img.alt) return clean(img.alt) || null;
    return null;
  }

  // ---------- meeting title ----------
  function detectTitle() {
    var el = $('[data-tid="call-title"], [data-tid="meeting-title"], [data-tid="calling-meeting-title"], [data-tid="call-header-title"], [data-tid="meetup-title"]');
    var t = txt(el);
    if (!t) {
      t = (document.title || '').replace(/\s*\|\s*Microsoft Teams.*$/i, '').replace(/^\(\d+\)\s*/, '').replace(/^Microsoft Teams$/i, '').trim();
      // title is often "Chat | Name" or "Calendar"; keep only when it looks like a meeting
      if (/^(chat|calendar|calend[aá]rio|activity|atividade|teams|communities|comunidades|calls|chamadas)\b/i.test(t)) t = '';
    }
    return t.replace(/\s+/g, ' ').trim();
  }

  // ---------- captions ----------
  // Rows are Fluent "compact chat message" nodes: [data-tid="author"] + [data-tid="closed-caption-text"].
  // Rows grow in place and may be revised, so each change is sent with a stable row id; the receiver overwrites.
  // (Evidence: .local/handoffs/ms-cc-teams-out.md)
  var CC_CONTAINERS = [
    '[data-tid="closed-caption-renderer-wrapper"]',
    '[data-tid="closed-caption-v2-window-wrapper"]',
    '[data-tid="closed-captions-renderer"]',
    '[data-tid="closed-caption-v2-virtual-list-content"]'
  ];
  var CC_ROWS = '.fui-ChatMessageCompact, [data-tid="closed-caption-chat-message"], [data-tid="closed-caption-item"]';
  var CC_AUTHOR = '[data-tid="author"], .ui-chat__message__author';
  var CC_TEXT = '[data-tid="closed-caption-text"]';
  var CC_TOGGLE = '[id="closed-captions-button"][data-tid^="closed-captions-button-"]';
  var rowIds = new WeakMap(), rowSeq = 0, sentText = new WeakMap(), ccOn = null;
  var lastCaptionTs = 0, lastCaptionSpeaker = '';

  function ccContainer() {
    for (var i = 0; i < CC_CONTAINERS.length; i++) { var el = $(CC_CONTAINERS[i]); if (el) return el; }
    return null;
  }
  function ccToggleOn() {
    var tg = $(CC_TOGGLE);
    if (!tg) return null;
    return tg.getAttribute('data-tid') === 'closed-captions-button-on' || tg.getAttribute('aria-checked') === 'true' || tg.getAttribute('aria-pressed') === 'true';
  }
  function detectCaptions() {
    var root = ccContainer();
    var on = root ? true : ccToggleOn();
    if (on !== null && on !== ccOn) { ccOn = on; send({ type: 'ccstate', platform: PLATFORM, on: on, ts: Date.now() }); }
    if (!root) return;
    $$(CC_ROWS, root).forEach(function (row) {
      var a = row.querySelector(CC_AUTHOR), c = row.querySelector(CC_TEXT);
      var text = txt(c);
      if (!text) return;
      var author = txt(a);
      var speaker = clean(author) || author || 'Participante';
      if (sentText.get(row) === text) return;
      sentText.set(row, text);
      var id = rowIds.get(row);
      if (!id) { var av = row.querySelector('span[id^="avatar-"]'); id = (av && av.id) || ('t' + (++rowSeq)); rowIds.set(row, id); }
      lastCaptionTs = Date.now(); lastCaptionSpeaker = speaker;
      send({ type: 'caption', platform: PLATFORM, speaker: speaker, text: text, rowId: id, ts: Date.now() });
    });
  }
  // Click the CC toggle (in the toolbar, else under "More") unless it already reads ON.
  var enabling = null;
  function enableCaptions() {
    if (enabling) return;
    var tries = 0;
    enabling = setInterval(function () {
      if (dead || ccOn === true || ++tries > 12) { clearInterval(enabling); enabling = null; return; }
      var tg = $(CC_TOGGLE);
      if (tg && ccToggleOn() === false) { tg.click(); return; }
      if (!tg) {
        var more = $('button[data-tid="more-button"], button[id="callingButtons-showMoreBtn"]');
        if (more && more.getAttribute('aria-expanded') !== 'true') { more.click(); }
        else if (more) { var item = $(CC_TOGGLE); if (item) item.click(); more.click(); }
      }
    }, 3000);
  }

  // ---------- main tick ----------
  // Idle until the background activates us (recording on this tab).
  var active = false, heavy = false, slowAt = 0;
  var last = { speakers: [], names: [], self: undefined, title: '' };
  var lastSent = 0;

  function tick() {
    if (dead || !active) return;
    try {
      var now = Date.now();
      if (!inCall()) {
        if (last.speakers.length) { last.speakers = []; send({ type: 'speakers', platform: PLATFORM, active: [], ts: now }); }
        last.names = []; last.self = undefined; last.title = ''; // next call re-reports everything
        detectCaptions();
        return;
      }
      if (heavy) {
        var sp = detectSpeakers();
        var changed = !sameArr(sp, last.speakers);
        if (changed || (sp.length && now - lastSent >= HEARTBEAT_MS)) {
          last.speakers = sp; lastSent = now;
          send({ type: 'speakers', platform: PLATFORM, active: sp, ts: now });
        }
      }
      if (heavy || now - slowAt > 1500) {
        slowAt = now;
        var names = detectParticipants();
        var self = detectSelf();
        if (self && names.map(function (n) { return n.toLowerCase(); }).indexOf(self.toLowerCase()) < 0) names.push(self);
        var key = names.slice().sort();
        if (!sameArr(key, last.names.slice().sort()) || self !== last.self) {
          if (names.length || self) {
            last.names = names; last.self = self;
            send({ type: 'participants', platform: PLATFORM, names: names, self: self || null, ts: now });
          }
        }
        var title = detectTitle();
        if (title && title !== last.title) {
          last.title = title;
          send({ type: 'meeting', platform: PLATFORM, title: title, url: location.href, ts: now });
        }
      }
      detectCaptions();
    } catch (e) { /* never break the page */ }
  }

  var scheduled = false;
  function schedule() {
    if (scheduled || dead) return;
    scheduled = true;
    setTimeout(function () { scheduled = false; tick(); }, 150);
  }
  var heartbeatTimer = null;
  function activate(mode) {
    heavy = mode === 'audio';
    sentText = new WeakMap(); ccOn = null; last.names = []; last.title = '';
    if (active) { tick(); return; }
    active = true;
    try {
      observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    } catch (e) {}
    pollTimer = setInterval(tick, POLL_MS);
    tick();
  }
  function deactivate() {
    active = false;
    try { if (observer) observer.disconnect(); } catch (e) {}
    observer = null;
    if (pollTimer) clearInterval(pollTimer);
    if (enabling) { clearInterval(enabling); enabling = null; }
  }

  try {
    chrome.runtime.onMessage.addListener(function (m, sender, sendResponse) {
      if (!m || sender.id !== chrome.runtime.id) return;
      if (m.type === 'ping') sendResponse({ ok: true, platform: PLATFORM });
      else if (m.type === 'activate') activate(m.mode);
      else if (m.type === 'deactivate') deactivate();
      else if (m.type === 'enable-captions') enableCaptions();
    });
    chrome.runtime.sendMessage({ type: 'hello' }).then(function (r) { if (r && r.active) activate(r.mode); }).catch(function () {});
  } catch (e) { stop(); }
})();
