import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { addWord, applySync, emptyData, ensurePassage, migrateLegacy, normalizeSync, schedule, validateData } from '../model.js';
import { answerQuiz, buildQuestion, generateQuizOptions, nextQuiz, reviewLearning, shuffle, startLearning, startQuiz } from '../quiz.js';
import { meaningKey } from '../quizOptions.js';
import { normalizeEntry } from '../dictionary.js';

const fallback = [
  { word: 'resource', contextMeaning: 'n. 资源', pos: 'n' },
  { word: 'evidence', contextMeaning: 'n. 证据', pos: 'n.' },
  { word: 'habitat', contextMeaning: 'n. 栖息地', pos: 'n.' },
  { word: 'decline', contextMeaning: 'v. 减少', pos: 'v.' },
  { word: 'rapid', contextMeaning: 'adj. 迅速的', pos: 'adj.' }
];
function fixture() {
  const data = emptyData();
  const first = addWord(data, 'Cam18-T1-P1', { word: 'court', contextMeaning: 'n. 宫廷', pos: 'n.',
    sentence: 'The royal court supported tea.', manual: true });
  const second = addWord(data, 'Cam18-T1-P1', { word: 'infuse', contextMeaning: 'v. 浸泡', pos: 'v.' });
  const unrelated = addWord(data, 'Cam18-T1-P2', { word: 'court', contextMeaning: 'n. 法院', pos: 'n.', manual: true });
  return { data, first, second, unrelated };
}

test('all generated dictionary entries are readable; Chinese fallback pool and inflections exist', async () => {
  const source = await readFile(new URL('../assets/wordlists/ecdict_reading.bundle.js', import.meta.url), 'utf8');
  const sandbox = {};
  vm.runInNewContext(source, sandbox);
  const entries = sandbox.__LOCAL_DICTIONARIES__.ecdict.entries;
  assert.ok(entries.length > 20000);
  assert.ok(entries.every((e) => typeof e.w === 'string'));
  const candidates = Array.from(entries, normalizeEntry);
  assert.ok(candidates.filter((e) => e.contextMeaning).length > 10000);
  assert.ok(candidates.find((e) => e.word === 'court').contextMeaning);
});

test('same spelling in different passages has independent context and progress', () => {
  const { data, first, unrelated } = fixture();
  schedule(first, false, 1000);
  assert.equal(first.errors, 1);
  assert.equal(unrelated.errors, 0);
  assert.notEqual(first.id, unrelated.id);
  validateData(data);
});

test('duplicate capture keeps progress and manually confirmed definition', () => {
  const { data, first } = fixture();
  schedule(first, true);
  addWord(data, first.passageId, { word: 'court', contextMeaning: 'n. 法院', sentence: 'Another sentence.' });
  assert.equal(first.contextMeaning, 'n. 宫廷');
  assert.equal(first.proficiency, 1);
  assert.equal(first.sentence, 'The royal court supported tea.');
});

test('legacy tasks migrate without losing sentences or known-word progress', () => {
  const data = migrateLegacy({ tea: { updatedAt: 1000, words: {
    court: { word: 'court', meaning: '宫廷', stage: 'known', sentence: 'The court.', reviewCount: 3 }
  } } });
  validateData(data);
  assert.equal(data.vocabRecords['tea:court'].status, 'review');
  assert.equal(data.vocabRecords['tea:court'].proficiency, 3);
  assert.equal(data.settings.activePassageId, 'tea');
});

test('SM-2-style schedule resets on wrong and increases correct intervals', () => {
  const { first } = fixture();
  schedule(first, true, 1000);
  assert.equal(first.intervalDays, 1);
  schedule(first, true, 2000);
  assert.equal(first.status, 'mastered');
  assert.equal(first.intervalDays, 3);
  schedule(first, true, 3000);
  assert.ok(first.intervalDays >= 7);
  schedule(first, false, 4000);
  assert.equal(first.status, 'learning');
  assert.equal(first.streak, 0);
  assert.equal(first.nextReviewAt, 604000);
});

