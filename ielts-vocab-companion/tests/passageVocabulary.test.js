import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPassageVocabulary, sentenceFor } from '../passageVocabulary.js';
import { addWord, applySync, emptyData, normalizeSync, validateData } from '../model.js';
import { answerQuiz, nextQuiz, startQuiz } from '../quiz.js';

const catalog = JSON.parse(await readFile(new URL('../assets/passage-vocab.json', import.meta.url), 'utf8'));
const pool = [
  { word: 'court', contextMeaning: '法庭', synonyms: [], pos: 'n.' },
  { word: 'benefit', contextMeaning: '好处', synonyms: [], pos: 'n.' },
  { word: 'increase', contextMeaning: '增加', synonyms: [], pos: 'v.' },
  { word: 'unrelated', contextMeaning: '不相关的', synonyms: [], pos: 'adj.' }
];

test('passage vocabulary uses only actual passage words and prefers checked contextual definitions', () => {
  const passage = { id: 'p1-high-01', activeText: 'The royal court rested. Tea provided benefits.' };
  const result = buildPassageVocabulary(passage, pool, catalog);
  assert.deepEqual(result.coreWords.map((word) => word.word), ['court', 'benefits']);
  assert.match(result.coreWords[0].contextMeaning, /宫廷/);
  assert.equal(result.coreWords[0].sentence, 'The royal court rested.');
  assert.equal(result.coreWords[0].meaningSource, 'source');
  assert.ok(result.synonyms.some((word) => word.synonyms.includes('royal household')));
  assert.deepEqual(passage, { id: 'p1-high-01', activeText: 'The royal court rested. Tea provided benefits.' });
});

test('unknown passage IDs get text-matched dictionary candidates, never a different passage table', () => {
  const result = buildPassageVocabulary({ id: 'Cam20-T1-P1', activeText: 'Court benefits increased.' }, pool, catalog);
  assert.ok(result.coreWords.some((word) => word.word === 'increased'));
  assert.equal(result.coreWords.find((word) => word.word === 'court').contextMeaning, '法庭');
  assert.ok(result.coreWords.every((word) => word.meaningSource === 'dictionary'));
  assert.ok(result.synonyms.every((word) => /通用/.test(word.reference)));
  assert.ok(!result.coreWords.some((word) => word.word === 'unrelated'));
  assert.deepEqual(buildPassageVocabulary({ id: 'empty', activeText: '' }, pool, catalog), { coreWords: [], synonyms: [] });
});

test('sentence offsets retain the clicked occurrence instead of the first repeated word', () => {
  const text = 'The court met. Later the court left.';
  assert.equal(sentenceFor(text, 'court', text.lastIndexOf('court')), 'Later the court left.');
  assert.equal(sentenceFor(text, 'court'), 'The court met.');
  assert.equal(sentenceFor('A courtyard.', 'court'), '');
});

test('saved manual synonyms remain passage-scoped and do not overwrite candidate definitions', () => {
  const result = buildPassageVocabulary({ id: 'other', activeText: 'The court met.' }, pool, catalog,
    [{ word: 'court', synonyms: ['royal household'], meaningSource: 'manual' },
      { word: 'unrelated', synonyms: ['irrelevant'], meaningSource: 'manual' }]);
  assert.deepEqual(result.synonyms.map((word) => word.word), ['court']);
  assert.equal(result.synonyms[0].reference, '已保存的篇章替换');
});

test('stale cross-passage events and passive suite results never steal the active reading', () => {
  const data = emptyData();
  applySync(data, normalizeSync({ id: 'active', sentAt: 3000, payload: { examId: 'p1-high-01' } }));
  applySync(data, normalizeSync({ id: 'old-tab', sentAt: 1000, payload: { examId: 'p2-low-06' } }));
  applySync(data, normalizeSync({ id: 'suite', sentAt: 5000,
    payload: { examId: 'p3-high-03', activate: false, wrongQuestions: [{ id: 'q1' }] } }));
  assert.equal(data.settings.activePassageId, 'p1-high-01');
  assert.equal(data.passageProgress['p3-high-03'].wrongQuestions.length, 1);
  assert.equal(data.passageProgress['p3-high-03'].lastDetectedAt, 0);
  applySync(data, normalizeSync({ id: 'next', sentAt: 4000, payload: { examId: 'p2-low-06' } }));
  assert.equal(data.settings.activePassageId, 'p2-low-06');
  validateData(data);
});

test('synonym enrichment preserves review progress and manually confirmed terms', () => {
  const data = emptyData();
  const record = addWord(data, 'tea', { word: 'court', contextMeaning: '宫廷' });
  record.errors = 3;
  addWord(data, 'tea', { word: 'court', synonyms: ['royal household'] });
  assert.deepEqual(record.synonyms, ['royal household']);
  assert.equal(record.errors, 3);
  addWord(data, 'tea', { word: 'court', contextMeaning: '宫廷', synonyms: [], manual: true });
  addWord(data, 'tea', { word: 'court', synonyms: ['law court'] });
  assert.deepEqual(record.synonyms, []);
});

test('namespaced passage IDs retain room for the full word ID when saved and restored', () => {
  const data = emptyData();
  const id = `imported_${'a'.repeat(231)}`;
  applySync(data, normalizeSync({ id: 'long-source', payload: { passageId: id } }),
    [{ word: 'a'.repeat(100), contextMeaning: '测试' }]);
  assert.equal(data.passageProgress[id].wordIds[0].length, 341);
  validateData(data);
  const record = data.vocabRecords[data.passageProgress[id].wordIds[0]];
  startQuiz(data, [record], [
    { word: 'first', contextMeaning: '第一' },
    { word: 'second', contextMeaning: '第二' },
    { word: 'third', contextMeaning: '第三' }
  ]);
  answerQuiz(data, data.quizSession.queue[0].correctIndex);
  nextQuiz(data);
  validateData(data);
  assert.throws(() => normalizeSync({ payload: { passageId: `${id}a` } }), /篇章 ID/);
});
