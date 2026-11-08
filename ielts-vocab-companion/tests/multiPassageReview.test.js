import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { addWord, emptyData, ensurePassage, recalculate, schedule, validateData } from '../model.js';
import { answerQuiz, forgetQuizWord, nextQuiz, reviewLearning, startLearning, startQuiz } from '../quiz.js';
import { StorageService } from '../storageService.js';

const fallback = [
  { word: 'resource', contextMeaning: 'n. 资源', pos: 'n' },
  { word: 'evidence', contextMeaning: 'n. 证据', pos: 'n.' },
  { word: 'habitat', contextMeaning: 'n. 栖息地', pos: 'n.' },
  { word: 'decline', contextMeaning: 'v. 减少', pos: 'v.' },
  { word: 'rapid', contextMeaning: 'adj. 迅速的', pos: 'adj.' }
];

function fixtureMulti() {
  const data = emptyData();
  const p1Word1 = addWord(data, 'Cam18-T1-P1', {
    word: 'court', contextMeaning: 'n. 宫廷', pos: 'n.',
    sentence: 'The royal court supported tea.', manual: true
  });
  const p1Word2 = addWord(data, 'Cam18-T1-P1', {
    word: 'infuse', contextMeaning: 'v. 浸泡', pos: 'v.',
    sentence: 'Infuse the leaves in hot water.'
  });
  const p2Word1 = addWord(data, 'Cam18-T1-P2', {
    word: 'tribunal', contextMeaning: 'n. 法庭', pos: 'n.',
    sentence: 'The tribunal reached a decision.', manual: true
  });
  const p3Word1 = addWord(data, 'Cam18-T1-P3', {
    word: 'altitude', contextMeaning: 'n. 海拔', pos: 'n.',
    sentence: 'The tree grows at high altitude.'
  });
  return { data, p1Word1, p1Word2, p2Word1, p3Word1 };
}

test('multi-passage learning combines circled words across selected passages and tracks progress', () => {
  const { data, p1Word1, p1Word2, p2Word1 } = fixtureMulti();

  // Starting without allowMultiplePassages fails for cross-passage words
  assert.throws(
    () => startLearning(data, 'Cam18-T1-P1', [p1Word1.id, p2Word1.id]),
    /当前篇章/
  );

  // Starts correctly with allowMultiplePassages
  startLearning(
    data,
    ['Cam18-T1-P1', 'Cam18-T1-P2'],
    [p1Word1.id, p1Word2.id, p2Word1.id],
    { allowMultiplePassages: true }
  );

  assert.ok(data.learningSession);
  assert.deepEqual(data.learningSession.passageIds, ['Cam18-T1-P1', 'Cam18-T1-P2']);
  assert.equal(data.learningSession.passageId, 'Cam18-T1-P1');
  assert.equal(data.learningSession.totalCount, 3);
  assert.deepEqual(data.learningSession.wordIds, [p1Word1.id, p1Word2.id, p2Word1.id]);
  assert.deepEqual(data.learningSession.activeWordIds, [p1Word1.id, p1Word2.id, p2Word1.id]);
  assert.equal(data.learningSession.index, 0);
  assert.equal(data.learningSession.revealed, false);
  validateData(data);
});

test('multi-passage learning marks words known, updates passage mastery independently, and finishes batch', () => {
  const { data, p1Word1, p1Word2, p2Word1 } = fixtureMulti();

  startLearning(
    data,
    ['Cam18-T1-P1', 'Cam18-T1-P2'],
    [p1Word1.id, p1Word2.id, p2Word1.id],
    { allowMultiplePassages: true }
  );

  // Review first word (p1Word1: Cam18-T1-P1)
  reviewLearning(data, true);
  assert.equal(data.learningSession.activeWordIds.length, 2);
  validateData(data);

  // Review second word (p1Word2: Cam18-T1-P1)
  reviewLearning(data, true);
  assert.equal(data.learningSession.activeWordIds.length, 1);
  validateData(data);

  // Review third word (p2Word1: Cam18-T1-P2)
  reviewLearning(data, true);
  assert.equal(data.learningSession.activeWordIds.length, 0);
  assert.equal(data.learningSession.index, 3);
  validateData(data);
});