test('options use exactly one target definition and three unique other definitions', () => {
  const { first } = fixture();
  for (let i = 0; i < 100; i++) {
    const choices = generateQuizOptions(first, [], fallback);
    assert.equal(choices.length, 4);
    assert.equal(new Set(choices).size, 4);
    assert.equal(choices.filter((s) => s === first.contextMeaning).length, 1);
    assert.ok(choices.filter((s) => s !== first.contextMeaning).every((s) => s.startsWith('n.')));
  }
});

test('local pool is preferred and duplicate translations / same spelling are excluded', () => {
  const { first } = fixture();
  const local = [first, ...fallback.slice(0, 3), { word: 'court', contextMeaning: '法院', pos: 'n.' },
    { word: 'test', contextMeaning: 'n. 证据', pos: 'n.' }];
  const options = generateQuizOptions(first, local, [{ word: 'alien', contextMeaning: '外部词义' }]);
  assert.deepEqual(new Set(options), new Set(['n. 宫廷', 'n. 资源', 'n. 证据', 'n. 栖息地']));
});

test('insufficient / invalid Chinese choices fail explicitly, Fisher-Yates does not mutate input', () => {
  const { first } = fixture();
  assert.throws(() => generateQuizOptions(first, [], []), /不足/);
  assert.throws(() => generateQuizOptions({ word: 'alien', contextMeaning: 'unknown' }, [], fallback), /中文/);
  const source = [1, 2, 3, 4];
  assert.notDeepEqual(shuffle(source, () => 0), source);
  assert.deepEqual(source, [1, 2, 3, 4]);
});

test('learning batch freezes IDs, quiz never adds another passage or later-added word', () => {
  const { data, first, second, unrelated } = fixture();
  startLearning(data, first.passageId, [first.id, second.id]);
  addWord(data, first.passageId, { word: 'later', contextMeaning: '后来的' });
  reviewLearning(data, true);
  reviewLearning(data, true);
  assert.equal(data.learningSession.index, 2);
  startQuiz(data, data.learningSession.wordIds.map((id) => data.vocabRecords[id]), fallback);
  assert.deepEqual(data.quizSession.words.map((w) => w.id), [first.id, second.id]);
  assert.ok(!data.quizSession.queue.some((item) => item.wordId === unrelated.id));
  assert.throws(() => startQuiz(data, [first, unrelated], fallback), /范围/);
  validateData(data);
});

test('wrong and unsure append retry until correct; feedback is immutable and score uses first attempts', () => {
  const { data, first } = fixture();
  startQuiz(data, [first], fallback);
  const original = structuredClone(data.quizSession.queue[0].options);
  answerQuiz(data, null, 1000);
  assert.equal(data.quizSession.queue.length, 2);
  assert.equal(first.errors, 1);
  assert.equal(answerQuiz(data, 1), false);
  validateData(data);
  nextQuiz(data, 2000);
  assert.equal(data.quizSession.reviewBreak, 2);
  assert.equal(answerQuiz(data, 0), false);
  nextQuiz(data);
  nextQuiz(data);
  answerQuiz(data, null, 3000);
  nextQuiz(data, 4000);
  nextQuiz(data);
  nextQuiz(data);
  const correct = data.quizSession.queue[2].options.indexOf('n. 宫廷');
  answerQuiz(data, correct, 5000);
  nextQuiz(data, 6000);
  assert.equal(data.quizSession.completed, true);
  assert.equal(data.quizHistory[0].accuracy, 0);
  assert.equal(data.quizHistory[0].attemptAccuracy, 1 / 3);
  assert.equal(data.quizHistory[0].attempts, 3);
  assert.deepEqual(data.quizHistory[0].wrongWordIds, [first.id]);
  assert.equal(data.quizSession.queue.length, 3);
  assert.deepEqual(data.quizSession.queue[2].options, original);
  assert.equal(nextQuiz(data), false);
  assert.equal(data.quizHistory.length, 1);
  validateData(data);
});

test('buildQuestion prioritizes same-passage same-POS words, including unselected distractors', () => {
  const { data, first } = fixture();
  const local = fallback.slice(0, 3).map((w) => addWord(data, first.passageId, w));
  const question = buildQuestion(first, [...fallback, ...Object.values(data.vocabRecords)], () => 0.3);
  assert.deepEqual(new Set(question.options), new Set([first.contextMeaning, ...local.map((w) => w.contextMeaning)]));
  assert.equal(question.options[question.correctIndex], first.contextMeaning);
  startQuiz(data, [first], [...local, ...fallback]);
  assert.deepEqual(data.quizSession.words.map((w) => w.id), [first.id]);
  assert.ok(data.quizSession.queue.every((q) => q.wordId === first.id));
});

