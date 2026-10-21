import { addWord, applySync, chineseMeaning, ensurePassage, recalculate, validateData, migrateLegacy } from './model.js';
import { StorageService } from './storageService.js';
import { Dictionary } from './dictionary.js';
import { Bridge } from './bridge.js';
import { answerQuiz, nextQuiz, reviewLearning, startLearning, startQuiz } from './quiz.js';
import { buildPassageVocabulary, sentenceFor } from './passageVocabulary.js';

const $ = (id) => document.getElementById(id);
const dictionary = new Dictionary();
const selected = new Set();
const STATUS = { new: '未学习', learning: '需重背', review: '待复习', mastered: '已掌握' };
let store;
let view = 'extract';
let busy = false;
let editorPassage = '';
let editorLookup = null;
let editorGeneration = 0;
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
const on = (id, event, action) => $(id).addEventListener(event, (e) => {
  if (event === 'submit') e.preventDefault();
  guarded(() => action(e));
});

function highlight(sentence, word) {
  const fragment = document.createDocumentFragment();
  if (!sentence) { fragment.append(node('span', '尚无原句，请编辑词条补充真实阅读语境。', 'hint')); return fragment; }
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  const parsed = new DOMParser().parseFromString((exam.passage?.blocks || [])
    .map((block) => block.bodyHtml || block.html || '').join('\n'), 'text/html');
  parsed.querySelectorAll('script, style, button, input, .paragraph-dropzone, .dropped-items')
    .forEach((n) => n.remove());
  const paragraphs = [...parsed.querySelectorAll('p, h2, h3')].map((n) => n.textContent.trim()).filter(Boolean);
  return paragraphs.length ? paragraphs.join('\n\n') : parsed.body.textContent.trim();
}

async function ensureText(id) {
  if (store.data.passageProgress[id]?.activeText || loadingPassage === id) return;
  loadingPassage = id;
  try {
    const exam = await bridge.loadExam(id);
    if (!exam) { message(`未找到 ${id} 的本地原文，可手动粘贴或通过 Chrome 同步。`); return; }
    const activeText = htmlToText(exam);
    await mutate((data) => {
      const p = ensurePassage(data, id);
      if (!p.activeText) {
        p.activeText = activeText;
        if (p.title === id) p.title = exam.meta?.title || id;
      }
    });
  } catch (error) { message(error.message, true); }
  finally { loadingPassage = ''; }
}

