import { meaningKey } from './quizOptions.js';

export const SCHEMA_VERSION = 2;
export const LEGACY_KEY = 'ielts_reading_vocab_tasks_v1';
export const STATES = ['new', 'learning', 'review', 'mastered'];
export const clone = (value) => structuredClone(value);
export const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const wordId = (passageId, word) => `${passageId}:${word.toLowerCase().trim()}`;
export const chineseMeaning = (text) => typeof text === 'string' && /[\u3400-\u9fff]/u.test(text);
const safeKey = (key, max = 240) => typeof key === 'string' && key.length > 0 && key.length <= max &&
  !['__proto__', 'constructor', 'prototype'].includes(key);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 200000) => typeof value === 'string' && value.length <= max;
const number = (value) => Number.isFinite(value) && value >= 0;
const validWord = (value) => text(value, 100) && /^[a-z][a-z'-]*(?: [a-z][a-z'-]*){0,5}$/i.test(value);

export function emptyData() {
  return {
    schemaVersion: SCHEMA_VERSION, revision: 0, updatedAt: 0,
    passageProgress: {}, vocabRecords: {}, quizHistory: [],
    learningSession: null, quizSession: null,
    settings: { activePassageId: 'p1-high-01', autoSync: true, capture: false },
    processedEvents: []
  };
}

export function ensurePassage(data, id, info = {}) {
  if (!safeKey(id)) throw new Error('篇章 ID 无效');
  if (!Object.hasOwn(data.passageProgress, id)) {
    data.passageProgress[id] = {
      id, title: info.title || id, activeText: '', book: '', test: '', passage: '',
      practicedAt: Date.now(), masteryRate: 0, wordIds: [], wrongQuestions: [], source: 'manual',
      lastSyncAt: 0, lastDetectedAt: 0
    };
  }
  return data.passageProgress[id];
}

export function addWord(data, passageId, info) {
  const word = String(info.word || '').trim().toLowerCase();
  if (!/^[a-z][a-z'-]*(?: [a-z][a-z'-]*){0,5}$/i.test(word) || word.length > 100) {
    throw new Error('请输入英文单词或短语（最多六个词）');
  }
  const id = wordId(passageId, word);
  const passage = ensurePassage(data, passageId);
  const existing = data.vocabRecords[id];
  const record = existing || {
    id, passageId, word, phonetic: '', contextMeaning: '', dictionaryMeaning: '',
    meaningSource: 'dictionary', sentence: '', synonyms: [], pos: '',
    status: 'new', errors: 0, proficiency: 0, streak: 0, repetitions: 0,
    ease: 2.5, intervalDays: 0, nextReviewAt: 0, lastStudiedAt: 0,
    addedAt: Date.now(), updatedAt: Date.now()
  };
  // Synchronization never replaces a learner-confirmed contextual definition.
  for (const key of ['phonetic', 'sentence', 'dictionaryMeaning', 'pos']) {
    if (typeof info[key] === 'string' && (!existing || !record[key] || info.manual)) record[key] = info[key].slice(0, 10000);
  }
  if (typeof info.contextMeaning === 'string' && (!existing || record.meaningSource !== 'manual' || info.manual)) {
    record.contextMeaning = info.contextMeaning.trim().slice(0, 2000);
    record.meaningSource = info.manual ? 'manual' : (info.meaningSource || 'dictionary');
  }
  if (Array.isArray(info.synonyms) && (!existing || info.manual ||
      (!record.synonyms.length && record.meaningSource !== 'manual'))) {
    record.synonyms = info.synonyms.filter((s) => text(s, 200)).slice(0, 30);
  }
  record.updatedAt = Date.now();
  data.vocabRecords[id] = record;
  if (!passage.wordIds.includes(id)) passage.wordIds.push(id);
  recalculate(data, passageId);
  return record;
}

export function recalculate(data, passageId) {
  const passage = data.passageProgress[passageId];
  if (!passage) return;
  const words = passage.wordIds.map((id) => data.vocabRecords[id]).filter(Boolean);
  passage.masteryRate = words.length ? words.filter((w) => w.status === 'mastered').length / words.length : 0;
}

export function schedule(record, correct, now = Date.now()) {
  record.updatedAt = now;
  record.lastStudiedAt = now;
  if (!correct) {
    record.errors++;
    record.streak = 0;
    record.repetitions = 0;
    record.proficiency = Math.max(0, record.proficiency - 1);
    record.ease = Math.max(1.3, record.ease - 0.2);
    record.intervalDays = 0;
    record.nextReviewAt = now + 10 * 60 * 1000;
    record.status = 'learning';
    return;
  }
  record.proficiency++;
  record.streak++;
  record.repetitions++;
  record.intervalDays = record.repetitions === 1 ? 1 : record.repetitions === 2 ? 3 :
    Math.max(4, Math.round(record.intervalDays * record.ease));
  record.nextReviewAt = now + record.intervalDays * 86400000;
  record.status = record.streak >= 2 ? 'mastered' : 'review';
}