test('seamless transition from completed multi-passage learning batch to quiz ("测试本批")', () => {
  const { data, p1Word1, p1Word2, p2Word1 } = fixtureMulti();

  startLearning(
    data,
    ['Cam18-T1-P1', 'Cam18-T1-P2'],
    [p1Word1.id, p1Word2.id, p2Word1.id],
    { allowMultiplePassages: true }
  );
  const learningSessionId = data.learningSession.id;

  // Mark all words known
  reviewLearning(data, true);
  reviewLearning(data, true);
  reviewLearning(data, true);
  assert.equal(data.learningSession.activeWordIds.length, 0);

  // Click "测试本批" -> startQuiz with targetWords from learning batch
  const targetWords = data.learningSession.wordIds.map((id) => data.vocabRecords[id]);
  startQuiz(data, targetWords, fallback, Math.random, { allowMultiplePassages: true });

  assert.ok(data.quizSession);
  assert.equal(data.quizSession.batchId, learningSessionId);
  assert.deepEqual(data.quizSession.passageIds, ['Cam18-T1-P1', 'Cam18-T1-P2']);
  assert.equal(data.quizSession.words.length, 3);
  validateData(data);

  // Complete the quiz
  for (let i = 0; i < 3; i++) {
    const item = data.quizSession.queue[data.quizSession.index];
    answerQuiz(data, item.correctIndex, 1000 + i * 1000);
    nextQuiz(data, 1500 + i * 1000);
    validateData(data);
  }

  assert.equal(data.quizSession.completed, true);
  assert.equal(data.learningSession, null);
  assert.equal(data.quizHistory.length, 1);
  assert.deepEqual(data.quizHistory[0].passageIds, ['Cam18-T1-P1', 'Cam18-T1-P2']);
  assert.equal(data.quizHistory[0].accuracy, 1);
  validateData(data);
});

test('seamless transition to quiz via skip-to-quiz during multi-passage learning', () => {
  const { data, p1Word1, p1Word2, p2Word1 } = fixtureMulti();

  startLearning(
    data,
    ['Cam18-T1-P1', 'Cam18-T1-P2'],
    [p1Word1.id, p1Word2.id, p2Word1.id],
    { allowMultiplePassages: true }
  );

  // User studies 1 word then clicks "直接进入测试"
  reviewLearning(data, false);
  assert.equal(data.learningSession.activeWordIds.length, 3);

  // Skip to quiz: creates a multi-passage quiz containing all words in the combined batch
  const targetWords = data.learningSession.wordIds.map((id) => data.vocabRecords[id]);
  data.learningSession = null;
  startQuiz(data, targetWords, fallback, Math.random, { allowMultiplePassages: true });

  assert.deepEqual(data.quizSession.passageIds, ['Cam18-T1-P1', 'Cam18-T1-P2']);
  assert.equal(data.quizSession.words.length, 3);
  validateData(data);
});

test('direct combined testing of all circled words ("联合测试（Y 词）")', () => {
  const { data, p1Word1, p1Word2, p2Word1, p3Word1 } = fixtureMulti();

  const selectedWords = [p1Word1, p1Word2, p2Word1, p3Word1];
  startQuiz(data, selectedWords, fallback, Math.random, { allowMultiplePassages: true });

  assert.deepEqual(data.quizSession.passageIds, ['Cam18-T1-P1', 'Cam18-T1-P2', 'Cam18-T1-P3']);
  assert.equal(data.quizSession.words.length, 4);
  validateData(data);
});