function render() {
  if (!store?.ready) return;
  const data = store.data;
  const p = currentPassage();
  $('app').setAttribute('aria-busy', 'false');
  $('passage-title').textContent = p?.title || data.settings.activePassageId;
  $('passage-meta').textContent = p ? `${p.id} · ${wordsFor(p).length} 词 · 最近练习 ${date(p.practicedAt)}` : '';
  $('mastery').textContent = percent(p?.masteryRate || 0);
  $('mastery').title = '本篇词汇掌握率';
  const select = $('passage-select');
  const oldIds = [...select.options].map((o) => o.value).join('|');
  const passages = Object.values(data.passageProgress).sort((a, b) => b.practicedAt - a.practicedAt);
  const detected = passages.filter((item) => item.source === 'IELTS-practice' &&
    (item.lastDetectedAt ?? item.lastSyncAt))
    .sort((a, b) => (b.lastDetectedAt ?? b.lastSyncAt) - (a.lastDetectedAt ?? a.lastSyncAt))[0];
  $('detected-passage').hidden = !detected || !data.settings.autoSync;
  $('detected-passage').textContent = detected ?
    `已检测到正在练习：${detected.title}（${detected.id}）${activeSession() && activeSession().passageId !== detected.id ?
      '；本轮批次保持不变，新篇章已存入历史。' : ''}` : '';
  if (oldIds !== passages.map((item) => item.id).join('|') ||
      [...select.options].some((o) => o.textContent !== `${data.passageProgress[o.value]?.title} · ${o.value}`)) {
    select.replaceChildren(...passages.map((item) => {
      const option = node('option', `${item.title} · ${item.id}`);
      option.value = item.id;
      return option;
    }));
  }
  select.value = data.settings.activePassageId;
  select.disabled = false;
  if (lastSelectedPassage !== data.settings.activePassageId) {
    selected.clear();
    p?.wordIds.forEach((id) => selected.add(id));
    lastSelectedPassage = data.settings.activePassageId;
  }
  $('auto-sync').checked = data.settings.autoSync;
  $('capture-enabled').checked = data.settings.capture;
  for (const button of document.querySelectorAll('[data-view]')) {
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  for (const name of ['extract', 'learn', 'quiz', 'history']) $(`view-${name}`).hidden = view !== name;
  const session = activeSession();
  $('session-notice').hidden = !session;
  $('session-notice').textContent = session ? `批次已锁定到 ${session.passageId}。新同步篇章不会改变本轮题池；退出批次后才能切换。` : '';
  if (view === 'extract' && p) { renderPassage(p); renderWords(p); renderResources(p); }
  if (view === 'learn') renderLearn();
  if (view === 'quiz') renderQuiz();
  if (view === 'history') renderHistory();
}

function renderResources(p) {
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

function renderPassage(p) {
  const key = `${p.id}:${p.activeText}`;
  if (key !== passageRenderKey) {
    passageRenderKey = key;
    const container = $('passage-content');
    container.replaceChildren();
    if (!p.activeText) container.append(node('p', '尚无原文。可手动粘贴、等待 Chrome 同步，或直接添加生词。', 'empty'));
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
  const saved = new Set(wordsFor(p).map((w) => w.word));
  for (const token of $('passage-content').querySelectorAll('.token')) token.classList.toggle('saved', saved.has(token.dataset.word));
  $('wrong-count').textContent = p.wrongQuestions.length;
  $('wrong-questions').replaceChildren(...p.wrongQuestions.map((q) =>
    node('p', `${q.id} ${q.question}\n你的答案：${q.answer || '未作答'} · 正确答案：${q.correctAnswer || '未提供'}`)));
}

function renderWords(p) {
  const words = wordsFor(p);
  $('word-count').textContent = words.length;
  const list = $('vocab-list');
  list.replaceChildren();
  if (!words.length) list.append(node('p', '从原文点选第一个生词，或粘贴原句开始。', 'empty'));
  for (const w of words) {
    const row = node('div', '', 'vocab-row');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected.has(w.id);
    checkbox.setAttribute('aria-label', `选择 ${w.word}`);
    checkbox.onchange = () => { checkbox.checked ? selected.add(w.id) : selected.delete(w.id); updateSelection(); };
    const detail = node('div');
    detail.append(node('strong', w.word), node('small', `${w.phonetic} · ${STATUS[w.status]} · 错 ${w.errors} 次`));
    detail.append(node('p', w.contextMeaning || '尚无中文释义，请编辑'));
    detail.append(node('small', w.meaningSource === 'dictionary' ? '词典候选义 · 请确认本篇用法' : '已确认篇章义'));
    if (w.nextReviewAt) detail.append(node('small', `下次复习 ${date(w.nextReviewAt)}`));
    const tools = node('div', '', 'row-tools');
    const edit = node('button', '编辑');
    edit.onclick = () => guarded(() => openEditor(w.word, w.sentence, p.id, w));
    const remove = node('button', '移除', 'delete');
    remove.setAttribute('aria-label', `移除 ${w.word}`);
    remove.onclick = () => guarded(async () => {
      if (activeSession()?.passageId === p.id) throw new Error('本篇正在学习或测试，退出批次后才能移除');
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

function renderLearn() {
  const batch = store.data.learningSession;
  const stage = $('learn-card');
  stage.replaceChildren();
  const total = batch?.wordIds.length || 0;
  $('learn-label').textContent = batch ? `${batch.passageId} · ${Math.min(batch.index, total)} / ${total}` : '尚无学习批次';
  $('learn-progress').max = total || 1;
  $('learn-progress').value = batch?.index || 0;
  const completed = batch && batch.index >= total;
  $('learn-controls').hidden = !batch || completed;
  $('batch-quiz').hidden = !completed;
  $('leave-session').hidden = !batch;
  if (!batch) { stage.append(node('p', '回到圈词页，勾选本篇单词后开始背诵。', 'empty')); return; }
  if (completed) {
    stage.append(node('p', 'BATCH COMPLETE', 'eyebrow'), node('h2', '让记忆回到语境。'));
    stage.append(node('p', `本批 ${total} 词已过完。下一步只测试这 ${total} 词，后续加入的单词不会混入。`));
    return;
  }
  const w = store.data.vocabRecords[batch.wordIds[batch.index]];
  stage.append(node('p', `WORD ${batch.index + 1} / ${total}`, 'eyebrow'), node('h2', w.word), node('p', w.phonetic, 'phonetic'));
  stage.append(node('p', '阅读原文语境', 'context-label'), context(w));
  $('reveal').setAttribute('aria-expanded', String(batch.revealed));
  if (batch.revealed) {
    stage.append(node('p', w.contextMeaning || '尚无中文释义，请在圈词页编辑。', 'meaning'));
    if (w.synonyms.length) stage.append(node('p', `同义替换：${w.synonyms.join(' · ')}`, 'hint'));
    stage.append(node('p', w.meaningSource === 'dictionary' ? '此为词典候选义，尚未人工确认篇章用法。' : '本篇已确认用法', 'hint'));
  } else stage.append(node('p', '先在脑中回忆，再按 Space 显示释义与原句。', 'hint'));
}

function renderQuiz() {
  const q = store.data.quizSession;
  const stage = $('quiz-content');
  stage.replaceChildren();
  $('quiz-options').replaceChildren();
  $('quiz-feedback').replaceChildren();
  $('quiz-feedback').className = 'feedback';
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
    $('quiz-label').textContent = `${q.passageId} · 本轮完成`;
    stage.append(node('p', 'SESSION COMPLETE', 'eyebrow'), node('h2', `${percent(history.accuracy)} 首答正确率`));
    stage.append(node('p', `共 ${q.words.length} 词，${history.attempts} 次作答；含重测准确率 ${percent(history.attemptAccuracy)}。所有错词已在本轮答对。`));
    stage.append(node('p', `本轮错词：${q.wrongWordIds.map((id) => q.words.find((w) => w.id === id).word).join('、') || '无'}`, 'hint'));
    return;
  }
  if (q.reviewBreak) {
    $('quiz-label').textContent = `${q.passageId} · 间隔复习`;
    stage.append(node('p', 'SPACED RECALL', 'eyebrow'), node('h2', '稍后再测，先回忆语境。'));
    stage.append(node('p', `本批可用词不足以插入其他题目，还需 ${q.reviewBreak} 步复习间隔。回想原文主题与刚才的例句，再按 Enter 继续。`, 'hint'));
    stage.append(node('p', '这不是计分题，也不会加入本批以外的单词。', 'hint'));
    $('unsure').hidden = true;
    $('next-question').disabled = false;
    return;
  }
  const item = q.queue[q.index];
  const w = q.words.find((target) => target.id === item.wordId);
  const remaining = q.queue.length - q.index;
  $('quiz-label').textContent = `${q.passageId} · 已答 ${q.index} 次 · 队列剩余 ${remaining} 题`;
  const kind = item.kind === 'reinforcement' ? '间隔巩固题 · 仅使用本批目标词' :
    item.kind === 'retry' ? '错词重测' : 'MEANING IN CONTEXT';
  stage.append(node('p', kind, 'eyebrow'), node('h2', w.word), node('p', w.phonetic, 'phonetic'));
  const p = currentPassage();
  if (p && p.activeText && $('quiz-passage-content')) {
    const pContainer = $('quiz-passage-content');
    pContainer.replaceChildren();
    const targetWordLower = w.word.toLowerCase();
    let targetSpan = null;
    for (const paragraph of p.activeText.split(/\n+/).filter(Boolean)) {
      const element = node('p');
      for (const part of paragraph.split(/([a-zA-Z]+(?:['-][a-zA-Z]+)*)/g)) {
        if (/^[a-zA-Z]/.test(part)) {
          const isTarget = part.toLowerCase() === targetWordLower;
          const token = node('span', part, isTarget ? 'token target-quiz-active' : 'token');
          if (isTarget && !targetSpan) targetSpan = token;
          element.append(token);
        } else element.append(document.createTextNode(part));
      }
      pContainer.append(element);
    }
    if (targetSpan) {
      setTimeout(() => {
        targetSpan.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  } else {
    stage.append(node('p', '阅读原文 · 结合语境选择中文词义', 'context-label'), context(w));
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

function renderHistory() {
  const container = $('history-list');
  container.replaceChildren();
  if (!store.data.quizHistory.length) container.append(node('p', '完成第一轮测试后，这里会保留成绩和错词。', 'empty'));
  for (const h of [...store.data.quizHistory].reverse()) {
    const row = node('section', '', 'history-row');
    row.append(node('p', `${h.passageId} · ${date(h.completedAt)}`, 'muted'));
    row.append(node('p', `${percent(h.accuracy)} 首答正确率`, 'history-score'));
    row.append(node('p', `${h.wordIds.length} 词 · ${h.attempts} 次作答 · 含重测 ${percent(h.attemptAccuracy)}`));
    row.append(node('p', `错词：${h.wrongWordIds.map((id) => id.slice(id.indexOf(':') + 1)).join('、') || '无'}`, 'hint'));
    container.append(row);
  }
}

async function changePassage(id) {
  if (activeSession() && activeSession().passageId !== id) {
    render();
    throw new Error('当前批次已锁定，请先退出背词 / 测试，再切换篇章');
  }
  await mutate((data) => { ensurePassage(data, id); data.settings.activePassageId = id; });
  await ensureText(id);
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
  $('dictionary-reference').textContent = record?.dictionaryMeaning || '词典提供候选义；请结合原文确认，不自动猜测熟词僻义。';
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
  $('edit-phonetic').value = info.phonetic;
  $('edit-pos').value = info.pos;
  $('edit-meaning').value = info.contextMeaning;
  $('dictionary-reference').textContent = `词典参考：${info.dictionaryMeaning || '未找到，请手动补充'}`;
}

const STOP_WORDS = new Set('a an the to of in on is are was were be been being it its i you he she we they and or but as for with by from this that these those at has have had do does did not can could will would should may might than then their his her our your some all into over which who when what also such'.split(' '));

async function recognizeText(value, passageId, originalSentence = '') {
  const text = value.trim();
  if (!text || !/[a-z]/i.test(text)) throw new Error('请提供英文单词或阅读原句');
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
  message(`已识别 ${records.length} 个词，归入 ${passageId}。候选释义请按当前语境确认。`);
}

function findSentence(text, word) {
  return sentenceFor(text, word);
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
  $('bridge-status').textContent = `已接收 ${event.passageId} · ${date(event.sentAt)}`;
  if (!event.activeText) await ensureText(event.passageId);
  return true;
}

const bridge = new Bridge(receiveSync, (status) => { $('bridge-status').textContent = status; });

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

function setup() {
  for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => { view = button.dataset.view; render(); };
  for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => $(button.dataset.close).close();
  on('settings-open', 'click', () => $('settings-dialog').showModal());
  on('passage-select', 'change', (e) => changePassage(e.target.value));
  on('passage-form', 'submit', async () => {
    const id = $('manual-id').value.trim();
    if (activeSession() && activeSession().passageId !== id) throw new Error('请先退出当前批次');
    await mutate((data) => {
      const p = ensurePassage(data, id);
      p.title = $('manual-title').value.trim() || p.title;
      if ($('manual-text').value.trim()) p.activeText = $('manual-text').value.trim();
      data.settings.activePassageId = id;
    });
    $('manual-switch').open = false;
    await ensureText(id);
  });
  on('add-open', 'click', () => openEditor());
  on('lookup', 'click', async () => {
    if (!$('edit-word').value.trim()) throw new Error('请先输入英文单词');
    fillLookup(await dictionary.lookup($('edit-word').value));
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
  $('word-dialog').addEventListener('close', () => editorGeneration++);
  $('passage-content').addEventListener('click', (event) => {
    const token = event.target.closest('.token');
    if (!token || window.getSelection()?.toString().length > token.textContent.length) return;
    const p = currentPassage();
    const generation = ++lookupGeneration;
    guarded(async () => {
      if (generation !== lookupGeneration) return;
      await openEditor(token.dataset.word, findSentence(p.activeText, token.dataset.word), p.id,
        store.data.vocabRecords[`${p.id}:${token.dataset.word}`] || null);
    });
  });
  on('capture-form', 'submit', async () => {
    await captureText($('capture-text').value, store.data.settings.activePassageId);
    $('capture-text').value = '';
  });
  on('clipboard-import', 'click', () => { clipboardDenied = false; return clipboardRead(true); });
  $('select-all').onchange = () => {
    currentPassage().wordIds.forEach((id) => $('select-all').checked ? selected.add(id) : selected.delete(id));
    render();
  };
  $('select-due').onclick = () => {
    selected.clear();
    wordsFor(currentPassage()).filter((w) => w.nextReviewAt > 0 && w.nextReviewAt <= Date.now()).forEach((w) => selected.add(w.id));
    render();
  };
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
  on('unknown', 'click', () => mutate((data) => reviewLearning(data, false)));
  const beginQuiz = async (batch) => {
    const learning = store.data.learningSession;
    if (batch && (!learning || learning.index !== learning.wordIds.length)) {
      throw new Error('请先完成当前批次背诵');
    }
    const ids = batch ? learning.wordIds : currentPassage().wordIds.filter((id) => selected.has(id));
    const targetWords = structuredClone(ids.map((id) => store.data.vocabRecords[id]));
    if (activeSession() && !batch && !confirm('开始选中词测试将替换当前批次，继续？')) return;
    try { await dictionary.load(); }
    catch { message('离线词库暂不可用，将尝试使用已保存的篇章词库生成选项。'); }
    await mutate((data) => {
      if (!batch) data.learningSession = null;
      startQuiz(data, targetWords, [...Object.values(data.vocabRecords), ...(dictionary.fallback || [])]);
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
      if (batch.index < batch.wordIds.length) {
        if (event.code === 'Space') action = () => mutate((data) => { data.learningSession.revealed = !data.learningSession.revealed; });
        if (['ArrowLeft', '1'].includes(event.key)) action = () => mutate((data) => reviewLearning(data, false));
        if (['ArrowRight', '2'].includes(event.key)) action = () => mutate((data) => reviewLearning(data, true));
      }
    } else if (view === 'quiz' && store?.data.quizSession && !store.data.quizSession.completed) {
      const quiz = store.data.quizSession;
      if (/^[1-4]$/.test(event.key) && !quiz.feedback && !quiz.reviewBreak) {
        action = () => mutate((data) => answerQuiz(data, Number(event.key) - 1));
      }
      if (event.key === 'Enter' && (quiz.feedback || quiz.reviewBreak)) {
        action = () => mutate((data) => nextQuiz(data));
      }
    }
    if (action) { event.preventDefault(); guarded(action); }
  });
}

async function finishBoot() {
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
  clipboardTimer = setInterval(() => clipboardRead(false), 3000);
  await ensureText(store.data.settings.activePassageId);
}

async function init() {
  setup();
  const remote = await bridge.connect();
  if (bridge.config) $('disk-path').textContent = `原子写入：${bridge.config.dataFile}`;
  else {
    $('install-script').removeAttribute('href');
    $('install-script').textContent = '跨端口桥接需先通过 npm start 启动';
  }
  let local;
  try { local = window.localStorage; } catch { local = null; }
  store = new StorageService({ localStorage: local, remote,
    onStatus: (status) => { $('storage-status').textContent = status; } });
  try {
    await store.hydrate();
    try {
      const response = await fetch('./assets/passage-vocab.json');
      if (!response.ok) throw new Error();
      passageCatalog = await response.json();
    } catch { message('篇章校对词表不可用，仍可按原文匹配离线词典或手动收录。'); }
    try { await dictionary.load(); }
    catch (error) { message(`${error.message}；已有记录仍可查看和续测，添加词条可手动填写。`, true); }
    await finishBoot();
  } catch (error) {
    message(error.message, true);
    $('app').setAttribute('aria-busy', 'false');
  }
}
const flushStorage = () => {
  store?.flush().catch((error) => { $('storage-status').textContent = error.message; });
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushStorage();
});
window.addEventListener('pagehide', () => {
  flushStorage();
  clearInterval(clipboardTimer);
  bridge.stop();
});
window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload(); });
init();