test('normalized meanings and POS aliases prevent duplicate distractors with global fallback', () => {
  const target = { id: 'target', word: 'target', passageId: 'tea', pos: 'verb', contextMeaning: '  v. 浸泡  ' };
  const question = buildQuestion(target, [
    { word: 'duplicate', contextMeaning: '浸泡。', pos: 'vt.' },
    { word: 'decrease', contextMeaning: 'v. 减少', pos: 'vi.' },
    { word: 'fall', contextMeaning: '减少', pos: 'verb' },
    { word: 'support', contextMeaning: '支持', pos: 'vt.' },
    { word: 'rise', contextMeaning: '增加', pos: 'v.' },
    { word: 'forest', contextMeaning: '森林', pos: 'noun' },
    { word: 'invalid', contextMeaning: 'unknown' }
  ]);
  assert.deepEqual(new Set(question.options.map(meaningKey)), new Set(['浸泡', '减少', '支持', '增加']));
  assert.equal(new Set(question.options.map(meaningKey)).size, 4);
  assert.equal(meaningKey('n. 资 源。'), meaningKey('资源'));
});

test('target snapshots and option order remain stable, failed starts are atomic', () => {
  const { data, first, second } = fixture();
  const targets = structuredClone([first, second]);
  const pool = structuredClone([...targets, ...fallback]);
  startQuiz(data, targets, pool);
  const snapshot = structuredClone(data.quizSession);
  targets[0].contextMeaning = '改变的释义';
  pool[0].sentence = 'Changed.';
  pool.length = 0;
  assert.deepEqual(data.quizSession, snapshot);
  assert.throws(() => startQuiz(data, [first], []), /不足/);
  assert.deepEqual(data.quizSession, snapshot);
  assert.throws(() => startQuiz(data, [], fallback), /范围/);
  validateData(data);
});

test('a late failure gets two intervening target-only questions before retry', () => {
  const { data, first, second } = fixture();
  const third = addWord(data, first.passageId, { word: 'porcelain', contextMeaning: '瓷器' });
  startQuiz(data, [first, second, third], fallback);
  for (let i = 0; i < 3; i++) {
    const item = data.quizSession.queue[data.quizSession.index];
    answerQuiz(data, i === 2 ? null : item.correctIndex);
    nextQuiz(data);
  }
  const q = data.quizSession;
  assert.equal(q.queue[q.index].kind, 'reinforcement');
  for (let i = 0; i < 2; i++) {
    assert.notEqual(q.queue[q.index].wordId, third.id);
    answerQuiz(data, q.queue[q.index].correctIndex);
    nextQuiz(data);
    validateData(data);
  }
  assert.equal(q.queue[q.index].wordId, third.id);
  assert.equal(q.answers.length - q.answers.findIndex((a) => !a.correct), 3);
  assert.ok(q.queue.every((item) => q.words.some((w) => w.id === item.wordId)));
  answerQuiz(data, q.queue[q.index].correctIndex);
  nextQuiz(data);
  assert.equal(q.completed, true);
  assert.equal(data.quizHistory[0].accuracy, 2 / 3);
});

test('multiple failures and reinforcement failures respect cooldown and terminate after correct retries', () => {
  const { data, first, second } = fixture();
  startQuiz(data, [first, second], fallback);
  const failures = new Map();
  let graded = 0;
  let breaks = 0;
  for (let steps = 0; steps < 100 && !data.quizSession.completed; steps++) {
    const q = data.quizSession;
    if (q.reviewBreak) {
      breaks++;
      nextQuiz(data);
    } else {
      const item = q.queue[q.index];
      const previous = q.answers.findLast((a) => a.wordId === item.wordId && !a.correct);
      if (previous) assert.ok(graded + breaks - previous.turn >= 3);
      const count = failures.get(item.wordId) || 0;
      const fail = count < 2;
      if (fail) failures.set(item.wordId, count + 1);
      answerQuiz(data, fail ? null : item.correctIndex);
      graded++;
      nextQuiz(data);
    }
    validateData(data);
  }
  assert.equal(data.quizSession.completed, true);
  assert.ok(breaks > 0);
  assert.equal(data.quizHistory[0].attempts, graded);
  assert.equal(data.quizHistory[0].accuracy, 0);
});