export function migrateLegacy(tasks) {
  if (!object(tasks)) throw new Error('旧版数据格式无效');
  const data = emptyData();
  for (const [id, task] of Object.entries(tasks)) {
    if (!safeKey(id) || !object(task) || !object(task.words)) throw new Error('旧版篇章数据无效');
    const passage = ensurePassage(data, id);
    passage.practicedAt = Number(task.updatedAt) || Date.now();
    for (const value of Object.values(task.words)) {
      const record = addWord(data, id, {
        ...value, contextMeaning: value.meaning || '', dictionaryMeaning: value.meaning || ''
      });
      record.status = value.stage === 'known' ? 'review' : value.stage === 'review' ? 'learning' : 'new';
      record.proficiency = Math.max(0, Number(value.reviewCount) || 0);
      record.lastStudiedAt = record.status === 'new' ? 0 : passage.practicedAt;
    }
  }
  const ids = Object.keys(data.passageProgress);
  if (ids.length) data.settings.activePassageId = ids[0];
  data.updatedAt = Date.now();
  return data;
}

export function validateData(input) {
  if (!object(input) || input.schemaVersion !== SCHEMA_VERSION ||
      !object(input.passageProgress) || !object(input.vocabRecords) || !Array.isArray(input.quizHistory) ||
      !object(input.settings) || !number(input.revision) || !number(input.updatedAt)) {
    throw new Error('备份格式或版本无效，未修改已有数据');
  }
  if (Object.keys(input.vocabRecords).length > 100000 || Object.keys(input.passageProgress).length > 10000) {
    throw new Error('备份数据超出容量限制');
  }
  for (const [id, p] of Object.entries(input.passageProgress)) {
    if (!safeKey(id) || !object(p) || p.id !== id || !text(p.title, 2000) || !text(p.activeText) ||
        !Array.isArray(p.wordIds) || new Set(p.wordIds).size !== p.wordIds.length ||
        !number(p.practicedAt) || !number(p.masteryRate) || p.masteryRate > 1 ||
        (p.lastDetectedAt !== undefined && !number(p.lastDetectedAt)) ||
        !Array.isArray(p.wrongQuestions) || p.wrongQuestions.some((q) => !object(q) ||
          !text(q.id, 100) || !text(q.question, 5000) || !text(q.answer, 2000) || !text(q.correctAnswer, 2000))) {
      throw new Error(`篇章数据无效：${id}`);
    }
    for (const key of p.wordIds) {
      if (!safeKey(key, 341) || input.vocabRecords[key]?.passageId !== id) throw new Error('篇章词条关联损坏');
    }
  }
  for (const [id, w] of Object.entries(input.vocabRecords)) {
    if (!safeKey(id, 341) || !object(w) || w.id !== id || !safeKey(w.passageId) ||
        !Object.hasOwn(input.passageProgress, w.passageId) ||
        !input.passageProgress[w.passageId].wordIds.includes(id) ||
        !validWord(w.word) || id !== wordId(w.passageId, w.word) ||
        !text(w.phonetic, 10000) || !text(w.sentence, 10000) ||
        !text(w.contextMeaning, 2000) || !text(w.dictionaryMeaning, 10000) || !text(w.pos, 100) ||
        !['dictionary', 'manual', 'source'].includes(w.meaningSource) ||
        !Array.isArray(w.synonyms) || w.synonyms.some((s) => !text(s, 200)) ||
        !STATES.includes(w.status) ||
        (w.lastStudiedAt !== undefined && !number(w.lastStudiedAt)) ||
        ['errors', 'proficiency', 'streak', 'repetitions', 'ease', 'intervalDays', 'nextReviewAt', 'addedAt', 'updatedAt']
          .some((key) => !number(w[key])) || w.ease < 1.3) {
      throw new Error(`词条数据无效：${id}`);
    }
  }
  if (!safeKey(input.settings.activePassageId) ||
      typeof input.settings.autoSync !== 'boolean' || typeof input.settings.capture !== 'boolean' ||
      !Array.isArray(input.processedEvents) || input.processedEvents.length > 1000 ||
      input.processedEvents.some((id) => !text(id, 300))) throw new Error('设置数据无效');
  const learning = input.learningSession;
  if (learning !== null && (!object(learning) || !safeKey(learning.id) ||
      !Object.hasOwn(input.passageProgress, learning.passageId) || !Array.isArray(learning.wordIds) ||
      !learning.wordIds.length || learning.wordIds.some((id) => input.vocabRecords[id]?.passageId !== learning.passageId) ||
      new Set(learning.wordIds).size !== learning.wordIds.length ||
      !Number.isInteger(learning.index) || learning.index < 0 || learning.index > learning.wordIds.length ||
      typeof learning.revealed !== 'boolean' || !number(learning.startedAt))) throw new Error('学习批次无效');
  const quiz = input.quizSession;
  if (quiz !== null) validateQuiz(quiz, input);
  for (const h of input.quizHistory) {
    if (!object(h) || !safeKey(h.id) || !safeKey(h.passageId) || !Array.isArray(h.wordIds) ||
        !h.wordIds.length || h.wordIds.some((id) => !safeKey(id, 341)) || !Array.isArray(h.wrongWordIds) ||
        h.wrongWordIds.some((id) => !h.wordIds.includes(id)) ||
        ['accuracy', 'attemptAccuracy', 'completedAt', 'attempts', 'firstCorrect'].some((key) => !number(h[key])) ||
        h.accuracy > 1 || h.attemptAccuracy > 1) throw new Error('测试历史无效');
  }
  if (quiz?.completed && !input.quizHistory.some((h) => h.id === quiz.id)) throw new Error('已完成测试缺少成绩记录');
  const normalized = clone(input);
  for (const word of Object.values(normalized.vocabRecords)) {
    // Version 2 backups predating this field remain importable.
    word.lastStudiedAt ??= word.status === 'new' ? 0 : word.updatedAt;
  }
  return normalized;
}