test('multi-passage learning validation rejects corrupted sessions and foreign wordIds', () => {
  const { data, p1Word1, p2Word1 } = fixtureMulti();

  startLearning(
    data,
    ['Cam18-T1-P1', 'Cam18-T1-P2'],
    [p1Word1.id, p2Word1.id],
    { allowMultiplePassages: true }
  );
  validateData(data);

  // Corrupt: wordId belonging to non-included passage
  const corruptWord = structuredClone(data);
  corruptWord.learningSession.wordIds.push('Cam18-T1-P3:altitude');
  assert.throws(() => validateData(corruptWord), /学习批次/);

  // Corrupt: passageId not in passageProgress
  const corruptPassage = structuredClone(data);
  corruptPassage.learningSession.passageIds.push('nonexistent-passage');
  assert.throws(() => validateData(corruptPassage), /学习批次/);

  // Corrupt: index out of bounds
  const corruptIndex = structuredClone(data);
  corruptIndex.learningSession.index = 99;
  assert.throws(() => validateData(corruptIndex), /学习批次/);
});

test('UI code analysis: verify multi-quiz-bar has no emojis, no due-quiz button, and has combined learn and test buttons', async () => {
  const appJs = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');

  // Verify "联合测试已选到期词" button is completely removed
  assert.ok(!appJs.includes('联合测试已选到期词'));
  assert.ok(!indexHtml.includes('联合测试已选到期词'));

  // Verify combined test button text format: 联合测试（${selectedAllIds.length} 词）
  assert.ok(appJs.includes('`联合测试（${selectedAllIds.length} 词）`'));

  // Verify combined learn button text format: 联合背词（${selectedAllIds.length} 词）
  assert.ok(appJs.includes('`联合背词（${selectedAllIds.length} 词）`'));

  // Verify batch-quiz button in index.html is "测试本批"
  assert.ok(indexHtml.includes('id="batch-quiz" class="primary wide" hidden>测试本批</button>'));

  // Extract multiQuizBar rendering block from app.js and verify no emojis exist
  const barBlockMatch = appJs.match(/const multiQuizBar = \$\('multi-quiz-bar'\);[\s\S]*?multiQuizBar\.hidden = true;\s*\}/);
  assert.ok(barBlockMatch, 'multi-quiz-bar rendering block should be present in app.js');
  const barBlockCode = barBlockMatch[0];

  // Regex for emojis: Pictographic / Emoji ranges
  const emojiRegex = /\p{Extended_Pictographic}/u;
  // String literal contents inside the block should not have emojis
  const stringLiterals = barBlockCode.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) || [];
  for (const literal of stringLiterals) {
    assert.ok(
      !emojiRegex.test(literal),
      `Found emoji in multi-quiz-bar string literal: ${literal}`
    );
  }

  // Verify startMultiPassageLearnBatch is defined and called by btnMultiLearnAll
  assert.ok(appJs.includes('async function startMultiPassageLearnBatch('));
  assert.ok(appJs.includes('startMultiPassageLearnBatch(selectedPassageIds, selectedAllIds)'));

  // Verify skip-to-quiz transitions multi-passage sessions seamlessly
  assert.ok(appJs.includes('startMultiPassageQuizBatch(passageIds, learning.wordIds, { skipConfirm: true })'));
});