test('review breaks survive restoration without counting as answers or changing option positions', () => {
  const { data, first } = fixture();
  startQuiz(data, [first], fallback);
  const options = structuredClone(data.quizSession.queue[0].options);
  answerQuiz(data, null);
  nextQuiz(data);
  nextQuiz(data);
  const restored = validateData(JSON.parse(JSON.stringify(data)));
  assert.equal(restored.quizSession.reviewBreak, 1);
  assert.equal(restored.quizSession.answers.length, 1);
  nextQuiz(restored);
  assert.equal(restored.quizSession.reviewBreak, 0);
  assert.deepEqual(restored.quizSession.queue[1].options, options);
  answerQuiz(restored, restored.quizSession.queue[1].correctIndex);
  nextQuiz(restored);
  assert.equal(restored.quizSession.completed, true);
  assert.equal(restored.quizHistory[0].attempts, 2);
  validateData(restored);
});

test('a failed reinforcement question also returns to the tail with its own cooldown', () => {
  const { data, first, second } = fixture();
  startQuiz(data, [first, second], fallback);
  answerQuiz(data, data.quizSession.queue[0].correctIndex);
  nextQuiz(data);
  answerQuiz(data, null);
  nextQuiz(data);
  assert.equal(data.quizSession.queue[data.quizSession.index].kind, 'reinforcement');
  answerQuiz(data, null);
  nextQuiz(data);
  assert.deepEqual(new Set(data.quizSession.wrongWordIds), new Set([first.id, second.id]));
  for (let i = 0; i < 30 && !data.quizSession.completed; i++) {
    const q = data.quizSession;
    if (q.reviewBreak) nextQuiz(data);
    else {
      const item = q.queue[q.index];
      const prior = q.answers.findLast((a) => a.wordId === item.wordId && !a.correct);
      if (prior) assert.ok(q.answers.length + q.reviewTurns - prior.turn >= 3);
      answerQuiz(data, item.correctIndex);
      nextQuiz(data);
    }
    validateData(data);
  }
  assert.equal(data.quizSession.completed, true);
});

test('backup validation rejects duplicate semantic choices and invalid queue metadata', () => {
  const { data, first } = fixture();
  startQuiz(data, [first], fallback);
  for (const mutate of [
    (q) => { q.queue[0].options = ['n. 宫廷', 'n. 资源', '资源。', '证据']; },
    (q) => { q.queue[0].correctIndex = 8; },
    (q) => { q.queue[0].kind = 'external'; },
    (q) => { q.reviewBreak = -1; },
    (q) => { q.reviewTurns = 0.5; }
  ]) {
    const backup = structuredClone(data);
    mutate(backup.quizSession);
    assert.throws(() => validateData(backup), /测试/);
  }
  const old = structuredClone(data);
  delete old.quizSession.reviewTurns;
  delete old.quizSession.reviewBreak;
  for (const item of old.quizSession.queue) {
    delete item.kind;
    delete item.correctIndex;
  }
  validateData(old);
});

test('sync normalizes coordinates, deduplicates, keeps wrong answers unless explicitly updated', () => {
  const data = emptyData();
  const event = normalizeSync({ id: 'e1', sentAt: 2000,
    payload: { book: 18, test: 1, passage: 1, activeText: 'The court.',
      wrongQuestions: [{ questionId: 'q2', userAnswer: 'a', correctAnswer: 'b' }] } });
  assert.equal(event.passageId, 'Cam18-T1-P1');
  applySync(data, event);
  assert.equal(applySync(data, event), false);
  applySync(data, normalizeSync({ id: 'e2', sentAt: 3000, payload: { examId: event.passageId, activeText: 'New text.' } }));
  assert.equal(data.passageProgress[event.passageId].wrongQuestions.length, 1);
  applySync(data, normalizeSync({ id: 'older', sentAt: 1000, payload: { examId: event.passageId, activeText: 'Stale text.' } }));
  assert.equal(data.passageProgress[event.passageId].activeText, 'New text.');
  applySync(data, normalizeSync({ id: 'e3', sentAt: 4000, payload: { examId: event.passageId, wrongQuestions: [] } }));
  assert.equal(data.passageProgress[event.passageId].wrongQuestions.length, 0);
  validateData(data);
});

