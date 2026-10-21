// ==UserScript==
// @name         IELTS Practice - Vocab Companion Bridge
// @namespace    ielts-vocab-companion
// @version      2.1.0
// @description  Sync active reading, clicked words, original sentences and results to your local companion.
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @match        https://sallowayma-git.github.io/IELTS-practice/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  const ORIGIN = '__BRIDGE_ORIGIN__' === '__' + 'BRIDGE_ORIGIN__' ? 'http://127.0.0.1:47832' : '__BRIDGE_ORIGIN__';
  const TOKEN = '__BRIDGE_TOKEN__' === '__' + 'BRIDGE_TOKEN__' ? '' : '__BRIDGE_TOKEN__';
  if (location.origin === ORIGIN && !location.pathname.startsWith('/practice/')) return;
  const CHANNEL = 'ielts_practice_sync';
  const KEY = 'ielts_practice_sync_event';
  const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  let rememberedId = '';
  let manualId = '';
  let manualUrl = '';
  let fingerprint = '';
  let flushing = false;
  let lastCapture = '';
  let lastCaptureAt = 0;
  let capture = GM_getValue('capture', false);
  let queue = [];
  try { queue = JSON.parse(sessionStorage.getItem('vocab_bridge_outbox') || '[]'); } catch { queue = []; }
  const saveQueue = () => {
    try { sessionStorage.setItem('vocab_bridge_outbox', JSON.stringify(queue)); } catch (error) { console.warn('[Vocab bridge] Outbox full', error); }
  };
  let channel;
  try { channel = new BroadcastChannel(CHANNEL); } catch { channel = null; }
  const request = (event) => {
    const authHeaders = { 'Content-Type': 'application/json' };
    if (TOKEN) authHeaders.Authorization = `Bearer ${TOKEN}`;
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'POST', url: `${ORIGIN}/api/sync`,
          headers: authHeaders,
          data: JSON.stringify(event), timeout: 5000,
          onload: (r) => r.status === 200 ? resolve() : reject(new Error(`HTTP ${r.status}`)),
          ontimeout: () => reject(new Error('timeout')), onerror: () => reject(new Error('offline'))
        });
      } else {
        fetch(`${ORIGIN}/api/sync`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(event)
        }).then(r => r.ok ? resolve() : reject(new Error(`HTTP ${r.status}`))).catch(reject);
      }
    });
  };
  async function flush() {
    if (flushing || !queue.length) return;
    flushing = true;
    try {
      while (queue.length) {
        await request(queue[0]);
        queue.shift();
        saveQueue();
      }
    } catch (error) { console.debug('[Vocab bridge] Will retry:', error.message); }
    finally { flushing = false; }
  }
  function emit(payload, kind = 'reading') {
    const event = { channel: CHANNEL, id: crypto.randomUUID(), sentAt: Date.now(), kind, payload };
    channel?.postMessage(event);
    try { localStorage.setItem(KEY, JSON.stringify(event)); } catch { /* HTTP bridge still works. */ }
    queue.push(event);
    saveQueue();
    flush();
  }
  function readerFor(doc = document, win = page) {
    const overlay = doc.querySelector('#reading-vocab-reader-overlay');
    return overlay && !overlay.classList.contains('is-hidden') && !overlay.hidden ?
      win.ReadingVocabReader : null;
  }
  function root(doc = document, win = page) {
    if (readerFor(doc, win)) {
      const reader = readerFor(doc, win);
      if (!reader._sourceReady || !reader.currentPayload) return null;
      return doc.querySelector('#vocab-passage-content');
    }
    return doc.querySelector('#left, #passage-content, .reading-passage, .passage-content, #passage');
  }
  function identify(doc = document, win = page) {
    if (manualId && win.location.href === manualUrl) return manualId;
    const reader = readerFor(doc, win);
    if (reader) return reader.currentExamId || '';
    const params = new URL(win.location.href).searchParams;
    return doc.body?.dataset.examId || params.get('examId') || win.practicePageEnhancer?.examId || rememberedId;
  }
  function scopedId(examId, reader) {
    if (reader?.currentSource?.kind !== 'imported') return examId;
    const bytes = new TextEncoder().encode(JSON.stringify([reader.currentSource.id, examId]));
    const id = `imported_${btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
    if (id.length > 240) throw new Error('导入题库的来源标识过长，无法安全同步');
    return id;
  }
  function extract(doc = document, win = page, forcedId = '') {
    const container = root(doc, win);
    const examId = forcedId || identify(doc, win);
    if (!container || !examId) return null;
    const duplicate = container.cloneNode(true);
    duplicate.querySelectorAll('script, style, button, input, textarea, select, .paragraph-dropzone, .dropped-items')
      .forEach((node) => node.remove());
    const paragraphs = [...duplicate.querySelectorAll('p, h2, h3')].map((p) => p.textContent.trim()).filter(Boolean);
    const activeText = (paragraphs.length ? paragraphs.join('\n\n') : duplicate.textContent.trim()).slice(0, 200000);
    if (!activeText) return null;
    const reader = readerFor(doc, win);
    const registry = win.__READING_EXAM_DATA__;
    const dataset = reader?.currentPayload || registry?.get?.(examId);
    const manifest = win.__READING_EXAM_MANIFEST__?.[examId];
    const title = (examId === identify(doc, win) ? reader?.currentExam?.title : '') ||
      dataset?.meta?.title || manifest?.title || container.querySelector('h3, h2')?.textContent.trim() || doc.title;
    // Coordinates must come from the identity itself, never a stale title or another suite slot.
    const cam = examId.match(/^(?:cam(?:bridge)?[-_\s]*)?(\d{1,2})[-_\s/]*t(?:est)?[-_\s]*(\d)[-_\s/]*p(?:assage)?[-_\s]*(\d)$/i);
    const passageId = reader?.currentSource?.kind === 'imported' ? scopedId(examId, reader) :
      cam ? `Cam${Number(cam[1])}-T${Number(cam[2])}-P${Number(cam[3])}` : examId;
    const payload = { examId, passageId, title, activeText };
    if (cam) Object.assign(payload, { book: cam[1], test: cam[2], passage: cam[3] });
    const rows = [...doc.querySelectorAll('.results-table tbody tr')];
    if (rows.length) payload.wrongQuestions = rows.filter((row) => row.querySelector('.result-incorrect, .result-partial'))
      .map((row) => {
        const cells = row.querySelectorAll('td');
        return {
          id: row.querySelector('[data-result-question-id]')?.dataset.resultQuestionId || cells[0]?.textContent.trim(),
          question: '', answer: cells[1]?.textContent.trim(), correctAnswer: cells[2]?.textContent.trim()
        };
      });
    return payload;
  }
  function scan() {
    // Inactive tabs must not repeatedly steal the companion's current passage.
    if (document.visibilityState === 'hidden') return;
    let payload;
    try { payload = extract(); }
    catch (error) { console.warn('[Vocab bridge]', error.message); return; }
    if (!payload) return;
    const next = JSON.stringify(payload);
    if (next !== fingerprint) {
      fingerprint = next;
      emit(payload);
    }
    request({ kind: 'heartbeat' }).catch(() => {});
  }
  const types = new Set(['INIT_SESSION', 'SESSION_READY', 'SIMULATION_ACTIVE_EXAM_CHANGE',
    'PRACTICE_COMPLETE', 'PRACTICE_RESULT', 'SIMULATION_SUBMIT']);
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || !types.has(event.data?.type)) return;
    const data = event.data.data || event.data.payload || {};
    if (event.source !== window && event.source !== window.opener && event.source !== window.parent) {
      try { if (event.source?.opener !== page && event.source?.parent !== page) return; } catch { return; }
    }
    if (event.source === window.opener || (window.parent !== window && event.source === window.parent)) {
      rememberedId = data.examId || rememberedId;
      setTimeout(scan, 200);
      return;
    }
    let sourceDoc = document;
    let sourceWin = page;
    try { if (event.source && event.source !== window) { sourceDoc = event.source.document; sourceWin = event.source; } } catch { return; }
    const entries = Array.isArray(data.suiteEntries) ? data.suiteEntries : [data];
    for (const entry of entries) {
      const id = entry.examId || data.examId || identify(sourceDoc, sourceWin);
      const payload = extract(sourceDoc, sourceWin, id);
      if (!payload) continue;
      // An aggregate suite result must not attach the visible article to other passages.
      if (id !== identify(sourceDoc, sourceWin)) {
        payload.activeText = '';
        payload.activate = false;
        payload.title = sourceWin.__READING_EXAM_MANIFEST__?.[id]?.title || id;
      }
      const comparison = entry.answerComparison || entry.results?.answerComparison;
      if (comparison) payload.wrongQuestions = Object.entries(comparison)
        .filter(([, q]) => q.isCorrect === false).map(([questionId, q]) => ({
          id: q.questionId || questionId, question: q.question || '',
          answer: String(q.userAnswer ?? ''), correctAnswer: String(q.correctAnswer ?? '')
        }));
      rememberedId = id;
      emit(payload, comparison ? 'result' : 'reading');
    }
  });
  function sentenceAt(text, offset) {
    return [...text.matchAll(/[^.!?\n]+[.!?]?/g)].find((m) =>
      offset >= m.index && offset < m.index + m[0].length)?.[0].trim() || text.trim();
  }
  function originalSentence(textNode, offset, fallback) {
    const block = textNode?.parentElement?.closest('p, [data-vocab-scope], .vocab-paragraph-text');
    if (!block) return fallback;
    const range = document.createRange();
    range.selectNodeContents(block);
    range.setEnd(textNode, offset);
    return sentenceAt(block.textContent, range.toString().length).slice(0, 10000);
  }
  function emitSelection(value, sentence) {
    const payload = extract();
    if (!payload) return;
    const key = JSON.stringify([payload.passageId, value.toLowerCase(), sentence]);
    if (key === lastCapture && Date.now() - lastCaptureAt < 1000) return;
    lastCapture = key;
    lastCaptureAt = Date.now();
    emit({ ...payload, selection: value, selectionSentence: sentence }, 'selection');
  }
  function editable(target) {
    return target?.closest?.('input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"])');
  }
  function captureSelection(event) {
    if (!capture || editable(event.target) || !root()?.contains(window.getSelection()?.anchorNode)) return;
    const selection = window.getSelection();
    const value = selection?.toString().trim();
    if (!value || value.length > 3000 || !/[a-z]/i.test(value)) return;
    const range = selection.getRangeAt(0);
    if (!root().contains(range.endContainer)) return;
    emitSelection(value, originalSentence(range.startContainer, range.startOffset, value));
  }
  function captureClick(event) {
    if (!capture || editable(event.target) || event.metaKey || event.ctrlKey ||
        !root()?.contains(event.target) || window.getSelection()?.toString().trim() ||
        Date.now() - lastCaptureAt < 250) return;
    const marked = event.target.closest('[data-word], .vocab-highlight');
    if (marked) {
      const value = (marked.dataset.word || marked.textContent).trim();
      if (/^[a-z][a-z '-]{0,99}$/i.test(value)) {
        emitSelection(value, originalSentence(marked.firstChild, 0, value));
      }
      return;
    }
    const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY);
    const range = !caret && document.caretRangeFromPoint?.(event.clientX, event.clientY);
    const textNode = caret?.offsetNode || range?.startContainer;
    const offset = caret?.offset ?? range?.startOffset;
    if (textNode?.nodeType !== Node.TEXT_NODE || !root().contains(textNode)) return;
    const token = [...textNode.textContent.matchAll(/[a-z]+(?:['-][a-z]+)*/gi)]
      .find((m) => offset >= m.index && offset < m.index + m[0].length);
    if (token) emitSelection(token[0], originalSentence(textNode, token.index, token[0]));
  }
  document.addEventListener('copy', captureSelection);
  document.addEventListener('mouseup', captureSelection, true);
  document.addEventListener('keyup', (event) => { if (event.shiftKey) captureSelection(event); }, true);
  document.addEventListener('click', captureClick, true);
  GM_registerMenuCommand('开启 / 关闭划词及复制捕获', () => {
    capture = !capture;
    GM_setValue('capture', capture);
    alert(`点击生词、划词及复制捕获已${capture ? '开启' : '关闭'}。伴侣设置中的捕获开关也需开启。`);
  });
  GM_registerMenuCommand('立即同步当前篇章', () => { fingerprint = ''; scan(); });
  GM_registerMenuCommand('手动设置当前篇章 ID', () => {
    const value = prompt('输入 Cam18-T1-P1 或实际 examId', identify());
    if (value && /^[a-zA-Z0-9_-]+$/.test(value)) {
      manualId = value;
      manualUrl = page.location.href;
      fingerprint = '';
      scan();
    }
  });
  let pending;
  const observer = new MutationObserver(() => {
    clearTimeout(pending);
    pending = setTimeout(scan, 500);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['data-exam-id', 'class', 'hidden'] });
  for (const method of ['pushState', 'replaceState']) {
    const original = page.history[method];
    page.history[method] = function (...args) {
      const result = original.apply(this, args);
      fingerprint = '';
      clearTimeout(pending);
      pending = setTimeout(scan, 100);
      return result;
    };
  }
  window.addEventListener('popstate', () => { fingerprint = ''; scan(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { fingerprint = ''; scan(); }
  });
  setInterval(() => { scan(); flush(); }, 5000);
  scan();
  flush();
})();