test('multi-quiz-bar DOM simulation: verify structure, labels, button states, and zero emojis', () => {
  function createMockElement(tag, text = '', className = '') {
    return {
      tagName: tag.toUpperCase(),
      children: [],
      className,
      textContent: text,
      hidden: false,
      disabled: false,
      type: '',
      onclick: null,
      append(...nodes) {
        for (const n of nodes) {
          if (typeof n === 'string') this.textContent += n;
          else if (n) this.children.push(n);
        }
      },
      replaceChildren(...nodes) {
        this.children = [];
        this.textContent = '';
        this.append(...nodes);
      }
    };
  }

  function simulateMultiQuizBar(circledPassages, selectedReviewPassages) {
    const multiQuizBar = createMockElement('div');
    if (circledPassages.length > 0) {
      multiQuizBar.hidden = false;
      const selectedEntries = circledPassages.filter((item) => selectedReviewPassages.has(item.p.id));
      const selectedPassageIds = selectedEntries.map((item) => item.p.id);
      const selectedDueIds = selectedEntries.flatMap((item) => item.dueWords.map((w) => w.id));
      const selectedAllIds = selectedEntries.flatMap((item) => item.words.map((w) => w.id));
      multiQuizBar.className = `multi-quiz-bar${selectedEntries.length > 0 ? ' has-selection' : ''}`;

      const info = createMockElement('div', '', 'multi-quiz-info');
      info.append(
        createMockElement(
          'span',
          selectedEntries.length > 0
            ? `多篇联合：已勾选 ${selectedEntries.length} 篇（共 ${selectedAllIds.length} 词 · 到期 ${selectedDueIds.length} 词）`
            : '多篇联合：在下方勾选多个篇章，即可合为一轮一起背词或测试'
        )
      );

      const quickSelectRow = createMockElement('div', '', 'inline-actions');
      const btnSelectVisible = createMockElement('button', '全选当前列表');
      const btnSelectDuePassages = createMockElement('button', '全选今日待复习篇章');
      const btnClearSelection = createMockElement('button', '清空勾选');
      btnClearSelection.disabled = selectedEntries.length === 0;

      const btnMultiLearnAll = createMockElement(
        'button',
        `联合背词（${selectedAllIds.length} 词）`,
        selectedAllIds.length > 0 ? 'primary' : ''
      );
      btnMultiLearnAll.disabled = selectedAllIds.length === 0;

      const btnMultiQuizAll = createMockElement(
        'button',
        `联合测试（${selectedAllIds.length} 词）`
      );
      btnMultiQuizAll.disabled = selectedAllIds.length === 0;

      quickSelectRow.append(btnSelectVisible, btnSelectDuePassages, btnClearSelection, btnMultiLearnAll, btnMultiQuizAll);
      multiQuizBar.append(info, quickSelectRow);
    } else {
      multiQuizBar.hidden = true;
    }
    return multiQuizBar;
  }

  const emojiRegex = /\p{Extended_Pictographic}/u;
  const circledPassages = [
    { p: { id: 'P1' }, words: [{ id: 'w1' }, { id: 'w2' }], dueWords: [{ id: 'w1' }] },
    { p: { id: 'P2' }, words: [{ id: 'w3' }], dueWords: [] }
  ];

  // Case 1: 2 passages selected (total 3 words)
  const barSelected = simulateMultiQuizBar(circledPassages, new Set(['P1', 'P2']));
  assert.equal(barSelected.hidden, false);
  assert.ok(barSelected.className.includes('has-selection'));

  // Collect all text from tree
  function getAllText(el) {
    let t = el.textContent || '';
    for (const child of el.children) t += ' ' + getAllText(child);
    return t;
  }

  const selectedTreeText = getAllText(barSelected);
  assert.ok(!emojiRegex.test(selectedTreeText), `Emoji found in selected bar text: ${selectedTreeText}`);
  assert.ok(!selectedTreeText.includes('联合测试已选到期词'));

  // Find buttons
  const buttonsSelected = barSelected.children[1].children;
  const learnBtn = buttonsSelected[3];
  const quizBtn = buttonsSelected[4];
  assert.equal(learnBtn.textContent, '联合背词（3 词）');
  assert.equal(learnBtn.disabled, false);
  assert.equal(learnBtn.className, 'primary');

  assert.equal(quizBtn.textContent, '联合测试（3 词）');
  assert.equal(quizBtn.disabled, false);

  // Case 2: 0 passages selected
  const barEmpty = simulateMultiQuizBar(circledPassages, new Set());
  assert.equal(barEmpty.hidden, false);
  assert.ok(!barEmpty.className.includes('has-selection'));
  const emptyTreeText = getAllText(barEmpty);
  assert.ok(!emojiRegex.test(emptyTreeText), `Emoji found in empty bar text: ${emptyTreeText}`);
  const buttonsEmpty = barEmpty.children[1].children;
  const learnBtnEmpty = buttonsEmpty[3];
  const quizBtnEmpty = buttonsEmpty[4];
  assert.equal(learnBtnEmpty.textContent, '联合背词（0 词）');
  assert.equal(learnBtnEmpty.disabled, true);
  assert.equal(quizBtnEmpty.textContent, '联合测试（0 词）');
  assert.equal(quizBtnEmpty.disabled, true);
});

