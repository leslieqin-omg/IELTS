import { addWord, applySync, canPostponePassageWords, chineseMeaning, daysUntilReview, endOfDay, ensurePassage, isWordDueToday, isWordStudied, recalculate, rescheduleBacklog, schedule, startOfDay, validateData, migrateLegacy } from './model.js?v=20261103e';
import { StorageService } from './storageService.js?v=20261103e';
import { Dictionary, getAIConfig, saveAIConfig } from './dictionary.js?v=20261103e';
import { Bridge } from './bridge.js?v=20261103e';
import { answerQuiz, forgetQuizWord, nextQuiz, reviewLearning, startLearning, startQuiz } from './quiz.js?v=20261103e';
import { buildPassageVocabulary, sentenceFor } from './passageVocabulary.js?v=20261103e';

const $ = (id) => document.getElementById(id);
const dictionary = new Dictionary();
const selected = new Set();
const selectedReviewPassages = new Set();
const STATUS = { new: '未学习', learning: '需重背', review: '待复习', mastered: '已掌握' };
let store;
let view = 'extract';
let busy = false;
let editorPassage = '';
let editorLookup = null;
let editorGeneration = 0;
let inlineGeneration = 0;
let passageRenderKey = '';
let lastSelectedPassage = '';
let lastClipboard = '';
let clipboardTimer;
let clipboardPolling = false;
let clipboardDenied = false;
let loadingPassage = '';
let lookupGeneration = 0;
let booted = false;
let passageCatalog = {};
let resourceCache;
let dbSyncChannel = null;
let reviewFilterDueOnly = false;
const FONT_SIZE_KEY = 'ielts_vocab_passage_font_size';
const DEFAULT_FONT_SIZE = 18;
const MIN_FONT_SIZE = 13;
const MAX_FONT_SIZE = 28;
let passageFontSize = DEFAULT_FONT_SIZE;
let lastCelebratedQuizId = '';

function launchCelebrationConfetti() {
  if (typeof document === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999;';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = window.innerWidth;
  const H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  const colors = ['#10b981', '#34d399', '#fbbf24', '#f59e0b', '#38bdf8', '#a78bfa', '#fb7185', '#6ee7b7'];
  const particles = [];
  for (let i = 0; i < 110; i++) {
    const fromLeft = i % 2 === 0;
    const angle = fromLeft
      ? (-Math.PI / 3) + (Math.random() - 0.5) * 0.65
      : (-2 * Math.PI / 3) + (Math.random() - 0.5) * 0.65;
    const speed = 11 + Math.random() * 14;
    particles.push({
      x: fromLeft ? W * 0.12 : W * 0.88,
      y: H * 0.68,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 3,
      w: 6 + Math.random() * 6,
      h: 4 + Math.random() * 5,
      color: colors[i % colors.length],
      rot: Math.random() * Math.PI * 2,
      vRot: (Math.random() - 0.5) * 0.25,
      shape: i % 5 === 0 ? 'star' : 'rect',
      alpha: 1
    });
  }

  let frame = 0;
  const tick = () => {
    frame++;
    ctx.clearRect(0, 0, W, H);
    let alive = false;
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.36;
      p.vx *= 0.985;
      p.rot += p.vRot;
      if (frame > 75) p.alpha = Math.max(0, p.alpha - 0.022);
      if (p.alpha > 0 && p.y < H + 40) alive = true;

      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === 'star') {
        ctx.beginPath();
        ctx.arc(0, 0, p.w * 0.55, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      ctx.restore();
    }
    if (alive && frame < 150) {
      requestAnimationFrame(tick);
    } else {
      canvas.remove();
    }
  };
  requestAnimationFrame(tick);
}

function loadPassageFontSize() {
  try {
    const saved = Number(globalThis.localStorage?.getItem(FONT_SIZE_KEY));
    if (Number.isFinite(saved) && saved >= MIN_FONT_SIZE && saved <= MAX_FONT_SIZE) {
      passageFontSize = saved;
    }
  } catch { /* ignore */ }
  applyPassageFontSize(passageFontSize, false);
}

function applyPassageFontSize(size, persist = true) {
  passageFontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)));
  const el = $('passage-content');
  if (el) el.style.setProperty('--passage-font-size', `${passageFontSize}px`);
  if ($('font-size-label')) $('font-size-label').textContent = `${passageFontSize}px`;
  if ($('font-dec')) $('font-dec').disabled = passageFontSize <= MIN_FONT_SIZE;
  if ($('font-inc')) $('font-inc').disabled = passageFontSize >= MAX_FONT_SIZE;
  if ($('font-reset')) $('font-reset').disabled = passageFontSize === DEFAULT_FONT_SIZE;
  if (persist) {
    try { globalThis.localStorage?.setItem(FONT_SIZE_KEY, String(passageFontSize)); } catch { /* ignore */ }
  }
}

function formatReviewStage(w, now = Date.now()) {
  const stage = Math.min(w.repetitions || 0, 6);
  const interval = w.intervalDays || 1;
  if (!isWordDueToday(w, now)) {
    const days = daysUntilReview(w, now);
    return stage > 0
      ? `艾宾浩斯第 ${stage} 轮（${interval}天）· ${days} 天后复习`
      : `已顺延分期 · ${days} 天后复习`;
  }
  if (w.status === 'new' || !w.lastStudiedAt) return '新圈词 · 今日待复习';
  return stage > 0 ? `艾宾浩斯第 ${stage} 轮（${interval}天）· 今日到期` : '需重记 · 今日到期';
}

function getIdleDaysSinceLastStudy(now = Date.now()) {
  if (!store?.data) return 0;
  let lastTs = 0;
  for (const w of Object.values(store.data.vocabRecords || {})) {
    if (w?.lastStudiedAt && w.lastStudiedAt > lastTs) lastTs = w.lastStudiedAt;
  }
  for (const h of store.data.quizHistory || []) {
    if (h?.completedAt && h.completedAt > lastTs) lastTs = h.completedAt;
  }
  if (!lastTs) return 0;
  const diff = startOfDay(now) - startOfDay(lastTs);
  return Math.max(0, Math.round(diff / 86400000));
}

const node = (tag, value = '', className = '') => {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
};
const message = (text, error = false) => {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
};
const percent = (n) => `${Math.round(n * 100)}%`;
const date = (n) => new Date(n).toLocaleString('zh-CN');
const currentPassage = () => store.data.passageProgress[store.data.settings.activePassageId];
const activeSession = () => store.data.quizSession && !store.data.quizSession.completed ?
  store.data.quizSession : store.data.learningSession;
const wordsFor = (p) => p.wordIds.map((id) => store.data.vocabRecords[id]).filter(Boolean);

async function mutate(action) {
  await store.transaction(action);
  render();
}

async function guarded(action) {
  if (busy) return;
  busy = true;
  try { await action(); }
  catch (error) { message(error.message, true); }
  finally { busy = false; }
}
const on = (id, event, action) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener(event, (e) => {
    if (event === 'submit') e.preventDefault();
    guarded(() => action(e));
  });
};

function highlight(sentence, word) {
  const fragment = document.createDocumentFragment();
  if (!sentence) { fragment.append(node('span', '尚无原句，请编辑词条补充真实阅读语境。', 'hint')); return fragment; }
  const escaped = word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const regex = new RegExp(`(?<![a-z])(${escaped})(?![a-z])`, 'gi');
  let index = 0;
  for (const match of sentence.matchAll(regex)) {
    fragment.append(document.createTextNode(sentence.slice(index, match.index)), node('mark', match[0]));
    index = match.index + match[0].length;
  }
  fragment.append(document.createTextNode(sentence.slice(index)));
  return fragment;
}

function context(word) {
  const block = node('blockquote', '', 'context');
  block.append(highlight(word.sentence, word.word));
  return block;
}