function validateQuiz(q, data) {
  if (!object(q) || !safeKey(q.id) || !safeKey(q.passageId) || !Array.isArray(q.words) || !q.words.length ||
      !Array.isArray(q.queue) || !q.queue.length || !Array.isArray(q.answers) ||
      !Array.isArray(q.wrongWordIds) || !Number.isInteger(q.index) || q.index < 0 || q.index > q.queue.length ||
      typeof q.completed !== 'boolean' || q.completed !== (q.index === q.queue.length) ||
      ['reviewTurns', 'reviewBreak'].some((key) => q[key] !== undefined &&
        (!Number.isInteger(q[key]) || q[key] < 0)) ||
      (q.reviewBreak && (q.feedback || q.completed)) ||
      !number(q.startedAt)) throw new Error('测试批次无效');
  if (q.words.some((w) => !object(w))) throw new Error('测试题池无效');
  const ids = new Set(q.words.map((w) => w.id));
  if (ids.size !== q.words.length || q.words.some((w) => !object(w) || w.passageId !== q.passageId ||
      data.vocabRecords[w.id]?.passageId !== q.passageId || !validWord(w.word) ||
      !text(w.contextMeaning, 2000) || !chineseMeaning(w.contextMeaning) ||
      !Array.isArray(w.synonyms) || w.synonyms.some((s) => !text(s, 200)) ||
      !text(w.sentence, 10000) || !text(w.phonetic, 10000))) {
    throw new Error('测试题池无效');
  }
  for (const item of q.queue) {
    if (!object(item) || !ids.has(item.wordId) || !Array.isArray(item.options) || item.options.length !== 4 ||
        item.options.some((s) => !text(s, 2000) || !chineseMeaning(s)) ||
        new Set(item.options.map(meaningKey)).size !== 4 ||
        (item.kind !== undefined && !['initial', 'retry', 'reinforcement'].includes(item.kind)) ||
        (item.correctIndex !== undefined && (!Number.isInteger(item.correctIndex) ||
          item.options[item.correctIndex] !== q.words.find((w) => w.id === item.wordId).contextMeaning)) ||
        !item.options.includes(q.words.find((w) => w.id === item.wordId).contextMeaning)) throw new Error('测试选项无效');
  }
  if (q.wrongWordIds.some((id) => !ids.has(id)) || q.answers.some((a) => !object(a) ||
      !ids.has(a.wordId) || typeof a.correct !== 'boolean' || !number(a.at) ||
      (a.turn !== undefined && (!Number.isInteger(a.turn) || a.turn < 0)) ||
      !(a.selected === null || (Number.isInteger(a.selected) && a.selected >= 0 && a.selected < 4))) ||
      q.answers.length !== q.index + (q.feedback ? 1 : 0) ||
      (q.feedback && (!object(q.feedback) || typeof q.feedback.correct !== 'boolean' ||
        !(q.feedback.selected === null || (Number.isInteger(q.feedback.selected) &&
          q.feedback.selected >= 0 && q.feedback.selected < 4))))) throw new Error('测试作答记录无效');
  for (let index = 0; index < q.answers.length; index++) {
    const answer = q.answers[index];
    const item = q.queue[index];
    const correct = answer.selected !== null &&
      item.options[answer.selected] === q.words.find((w) => w.id === item.wordId).contextMeaning;
    if (answer.wordId !== item.wordId || answer.correct !== correct ||
        (answer.turn !== undefined && (answer.turn < index ||
          answer.turn > index + (q.reviewTurns || 0) ||
          (index && answer.turn <= (q.answers[index - 1].turn ?? index - 1))))) {
      throw new Error('测试作答顺序无效');
    }
  }
  if (q.feedback && (q.feedback.correct !== q.answers.at(-1)?.correct ||
      q.feedback.selected !== q.answers.at(-1)?.selected)) throw new Error('测试反馈无效');
}