test('multi-passage learning session with 10+ passages and 50+ words, mid-session persistence, and quiz completion with celebration threshold', async () => {
  const data = emptyData();
  const passages = [];
  const allWords = [];
  const letters = 'abcdefghijklmnopqrstuvwxyz';

  // 12 passages with 5 words each = 60 words
  for (let pIdx = 0; pIdx < 12; pIdx++) {
    const pid = `Passage-${letters[pIdx]}`;
    passages.push(pid);
    for (let wIdx = 0; wIdx < 5; wIdx++) {
      const wordStr = `word${letters[pIdx]}${letters[wIdx]}`;
      const word = addWord(data, pid, {
        word: wordStr,
        contextMeaning: `n. 释义${letters[pIdx]}${letters[wIdx]}`,
        pos: 'n.',
        sentence: `This is a sentence containing ${wordStr} in passage ${pid}.`,
        manual: true
      });
      allWords.push(word);
    }
  }

  assert.equal(passages.length, 12);
  assert.equal(allWords.length, 60);

  // 1. Start learning batch
  const wordIds = allWords.map((w) => w.id);
  startLearning(data, passages, wordIds, { allowMultiplePassages: true });
  assert.equal(data.learningSession.passageIds.length, 12);
  assert.equal(data.learningSession.wordIds.length, 60);
  assert.equal(data.learningSession.activeWordIds.length, 60);
  validateData(data);

  // 2. Study 20 words as known, 5 words as unknown (recycled)
  for (let i = 0; i < 20; i++) reviewLearning(data, true);
  for (let i = 0; i < 5; i++) reviewLearning(data, false);
  assert.equal(data.learningSession.activeWordIds.length, 40);
  validateData(data);

  // 3. Test mid-session persistence with StorageService
  const fakeStorage = new Map();
  const service = new StorageService({
    indexedDB: null,
    localStorage: {
      getItem: (k) => fakeStorage.get(k) ?? null,
      setItem: (k, v) => fakeStorage.set(k, String(v)),
      removeItem: (k) => fakeStorage.delete(k)
    }
  });

  await service.persist(data, 0, true);
  const reloaded = new StorageService({
    indexedDB: null,
    localStorage: {
      getItem: (k) => fakeStorage.get(k) ?? null,
      setItem: (k, v) => fakeStorage.set(k, String(v)),
      removeItem: (k) => fakeStorage.delete(k)
    }
  });
  const hydrated = await reloaded.hydrate();
  assert.ok(hydrated.learningSession);
  assert.equal(hydrated.learningSession.passageIds.length, 12);
  assert.equal(hydrated.learningSession.wordIds.length, 60);
  assert.equal(hydrated.learningSession.activeWordIds.length, 40);
  validateData(hydrated);

  // 4. Finish all remaining words in learning batch
  while (data.learningSession.activeWordIds.length > 0) {
    reviewLearning(data, true);
  }
  assert.equal(data.learningSession.activeWordIds.length, 0);

  // 5. Seamlessly transition to quiz ("测试本批")
  const targetWords = data.learningSession.wordIds.map((id) => data.vocabRecords[id]);
  const fallbackPool = [
    { word: 'distractorA', contextMeaning: 'n. 干扰项A', pos: 'n.' },
    { word: 'distractorB', contextMeaning: 'n. 干扰项B', pos: 'n.' },
    { word: 'distractorC', contextMeaning: 'n. 干扰项C', pos: 'n.' }
  ];
  startQuiz(data, targetWords, fallbackPool, Math.random, { allowMultiplePassages: true });
  assert.ok(data.quizSession);
  assert.equal(data.quizSession.words.length, 60);
  assert.equal(data.quizSession.passageIds.length, 12);

  // 6. Test mid-quiz persistence
  await service.persist(data, 0, true);
  const reloadedQuizService = new StorageService({
    indexedDB: null,
    localStorage: {
      getItem: (k) => fakeStorage.get(k) ?? null,
      setItem: (k, v) => fakeStorage.set(k, String(v)),
      removeItem: (k) => fakeStorage.delete(k)
    }
  });
  const hydratedQuiz = await reloadedQuizService.hydrate();
  assert.ok(hydratedQuiz.quizSession);
  assert.equal(hydratedQuiz.quizSession.words.length, 60);
  assert.equal(hydratedQuiz.quizSession.passageIds.length, 12);
  validateData(hydratedQuiz);

  // 7. Complete quiz with 59/60 accuracy (>= 90% celebration threshold)
  for (let i = 0; i < 58; i++) {
    const item = data.quizSession.queue[data.quizSession.index];
    answerQuiz(data, item.correctIndex);
    nextQuiz(data);
  }
  // Wrong answer on 59th
  const item59 = data.quizSession.queue[data.quizSession.index];
  answerQuiz(data, (item59.correctIndex + 1) % 4);
  nextQuiz(data);
  // Correct answer on 60th
  const item60 = data.quizSession.queue[data.quizSession.index];
  answerQuiz(data, item60.correctIndex);
  nextQuiz(data);

  // Clear remaining retried items
  while (!data.quizSession.completed) {
    if (data.quizSession.reviewBreak) nextQuiz(data);
    else {
      const it = data.quizSession.queue[data.quizSession.index];
      answerQuiz(data, it.correctIndex);
      nextQuiz(data);
    }
  }

  assert.equal(data.quizSession.completed, true);
  assert.equal(data.learningSession, null);
  assert.equal(data.quizHistory.length, 1);
  const record = data.quizHistory[0];
  assert.equal(record.accuracy, 59 / 60);
  assert.ok(record.accuracy >= 0.9);
  assert.equal(record.passageIds.length, 12);
  validateData(data);
});