test('live sync never changes active batch or affects its contextual snapshot', () => {
  const { data, first } = fixture();
  data.settings.activePassageId = first.passageId;
  startLearning(data, first.passageId, [first.id]);
  applySync(data, normalizeSync({ id: 'incoming', payload: { examId: 'Cam19-T2-P1', activeText: 'Other article.' } }));
  assert.equal(data.settings.activePassageId, first.passageId);
  startQuiz(data, [first], fallback);
  addWord(data, first.passageId, { word: first.word, contextMeaning: '庭院', manual: true });
  assert.equal(data.quizSession.words[0].contextMeaning, 'n. 宫廷');
  validateData(data);
});

test('backup validation rejects broken references, unsafe keys, unknown schema and broken sessions', () => {
  const { data, first } = fixture();
  const invalid = structuredClone(data);
  invalid.vocabRecords[first.id].errors = -1;
  assert.throws(() => validateData(invalid), /词条/);
  assert.throws(() => validateData({ ...data, schemaVersion: 99 }), /版本/);
  const unsafe = structuredClone(data);
  Object.defineProperty(unsafe.passageProgress, '__proto__', { value: {}, enumerable: true });
  assert.throws(() => validateData(unsafe), /篇章/);
  startLearning(data, first.passageId, [first.id]);
  data.learningSession.index = 2;
  assert.throws(() => validateData(data), /批次/);
});

test('backup validation rejects malformed quiz snapshots and missing completion reports', () => {
  const { data, first } = fixture();
  startQuiz(data, [first], fallback);
  const nullWord = structuredClone(data);
  nullWord.quizSession.words[0] = null;
  assert.throws(() => validateData(nullWord), /题池/);
  const missingSynonyms = structuredClone(data);
  delete missingSynonyms.quizSession.words[0].synonyms;
  assert.throws(() => validateData(missingSynonyms), /题池/);
  const duplicate = structuredClone(data);
  duplicate.passageProgress[first.passageId].wordIds.push(first.id);
  assert.throws(() => validateData(duplicate), /篇章/);
  answerQuiz(data, data.quizSession.queue[0].options.indexOf(first.contextMeaning));
  nextQuiz(data);
  data.quizHistory = [];
  assert.throws(() => validateData(data), /成绩/);
});

test('malformed incoming word entries cannot poison the durable synchronization queue', () => {
  const event = normalizeSync({ id: 'sanitized', payload: {
    examId: 'Cam18-T1-P1', words: [null, {}, { word: '<script>' },
      { word: 'court', contextMeaning: '宫廷', synonyms: ['palace', null] }]
  } });
  assert.equal(event.words.length, 1);
  assert.deepEqual(event.words[0].synonyms, ['palace']);
  assert.throws(() => normalizeSync({ payload: { examId: 'Cam18-T1-P1', wrongQuestions: null } }), /错题/);
  const data = emptyData();
  applySync(data, event, event.words);
  validateData(data);
});

test('a completed quiz does not pin subsequent live reading to the old passage', () => {
  const { data, first } = fixture();
  startQuiz(data, [first], fallback);
  answerQuiz(data, data.quizSession.queue[0].options.indexOf(first.contextMeaning));
  nextQuiz(data);
  applySync(data, normalizeSync({ id: 'after-quiz', payload: { examId: 'Cam20-T1-P1' } }));
  assert.equal(data.settings.activePassageId, 'Cam20-T1-P1');
});

test('demo exam is valid and has readable passage blocks', async () => {
  let exam;
  vm.runInNewContext(await readFile(new URL('../assets/demo-exams/p1-high-01.js', import.meta.url), 'utf8'), {
    __READING_EXAM_DATA__: { register(id, data) { assert.equal(id, 'p1-high-01'); exam = data; } }
  });
  assert.ok(exam.passage.blocks[0].html.includes('court'));
  assert.equal(Object.keys(exam.answerKey).length, 13);
});
