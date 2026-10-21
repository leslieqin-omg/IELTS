import { clone, recalculate, schedule, uid } from './model.js';
import { buildQuestion } from './quizOptions.js';
export { buildQuestion, generateQuizOptions, shuffle } from './quizOptions.js';

export function startLearning(data, passageId, ids) {
  if (data.quizSession && !data.quizSession.completed) throw new Error('请先结束或退出当前测试');
  const wordIds = [...new Set(ids)];
  if (!wordIds.length || wordIds.some((id) => data.vocabRecords[id]?.passageId !== passageId)) {
    throw new Error('请选择当前篇章的单词');
  }
  data.quizSession = null;
  data.learningSession = { id: uid(), passageId, wordIds, index: 0, revealed: false, startedAt: Date.now() };
}

export function reviewLearning(data, correct) {
  const batch = data.learningSession;
  const record = batch && data.vocabRecords[batch.wordIds[batch.index]];
  if (!record) return;
  schedule(record, correct);
  recalculate(data, batch.passageId);
  batch.index++;
  batch.revealed = false;
}

export function startQuiz(data, targetWords, allVocabPool, random = Math.random) {
  if (!Array.isArray(targetWords) || !targetWords.length) throw new Error('测试范围无效：请选择目标单词');
  const passageId = targetWords[0]?.passageId;
  if (!passageId || targetWords.some((w) => !w || !w.id || w.passageId !== passageId ||
      data.vocabRecords[w.id]?.passageId !== passageId || data.vocabRecords[w.id].word !== w.word)) {
    throw new Error('测试范围无效：目标单词必须来自指定篇章');
  }
  const words = clone([...new Map(targetWords.map((word) => [word.id, word])).values()]);
  for (const word of words) word.contextMeaning = word.contextMeaning?.trim();
  // Snapshot both target words and choices exactly once; re-renders never reshuffle.
  const queue = words.map((word) => ({ ...buildQuestion(word, allVocabPool, random), kind: 'initial' }));
  const batch = data.learningSession;
  data.quizSession = {
    id: uid(), passageId, batchId: batch?.passageId === passageId &&
      batch.wordIds.length === words.length && words.every((word) => batch.wordIds.includes(word.id)) ? batch.id : null,
    words, queue, index: 0, answers: [], feedback: null, reviewTurns: 0, reviewBreak: 0,
    wrongWordIds: [], startedAt: Date.now(), completed: false
  };
}

function retryTimes(q) {
  const times = new Map();
  q.answers.forEach((answer, index) => {
    if (!answer.correct) times.set(answer.wordId, (answer.turn ?? index) + 3);
  });
  return times;
}

function prepareNext(q) {
  const turn = q.answers.length + (q.reviewTurns || 0);
  const times = retryTimes(q);
  const eligible = (item) => (times.get(item.wordId) || 0) <= turn;
  const readyIndex = q.queue.findIndex((item, index) => index >= q.index && eligible(item));
  q.reviewBreak = 0;
  if (readyIndex >= 0) {
    if (readyIndex !== q.index) q.queue.splice(q.index, 0, q.queue.splice(readyIndex, 1)[0]);
    return;
  }
  const lastId = q.answers.at(-1)?.wordId;
  const filler = q.words.find((word) => word.id !== lastId && eligible({ wordId: word.id })) ||
    q.words.find((word) => eligible({ wordId: word.id }));
  if (filler) {
    const question = q.queue.find((item) => item.wordId === filler.id);
    q.queue.splice(q.index, 0, { ...clone(question), kind: 'reinforcement' });
  } else {
    // A one-word batch (or two just-failed words) cannot supply two other quiz turns.
    q.reviewBreak = Math.min(...q.queue.slice(q.index).map((item) => times.get(item.wordId))) - turn;
  }
}

export function answerQuiz(data, selected, now = Date.now()) {
  const q = data.quizSession;
  if (!q || q.completed || q.feedback || q.reviewBreak) return false;
  if (selected !== null && (!Number.isInteger(selected) || selected < 0 || selected > 3)) return false;
  const item = q.queue[q.index];
  const target = q.words.find((w) => w.id === item.wordId);
  const correct = selected !== null && item.options[selected] === target.contextMeaning;
  q.feedback = { correct, selected };
  q.answers.push({ wordId: target.id, correct, selected, at: now,
    turn: q.answers.length + (q.reviewTurns || 0) });
  schedule(data.vocabRecords[target.id], correct, now);
  recalculate(data, q.passageId);
  if (!correct) {
    if (!q.wrongWordIds.includes(target.id)) q.wrongWordIds.push(target.id);
    q.queue.push({ ...clone(item), kind: 'retry' });
  }
  return true;
}

export function nextQuiz(data, now = Date.now()) {
  const q = data.quizSession;
  if (!q || q.completed) return false;
  if (q.reviewBreak) {
    q.reviewTurns = (q.reviewTurns || 0) + 1;
    prepareNext(q);
    return true;
  }
  if (!q.feedback) return false;
  q.index++;
  q.feedback = null;
  if (q.index === q.queue.length) {
    q.completed = true;
    const firstAttempts = q.words.map((w) => q.answers.find((a) => a.wordId === w.id));
    const firstCorrect = firstAttempts.filter((a) => a.correct).length;
    data.quizHistory.push({
      id: q.id, passageId: q.passageId, wordIds: q.words.map((w) => w.id),
      wrongWordIds: [...q.wrongWordIds], accuracy: firstCorrect / q.words.length,
      attemptAccuracy: q.answers.filter((a) => a.correct).length / q.answers.length,
      firstCorrect, attempts: q.answers.length, completedAt: now
    });
    data.learningSession = null;
  } else prepareNext(q);
  return true;
}