test('multi-passage quiz reviewBreak label and session notice code formatting', async () => {
  const appJs = await readFile(new URL('../app.js', import.meta.url), 'utf8');

  // Verify reviewBreak title in app.js formats multi-passage label
  assert.ok(appJs.includes('q.passageIds?.length > 1'));
  assert.ok(appJs.includes('多篇联测（${q.passageIds.length} 篇）'));

  // Verify session notice in app.js formats multi-passage label
  assert.ok(appJs.includes('多篇联合（${session.passageIds.length} 篇）'));

  // Verify review card select toggle text format reflects combined learning & testing
  assert.ok(appJs.includes("isPassageChecked ? '已加入联合' : '勾选联合'"));
});

test('startLearning correctly defaults passageId when leading passage has no words in batch', () => {
  const data = emptyData();
  const word = addWord(data, 'Passage-Real', {
    word: 'resilient',
    contextMeaning: 'adj. 有韧性的',
    pos: 'adj.',
    sentence: 'The ecosystem is resilient.',
    manual: true
  });

  // passageId list has Passage-Empty first, but target words only exist in Passage-Real
  startLearning(
    data,
    ['Passage-Empty', 'Passage-Real'],
    [word.id],
    { allowMultiplePassages: true }
  );

  assert.ok(data.learningSession);
  // passageId must resolve to Passage-Real (not Passage-Empty)
  assert.equal(data.learningSession.passageId, 'Passage-Real');
  // Single passage represented in wordIds means passageIds is omitted
  assert.equal(data.learningSession.passageIds, undefined);
  // Must pass schema validation
  assert.doesNotThrow(() => validateData(data));
});

