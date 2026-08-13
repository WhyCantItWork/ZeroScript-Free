// SPDX-License-Identifier: GPL-3.0-or-later
// providers/useai.js - the use.ai provider.
// Exports the same ZSProvider interface as providers/deepseek.js, kimi.js and
// the other site providers; the core (core/main.js) is provider-agnostic.
// To DISABLE use.ai support, remove this file from manifest.json.
//
// use.ai DOM notes (validated from user-supplied DevTools captures, 2026-08):
//  - Messages expose stable test ids: user turns are `[data-testid="message-user"]`
//    and assistant turns are `[data-testid="message-assistant"]`. The readable
//    turn body lives in a descendant `[data-testid="message-content"]`.
//  - The composer is a REAL <textarea> (`[data-testid="chat-input-textarea"]`),
//    not a contenteditable. The site renders TWO composer instances (a hidden
//    mobile one + the visible desktop one), so composer selectors all match
//    twice - every composer lookup filters to visible nodes and the send button
//    is paired to the editor through their shared container.
//  - Text goes in via execCommand("insertText") (drives the site's real input
//    pipeline, which is what enables the send button); a native-setter +
//    synthetic input event is the fallback.
//  - The primary send control is a real <button data-testid="send-button">`.
//    While the reply is streaming, it is replaced by a real
//    `<button data-testid="stop-button" aria-label="Stop">`, and the UI also
//    shows a spinner/status node `[aria-label="Reply in progress"][role="status"]`.
//    Either signal means the assistant is still generating.
//  - Conversation URLs are `https://use.ai/<uuid>`. A fresh chat with no stable
//    id should yield an empty conversationKey so the core does not persist it as
//    already started.
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {};

  const S = {
    userItem: '[data-testid="message-user"]',
    assistantItem: '[data-testid="message-assistant"]',
    anyItem: '[data-testid="message-user"], [data-testid="message-assistant"]',
    body: '[data-testid="message-content"]',
    editor: 'textarea[data-testid="chat-input-textarea"]',
    sendBtn: 'button[data-testid="send-button"]',
    stopBtn: 'button[data-testid="stop-button"]',
    generating: '[aria-label="Reply in progress"][role="status"]',
    errorSurfaces: '[role="alert"],[class*="toast"],[class*="error"],[class*="alert"],[class*="notification"]',
  };

  const RE = {
    contextLimit: new RegExp(
      [
        'conversation.{0,20}(too long|length|limit)',
        'context.{0,20}(too long|limit|window|length|exceeded)',
        'please.{0,30}start.{0,20}new.{0,20}chat',
        '(token|context).{0,10}limit',
        'maximum.{0,20}context',
      ].join('|'),
      'i'
    ),
    tooLong: /conversation .{0,20}(too long|getting too long)|context .{0,15}(length|window|limit)/i,
    busy: /something went wrong|please try again|server is busy|rate.?limit|too many requests|temporarily unavailable/i,
    halted: /\b(stopped|cancelled|canceled|interrupted)\b/i,
    continueBtn: /^(continue|continue generating)$/i,
  };

  const timings = {
    GEN_IDLE_MS: 1500,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  const isUserItem = (item) => !!item && item.matches && item.matches(S.userItem);
  const isAssistantItem = (item) => !!item && item.matches && item.matches(S.assistantItem);

  function textWithout(root, excludeSel) {
    if (!root) return '';
    const skip = '.zs-chip' + (excludeSel ? ', ' + excludeSel : '');
    let t = '';
    const walk = (n) => {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (n.matches && n.matches(skip)) return;
      for (const c of n.childNodes) walk(c);
    };
    walk(root);
    return t;
  }

  const bodyEl = (item) =>
    item ? item.querySelector(S.body) || item : null;

  function itemText(item) {
    if (!item) return '';
    return textWithout(bodyEl(item) || item);
  }

  function classifyText(item, excludeSel) {
    return textWithout(bodyEl(item) || item, excludeSel);
  }

  const allItems = () => [...document.querySelectorAll(S.anyItem)];
  const assistantItems = () => [...document.querySelectorAll(S.assistantItem)];
  const assistantCount = () => assistantItems().length;
  const userCount = () => document.querySelectorAll(S.userItem).length;

  // use.ai renders TWO composer instances (a hidden mobile one + the visible
  // desktop one), so every composer selector matches twice. Filter to VISIBLE
  // nodes and pair the editor with the send button through their shared
  // container - picking the last textarea but the first button on the page
  // mismatched the pair, and the send button never enabled ("use.ai send
  // button did not enable", seen live).
  const visible = (el) => !!el && el.offsetParent !== null;

  const getEditor = () => {
    const site = [...document.querySelectorAll(S.editor)].filter(
      (e) => !e.closest('#zs-root')
    );
    const vis = site.filter(visible);
    const pool = vis.length ? vis : site;
    return pool[pool.length - 1] || null;
  };

  // The nearest ancestor holding BOTH the editor and a send/stop control -
  // that pairing is what makes the two composer copies distinguishable.
  const composerRoot = () => {
    const ed = getEditor();
    if (!ed) return document;
    let n = ed.parentElement;
    while (n && n !== document.body) {
      if (n.querySelector(S.sendBtn) || n.querySelector(S.stopBtn)) return n;
      n = n.parentElement;
    }
    return document;
  };

  const editorText = () => {
    const e = getEditor();
    return e ? e.value || '' : '';
  };

  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };

  function itemKey(item) {
    if (!item) return null;
    return item.id || item.getAttribute('data-message-id') || item.getAttribute('data-testid') + ':' + itemText(item).slice(0, 120);
  }

  function lastAssistantId() {
    return itemKey(lastAssistant());
  }

  const chatIsEmpty = () => allItems().length === 0;

  const isFreshChat = () => {
    const p = location.pathname || '';
    return chatIsEmpty() && (!p || p === '/' || !/^\/[0-9a-f-]{8,}$/i.test(p)) && !!getEditor();
  };

  const composerFrame = () => {
    const ed = getEditor();
    return (ed && (ed.closest('.chat-input-selection-zone') || ed.closest('form') || ed.parentElement)) || null;
  };

  const gateTarget = () => {
    const ed = getEditor();
    return (ed && (ed.closest('.chat-input-selection-zone') || ed.closest('.flex') || ed.parentElement)) || composerFrame();
  };

  function barAnchor() {
    const ed = getEditor();
    return (ed && (ed.closest('.chat-input-selection-zone') || ed.closest('.flex.flex-col') || ed.parentElement)) || null;
  }

  function chipAnchor(item) {
    return bodyEl(item) || item;
  }

  function chipTrailRef() { return null; }

  const LOCK_MSG = '⏳ Agent working... please wait';
  let _locked = false;
  let _origPlaceholder = null;

  function setInputLock(on) {
    _locked = on;
    const ed = getEditor();
    if (!ed) return;
    if (on) {
      if (_origPlaceholder == null) _origPlaceholder = ed.getAttribute('placeholder') || '';
      ed.setAttribute('readonly', 'true');
      ed.setAttribute('data-zs-locked', '1');
      try { ed.setAttribute('placeholder', LOCK_MSG); } catch {}
    } else {
      ed.removeAttribute('readonly');
      ed.removeAttribute('data-zs-locked');
      try { ed.setAttribute('placeholder', _origPlaceholder || ''); } catch {}
    }
  }

  const sendControl = () => {
    const root = composerRoot();
    const btns = [...root.querySelectorAll(S.sendBtn)].filter(visible);
    if (btns.length) return btns[0];
    return [...document.querySelectorAll(S.sendBtn)].filter(visible)[0] || null;
  };

  const stopButton = () => {
    const root = composerRoot();
    const btns = [...root.querySelectorAll(S.stopBtn)].filter(visible);
    if (btns.length) return btns[0];
    return [...document.querySelectorAll(S.stopBtn)].filter(visible)[0] || null;
  };

  function streamText(item) {
    const md = bodyEl(item || lastAssistant());
    return md ? textWithout(md, '.zs-chip') : '';
  }

  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;

  function sampleStream() {
    const item = lastAssistant();
    const len = streamText(item).length;
    return { item, len };
  }

  function grewWithin(ms) {
    const a = sampleStream();
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const b = sampleStream();
      if ((b.len || 0) > (a.len || 0)) return true;
    }
    return false;
  }

  function isGenerating() {
    if (document.querySelector(S.generating)) return true;
    if (stopButton()) return true;
    return false;
  }

  const isBusyNow = isGenerating;
  const isHardGenerating = () => !!stopButton();

  function genDebug() {
    try {
      return {
        spinner: !!document.querySelector(S.generating),
        stopBtn: !!stopButton(),
        sendBtn: !!sendControl(),
        len: streamLen(),
        gen: isGenerating(),
      };
    } catch (e) {
      return { err: String(e && e.message || e) };
    }
  }

  function snapshot() {
    try {
      const item = lastAssistant();
      const md = bodyEl(item);
      return {
        present: !!item,
        len: md ? textWithout(md).trim().length : 0,
      };
    } catch {
      return {};
    }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: '', thinking: '', item: null };
    const md = bodyEl(item);
    return {
      present: true,
      reply: md ? textWithout(md).trim() : '',
      thinking: '',
      item,
    };
  }

  function setTextareaValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  async function typeAndSend(text, images) {
    const ed = getEditor();
    if (!ed) throw new Error('use.ai input box not found');
    if (images && images.length) {
      throw new Error('use.ai image attachment support is not wired yet');
    }
    const relock = _locked;
    try {
      if (relock) ed.removeAttribute('readonly');
      ed.focus();
      // Prefer execCommand insertion: it walks the site's real input pipeline
      // (beforeinput/input), which is what enables the send button. A bare
      // value-set + synthetic input event can be ignored by the framework.
      ed.select();
      let ok = false;
      try { ok = document.execCommand('insertText', false, text); } catch {}
      if (!ok || (ed.value || '') !== text) {
        setTextareaValue(ed, text);
        ed.dispatchEvent(new Event('input', { bubbles: true }));
        ed.dispatchEvent(new Event('change', { bubbles: true }));
      }
      for (let i = 0; i < 40; i++) {
        const btn = sendControl();
        if (btn && !btn.disabled) {
          btn.click();
          return true;
        }
        await sleep(50);
      }
      throw new Error('use.ai send button did not enable');
    } finally {
      if (relock) ed.setAttribute('readonly', 'true');
    }
  }

  function stopGeneration() {
    const b = stopButton();
    if (b) try { b.click(); } catch {}
  }

  function enforceComposer() { return { ready: !!getEditor() }; }
  async function ensureComposerReady(reason) {
    diag('mode_ready', { reason, provider: 'useai' });
    return { ready: !!getEditor() };
  }
  function modeWarning() { return null; }
  function overlayBlocking() { return false; }

  function turnHalted(item) {
    if (!item) return false;
    const t = itemText(item).trim();
    return RE.halted.test(t) && streamLen(item) === 0;
  }

  function findContinueBtn() {
    for (const b of document.querySelectorAll('button')) {
      if (b.offsetParent === null) continue;
      const txt = (b.textContent || '').trim();
      const aria = (b.getAttribute('aria-label') || '').trim();
      if (RE.continueBtn.test(txt) || RE.continueBtn.test(aria)) return b;
    }
    return null;
  }

  function clickContinueBtn() {
    const b = findContinueBtn();
    if (!b) return false;
    try { b.click(); return true; } catch { return false; }
  }

  function scanError() {
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.closest(S.assistantItem) || el.closest(S.userItem)) continue;
        const t = (el.textContent || '').trim();
        if (!t) continue;
        if (RE.contextLimit.test(t) || RE.busy.test(t)) return t;
      }
      if (!getEditor()) return 'The input box disappeared (session ended?).';
    } catch {}
    return null;
  }

  const isTooLongMsg = (msg) => RE.tooLong.test(String(msg || ''));
  const isBusyMsg = (msg) => RE.busy.test(String(msg || ''));

  async function attachImages() { return false; }
  function clearAttachments() { return false; }

  const conversationKey = () => {
    const p = location.pathname || '';
    return /^\/[0-9a-f-]{8,}$/i.test(p) ? p : '';
  };

  function installSendHooks(handlers) {
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
        const ed = getEditor();
        if (!ed || e.target !== ed) return;
        if (editorText().trim() === '') return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );

    document.addEventListener(
      'click',
      (e) => {
        if (!getEditor()) return;
        const ctrl = e.target && e.target.closest && e.target.closest(S.sendBtn);
        if (!ctrl) return;
        if (editorText().trim() === '') return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );
  }

  const CMD_SHAPE = /(?:^|\n)\s*(?:```(?:json)?\s*[\[{]|```\s*###LUA###|###MCP_TOOL###|###\s*LUA\s*###)/i;
  const STARTS_CMD = /^\s*(?:```(?:json)?\s*)?(?:\{?\s*"(?:command|tool)"\s*:|###\s*lua|###mcp_tool###)/i;

  function findToolBlockSpot(item) {
    const md = bodyEl(item);
    if (!md) return null;
    let hidAny = null;

    md.querySelectorAll('pre, code').forEach((el) => {
      const host = el.closest('pre') || el;
      if (host.closest('.zs-chip')) return;
      if (CMD_SHAPE.test(host.textContent || '')) {
        host.classList.add('zs-tool-hide');
        item.classList.add('zs-cmd-mask');
        hidAny = hidAny || { parent: host.parentElement, ref: host };
      }
    });

    md.querySelectorAll('p, div').forEach((el) => {
      if (el.classList.contains('zs-tool-hide') || el.closest('.zs-chip') || el.querySelector('pre, code')) return;
      const t = (el.textContent || '').trim();
      if (STARTS_CMD.test(t)) {
        el.classList.add('zs-tool-hide');
        item.classList.add('zs-cmd-mask');
        hidAny = hidAny || { parent: el.parentElement, ref: el };
      }
    });

    return hidAny;
  }

  return {
    id: 'useai',
    displayName: 'Use AI',
    supportsVision: false,
    timings,
    thinkingSel: null,
    chipAtItemLevel: false,
    chipAnchor,
    chipAppend: false,
    chipTrailRef,
    reliableCounts: true,
    init({ diag: d } = {}) { if (d) diag = d; },
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey, readAssistant,
    streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, gateTarget, barAnchor,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating, genDebug,
    enforceComposer, ensureComposerReady, modeWarning, overlayBlocking,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
  };
})();