export function normalizeSync(raw) {
  if (!object(raw)) throw new Error('同步消息无效');
  const payload = raw.payload || raw;
  if (!object(payload)) throw new Error('同步内容无效');
  if (Object.hasOwn(payload, 'wrongQuestions') && !Array.isArray(payload.wrongQuestions)) {
    throw new Error('错题同步格式无效，未清空原错题');
  }
  const coordinates = [payload.book, payload.test, payload.passage].map((v) => String(v ?? '').replace(/\D/g, ''));
  const id = String(payload.passageId || (coordinates.every(Boolean) ?
    `Cam${coordinates[0]}-T${coordinates[1]}-P${coordinates[2]}` : payload.examId) || '');
  if (!safeKey(id) || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('未识别到篇章 ID，请手动选择');
  const wrong = Array.isArray(payload.wrongQuestions) ? payload.wrongQuestions : [];
  const stamp = Number(raw.sentAt || payload.timestamp) || Date.now();
  if (!number(stamp) || stamp > Date.now() + 60000) throw new Error('同步时间无效');
  const eventId = String(raw.id || `${id}-${stamp}`).slice(0, 300);
  return {
    id: eventId, sentAt: stamp, passageId: id,
    title: String(payload.title || id).slice(0, 2000),
    book: coordinates[0], test: coordinates[1], passage: coordinates[2],
    activeText: typeof payload.activeText === 'string' ? payload.activeText.slice(0, 200000) : '',
    // Omitted results mean "no update", not "clear previous wrong answers".
    wrongQuestions: Object.hasOwn(payload, 'wrongQuestions') ? wrong.slice(0, 200).filter(object).map((q) => ({
      id: String(q.id || q.questionId || '').slice(0, 100),
      question: String(q.question || '').slice(0, 5000),
      answer: String(q.answer ?? q.userAnswer ?? '').slice(0, 2000),
      correctAnswer: String(q.correctAnswer ?? '').slice(0, 2000)
    })) : null,
    words: (Array.isArray(payload.words) ? payload.words : []).slice(0, 100)
      .filter((w) => object(w) && /^[a-z][a-z'-]*(?: [a-z][a-z'-]*){0,5}$/i.test(String(w.word || '').trim()) &&
        String(w.word).trim().length <= 100).map((w) => ({
      word: String(w.word || '').slice(0, 100),
      sentence: String(w.sentence || '').slice(0, 10000),
      contextMeaning: String(w.contextMeaning || w.meaning || '').slice(0, 2000),
      phonetic: String(w.phonetic || '').slice(0, 200),
      pos: String(w.pos || '').slice(0, 100),
      synonyms: Array.isArray(w.synonyms) ? w.synonyms.filter((s) => text(s, 200)).slice(0, 30) : [],
      meaningSource: 'source'
    })),
    selection: typeof payload.selection === 'string' ? payload.selection.slice(0, 10000) : '',
    selectionSentence: typeof payload.selectionSentence === 'string' ? payload.selectionSentence.slice(0, 10000) : '',
    kind: raw.kind || 'reading', activate: payload.activate !== false
  };
}

export function applySync(data, event, enrichedWords = []) {
  if (data.processedEvents.includes(event.id)) return false;
  data.processedEvents.push(event.id);
  data.processedEvents = data.processedEvents.slice(-1000);
  const p = ensurePassage(data, event.passageId);
  const fresh = event.sentAt >= (p.lastSyncAt || 0);
  const latestSync = Math.max(0, ...Object.values(data.passageProgress)
    .map((item) => item.lastDetectedAt ?? item.lastSyncAt ?? 0));
  if (fresh) {
    p.title = event.title;
    if (event.activeText) p.activeText = event.activeText;
    p.book = event.book || p.book;
    p.test = event.test || p.test;
    p.passage = event.passage || p.passage;
    if (event.wrongQuestions !== null) p.wrongQuestions = event.wrongQuestions;
    p.practicedAt = event.sentAt;
    p.lastSyncAt = event.sentAt;
    p.source = 'IELTS-practice';
    if (event.activate !== false) p.lastDetectedAt = event.sentAt;
    if (!data.learningSession && (!data.quizSession || data.quizSession.completed) &&
        data.settings.autoSync && event.activate !== false && event.sentAt >= latestSync) data.settings.activePassageId = p.id;
  }
  for (const info of enrichedWords) addWord(data, p.id, info);
  return true;
}