test('single-passage quiz transition from reader does not inherit isMulti from previous multi-passage learning', () => {
  const { data, p1Word1, p1Word2, p2Word1 } = fixtureMulti();

  // Active multi-passage learning session
  startLearning(
    data,
    ['Cam18-T1-P1', 'Cam18-T1-P2'],
    [p1Word1.id, p1Word2.id, p2Word1.id],
    { allowMultiplePassages: true }
  );
  assert.ok(data.learningSession.passageIds?.length > 1);

  // User decides to test only selected words from current passage (Cam18-T1-P1)
  // When batch is false, startQuiz is initiated with single-passage target words
  const selectedWords = [p1Word1, p1Word2];
  const passageIds = [...new Set(selectedWords.map((w) => w?.passageId).filter(Boolean))];
  const batch = false;
  const isMulti = batch ? Boolean(data.learningSession?.passageIds?.length > 1 || passageIds.length > 1) : passageIds.length > 1;

  assert.equal(isMulti, false);
  data.learningSession = null;
  startQuiz(data, selectedWords, fallback, Math.random, { allowMultiplePassages: isMulti });

  assert.ok(data.quizSession);
  assert.equal(data.quizSession.passageId, 'Cam18-T1-P1');
  assert.equal(data.quizSession.passageIds, undefined);
  assert.equal(data.quizSession.words.length, 2);
  validateData(data);
});

test('multi-passage quiz handles forgetQuizWord and reviewBreak with valid schema invariants', () => {
  const { data, p1Word1, p1Word2, p2Word1, p3Word1 } = fixtureMulti();

  // 4 words across 3 passages
  const selectedWords = [p1Word1, p1Word2, p2Word1, p3Word1];
  startQuiz(data, selectedWords, fallback, Math.random, { allowMultiplePassages: true });

  assert.equal(data.quizSession.words.length, 4);
  assert.deepEqual(data.quizSession.passageIds, ['Cam18-T1-P1', 'Cam18-T1-P2', 'Cam18-T1-P3']);
  validateData(data);

  // Answer first question wrong
  const q1 = data.quizSession.queue[data.quizSession.index];
  answerQuiz(data, (q1.correctIndex + 1) % 4);
  validateData(data);
  nextQuiz(data);
  validateData(data);

  // Forget second question (belonging to Cam18-T1-P1)
  const q2 = data.quizSession.queue[data.quizSession.index];
  const forgottenWordId = q2.wordId;
  const forgottenTarget = forgetQuizWord(data);
  assert.equal(forgottenTarget.id, forgottenWordId);
  // Word status should be reset to learning with nextReviewAt = now
  assert.equal(data.vocabRecords[forgottenWordId].status, 'learning');
  validateData(data);

  // Complete remaining queue, handling possible reviewBreak
  while (!data.quizSession.completed) {
    if (data.quizSession.reviewBreak) {
      nextQuiz(data);
    } else {
      const it = data.quizSession.queue[data.quizSession.index];
      answerQuiz(data, it.correctIndex);
      nextQuiz(data);
    }
    validateData(data);
  }

  assert.equal(data.quizSession.completed, true);
  assert.equal(data.quizHistory.length, 1);
  const hist = data.quizHistory[0];
  assert.deepEqual(hist.passageIds, ['Cam18-T1-P1', 'Cam18-T1-P2', 'Cam18-T1-P3']);
  assert.ok(hist.wrongWordIds.includes(forgottenWordId));
  validateData(data);
});