function htmlToText(exam) {
  const rawHtml = (exam.passage?.blocks || [])
    .map((block) => block.bodyHtml || block.html || '').join('\n');
  if (!rawHtml.trim()) return exam.activeText || '';
  const parsed = new DOMParser().parseFromString(rawHtml, 'text/html');
  parsed.querySelectorAll('script, style, button, input, .paragraph-dropzone, .dropped-items')
    .forEach((n) => n.remove());
  const paragraphs = [...parsed.querySelectorAll('p, h2, h3')].map((n) => n.textContent.trim()).filter(Boolean);
  return paragraphs.length ? paragraphs.join('\n\n') : (parsed.body.textContent.trim() || rawHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

async function ensureText(id) {
  if (!id || loadingPassage === id) return;
  if (store.data.passageProgress[id]?.activeText) {
    render();
    return;
  }
  loadingPassage = id;
  try {
    const exam = await bridge.loadExam(id);
    if (!exam) {
      if (id.startsWith('suite-')) {
        message(`当前所选为套题模式综合记录 (${id})，请在上方“篇章历史”下拉菜单中选择单篇阅读即可呈现原文。`, false);
      }
      return;
    }
    const activeText = htmlToText(exam);
    if (!activeText) return;
    await mutate((data) => {
      const p = ensurePassage(data, id);
      p.activeText = activeText;
      const manifest = globalThis.__READING_EXAM_MANIFEST__;
      p.title = manifest?.[id]?.title || exam.meta?.title || (p.title !== id ? p.title : '') || id;
    });
    render();
  } catch (error) { message(error.message, true); }
  finally { loadingPassage = ''; }
}

function getCleanTitle(item) {
  if (!item) return '';
  const manifest = globalThis.__READING_EXAM_MANIFEST__;
  if (manifest && manifest[item.id]?.title) {
    return manifest[item.id].title;
  }
  if (item.title && item.title !== item.id) {
    return item.title;
  }
  return item.id;
}

function getPassageMeta(item) {
  if (!item) return { title: '', category: '', difficulty: '', frequency: '' };
  const manifestEntry = globalThis.__READING_EXAM_MANIFEST__?.[item.id];
  const title = getCleanTitle(item);
  let category = manifestEntry?.category || '';
  if (!category) {
    if (item.passage) category = `P${item.passage}`;
    else {
      const m = String(item.id).match(/(?:^|[-_])(p[123])(?:[-_]|$)/i);
      if (m) category = m[1].toUpperCase();
    }
  }
  const score = Number(manifestEntry?.difficultyScore ?? item.difficultyScore);
  const difficulty = Number.isFinite(score) && score > 0 ? `难度 ${score}` : '';
  const freqMap = {
    'ultra-high': '超高频',
    'very-high': '次高频',
    high: '高频',
    medium: '中频',
    mid: '中频',
    low: '低频',
    '超高频': '超高频',
    '次高频': '次高频',
    '高频': '高频',
    '中频': '中频',
    '低频': '低频'
  };
  const rawFreq = String(manifestEntry?.frequency || item.frequency || '').trim();
  const frequency = rawFreq ? (freqMap[rawFreq.toLowerCase()] || rawFreq) : '';
  return { title, category, difficulty, frequency };
}

function buildPassageRowContent(item) {
  const count = wordsFor(item).length;
  const meta = getPassageMeta(item);
  const wrap = node('span', '', 'picker-row-content');
  const dot = node('span', '', `holo-dot${count > 0 ? ' active' : ''}`);
  dot.setAttribute('aria-hidden', 'true');
  const countBadge = node('span', `${count} 词`, `picker-word-count${count > 0 ? '' : ' zero'}`);
  const titleSpan = node('span', meta.title, 'picker-title');
  wrap.append(dot, countBadge, titleSpan);
  if (meta.difficulty || meta.category || meta.frequency) {
    const metaGroup = node('span', '', 'picker-meta-group');
    if (meta.difficulty) metaGroup.append(node('span', meta.difficulty, 'picker-meta-tag diff'));
    if (meta.category) metaGroup.append(node('span', meta.category, 'picker-meta-tag cat'));
    if (meta.frequency) metaGroup.append(node('span', meta.frequency, 'picker-meta-tag freq'));
    wrap.append(metaGroup);
  }
  return wrap;
}

function render() {
  if (!store?.ready) return;
  const data = store.data;
  if (Object.keys(data.passageProgress).length === 0) {
    ensurePassage(data, 'p1-high-01', { title: 'A Brief History of Tea 茶叶简史' });
  }
  const passages = Object.values(data.passageProgress)
    .filter((item) => !item.id.startsWith('suite-'))
    .sort((a, b) => b.practicedAt - a.practicedAt);

  if (!data.settings.activePassageId ||
      !data.passageProgress[data.settings.activePassageId] ||
      data.settings.activePassageId.startsWith('suite-')) {
    data.settings.activePassageId = passages.length > 0 ? passages[0].id : 'p1-high-01';
  }

  const p = currentPassage();
  if (p && !p.activeText) {
    ensureText(p.id).catch(() => {});
  }
  $('app').setAttribute('aria-busy', 'false');
  $('passage-title').textContent = getCleanTitle(p) || data.settings.activePassageId;
  $('passage-meta').textContent = p ? `${wordsFor(p).length} 词 · 最近练习 ${date(p.practicedAt)}` : '';
  $('mastery').textContent = percent(p?.masteryRate || 0);
  $('mastery').title = '本篇词汇掌握率';

  const select = $('passage-select');
  const formatOptionLabel = (item) => {
    const count = wordsFor(item).length;
    const meta = getPassageMeta(item);
    const tail = [meta.difficulty, meta.category, meta.frequency].filter(Boolean).join(' · ');
    return `${count > 0 ? '●' : '○'} ${count}词 · ${meta.title}${tail ? ` · ${tail}` : ''}`;
  };
  const circledPassageCount = passages.filter((item) => wordsFor(item).length > 0).length;
  const totalWordCount = passages.reduce((sum, item) => sum + wordsFor(item).length, 0);
  if ($('passage-circled-summary')) {
    const summaryEl = $('passage-circled-summary');
    summaryEl.replaceChildren();
    const dot = node('span', '', `holo-dot${totalWordCount > 0 ? ' active' : ''}`);
    dot.style.marginRight = '5px';
    summaryEl.append(
      document.createTextNode('· '),
      dot,
      document.createTextNode(`已圈 ${totalWordCount} 词（${circledPassageCount}/${passages.length} 篇）`)
    );
  }
  if (select) {
    const oldSignature = [...select.options].map((o) => `${o.value}:${o.textContent}`).join('|');
    const newSignature = passages.map((item) => `${item.id}:${formatOptionLabel(item)}`).join('|');
    if (oldSignature !== newSignature) {
      select.replaceChildren(...passages.map((item) => {
        const option = node('option', formatOptionLabel(item));
        option.value = item.id;
        return option;
      }));
    }
    select.value = data.settings.activePassageId;
    select.disabled = false;
  }
  const pickerTrigger = $('passage-picker-trigger');
  const pickerMenu = $('passage-picker-menu');
  if (pickerTrigger && pickerMenu && p) {
    pickerTrigger.replaceChildren(buildPassageRowContent(p));
    pickerMenu.replaceChildren(...passages.map((item) => {
      const btn = node('button', '', 'passage-picker-item');
      btn.type = 'button';
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', String(item.id === data.settings.activePassageId));
      btn.append(buildPassageRowContent(item));
      btn.onclick = () => {
        pickerMenu.hidden = true;
        pickerTrigger.setAttribute('aria-expanded', 'false');
        if (item.id !== data.settings.activePassageId) {
          guarded(() => changePassage(item.id));
        }
      };
      return btn;
    }));
  }

  if (lastSelectedPassage !== data.settings.activePassageId) {
    selected.clear();
    p?.wordIds.forEach((id) => selected.add(id));
    lastSelectedPassage = data.settings.activePassageId;
  }
  $('auto-sync').checked = data.settings.autoSync;
  $('capture-enabled').checked = data.settings.capture;
  const allCircledWords = passages.flatMap((item) => wordsFor(item));
  const totalDueCount = allCircledWords.filter((w) => isWordDueToday(w)).length;
  if ($('review-due-badge')) {
    $('review-due-badge').hidden = totalDueCount === 0;
    $('review-due-badge').textContent = String(totalDueCount);
  }

  for (const button of document.querySelectorAll('[data-view]')) {
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  for (const name of ['extract', 'review', 'learn', 'quiz', 'history']) {
    if ($(`view-${name}`)) $(`view-${name}`).hidden = view !== name;
  }
  const headingSection = document.querySelector('.passage-heading');
  if (headingSection) headingSection.hidden = view === 'learn' || view === 'quiz' || view === 'review';
  const session = activeSession();
  $('session-notice').hidden = !session || view === 'learn' || view === 'quiz';
  const sessionDesc = session?.passageIds?.length > 1
    ? `多篇联合（${session.passageIds.length} 篇）`
    : (session?.passageId || '');
  $('session-notice').textContent = session ? `批次已锁定到 ${sessionDesc}。新同步篇章不会改变本轮题池；退出批次后才能切换。` : '';
  if (view === 'extract' && p) { renderPassage(p); renderWords(p); renderResources(p); }
  if (view === 'review') renderReview(passages);
  if (view === 'learn') renderLearn();
  if (view === 'quiz') renderQuiz();
  if (view === 'history') renderHistory();
}

function renderResources(p) {
  if (!$('core-list') || !$('synonym-list')) return;
  const key = JSON.stringify([p.id, p.activeText, wordsFor(p).map((word) => [word.id, word.updatedAt])]);
  if (resourceCache?.key === key) return;
  const resources = buildPassageVocabulary(p, dictionary.fallback || [], passageCatalog, wordsFor(p));
  resourceCache = { key, ...resources };
  $('core-count').textContent = resources.coreWords.length;
  $('core-status').textContent = !p.activeText ? '等待本篇原文同步后自动匹配。' :
    resources.coreWords.length ? '仅匹配本篇原文。篇章校对义优先，词典候选义请结合原句确认；不会自动加入学习批次。' :
      '本篇暂未匹配到离线核心词，可点击原文或手动添加；未加载无关篇章词表。';
  $('core-list').replaceChildren(...resources.coreWords.map((word) => {
    const row = node('div', '', 'resource-row');
    const body = node('div');
    body.append(node('strong', word.word), node('p', word.contextMeaning), node('small', word.reference, 'muted'));
    const save = node('button', store.data.vocabRecords[`${p.id}:${word.word}`] ? '查看 / 编辑' : '确认收录');
    save.type = 'button';
    save.onclick = () => guarded(() => openEditor(word.word, word.sentence, p.id,
      store.data.vocabRecords[`${p.id}:${word.word}`] || { ...word, dictionaryMeaning: word.dictionaryMeaning || '' }));
    row.append(body, save);
    return row;
  }));
  $('synonym-list').replaceChildren(...resources.synonyms.map((word) => {
    const row = node('div', '', 'synonym-row');
    row.append(node('strong', word.word), node('p', word.synonyms.join(' / ')),
      node('small', word.reference, 'muted'));
    return row;
  }));
  $('synonym-status').textContent = resources.synonyms.length ?
    '近义关系不一定可直接互换，需结合原文语境与题干判断。' :
    '本篇暂无已校对的近义参考，可在词条中补充；不会自动编造同义替换。';
}

function markTokensForWords(container, wordList, className) {
  const singleSet = new Set();
  const phrases = [];
  for (const raw of wordList) {
    const clean = String(raw || '').trim().toLowerCase();
    if (!clean) continue;
    if (clean.includes(' ')) {
      phrases.push(clean.split(/\s+/));
    } else {
      singleSet.add(clean);
    }
  }
  const tokens = [...container.querySelectorAll('.token')];
  for (const token of tokens) {
    token.classList.toggle(className, singleSet.has(token.dataset.word));
  }
  if (phrases.length) {
    for (const parts of phrases) {
      for (let i = 0; i <= tokens.length - parts.length; i++) {
        let match = true;
        for (let j = 0; j < parts.length; j++) {
          if (tokens[i + j].dataset.word !== parts[j]) {
            match = false;
            break;
          }
        }
        if (match) {
          for (let j = 0; j < parts.length; j++) {
            tokens[i + j].classList.add(className);
          }
        }
      }
    }
  }
}

function renderPassage(p) {
  const key = `${p.id}:${p.activeText}`;
  if (key !== passageRenderKey) {
    passageRenderKey = key;
    const container = $('passage-content');
    container.replaceChildren();
    if (!p.activeText) container.append(node('p', '尚无原文。可手动粘贴、等待阅读页同步，或直接添加生词。', 'empty'));
    for (const paragraph of p.activeText.split(/\n+/).filter(Boolean)) {
      const element = node('p');
      for (const part of paragraph.split(/([a-zA-Z]+(?:['-][a-zA-Z]+)*)/g)) {
        if (/^[a-zA-Z]/.test(part)) {
          const token = node('span', part, 'token');
          token.dataset.word = part.toLowerCase();
          element.append(token);
        } else element.append(document.createTextNode(part));
      }
      container.append(element);
    }
  }
  markTokensForWords($('passage-content'), wordsFor(p).map((w) => w.word), 'saved');
  $('wrong-count').textContent = p.wrongQuestions.length;
  $('wrong-questions').replaceChildren(...p.wrongQuestions.map((q) =>
    node('p', `${q.id} ${q.question}\n你的答案：${q.answer || '未作答'} · 正确答案：${q.correctAnswer || '未提供'}`)));
}

function renderWords(p) {
  const words = wordsFor(p);
  $('word-count').textContent = words.length;
  const list = $('vocab-list');
  list.replaceChildren();
  if (!words.length) list.append(node('p', '从原文点选生词、鼠标划选短语，或粘贴原句开始。', 'empty'));
  for (const w of words) {
    const row = node('div', '', 'vocab-row');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected.has(w.id);
    checkbox.setAttribute('aria-label', `选择 ${w.word}`);
    checkbox.onchange = () => { checkbox.checked ? selected.add(w.id) : selected.delete(w.id); updateSelection(); };
    const detail = node('div');
    detail.append(node('strong', w.word), node('small', `${w.phonetic || (w.word.includes(' ') ? '短语' : '')} · ${STATUS[w.status]} · 错 ${w.errors} 次`));
    detail.append(node('p', w.contextMeaning || '尚无中文释义，请编辑'));
    detail.append(node('small', w.meaningSource === 'dictionary' ? '词典/AI候选义 · 请确认本篇用法' : '已确认篇章义'));
    detail.append(node('small', formatReviewStage(w)));
    const tools = node('div', '', 'row-tools');
    const edit = node('button', '编辑');
    edit.onclick = () => guarded(() => openEditor(w.word, w.sentence, p.id, w));
    const remove = node('button', '移除', 'delete');
    remove.setAttribute('aria-label', `移除 ${w.word}`);
    remove.onclick = () => guarded(async () => {
      if (activeSession()?.passageId === p.id || activeSession()?.passageIds?.includes(p.id)) {
        throw new Error('本篇正在学习或测试，退出批次后才能移除');
      }
      await mutate((data) => {
        delete data.vocabRecords[w.id];
        data.passageProgress[p.id].wordIds = data.passageProgress[p.id].wordIds.filter((id) => id !== w.id);
        if (data.quizSession?.completed && data.quizSession.words.some((item) => item.id === w.id)) data.quizSession = null;
        recalculate(data, p.id);
      });
      selected.delete(w.id);
      updateSelection();
    });
    tools.append(edit, remove);
    row.append(checkbox, detail, tools);
    list.append(row);
  }
  updateSelection();
}

function updateSelection() {
  const ids = currentPassage()?.wordIds || [];
  const count = ids.filter((id) => selected.has(id)).length;
  $('select-all').checked = count > 0 && count === ids.length;
  $('select-all').indeterminate = count > 0 && count < ids.length;
  $('start-learn').disabled = !count;
  $('start-selected-quiz').disabled = !count;
  $('start-learn').textContent = `背诵选中词（${count}）`;
}

function markUnknown(data) {
  const batch = data.learningSession;
  if (!batch) return;
  batch.activeWordIds ||= [...batch.wordIds];
  if (!batch.activeWordIds.length) return;
  if (!batch.revealed) {
    batch.revealed = true;
    const currentId = batch.activeWordIds[batch.index % batch.activeWordIds.length];
    const r = currentId && data.vocabRecords[currentId];
    if (r) {
      schedule(r, false);
      recalculate(data, r.passageId || batch.passageId);
    }
  } else {
    reviewLearning(data, false);
  }
}

function renderLearn() {
  const batch = store.data.learningSession;
  const stage = $('learn-card');
  stage.replaceChildren();
  batch && (batch.activeWordIds ||= [...batch.wordIds]);
  const remaining = batch?.activeWordIds?.length ?? 0;
  const total = batch?.wordIds?.length || 0;
  const learned = total - remaining;
  const isMulti = batch?.passageIds?.length > 1;
  const currentRecord = batch && remaining > 0
    ? store.data.vocabRecords[batch.activeWordIds[batch.index % remaining]]
    : null;
  const learnTitle = isMulti
    ? `多篇联背（${batch.passageIds.length} 篇${currentRecord?.passageId ? ` · 当前：${currentRecord.passageId}` : ''}）`
    : (batch?.passageId || '');
  $('learn-label').textContent = batch ? `${learnTitle} · 剩余待背 ${remaining} 词 · 已背会 ${learned} / ${total}` : '尚无学习批次';
  $('learn-progress').max = total || 1;
  $('learn-progress').value = learned;
  const completed = batch && remaining === 0;
  $('learn-controls').hidden = !batch || completed;
  $('batch-quiz').hidden = !completed;
  if ($('batch-quiz')) $('batch-quiz').textContent = '测试本批';
  if ($('skip-to-quiz')) $('skip-to-quiz').hidden = !batch || completed;
  $('leave-session').hidden = !batch;
  if (!batch) { stage.append(node('p', '回到圈词页，勾选本篇单词后开始背诵。', 'empty')); return; }
  if (completed) {
    stage.append(node('p', 'BATCH COMPLETE', 'eyebrow'), node('h2', '让记忆回到语境。'));
    stage.append(node('p', `本批全部 ${total} 个单词已全部背会通关！下一步只测试这 ${total} 词，巩固真实长难句语境。`));
    return;
  }
  const w = store.data.vocabRecords[batch.activeWordIds[batch.index % remaining]];
  stage.append(node('p', `REMAINING ${(batch.index % remaining) + 1} / ${remaining}`, 'eyebrow'), node('h2', w.word), node('p', w.phonetic, 'phonetic'));
  stage.append(node('p', '阅读原文语境', 'context-label'), context(w));
  if ($('prev-word')) $('prev-word').disabled = remaining <= 1;
  if ($('next-word')) $('next-word').disabled = remaining <= 1;
  if (batch.revealed) {
    stage.append(node('p', w.contextMeaning || '尚无中文释义，请在圈词页编辑。', 'meaning'));
    if (w.synonyms.length) stage.append(node('p', `同义替换：${w.synonyms.join(' · ')}`, 'hint'));
    stage.append(node('p', w.meaningSource === 'dictionary' ? '此为词典候选义，尚未人工确认篇章用法。' : '本篇已确认用法', 'hint'));
  } else stage.append(node('p', '先在脑中回忆。按 ↓ / 1 会了，按 ↑ / 2 没会显示本词释义，按 ← / → 循环切换单词。', 'hint'));
}

async function handleForgetCurrentQuizWord() {
  let forgotten = null;
  await mutate((data) => {
    forgotten = forgetQuizWord(data);
  });
  if (forgotten) {
    message(`已将「${forgotten.word}（${forgotten.contextMeaning}）」移入复习模块，本轮测试不再出现`);
  }
}

function renderQuiz() {
  const q = store.data.quizSession;
  const stage = $('quiz-content');
  stage.replaceChildren();
  stage.classList.remove('celebration-card');
  stage.hidden = false;
  $('quiz-options').replaceChildren();
  $('quiz-feedback').replaceChildren();
  $('quiz-feedback').className = 'feedback';
  if ($('forget-word')) $('forget-word').hidden = !q || q.completed;
  $('unsure').hidden = !q || q.completed;
  $('next-question').hidden = !q || q.completed;
  $('next-question').textContent = q?.reviewBreak ? '继续间隔复习 Enter' : '下一题 Enter';
  $('quit-quiz').hidden = !q;
  const passageWrapper = $('quiz-passage-wrapper');
  if (passageWrapper) passageWrapper.hidden = !q || q.completed || Boolean(q.reviewBreak);
  if (!q) {
    $('quiz-label').textContent = '尚未开始测试';
    stage.append(node('p', '完成一批背诵后开始测试，或在圈词页勾选本篇待测词。', 'empty'));
    return;
  }
  if (q.completed) {
    const history = store.data.quizHistory.find((h) => h.id === q.id);
    const isHighAccuracy = history && history.accuracy >= 0.9;
    const labelPrefix = q.passageIds?.length > 1
      ? `多篇联测（共 ${q.passageIds.length} 篇）`
      : q.passageId;
    $('quiz-label').textContent = `${labelPrefix} · 本轮完成`;
    if (isHighAccuracy) {
      stage.classList.add('celebration-card');
      const banner = node('div', '', 'celebration-banner');
      const medal = node('span', history.accuracy === 1 ? '🏆' : '🌟', 'celebration-medal');
      const badgeText = node(
        'span',
        history.accuracy === 1 ? '满分通关 · 100% 一击即中！' : '高分达成 · 首答正确率 ≥ 90%！'
      );
      banner.append(medal, badgeText);
      stage.append(banner);
      if (lastCelebratedQuizId !== q.id) {
        lastCelebratedQuizId = q.id;
        launchCelebrationConfetti();
      }
    }
    stage.append(node('p', 'SESSION COMPLETE', 'eyebrow'), node('h2', `${percent(history.accuracy)} 首答正确率`));
    if (isHighAccuracy) {
      stage.append(node(
        'p',
        history.accuracy === 1
          ? '太棒了！本篇核心词汇的语境义你已完全吃透，考场遇到定能秒杀同义替换！'
          : '表现惊艳！你对本篇生词与短语的语境反应非常敏锐，继续保持这个节奏！',
        'celebration-quote'
      ));
    }
    const forgottenWords = q.words.filter((w) => q.answers.some((a) => a.wordId === w.id && a.forgotten));
    const summarySuffix = forgottenWords.length
      ? `其中 ${forgottenWords.length} 个「忘记了」的词已移入复习模块。`
      : '所有错词已在本轮答对。';
    stage.append(node('p', `共 ${q.words.length} 词，${history.attempts} 次作答；含重测准确率 ${percent(history.attemptAccuracy)}。${summarySuffix}`));
    stage.append(node('p', `本轮错词 / 忘记：${q.wrongWordIds.map((id) => q.words.find((w) => w.id === id)?.word).filter(Boolean).join('、') || '无'}`, 'hint'));
    if (forgottenWords.length) {
      stage.append(node('p', `已移入复习模块：${forgottenWords.map((w) => w.word).join('、')}`, 'hint'));
    }
    const actionsRow = node('div', '', 'inline-actions');
    const backReviewBtn = node('button', '返回按篇复习列表', 'primary');
    backReviewBtn.type = 'button';
    backReviewBtn.onclick = () => guarded(async () => {
      await mutate((data) => { data.learningSession = null; data.quizSession = null; });
      view = 'review';
      render();
    });
    actionsRow.append(backReviewBtn);
    if (isHighAccuracy) {
      const replayBtn = node('button', '🎉 再放一次礼花');
      replayBtn.type = 'button';
      replayBtn.onclick = () => launchCelebrationConfetti();
      actionsRow.append(replayBtn);
    }
    stage.append(actionsRow);
    return;
  }
  if (q.reviewBreak) {
    const breakTitle = q.passageIds?.length > 1
      ? `多篇联测（${q.passageIds.length} 篇）`
      : q.passageId;
    $('quiz-label').textContent = `${breakTitle} · 间隔复习`;
    stage.append(node('p', 'SPACED RECALL', 'eyebrow'), node('h2', '稍后再测，先回忆语境。'));
    stage.append(node('p', `本批可用词不足以插入其他题目，还需 ${q.reviewBreak} 步复习间隔。回想原文主题与刚才的例句，再按 Enter 继续。`, 'hint'));
    stage.append(node('p', '这不是计分题，也不会加入本批以外的单词。', 'hint'));
    if ($('forget-word')) $('forget-word').hidden = true;
    $('unsure').hidden = true;
    $('next-question').disabled = false;
    return;
  }
  const item = q.queue[q.index];
  const w = q.words.find((target) => target.id === item.wordId);
  const remaining = q.queue.length - q.index;
  const activeQuizTitle = q.passageIds?.length > 1
    ? `多篇联测（${q.passageIds.length} 篇 · 当前：${w.passageId}）`
    : q.passageId;
  $('quiz-label').textContent = `${activeQuizTitle} · 已答 ${q.index} 次 · 队列剩余 ${remaining} 题`;
  stage.hidden = true;
  const p = store.data.passageProgress[w.passageId] || store.data.passageProgress[q.passageId] || currentPassage();
  const escaped = w.word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const wordRegex = new RegExp(`(?<![a-z])(${escaped})(?![a-z])`, 'i');
  let excerpt = w.sentence ? w.sentence.trim() : '';
  if (p?.activeText) {
    const sentences = p.activeText
      .replace(/\n+/g, ' ')
      .match(/[^.!?]+[.!?]+|\S[^.!?]*$/g)
      ?.map((s) => s.trim())
      .filter(Boolean) || [];
    const idx = sentences.findIndex((s) => wordRegex.test(s));
    if (idx !== -1) {
      const prev = idx > 0 ? sentences[idx - 1] : '';
      const curr = sentences[idx];
      const next = idx + 1 < sentences.length ? sentences[idx + 1] : '';
      if (curr.length < 110 && next) excerpt = `${curr} ${next}`;
      else if (curr.length < 110 && prev) excerpt = `${prev} ${curr}`;
      else excerpt = curr;
    } else if (!excerpt) {
      excerpt = findSentence(p.activeText, w.word);
    }
  }
  if (!excerpt) excerpt = w.word;
  if (excerpt && $('quiz-passage-content')) {
    const pContainer = $('quiz-passage-content');
    pContainer.style.minHeight = '0';
    pContainer.style.height = 'auto';
    pContainer.replaceChildren();
    const element = node('p');
    element.style.marginBottom = '0';
    for (const part of excerpt.split(/([a-zA-Z]+(?:['-][a-zA-Z]+)*)/g)) {
      if (/^[a-zA-Z]/.test(part)) {
        const token = node('span', part, 'token');
        token.dataset.word = part.toLowerCase();
        element.append(token);
      } else element.append(document.createTextNode(part));
    }
    pContainer.append(element);
    markTokensForWords(pContainer, [w.word], 'target-quiz-active');
  }
  item.options.forEach((option, index) => {
    const button = node('button', '', 'quiz-option');
    button.append(node('span', `${index + 1} / ${'ABCD'[index]}`), node('span', option));
    button.disabled = Boolean(q.feedback);
    if (q.feedback) {
      if (option === w.contextMeaning) button.classList.add('correct');
      else if (q.feedback.selected === index) button.classList.add('incorrect');
    }
    button.onclick = () => guarded(() => mutate((data) => answerQuiz(data, index)));
    $('quiz-options').append(button);
  });
  const forgetOptionBtn = node('button', '', 'quiz-option forget-option');
  forgetOptionBtn.type = 'button';
  forgetOptionBtn.append(
    node('span', '5 / 忘记了'),
    node('span', '忘记了（移入复习模块，本轮测试不再出现）')
  );
  forgetOptionBtn.disabled = false;
  forgetOptionBtn.onclick = () => guarded(() => handleForgetCurrentQuizWord());
  $('quiz-options').append(forgetOptionBtn);
  if ($('forget-word')) $('forget-word').disabled = false;
  $('unsure').disabled = Boolean(q.feedback);
  $('next-question').disabled = !q.feedback;
  if (q.feedback) {
    const feedback = $('quiz-feedback');
    feedback.classList.add(q.feedback.correct ? 'success' : 'failure');
    feedback.append(node('strong', q.feedback.correct ? '回答正确，熟练度 +1。' :
      '已追加到队尾，至少间隔两题后重测；目标词不足时使用复习间隔页。'));
    feedback.append(node('p', `本篇词义：${w.contextMeaning}`), context(w));
    if (w.synonyms.length) feedback.append(node('p', `同义替换：${w.synonyms.join(' · ')}`));
  }
}

async function startPassageBatch(passageId, wordIds, mode = 'learn') {
  if (!wordIds?.length) throw new Error('没有可复习或测试的词汇');
  const isDifferentSession = activeSession() &&
    (activeSession().passageIds?.length > 1 || activeSession().passageId !== passageId);
  if (isDifferentSession &&
      !confirm('将退出当前进行中的批次并切换到所选篇章开始复习/测试，继续？')) return;
  await ensureText(passageId);
  if (mode === 'learn') {
    await mutate((data) => {
      data.settings.activePassageId = passageId;
      data.learningSession = null;
      data.quizSession = null;
      startLearning(data, passageId, wordIds);
    });
    view = 'learn';
    render();
    return;
  }
  const targetWords = structuredClone(wordIds.map((id) => store.data.vocabRecords[id]).filter(Boolean));
  try { await dictionary.load(); }
  catch { message('离线词库暂不可用，将尝试使用已保存的篇章词库生成选项。'); }
  for (const w of targetWords) {
    if (!w.pos && dictionary.map) {
      const entry = dictionary.map.get(String(w.word || '').trim().toLowerCase());
      const pos = entry?.t?.match(/\b(adj|adv|vt|vi|v|n|a|prep|pron|conj|num)\./i)?.[1] || '';
      if (pos) w.pos = pos;
    }
  }
  await mutate((data) => {
    data.settings.activePassageId = passageId;
    data.learningSession = null;
    data.quizSession = null;
    startQuiz(data, targetWords, dictionary.fallback?.length ? dictionary.fallback : Object.values(data.vocabRecords));
  });
  view = 'quiz';
  render();
}

async function startMultiPassageLearnBatch(passageIds, wordIds) {
  if (!passageIds?.length || !wordIds?.length) throw new Error('请先勾选至少一篇包含待背词汇的篇章');
  if (activeSession() && !confirm('将退出当前进行中的批次并开始所选多篇联合背词，继续？')) return;
  for (const pid of passageIds) {
    await ensureText(pid);
  }
  const primaryId = wordIds.map((id) => store.data.vocabRecords[id]?.passageId).find(Boolean) || passageIds[0];
  await mutate((data) => {
    data.settings.activePassageId = primaryId;
    data.learningSession = null;
    data.quizSession = null;
    startLearning(data, passageIds, wordIds, { allowMultiplePassages: true });
  });
  view = 'learn';
  render();
}

async function startMultiPassageQuizBatch(passageIds, wordIds, options = {}) {
  if (!passageIds?.length || !wordIds?.length) throw new Error('请先勾选至少一篇包含待测词汇的篇章');
  const session = activeSession();
  const isTransitionFromCurrentLearning = session === store.data.learningSession &&
    session?.wordIds?.length === wordIds.length &&
    wordIds.every((id) => session.wordIds.includes(id));
  if (session && !isTransitionFromCurrentLearning && !options?.skipConfirm &&
      !confirm('将退出当前进行中的批次并开始所选多篇联合测试，继续？')) return;
  for (const pid of passageIds) {
    await ensureText(pid);
  }
  const targetWords = structuredClone(wordIds.map((id) => store.data.vocabRecords[id]).filter(Boolean));
  try { await dictionary.load(); }
  catch { message('离线词库暂不可用，将尝试使用已保存的篇章词库生成选项。'); }
  for (const w of targetWords) {
    if (!w.pos && dictionary.map) {
      const entry = dictionary.map.get(String(w.word || '').trim().toLowerCase());
      const pos = entry?.t?.match(/\b(adj|adv|vt|vi|v|n|a|prep|pron|conj|num)\./i)?.[1] || '';
      if (pos) w.pos = pos;
    }
  }
  const primaryId = wordIds.map((id) => store.data.vocabRecords[id]?.passageId).find(Boolean) || passageIds[0];
  await mutate((data) => {
    data.settings.activePassageId = primaryId;
    if (!options?.keepLearningSession) data.learningSession = null;
    data.quizSession = null;
    startQuiz(
      data,
      targetWords,
      dictionary.fallback?.length ? dictionary.fallback : Object.values(data.vocabRecords),
      Math.random,
      { allowMultiplePassages: true }
    );
  });
  view = 'quiz';
  render();
}

function renderReview(passages = []) {
  const listContainer = $('review-passage-list');
  const statsContainer = $('review-stats');
  if (!listContainer || !statsContainer) return;

  if ($('review-filter-all') && $('review-filter-due')) {
    $('review-filter-all').classList.toggle('primary', !reviewFilterDueOnly);
    $('review-filter-due').classList.toggle('primary', reviewFilterDueOnly);
  }

  const now = Date.now();
  const circledPassages = passages
    .map((p) => {
      const words = wordsFor(p);
      const dueWords = words.filter((w) => isWordDueToday(w, now));
      const nextDays = words.length > dueWords.length
        ? Math.min(...words.filter((w) => !isWordDueToday(w, now)).map((w) => daysUntilReview(w, now)))
        : 0;
      return { p, words, dueWords, nextDays };
    })
    .filter((item) => item.words.length > 0)
    .sort((a, b) => {
      if ((b.dueWords.length > 0) !== (a.dueWords.length > 0)) {
        return b.dueWords.length > 0 ? 1 : -1;
      }
      if (b.dueWords.length !== a.dueWords.length) return b.dueWords.length - a.dueWords.length;
      return (b.p.practicedAt || 0) - (a.p.practicedAt || 0);
    });

  const duePassageCount = circledPassages.filter((item) => item.dueWords.length > 0).length;
  const postponablePassages = circledPassages.filter((item) => canPostponePassageWords(item.words, now));
  const postponablePassageCount = postponablePassages.length;
  const postponableWordCount = postponablePassages.reduce((s, item) => s + item.dueWords.length, 0);
  const newOnlyPassageCount = duePassageCount - postponablePassageCount;
  const totalWords = circledPassages.reduce((s, item) => s + item.words.length, 0);
  const totalDueWords = circledPassages.reduce((s, item) => s + item.dueWords.length, 0);
  const totalMastered = circledPassages.reduce((s, item) => s + item.words.filter((w) => w.status === 'mastered').length, 0);

  statsContainer.replaceChildren();
  const statItems = [
    { val: `${duePassageCount} 篇 / ${totalDueWords} 词`, label: `今日待复习（已背到期 ${postponablePassageCount} 篇 · 新圈待背 ${newOnlyPassageCount} 篇）` },
    { val: `${circledPassages.length} 篇 / ${totalWords} 词`, label: '已圈词篇章累计' },
    { val: `${totalMastered} 词`, label: '已掌握词汇（连续达标）' }
  ];
  for (const st of statItems) {
    const box = node('div', '', 'review-stat-card');
    box.append(node('strong', st.val), node('span', st.label));
    statsContainer.append(box);
  }

  const backlogBanner = $('backlog-banner');
  if (backlogBanner) {
    backlogBanner.replaceChildren();
    if (postponablePassageCount > 0) {
      backlogBanner.hidden = false;
      const idleDays = getIdleDaysSinceLastStudy(now);
      const isUrgentBacklog = idleDays >= 3 || postponablePassageCount >= 3;
      backlogBanner.className = `backlog-banner${isUrgentBacklog ? ' urgent' : ''}`;
      const textWrap = node('div');
      const titleText = idleDays >= 3
        ? `🏖️ 检测到已间隔 ${idleDays} 天未复习（已背过待复习积压 ${postponablePassageCount} 篇 / ${postponableWordCount} 词）`
        : postponablePassageCount >= 3
          ? `🏖️ 当前积压了 ${postponablePassageCount} 篇（共 ${postponableWordCount} 词）已背过的到期文章`
          : `📅 顺延已背篇章（平移时间轴 / 分期消化）`;
      const descNote = newOnlyPassageCount > 0
        ? `仅顺延「已背过」的 ${postponablePassageCount} 篇（${postponableWordCount} 词）；另外 ${newOnlyPassageCount} 篇「新圈词未背诵」文章不可顺延，需先完成首次背词：`
        : '断更或时间不够时，可一键将已背过的到期篇章平滑分摊到未来几天（新圈词未背文章不参与顺延）：';
      textWrap.append(
        node('div', titleText, 'backlog-banner-title'),
        node('div', descNote, 'backlog-banner-desc')
      );
      const btnRow = node('div', '', 'inline-actions');
      if (postponablePassageCount >= 2) {
        const keepOneBtn = node('button', '✨ 已背篇章留 1 篇今日，其余分摊到未来 5 天', 'primary');
        keepOneBtn.type = 'button';
        keepOneBtn.onclick = () => guarded(async () => {
          let res;
          await mutate((data) => {
            res = rescheduleBacklog(data, { days: 5, keepTodayPassages: 1 });
          });
          message(`已为您保留今日最急需的 1 篇已背文章，其余 ${res.postponedPassages} 篇（${res.postponedWords} 词）已均匀分摊到未来 5 天！`);
        });
        btnRow.append(keepOneBtn);
      }
      const spread3Btn = node('button', '📅 已背到期全部顺延分摊到未来 3 天', postponablePassageCount < 2 ? 'primary' : '');
      spread3Btn.type = 'button';
      spread3Btn.onclick = () => guarded(async () => {
        let res;
        await mutate((data) => {
          res = rescheduleBacklog(data, { days: 3, keepTodayPassages: 0 });
        });
        message(`已将 ${res.postponedPassages} 篇已背文章（${res.postponedWords} 词）顺延并均匀分摊到未来 3 天！`);
      });
      const spread7Btn = node('button', '🏖️ 已背到期全部顺延分摊到未来 7 天');
      spread7Btn.type = 'button';
      spread7Btn.onclick = () => guarded(async () => {
        let res;
        await mutate((data) => {
          res = rescheduleBacklog(data, { days: 7, keepTodayPassages: 0 });
        });
        message(`已将 ${res.postponedPassages} 篇已背文章（${res.postponedWords} 词）顺延并均匀分摊到未来 7 天！`);
      });
      btnRow.append(spread3Btn, spread7Btn);
      backlogBanner.append(textWrap, btnRow);
    } else if (newOnlyPassageCount > 0) {
      backlogBanner.hidden = false;
      backlogBanner.className = 'backlog-banner';
      backlogBanner.append(
        node('div', `📌 当前待处理的 ${newOnlyPassageCount} 篇均为「新圈词尚未背诵」文章`, 'backlog-banner-title'),
        node('div', '新圈词的文章不可顺延；请先点击下方卡片完成首次背词或测试后，即可进入艾宾浩斯复习与顺延队列。', 'backlog-banner-desc')
      );
    } else {
      backlogBanner.hidden = true;
    }
  }

  const filtered = reviewFilterDueOnly
    ? circledPassages.filter((item) => item.dueWords.length > 0)
    : circledPassages;

  const validPassageIds = new Set(circledPassages.map((item) => item.p.id));
  for (const pid of [...selectedReviewPassages]) {
    if (!validPassageIds.has(pid)) selectedReviewPassages.delete(pid);
  }

  const multiQuizBar = $('multi-quiz-bar');
  if (multiQuizBar) {
    multiQuizBar.replaceChildren();
    if (circledPassages.length > 0) {
      multiQuizBar.hidden = false;
      const selectedEntries = circledPassages.filter((item) => selectedReviewPassages.has(item.p.id));
      const selectedPassageIds = selectedEntries.map((item) => item.p.id);
      const selectedDueIds = selectedEntries.flatMap((item) => item.dueWords.map((w) => w.id));
      const selectedAllIds = selectedEntries.flatMap((item) => item.words.map((w) => w.id));
      multiQuizBar.className = `multi-quiz-bar${selectedEntries.length > 0 ? ' has-selection' : ''}`;

      const info = node('div', '', 'multi-quiz-info');
      info.append(
        node(
          'span',
          selectedEntries.length > 0
            ? `多篇联合：已勾选 ${selectedEntries.length} 篇（共 ${selectedAllIds.length} 词 · 到期 ${selectedDueIds.length} 词）`
            : '多篇联合：在下方勾选多个篇章，即可合为一轮一起背词或测试'
        )
      );

      const quickSelectRow = node('div', '', 'inline-actions');
      const btnSelectVisible = node('button', '全选当前列表');
      btnSelectVisible.type = 'button';
      btnSelectVisible.onclick = () => {
        filtered.forEach((item) => selectedReviewPassages.add(item.p.id));
        render();
      };
      const btnSelectDuePassages = node('button', '全选今日待复习篇章');
      btnSelectDuePassages.type = 'button';
      btnSelectDuePassages.disabled = duePassageCount === 0;
      btnSelectDuePassages.onclick = () => {
        selectedReviewPassages.clear();
        circledPassages.filter((item) => item.dueWords.length > 0).forEach((item) => selectedReviewPassages.add(item.p.id));
        render();
      };
      const btnClearSelection = node('button', '清空勾选');
      btnClearSelection.type = 'button';
      btnClearSelection.disabled = selectedEntries.length === 0;
      btnClearSelection.onclick = () => {
        selectedReviewPassages.clear();
        render();
      };
      const btnMultiLearnAll = node(
        'button',
        `联合背词（${selectedAllIds.length} 词）`,
        selectedAllIds.length > 0 ? 'primary' : ''
      );
      btnMultiLearnAll.type = 'button';
      btnMultiLearnAll.disabled = selectedAllIds.length === 0;
      btnMultiLearnAll.onclick = () => guarded(() => startMultiPassageLearnBatch(selectedPassageIds, selectedAllIds));

      const btnMultiQuizAll = node(
        'button',
        `联合测试（${selectedAllIds.length} 词）`
      );
      btnMultiQuizAll.type = 'button';
      btnMultiQuizAll.disabled = selectedAllIds.length === 0;
      btnMultiQuizAll.onclick = () => guarded(() => startMultiPassageQuizBatch(selectedPassageIds, selectedAllIds));

      quickSelectRow.append(btnSelectVisible, btnSelectDuePassages, btnClearSelection, btnMultiLearnAll, btnMultiQuizAll);
      multiQuizBar.append(info, quickSelectRow);
    } else {
      multiQuizBar.hidden = true;
    }
  }

  listContainer.replaceChildren();
  if (!filtered.length) {
    listContainer.append(node(
      'p',
      reviewFilterDueOnly
        ? '🎉 今日所有已圈词汇均已完成按期复习！可切换到「全部已圈词篇章」提前巩固或直接测试。'
        : '尚无已圈词篇章。请先在「圈词」页面点击原文生词或划选短语收录词汇。',
      'empty'
    ));
    return;
  }

  for (const { p, words, dueWords, nextDays } of filtered) {
    const isPassageChecked = selectedReviewPassages.has(p.id);
    const card = node('section', '', `review-passage-card${dueWords.length > 0 ? ' has-due' : ''}${isPassageChecked ? ' is-selected' : ''}`);
    const header = node('div', '', 'review-card-header');
    const titleBox = node('div');
    const titleEl = node('h3', '', 'review-card-title');
    titleEl.append(buildPassageRowContent(p));
    const metaRow = node('div');
    const canPostponeThis = canPostponePassageWords(words, now);
    const hasUnstudiedNew = words.some((w) => !isWordStudied(w));
    const dueLabel = dueWords.length > 0
      ? (hasUnstudiedNew ? `新圈词待背 ${dueWords.length} 词（未背不可顺延）` : `今日待复习 ${dueWords.length} 词`)
      : `今日已清 · 下次复习 ${nextDays} 天后`;
    const duePill = node(
      'span',
      dueLabel,
      `review-pill${dueWords.length > 0 ? ' due' : ''}`
    );
    const countMeta = node(
      'span',
      `${p.id} · 共圈 ${words.length} 词 · 掌握率 ${percent(p.masteryRate || 0)}`,
      'muted'
    );
    metaRow.append(duePill, countMeta);
    titleBox.append(titleEl, metaRow);

    const selectLabel = node('label', '', 'review-select-toggle');
    const selectCheckbox = document.createElement('input');
    selectCheckbox.type = 'checkbox';
    selectCheckbox.checked = isPassageChecked;
    selectCheckbox.onchange = () => {
      if (selectCheckbox.checked) selectedReviewPassages.add(p.id);
      else selectedReviewPassages.delete(p.id);
      render();
    };
    selectLabel.append(selectCheckbox, node('span', isPassageChecked ? '已加入联合' : '勾选联合'));

    header.append(titleBox, selectLabel);
    card.append(header);

    const chips = node('div', '', 'review-word-chips');
    for (const w of words) {
      const due = isWordDueToday(w, now);
      const chip = node('span', '', `review-word-chip${due ? ' is-due' : ''}`);
      chip.append(
        node('strong', w.word),
        node('span', w.contextMeaning || '待补充释义'),
        node('small', `· ${due ? '今日到期' : `${daysUntilReview(w, now)}天后`}`)
      );
      chips.append(chip);
    }
    card.append(chips);

    const actions = node('div', '', 'inline-actions');
    if (dueWords.length > 0) {
      const dueIds = dueWords.map((w) => w.id);
      const btnLearnDue = node('button', `先复习再测试（到期 ${dueWords.length} 词）`, 'primary');
      btnLearnDue.type = 'button';
      btnLearnDue.onclick = () => guarded(() => startPassageBatch(p.id, dueIds, 'learn'));
      const btnQuizDue = node('button', `直接测试到期词（${dueWords.length} 词）`);
      btnQuizDue.type = 'button';
      btnQuizDue.onclick = () => guarded(() => startPassageBatch(p.id, dueIds, 'quiz'));
      actions.append(btnLearnDue, btnQuizDue);
      if (canPostponeThis) {
        const btnSnoozeOne = node('button', '⏳ 本篇顺延 1 天');
        btnSnoozeOne.type = 'button';
        btnSnoozeOne.onclick = () => guarded(async () => {
          let res;
          await mutate((data) => {
            res = rescheduleBacklog(data, { days: 1, passageId: p.id });
          });
          message(`已将「${getCleanTitle(p)}」的 ${res.postponedWords} 个到期词顺延至明天复习`);
        });
        actions.append(btnSnoozeOne);
      }
    }
    const allIds = words.map((w) => w.id);
    const btnLearnAll = node(
      'button',
      dueWords.length > 0 ? `复习全篇（${words.length} 词）` : `先复习再测试（全篇 ${words.length} 词）`,
      dueWords.length === 0 ? 'primary' : ''
    );
    btnLearnAll.type = 'button';
    btnLearnAll.onclick = () => guarded(() => startPassageBatch(p.id, allIds, 'learn'));

    const btnQuizAll = node('button', `直接测试全篇（${words.length} 词）`);
    btnQuizAll.type = 'button';
    btnQuizAll.onclick = () => guarded(() => startPassageBatch(p.id, allIds, 'quiz'));

    const btnOpenExtract = node('button', '查看原文 / 圈词');
    btnOpenExtract.type = 'button';
    btnOpenExtract.onclick = () => guarded(async () => {
      await changePassage(p.id);
      view = 'extract';
      render();
    });

    actions.append(btnLearnAll, btnQuizAll, btnOpenExtract);
    card.append(actions);
    listContainer.append(card);
  }
}

function renderHistory() {
  const container = $('history-list');
  container.replaceChildren();
  if (!store.data.quizHistory.length) container.append(node('p', '完成第一轮测试后，这里会保留成绩和错词。', 'empty'));
  for (const h of [...store.data.quizHistory].reverse()) {
    const row = node('section', '', 'history-row');
    const passageDesc = h.passageIds?.length > 1
      ? `多篇联测（${h.passageIds.join('、')}）`
      : h.passageId;
    row.append(node('p', `${passageDesc} · ${date(h.completedAt)}`, 'muted'));
    row.append(node('p', `${percent(h.accuracy)} 首答正确率`, 'history-score'));
    row.append(node('p', `${h.wordIds.length} 词 · ${h.attempts} 次作答 · 含重测 ${percent(h.attemptAccuracy)}`));
    row.append(node('p', `错词：${h.wrongWordIds.map((id) => id.slice(id.indexOf(':') + 1)).join('、') || '无'}`, 'hint'));
    container.append(row);
  }
}

async function changePassage(id) {
  const isLocked = activeSession() &&
    (activeSession().passageIds?.length > 1 ? !activeSession().passageIds.includes(id) : activeSession().passageId !== id);
  if (isLocked) {
    render();
    throw new Error('当前批次已锁定，请先退出背词 / 测试，再切换篇章');
  }
  const now = Date.now();
  await mutate((data) => {
    const p = ensurePassage(data, id);
    p.lastDetectedAt = now;
    p.lastSyncAt = Math.max(p.lastSyncAt || 0, now);
    data.settings.activePassageId = id;
  });
  await ensureText(id);
  render();
}

async function triggerInlineAITranslate(word, sentence, gen = inlineGeneration) {
  const clean = String(word || '').trim();
  if (!clean) return;
  const btn = $('inline-ai-translate');
  if (btn) { btn.disabled = true; btn.textContent = '✨ 翻译中...'; }
  $('inline-dict-reference').textContent = '✨ AI 正在结合本篇原句分析精准词义...';
  try {
    const aiInfo = await dictionary.aiLookup(clean, sentence);
    if (gen !== inlineGeneration || $('inline-editor-card')?.hidden) return;
    if (aiInfo && aiInfo.contextMeaning) {
      editorLookup = { ...(editorLookup || {}), ...aiInfo };
      if (aiInfo.phonetic) $('inline-edit-phonetic').value = aiInfo.phonetic;
      if (aiInfo.pos) $('inline-edit-pos').value = aiInfo.pos;
      $('inline-edit-meaning').value = aiInfo.contextMeaning;
      $('inline-dict-reference').textContent = `✨ AI 语境解析：${aiInfo.dictionaryMeaning || aiInfo.contextMeaning}`;
    } else {
      $('inline-dict-reference').textContent = editorLookup?.dictionaryMeaning
        ? `词典参考：${editorLookup.dictionaryMeaning}`
        : 'AI 暂未返回结果，请手动输入或重试。';
    }
  } catch {
    if (gen === inlineGeneration) {
      $('inline-dict-reference').textContent = 'AI 翻译请求失败，请手动输入中文释义。';
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✨ AI 语境翻译'; }
  }
}

function clearSelectingTokens() {
  const container = $('passage-content');
  if (!container) return;
  for (const el of container.querySelectorAll('.token.selecting')) {
    el.classList.remove('selecting');
  }
}

async function openInlineEditor(word = '', sentence = '', passageId = store.data.settings.activePassageId, record = null, targetTokens = null) {
  const card = $('inline-editor-card');
  if (!card) return;
  const gen = ++inlineGeneration;
  const cleanWord = word.trim().toLowerCase().replace(/\s+/g, ' ');
  clearSelectingTokens();
  if (Array.isArray(targetTokens) && targetTokens.length) {
    for (const t of targetTokens) t.classList.add('selecting');
  } else if (cleanWord && $('passage-content')) {
    markTokensForWords($('passage-content'), [cleanWord], 'selecting');
  }
  card.hidden = false;
  editorPassage = passageId;
  editorLookup = record;
  $('inline-edit-word').value = cleanWord;
  $('inline-edit-meaning').value = record?.contextMeaning || '';
  $('inline-edit-phonetic').value = record?.phonetic || '';
  $('inline-edit-pos').value = record?.pos || (cleanWord.includes(' ') ? 'phr.' : '');
  $('inline-edit-sentence').value = sentence;
  $('inline-dict-reference').textContent = record?.dictionaryMeaning || '正在查询词义...';
  $('inline-editor-title').textContent = `${cleanWord.includes(' ') ? '短语收录' : '生词收录'} · ${cleanWord}`;
  if (cleanWord && !record) {
    let info = await dictionary.lookup(cleanWord);
    const curated = passageCatalog.passages?.[passageId]?.find((entry) => entry.word === cleanWord);
    if (curated) info = { ...info, ...curated, meaningSource: 'source' };
    if (gen !== inlineGeneration) return;
    editorLookup = info;
    if (info.phonetic) $('inline-edit-phonetic').value = info.phonetic;
    if (info.pos) $('inline-edit-pos').value = info.pos;
    if (info.contextMeaning) $('inline-edit-meaning').value = info.contextMeaning;
    $('inline-dict-reference').textContent = info.dictionaryMeaning
      ? `离线词典：${info.dictionaryMeaning}（若不贴合语境，可点击「✨ AI 语境翻译」）`
      : '离线词典未直接收录整条，可手动填写或点击「✨ AI 语境翻译」';
  }
}

async function openEditor(word = '', sentence = '', passageId = store.data.settings.activePassageId, record = null) {
  const generation = ++editorGeneration;
  editorPassage = passageId;
  editorLookup = record;
  $('edit-word').value = word;
  $('edit-word').readOnly = Boolean(record);
  $('edit-meaning').value = record?.contextMeaning || '';
  $('edit-phonetic').value = record?.phonetic || '';
  $('edit-pos').value = record?.pos || '';
  $('edit-sentence').value = sentence;
  $('edit-synonyms').value = record?.synonyms.join(', ') || '';
  $('dictionary-reference').textContent = record?.dictionaryMeaning || '默认使用离线词典；若觉得离线释义不准确，可点击「✨ AI 语境翻译」。';
  $('word-passage').textContent = `收录到 ${passageId}`;
  $('word-dialog').showModal();
  if (word && !record) {
    const info = await dictionary.lookup(word);
    if (generation !== editorGeneration || !$('word-dialog').open) return;
    fillLookup(info);
  }
}

function fillLookup(info) {
  editorLookup = info;
  if (info.phonetic) $('edit-phonetic').value = info.phonetic;
  if (info.pos) $('edit-pos').value = info.pos;
  if (info.contextMeaning) $('edit-meaning').value = info.contextMeaning;
  if (Array.isArray(info.synonyms) && info.synonyms.length && !$('edit-synonyms').value.trim()) {
    $('edit-synonyms').value = info.synonyms.join(', ');
  }
  $('dictionary-reference').textContent = info.fromAI
    ? `✨ AI 语境解析：${info.dictionaryMeaning || info.contextMeaning}`
    : `离线词典：${info.dictionaryMeaning || '未找到，可点击「✨ AI 语境翻译」或手动补充'}`;
}

const STOP_WORDS = new Set('a an the to of in on is are was were be been being it its i you he she we they and or but as for with by from this that these those at has have had do does did not can could will would should may might than then their his her our your some all into over which who when what also such'.split(' '));

async function recognizeText(value, passageId, originalSentence = '') {
  const text = value.trim();
  if (!text || !/[a-z]/i.test(text)) throw new Error('请提供英文单词、短语或阅读原句');
  const normalizedPhrase = text.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '').replace(/\s+/g, ' ').toLowerCase();
  if (/^[a-z][a-z'-]*(?: [a-z][a-z'-]*){1,5}$/i.test(normalizedPhrase) && normalizedPhrase.split(' ').length <= 6 && !/[.!?\n]/.test(text)) {
    const sentence = originalSentence || findSentence(store.data.passageProgress[passageId]?.activeText || '', normalizedPhrase);
    const info = await dictionary.lookup(normalizedPhrase);
    return [{ ...info, word: normalizedPhrase, sentence }];
  }
  const tokens = text.match(/[a-z]+(?:['-][a-z]+)*/gi) || [];
  const candidates = [...new Set(tokens.map((t) => t.toLowerCase()))]
    .filter((w) => tokens.length === 1 || (w.length >= 4 && !STOP_WORDS.has(w))).slice(0, 30);
  const records = [];
  for (const word of candidates) {
    let info;
    try { info = await dictionary.lookup(word); }
    catch { info = { word, phonetic: '', contextMeaning: '', dictionaryMeaning: '', pos: '', synonyms: [] }; }
    const curated = passageCatalog.passages?.[passageId]?.find((entry) => entry.word === word);
    if (curated) info = { ...info, ...curated, meaningSource: 'source' };
    if (tokens.length === 1 || chineseMeaning(info.contextMeaning) || !dictionary.map) {
      const sentence = originalSentence || (tokens.length > 1 ? text :
        findSentence(store.data.passageProgress[passageId]?.activeText || '', word));
      records.push({ ...info, sentence });
    }
  }
  if (!records.length) throw new Error('未识别出可收录词，请手动添加并填写中文释义');
  return records;
}

async function captureText(value, passageId, originalSentence = '') {
  const records = await recognizeText(value, passageId, originalSentence);
  await mutate((data) => { for (const info of records) addWord(data, passageId, info); });
  records.forEach((info) => selected.add(`${passageId}:${info.word}`));
  if (currentPassage()?.id === passageId) render();
  message(`已识别 ${records.length} 个词/短语，归入 ${passageId}。候选释义请按当前语境确认。`);
}

function findSentence(text, word) {
  if (!text || !word) return '';
  const clean = word.trim();
  if (clean.includes(' ')) {
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const regex = new RegExp(`(?<![a-z])(${escaped})(?![a-z])`, 'i');
    const sentences = text.replace(/\n+/g, ' ').match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [];
    const matched = sentences.find((s) => regex.test(s));
    if (matched) return matched.trim();
  }
  return sentenceFor(text, clean);
}

async function receiveSync(event) {
  if (!store?.ready || !store.data.settings.autoSync) return false;
  if (store.data.processedEvents.includes(event.id)) return true;
  const enriched = [];
  for (const item of event.words) {
    let info = {};
    try { info = await dictionary.lookup(item.word); }
    catch { /* Passage and supplied definitions remain usable without the dictionary asset. */ }
    enriched.push({ ...info, ...item, contextMeaning: item.contextMeaning || info.contextMeaning,
      phonetic: item.phonetic || info.phonetic, pos: item.pos || info.pos,
      sentence: item.sentence || findSentence(event.activeText ||
        store.data.passageProgress[event.passageId]?.activeText || '', item.word),
      dictionaryMeaning: info.dictionaryMeaning || '', meaningSource: item.contextMeaning ? 'source' : 'dictionary' });
  }
  if (event.selection && store.data.settings.capture) {
    enriched.push(...await recognizeText(event.selection, event.passageId, event.selectionSentence));
  }
  await mutate((data) => {
    if (!data.settings.autoSync) return;
    applySync(data, event, data.settings.capture ? enriched :
      enriched.filter((info) => event.words.some((item) => item.word.toLowerCase() === info.word.toLowerCase())));
  });
  if (!store.data.processedEvents.includes(event.id)) return false;
  if (currentPassage()?.id === event.passageId) {
    enriched.forEach((info) => selected.add(`${event.passageId}:${info.word.toLowerCase()}`));
    render();
  }
  if ($('bridge-status')) $('bridge-status').textContent = `已接收 ${event.passageId} · ${date(event.sentAt)}`;
  if (!event.activeText) await ensureText(event.passageId);
  return true;
}

const bridge = new Bridge(receiveSync, (status) => { if ($('bridge-status')) $('bridge-status').textContent = status; });

async function clipboardRead(manual = false) {
  if (!manual && (!store.data.settings.capture || document.visibilityState !== 'visible' ||
      !document.hasFocus() || document.querySelector('dialog[open]') || clipboardDenied)) return;
  if (clipboardPolling) return;
  clipboardPolling = true;
  try {
    if (!navigator.clipboard?.readText) throw new Error('此浏览器不支持剪贴板读取，请直接粘贴');
    const value = await navigator.clipboard.readText();
    if (!value || (!manual && value === lastClipboard)) return;
    lastClipboard = value;
    if (manual) $('capture-text').value = value.slice(0, 10000);
    else await captureText(value.slice(0, 10000), store.data.settings.activePassageId);
  } catch (error) {
    if (!manual) clipboardDenied = true;
    message(manual ? `剪贴板未授权，请粘贴导入：${error.message}` :
      '自动剪贴板读取未授权。请点击“读取剪贴板”授权，或使用 Chrome Userscript 捕获。', true);
  } finally { clipboardPolling = false; }
}

function extractPhraseFromSelection(container) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null;
  const raw = sel.toString().trim();
  if (!raw || raw.length > 100) return null;
  const normalized = raw
    .replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  if (!/^[a-z][a-z'-]*(?: [a-z][a-z'-]*){1,5}$/i.test(normalized)) return null;
  const para = range.startContainer.parentElement?.closest('p');
  const sourceText = para?.textContent || currentPassage()?.activeText || '';
  const sentence = findSentence(sourceText, normalized) || findSentence(currentPassage()?.activeText || '', normalized);
  const tokens = [...container.querySelectorAll('.token')].filter((t) => range.intersectsNode(t));
  return { phrase: normalized, sentence, tokens };
}

function setup() {
  for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => { view = button.dataset.view; render(); };
  for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => $(button.dataset.close).close();
  on('settings-open', 'click', () => {
    const aiCfg = getAIConfig();
    if ($('ai-enabled')) $('ai-enabled').checked = aiCfg.enabled;
    if ($('ai-endpoint')) $('ai-endpoint').value = aiCfg.endpoint;
    if ($('ai-key')) $('ai-key').value = aiCfg.apiKey;
    if ($('ai-model')) $('ai-model').value = aiCfg.model;
    $('settings-dialog').showModal();
  });
  for (const id of ['ai-enabled', 'ai-endpoint', 'ai-key', 'ai-model']) {
    $(id)?.addEventListener('change', () => {
      saveAIConfig({
        enabled: $('ai-enabled') ? $('ai-enabled').checked : true,
        endpoint: $('ai-endpoint')?.value || '',
        apiKey: $('ai-key')?.value || '',
        model: $('ai-model')?.value || ''
      });
    });
  }
  on('passage-select', 'change', (e) => changePassage(e.target.value));
  loadPassageFontSize();
  on('font-dec', 'click', () => applyPassageFontSize(passageFontSize - 1));
  on('font-inc', 'click', () => applyPassageFontSize(passageFontSize + 1));
  on('font-reset', 'click', () => applyPassageFontSize(DEFAULT_FONT_SIZE));
  on('passage-picker-trigger', 'click', () => {
    const menu = $('passage-picker-menu');
    const trigger = $('passage-picker-trigger');
    if (!menu || !trigger) return;
    menu.hidden = !menu.hidden;
    trigger.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (event) => {
    const picker = $('passage-picker');
    const menu = $('passage-picker-menu');
    const trigger = $('passage-picker-trigger');
    if (picker && menu && !menu.hidden && !picker.contains(event.target)) {
      menu.hidden = true;
      trigger?.setAttribute('aria-expanded', 'false');
    }
  });
  on('passage-form', 'submit', async () => {
    const id = $('manual-id').value.trim();
    const isLocked = activeSession() &&
      (activeSession().passageIds?.length > 1 ? !activeSession().passageIds.includes(id) : activeSession().passageId !== id);
    if (isLocked) throw new Error('请先退出当前批次');
    await mutate((data) => {
      const p = ensurePassage(data, id);
      p.title = $('manual-title').value.trim() || p.title;
      if ($('manual-text').value.trim()) p.activeText = $('manual-text').value.trim();
      data.settings.activePassageId = id;
    });
    $('manual-switch').open = false;
    await ensureText(id);
    render();
  });
  on('add-open', 'click', () => openEditor());
  on('lookup', 'click', async () => {
    if (!$('edit-word').value.trim()) throw new Error('请先输入英文单词或短语');
    fillLookup(await dictionary.lookup($('edit-word').value));
  });
  on('ai-lookup', 'click', async () => {
    const word = $('edit-word').value.trim();
    if (!word) throw new Error('请先输入英文单词或短语');
    const btn = $('ai-lookup');
    if (btn) { btn.disabled = true; btn.textContent = '✨ 翻译中...'; }
    $('dictionary-reference').textContent = '✨ AI 正在结合原句分析精准词义...';
    try {
      const aiInfo = await dictionary.aiLookup(word, $('edit-sentence').value.trim());
      if (aiInfo) fillLookup(aiInfo);
      else $('dictionary-reference').textContent = 'AI 暂未返回结果，请重试或手动补充。';
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '✨ AI 语境翻译'; }
    }
  });
  on('inline-ai-translate', 'click', async () => {
    const word = $('inline-edit-word').value.trim();
    if (!word) throw new Error('请先输入英文单词或短语');
    await triggerInlineAITranslate(word, $('inline-edit-sentence').value.trim(), ++inlineGeneration);
  });
  on('word-form', 'submit', async () => {
    const contextMeaning = $('edit-meaning').value.trim();
    if (!chineseMeaning(contextMeaning)) throw new Error('篇章释义需包含中文，才能生成中文测试选项');
    await mutate((data) => addWord(data, editorPassage, {
      word: $('edit-word').value, phonetic: $('edit-phonetic').value,
      pos: $('edit-pos').value, contextMeaning, sentence: $('edit-sentence').value,
      dictionaryMeaning: editorLookup?.dictionaryMeaning || '',
      synonyms: $('edit-synonyms').value.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean),
      manual: true
    }));
    selected.add(`${editorPassage}:${$('edit-word').value.trim().toLowerCase()}`);
    $('word-dialog').close();
    editorGeneration++;
    render();
    message(`已保存 ${editorPassage} 的篇章用法`);
  });
  on('inline-editor-close', 'click', () => {
    inlineGeneration++;
    clearSelectingTokens();
    $('inline-editor-card').hidden = true;
  });
  on('inline-word-form', 'submit', async () => {
    const contextMeaning = $('inline-edit-meaning').value.trim();
    if (!chineseMeaning(contextMeaning)) throw new Error('篇章释义需包含中文，才能生成中文测试选项');
    const cleanWord = $('inline-edit-word').value.trim().toLowerCase().replace(/\s+/g, ' ');
    await mutate((data) => addWord(data, editorPassage, {
      word: cleanWord, phonetic: $('inline-edit-phonetic').value,
      pos: $('inline-edit-pos').value, contextMeaning, sentence: $('inline-edit-sentence').value,
      dictionaryMeaning: editorLookup?.dictionaryMeaning || '',
      synonyms: Array.isArray(editorLookup?.synonyms) ? editorLookup.synonyms : [],
      manual: true
    }));
    selected.add(`${editorPassage}:${cleanWord}`);
    clearSelectingTokens();
    $('inline-editor-card').hidden = true;
    render();
    message(`已收录「${cleanWord}」到本篇生词本`);
  });
  $('word-dialog')?.addEventListener('close', () => editorGeneration++);
  $('passage-content')?.addEventListener('mouseup', () => {
    const container = $('passage-content');
    const extracted = extractPhraseFromSelection(container);
    if (!extracted) return;
    const p = currentPassage();
    if (!p) return;
    const generation = ++lookupGeneration;
    guarded(async () => {
      if (generation !== lookupGeneration) return;
      await openInlineEditor(
        extracted.phrase,
        extracted.sentence,
        p.id,
        store.data.vocabRecords[`${p.id}:${extracted.phrase}`] || null,
        extracted.tokens
      );
    });
  });
  $('passage-content')?.addEventListener('click', (event) => {
    const token = event.target.closest('.token');
    const selText = window.getSelection()?.toString().trim() || '';
    if (!token || (selText && selText.length > token.textContent.length)) return;
    const p = currentPassage();
    const generation = ++lookupGeneration;
    guarded(async () => {
      if (generation !== lookupGeneration) return;
      await openInlineEditor(
        token.dataset.word,
        findSentence(p.activeText, token.dataset.word),
        p.id,
        store.data.vocabRecords[`${p.id}:${token.dataset.word}`] || null,
        [token]
      );
    });
  });
  on('capture-form', 'submit', async () => {
    await captureText($('capture-text').value, store.data.settings.activePassageId);
    $('capture-text').value = '';
  });
  on('clipboard-import', 'click', () => { clipboardDenied = false; return clipboardRead(true); });
  if ($('select-all')) {
    $('select-all').onchange = () => {
      currentPassage()?.wordIds.forEach((id) => $('select-all').checked ? selected.add(id) : selected.delete(id));
      render();
    };
  }
  if ($('select-due')) {
    $('select-due').onclick = () => {
      selected.clear();
      wordsFor(currentPassage()).filter((w) => isWordDueToday(w)).forEach((w) => selected.add(w.id));
      render();
    };
  }
  on('review-filter-all', 'click', () => { reviewFilterDueOnly = false; render(); });
  on('review-filter-due', 'click', () => { reviewFilterDueOnly = true; render(); });
  on('skip-to-quiz', 'click', async () => {
    const learning = store.data.learningSession;
    if (!learning?.wordIds?.length) return;
    const passageIds = learning.passageIds?.length > 1
      ? learning.passageIds
      : [...new Set(learning.wordIds.map((id) => store.data.vocabRecords[id]?.passageId).filter(Boolean))];
    if (passageIds.length > 1) {
      await startMultiPassageQuizBatch(passageIds, learning.wordIds, { skipConfirm: true });
    } else {
      await startPassageBatch(learning.passageId || passageIds[0], learning.wordIds, 'quiz');
    }
  });
  on('start-learn', 'click', async () => {
    if (activeSession() && !confirm('将退出当前批次并开始新批次，已保存的熟练度不会丢失。继续？')) return;
    await mutate((data) => {
      data.learningSession = null;
      data.quizSession = null;
      startLearning(data, data.settings.activePassageId, currentPassage().wordIds.filter((id) => selected.has(id)));
    });
    view = 'learn'; render();
  });
  on('reveal', 'click', () => mutate((data) => {
    if (data.learningSession) data.learningSession.revealed = !data.learningSession.revealed;
  }));
  on('known', 'click', () => mutate((data) => reviewLearning(data, true)));
  on('unknown', 'click', () => mutate((data) => markUnknown(data)));
  on('prev-word', 'click', () => mutate((data) => {
    if (data.learningSession && data.learningSession.activeWordIds?.length) {
      const total = data.learningSession.activeWordIds.length;
      data.learningSession.index = (data.learningSession.index - 1 + total) % total;
      data.learningSession.revealed = false;
    }
  }));
  on('next-word', 'click', () => mutate((data) => {
    if (data.learningSession && data.learningSession.activeWordIds?.length) {
      const total = data.learningSession.activeWordIds.length;
      data.learningSession.index = (data.learningSession.index + 1) % total;
      data.learningSession.revealed = false;
    }
  }));
  const beginQuiz = async (batch) => {
    const learning = store.data.learningSession;
    if (batch && (!learning || (learning.activeWordIds && learning.activeWordIds.length > 0))) {
      throw new Error('请先完成当前批次背诵');
    }
    const ids = batch ? learning.wordIds : currentPassage().wordIds.filter((id) => selected.has(id));
    const targetWords = structuredClone(ids.map((id) => store.data.vocabRecords[id]).filter(Boolean));
    if (activeSession() && !batch && !confirm('开始选中词测试将替换当前批次，继续？')) return;
    const passageIds = [...new Set(targetWords.map((w) => w?.passageId).filter(Boolean))];
    const isMulti = batch ? Boolean(learning?.passageIds?.length > 1 || passageIds.length > 1) : passageIds.length > 1;
    for (const pid of passageIds) {
      await ensureText(pid);
    }
    try { await dictionary.load(); }
    catch { message('离线词库暂不可用，将尝试使用已保存的篇章词库生成选项。'); }
    for (const w of targetWords) {
      if (!w.pos && dictionary.map) {
        const entry = dictionary.map.get(String(w.word || '').trim().toLowerCase());
        const pos = entry?.t?.match(/\b(adj|adv|vt|vi|v|n|a|prep|pron|conj|num)\./i)?.[1] || '';
        if (pos) w.pos = pos;
      }
    }
    await mutate((data) => {
      if (!batch) data.learningSession = null;
      if (passageIds.length) data.settings.activePassageId = passageIds[0];
      startQuiz(
        data,
        targetWords,
        dictionary.fallback?.length ? dictionary.fallback : Object.values(data.vocabRecords),
        Math.random,
        { allowMultiplePassages: isMulti }
      );
    });
    view = 'quiz'; render();
  };
  on('batch-quiz', 'click', () => beginQuiz(true));
  on('start-selected-quiz', 'click', () => beginQuiz(false));
  const quit = async () => {
    if (activeSession() && !confirm('退出当前批次？已保存的学习状态不会丢失，未完成测试不会计入成绩。')) return;
    await mutate((data) => { data.learningSession = null; data.quizSession = null; });
    view = 'extract'; render();
  };
  on('leave-session', 'click', quit);
  on('quit-quiz', 'click', quit);
  on('forget-word', 'click', () => handleForgetCurrentQuizWord());
  on('unsure', 'click', () => mutate((data) => answerQuiz(data, null)));
  on('next-question', 'click', () => mutate((data) => nextQuiz(data)));
  on('auto-sync', 'change', () => mutate((data) => { data.settings.autoSync = $('auto-sync').checked; }));
  on('capture-enabled', 'change', () => {
    clipboardDenied = false;
    return mutate((data) => { data.settings.capture = $('capture-enabled').checked; });
  });
  on('export-data', 'click', async () => {
    await store.tail;
    // Export remains available even when a browser mirror cannot be flushed.
    try { await store.flush(); } catch (error) { message(error.message, true); }
    const blob = new Blob([store.exportJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ielts-vocab-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
  on('import-data', 'change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 32 * 1024 * 1024) throw new Error('备份文件不能超过 32 MB');
    const parsed = JSON.parse(await file.text());
    const validated = parsed.schemaVersion ? validateData(parsed) : migrateLegacy(parsed);
    if (!confirm(`将恢复 ${Object.keys(validated.vocabRecords).length} 个词并替换当前记录。已导出当前备份吗？`)) return;
    await store.restore(validated);
    selected.clear();
    lastSelectedPassage = '';
    $('settings-dialog').close();
    if (!booted) await finishBoot();
    view = store.data.quizSession ? 'quiz' : store.data.learningSession ? 'learn' : 'extract';
    render();
    message('备份已恢复');
  });
  document.addEventListener('keydown', (event) => {
    if (event.repeat || event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey ||
        document.querySelector('dialog[open]') || event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox]')) return;
    let action;
    if (view === 'learn' && store?.data.learningSession) {
      const batch = store.data.learningSession;
      batch.activeWordIds ||= [...batch.wordIds];
      if (batch.activeWordIds.length > 0) {
        if (event.code === 'Space') {
          action = () => mutate((data) => { data.learningSession.revealed = !data.learningSession.revealed; });
        } else if (event.key === 'ArrowLeft') {
          action = () => mutate((data) => {
            const total = data.learningSession.activeWordIds.length;
            if (total > 0) {
              data.learningSession.index = (data.learningSession.index - 1 + total) % total;
              data.learningSession.revealed = false;
            }
          });
        } else if (event.key === 'ArrowRight') {
          action = () => mutate((data) => {
            const total = data.learningSession.activeWordIds.length;
            if (total > 0) {
              data.learningSession.index = (data.learningSession.index + 1) % total;
              data.learningSession.revealed = false;
            }
          });
        } else if (event.key === 'ArrowDown' || event.key === '1') {
          action = () => mutate((data) => reviewLearning(data, true));
        } else if (event.key === 'ArrowUp' || event.key === '2') {
          action = () => mutate((data) => markUnknown(data));
        }
      }
    } else if (view === 'quiz' && store?.data.quizSession && !store.data.quizSession.completed) {
      const quiz = store.data.quizSession;
      if (/^[1-4]$/.test(event.key) && !quiz.feedback && !quiz.reviewBreak) {
        action = () => mutate((data) => answerQuiz(data, Number(event.key) - 1));
      } else if (event.key === '5' && !quiz.reviewBreak) {
        action = () => handleForgetCurrentQuizWord();
      }
      if (event.key === 'Enter' && (quiz.feedback || quiz.reviewBreak)) {
        action = () => mutate((data) => nextQuiz(data));
      }
    }
    if (action) { event.preventDefault(); guarded(action); }
  });
}

async function finishBoot() {
  if (!store.data.settings.activePassageId) {
    const validP = Object.values(store.data.passageProgress).filter((item) => !item.id.startsWith('suite-')).sort((a, b) => b.practicedAt - a.practicedAt);
    if (validP.length > 0) store.data.settings.activePassageId = validP[0].id;
    else store.data.settings.activePassageId = 'p1-high-01';
  }
  if (!currentPassage()) await store.transaction((data) => ensurePassage(data, data.settings.activePassageId));
  const session = activeSession();
  if (session && store.data.settings.activePassageId !== session.passageId) {
    await store.transaction((data) => { data.settings.activePassageId = session.passageId; });
  }
  view = store.data.quizSession ? 'quiz' : store.data.learningSession ? 'learn' : 'extract';
  booted = true;
  render();
  try { await store.flush(); }
  catch (error) { message(`恢复记录已载入，镜像同步失败：${error.message}`, true); }
  bridge.start();
  bridge.loadManifest().then((m) => { if (m) render(); }).catch(() => {});
  clipboardTimer = setInterval(() => clipboardRead(false), 3000);
  ensureText(store.data.settings.activePassageId).catch(() => {});
  checkIdleBacklogOnBoot();
}

function checkIdleBacklogOnBoot() {
  try {
    const now = Date.now();
    const idleDays = getIdleDaysSinceLastStudy(now);
    if (idleDays < 3) return;
    const todayKey = String(startOfDay(now));
    if (globalThis.localStorage?.getItem('ielts_vocab_backlog_prompt_day') === todayKey) return;
    const duePassages = Object.values(store.data.passageProgress || {})
      .filter((p) => p && !String(p.id).startsWith('suite-'))
      .map((p) => {
        const allWords = (p.wordIds || []).map((id) => store.data.vocabRecords[id]).filter(Boolean);
        if (!canPostponePassageWords(allWords, now)) return [];
        return allWords.filter((w) => isWordDueToday(w, now));
      })
      .filter((list) => list.length > 0);
    if (duePassages.length < 2) return;
    const totalDue = duePassages.reduce((s, list) => s + list.length, 0);
    globalThis.localStorage?.setItem('ielts_vocab_backlog_prompt_day', todayKey);
    if (confirm(`🏖️ 欢迎回来！检测到您已间隔 ${idleDays} 天未复习，当前积压了 ${duePassages.length} 篇（共 ${totalDue} 词）待复习。\n\n是否一键将积压词平滑分摊到未来 5 天（今日仅保留 1 篇）？`)) {
      guarded(async () => {
        let res;
        await mutate((data) => {
          res = rescheduleBacklog(data, { days: 5, keepTodayPassages: 1 }, now);
        });
        message(`已保留今日 1 篇，其余 ${res.postponedPassages} 篇（${res.postponedWords} 词）已均匀分摊到未来 5 天！`);
      });
    }
  } catch { /* ignore */ }
}

function extractWrongQuestionsFromComparison(comparison) {
  if (!comparison || typeof comparison !== 'object') return null;
  return Object.entries(comparison)
    .filter(([, q]) => q && (q.isCorrect === false || q.correct === false))
    .slice(0, 200)
    .map(([qid, q]) => ({
      id: String(q.questionId || qid).slice(0, 100),
      question: String(q.question || '').slice(0, 5000),
      answer: String(q.userAnswer ?? q.answer ?? '').slice(0, 2000),
      correctAnswer: String(q.correctAnswer ?? '').slice(0, 2000)
    }));
}

function parseRecordTimestamp(raw) {
  if (!raw) return 0;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  const num = Number(raw);
  if (Number.isFinite(num) && num > 0) return num;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

let lastSeenMainDbMaxTs = 0;

async function importFromMainDatabase() {
  if (!window.indexedDB || !store?.ready) return 0;
  try {
    const req = window.indexedDB.open('IELTSAtlasDataV2');
    return new Promise((resolve) => {
      req.onerror = () => resolve(0);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('practiceSummaries')) {
          db.close();
          return resolve(0);
        }
        const storeNames = ['practiceSummaries'];
        const hasDetails = db.objectStoreNames.contains('practiceDetails');
        if (hasDetails) storeNames.push('practiceDetails');
        const tx = db.transaction(storeNames, 'readonly');
        const summariesReq = tx.objectStore('practiceSummaries').getAll();
        const detailsReq = hasDetails ? tx.objectStore('practiceDetails').getAll() : null;

        tx.oncomplete = async () => {
          db.close();
          const summaryRows = summariesReq.result || [];
          const detailRows = detailsReq?.result || [];
          const detailsByRecordId = new Map();
          for (const r of detailRows) {
            const detail = r.data || r;
            const key = r.id || r.recordId || detail?.id || detail?.recordId;
            if (key) detailsByRecordId.set(key, detail);
          }

          let imported = 0;
          let latestExamId = '';
          let latestTimestamp = 0;
          const manifest = globalThis.__READING_EXAM_MANIFEST__;

          const candidates = [];
          for (const row of summaryRows) {
            const d = row.data || row;
            if (!d || d.type === 'listening' || d.module === 'listening' || d.category === 'listening') continue;
            const recordId = row.id || row.recordId || d.id || d.recordId;
            const detail = recordId ? detailsByRecordId.get(recordId) : null;
            const rowTs = parseRecordTimestamp(d.completedAt || d.timestamp || d.date || row.updatedAt) || 1;

            if (Array.isArray(d.suiteEntrySummaries) && d.suiteEntrySummaries.length > 0) {
              const detailEntries = Array.isArray(detail?.suiteEntries) ? detail.suiteEntries : [];
              for (const sub of d.suiteEntrySummaries) {
                const subId = sub.examId || sub.id;
                if (!subId || String(subId).startsWith('suite-')) continue;
                const matchingDetail = detailEntries.find((de) => (de.examId || de.id) === subId);
                candidates.push({
                  examId: String(subId),
                  title: manifest?.[subId]?.title || sub.title || String(subId),
                  timestamp: parseRecordTimestamp(sub.completedAt || sub.timestamp) || rowTs,
                  wrongQuestions: extractWrongQuestionsFromComparison(
                    matchingDetail?.answerComparison || matchingDetail?.results?.answerComparison || sub.answerComparison
                  )
                });
              }
              continue;
            }

            const examId = d.examId || d.metadata?.examId || (typeof d.id === 'string' && !d.id.startsWith('rec_') ? d.id : '');
            if (!examId || String(examId).startsWith('suite-')) continue;
            candidates.push({
              examId: String(examId),
              title: manifest?.[examId]?.title || d.title || d.metadata?.title || String(examId),
              timestamp: rowTs,
              wrongQuestions: extractWrongQuestionsFromComparison(
                detail?.answerComparison || detail?.results?.answerComparison || d.answerComparison
              )
            });
          }

          if (!candidates.length) return resolve(0);

          let switchedActive = false;
          await store.transaction((data) => {
            const prevMaxSync = Math.max(
              lastSeenMainDbMaxTs,
              ...Object.values(data.passageProgress).map((item) => item.lastSyncAt || 0)
            );
            for (const item of candidates) {
              if (!/^[a-zA-Z0-9_-]+$/.test(item.examId)) continue;
              const isNew = !Object.hasOwn(data.passageProgress, item.examId);
              const p = ensurePassage(data, item.examId, { title: item.title });
              if (item.title && (p.title === item.examId || !p.title)) p.title = item.title;
              if (isNew || item.timestamp > (p.lastSyncAt || 0)) {
                p.practicedAt = item.timestamp;
                p.lastSyncAt = item.timestamp;
                p.lastDetectedAt = Math.max(p.lastDetectedAt || 0, item.timestamp);
                p.source = 'IELTS-practice';
                if (item.wrongQuestions !== null) p.wrongQuestions = item.wrongQuestions;
              }
              if (item.timestamp > latestTimestamp) {
                latestTimestamp = item.timestamp;
                latestExamId = item.examId;
              }
              imported++;
            }
            if (latestTimestamp > lastSeenMainDbMaxTs) {
              lastSeenMainDbMaxTs = latestTimestamp;
            }
            const hasTrulyNewPractice = latestTimestamp > prevMaxSync;
            if (hasTrulyNewPractice && latestExamId && data.settings.autoSync &&
                !data.learningSession && (!data.quizSession || data.quizSession.completed)) {
              const current = data.passageProgress[data.settings.activePassageId];
              const currentTouch = Math.max(current?.lastDetectedAt || 0, current?.lastSyncAt || 0);
              if (!current || latestTimestamp > currentTouch) {
                data.settings.activePassageId = latestExamId;
                switchedActive = true;
              }
            }
          });
          if (booted && switchedActive) {
            render();
            ensureText(store.data.settings.activePassageId).catch(() => {});
          }
          resolve(imported);
        };
        tx.onerror = () => {
          db.close();
          resolve(0);
        };
      };
    });
  } catch (_) {
    return 0;
  }
}

async function init() {
  setup();
  const remote = await bridge.connect();
  if ($('disk-path')) {
    if (bridge.config) $('disk-path').textContent = `原子写入：${bridge.config.dataFile}`;
    else {
      if ($('install-script')) {
        $('install-script').removeAttribute('href');
        $('install-script').textContent = '同源模式无需安装脚本（跨端口需先启动本地服务）';
      }
    }
  }
  let local;
  try { local = window.localStorage; } catch { local = null; }
  store = new StorageService({ localStorage: local, remote,
    onStatus: (status) => { if ($('storage-status')) $('storage-status').textContent = status; } });

  try {
    await store.hydrate();
    await bridge.loadManifest().catch(() => {});
    try { await importFromMainDatabase(); } catch (_) {}
    try {
      const response = await fetch('./assets/passage-vocab.json');
      if (!response.ok) throw new Error();
      passageCatalog = await response.json();
    } catch { /* Optional passage catalog */ }
    try { await dictionary.load(); }
    catch (error) { message(`${error.message}；已有记录仍可查看和续测，添加词条可使用 AI 翻译或手动填写。`, true); }
    await finishBoot();
    render();
    try {
      dbSyncChannel = new BroadcastChannel('IELTSAtlasDataV2:committed');
      dbSyncChannel.onmessage = () => { importFromMainDatabase().catch(() => {}); };
    } catch (_) {}
  } catch (error) {
    message(error.message, true);
    $('app').setAttribute('aria-busy', 'false');
  }
}
const flushStorage = () => {
  store?.flush().catch((error) => { if ($('storage-status')) $('storage-status').textContent = error.message; });
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushStorage();
  else if (document.visibilityState === 'visible' && booted) {
    importFromMainDatabase().catch(() => {});
  }
});
window.addEventListener('focus', () => {
  if (booted) importFromMainDatabase().catch(() => {});
});
window.addEventListener('pagehide', () => {
  flushStorage();
  clearInterval(clipboardTimer);
  dbSyncChannel?.close();
  bridge.stop();
});
window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload(); });
init();
