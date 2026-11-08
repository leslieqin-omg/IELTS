import { clone, recalculate, schedule, uid } from './model.js';
import { buildQuestion, meaningKey } from './quizOptions.js';
export { buildQuestion, generateQuizOptions, shuffle } from './quizOptions.js';

export function startLearning(data, passageId, ids, options = {}) {
  if (data.quizSession && !data.quizSession.completed) throw new Error('请先结束或退出当前测试');
  const allowMulti = Boolean(options?.allowMultiplePassages || Array.isArray(passageId));
  const wordIds = [...new Set(ids)];
  if (!wordIds.length) {
    throw new Error(allowMulti ? '请先勾选至少一篇包含待背词汇的篇章' : '请选择当前篇章的单词');
  }
  const pids = Array.isArray(passageId) ? [...new Set(passageId)] : [passageId];
  const primaryPassageId = pids[0];
  if (!allowMulti) {
    if (wordIds.some((id) => data.vocabRecords[id]?.passageId !== primaryPassageId)) {
      throw new Error('请选择当前篇章的单词');
    }
  } else {
    if (wordIds.some((id) => !data.vocabRecords[id] || (pids.length > 0 && !pids.includes(data.vocabRecords[id].passageId)))) {
      throw new Error('所选单词必须来自指定篇章');
    }
  }
  const allPassageIds = [...new Set(wordIds.map((id) => data.vocabRecords[id]?.passageId).filter(Boolean))];
  data.quizSession = null;
  data.learningSession = {
    id: uid(),
    passageId: (allPassageIds.includes(primaryPassageId) ? primaryPassageId : allPassageIds[0]) || primaryPassageId,
    ...(allPassageIds.length > 1 ? { passageIds: allPassageIds } : {}),
    wordIds,
    activeWordIds: [...wordIds],
    totalCount: wordIds.length,
    index: 0,
    revealed: false,
    startedAt: Date.now()
  };
}

export function reviewLearning(data, correct) {
  const batch = data.learningSession;
  if (!batch || !batch.wordIds.length) return;
  batch.activeWordIds ||= [...batch.wordIds];
  if (!batch.activeWordIds.length) {
    batch.index = batch.wordIds.length;
    return;
  }
  const currentId = batch.activeWordIds[batch.index % batch.activeWordIds.length];
  const record = currentId && data.vocabRecords[currentId];
  if (!record) return;
  schedule(record, correct);
  recalculate(data, record.passageId || batch.passageId);
  if (correct) {
    const currIdx = batch.index % batch.activeWordIds.length;
    batch.activeWordIds.splice(currIdx, 1);
    if (batch.activeWordIds.length === 0) {
      batch.index = batch.wordIds.length;
    } else if (batch.index >= batch.activeWordIds.length) {
      batch.index = 0;
    }
  } else {
    const currIdx = batch.index % batch.activeWordIds.length;
    batch.activeWordIds.splice(currIdx, 1);
    batch.activeWordIds.push(currentId);
    if (batch.index >= batch.activeWordIds.length) {
      batch.index = 0;
    }
  }
  batch.revealed = false;
}

export function startQuiz(data, targetWords, allVocabPool, random = Math.random, options = {}) {
  if (!Array.isArray(targetWords) || !targetWords.length) throw new Error('测试范围无效：请选择目标单词');
  const allowMulti = Boolean(options?.allowMultiplePassages);
  const passageId = targetWords[0]?.passageId;
  if (!passageId || targetWords.some((w) => !w || !w.id || !w.passageId ||
      (!allowMulti && w.passageId !== passageId) ||
      data.vocabRecords[w.id]?.passageId !== w.passageId || data.vocabRecords[w.id].word !== w.word)) {
    throw new Error('测试范围无效：目标单词必须来自指定篇章');
  }
  const words = clone([...new Map(targetWords.map((word) => [word.id, word])).values()]);
  const passageIds = [...new Set(words.map((w) => w.passageId))];
  for (const word of words) word.contextMeaning = word.contextMeaning?.trim();
  const circledSpellings = new Set([
    ...Object.values(data.vocabRecords || {}).map((w) => String(w?.word || '').trim().toLowerCase()),
    ...words.map((w) => String(w?.word || '').trim().toLowerCase())
  ]);
  const circledMeanings = new Set([
    ...Object.values(data.vocabRecords || {}).map((w) => meaningKey(w?.contextMeaning)),
    ...words.map((w) => meaningKey(w?.contextMeaning))
  ]);
  const dictOnlyPool = Array.isArray(allVocabPool)
    ? allVocabPool.filter((c) =>
        c && !c.passageId &&
        !circledSpellings.has(String(c.word || '').trim().toLowerCase()) &&
        !circledMeanings.has(meaningKey(c.contextMeaning ?? c.meaning ?? c.translation))
      )
    : [];
  const effectivePool = dictOnlyPool.length >= 3 ? dictOnlyPool : allVocabPool;
  // Snapshot both target words and choices exactly once; re-renders never reshuffle.
  const queue = words.map((word) => ({ ...buildQuestion(word, effectivePool, random), kind: 'initial' }));
  const batch = data.learningSession;
  data.quizSession = {
    id: uid(), passageId, ...(passageIds.length > 1 ? { passageIds } : {}),
    batchId: batch &&
      (batch.passageIds?.length > 1
        ? (passageIds.length === batch.passageIds.length && passageIds.every((pid) => batch.passageIds.includes(pid)))
        : (batch.passageId === passageId && passageIds.length === 1)) &&
      batch.wordIds.length === words.length && words.every((word) => batch.wordIds.includes(word.id)) ? batch.id : null,
    words, queue, index: 0, answers: [], feedback: null, reviewTurns: 0, reviewBreak: 0,
    wrongWordIds: [], startedAt: Date.now(), completed: false
  };
}

function isForgottenInQuiz(q, wordId) {
  return q.answers.some((a) => a.wordId === wordId && a.forgotten);
}

function retryTimes(q) {
  const times = new Map();
  q.answers.forEach((answer, index) => {
    if (answer.forgotten) times.delete(answer.wordId);
    else if (!answer.correct) times.set(answer.wordId, (answer.turn ?? index) + 3);
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
  const filler = q.words.find((word) => word.id !== lastId && !isForgottenInQuiz(q, word.id) && eligible({ wordId: word.id })) ||
    q.words.find((word) => !isForgottenInQuiz(q, word.id) && eligible({ wordId: word.id }));
  if (filler) {
    const question = q.queue.find((item) => item.wordId === filler.id);
    q.queue.splice(q.index, 0, { ...clone(question), kind: 'reinforcement' });
  } else {
    // A one-word batch (or two just-failed words) cannot supply two other quiz turns.
    q.reviewBreak = Math.min(...q.queue.slice(q.index).map((item) => times.get(item.wordId))) - turn;
  }
}

function finalizeQuizStep(data, q, now) {
  if (q.index === q.queue.length) {
    q.completed = true;
    const firstAttempts = q.words.map((w) => q.answers.find((a) => a.wordId === w.id)).filter(Boolean);
    const firstCorrect = firstAttempts.filter((a) => a.correct).length;
    data.quizHistory.push({
      id: q.id, passageId: q.passageId,
      ...(q.passageIds?.length > 1 ? { passageIds: [...q.passageIds] } : {}),
      wordIds: q.words.map((w) => w.id),
      wrongWordIds: [...q.wrongWordIds], accuracy: firstCorrect / q.words.length,
      attemptAccuracy: q.answers.filter((a) => a.correct).length / q.answers.length,
      firstCorrect, attempts: q.answers.length, completedAt: now
    });
    data.learningSession = null;
  } else {
    prepareNext(q);
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
  recalculate(data, target.passageId || q.passageId);
  if (!correct) {
    if (!q.wrongWordIds.includes(target.id)) q.wrongWordIds.push(target.id);
    q.queue.push({ ...clone(item), kind: 'retry' });
  }
  return true;
}

export function forgetQuizWord(data, now = Date.now()) {
  const q = data.quizSession;
  if (!q || q.completed || q.reviewBreak) return null;
  const item = q.queue[q.index];
  const target = q.words.find((w) => w.id === item?.wordId);
  if (!target) return null;
  if (q.feedback && q.answers[q.index]?.wordId === target.id) {
    q.answers[q.index].correct = false;
    q.answers[q.index].selected = null;
    q.answers[q.index].forgotten = true;
    q.answers[q.index].at = now;
  } else {
    q.answers.push({
      wordId: target.id,
      correct: false,
      selected: null,
      forgotten: true,
      at: now,
      turn: q.answers.length + (q.reviewTurns || 0)
    });
  }
  const record = data.vocabRecords[target.id];
  if (record) {
    schedule(record, false, now);
    record.nextReviewAt = now;
    record.status = 'learning';
  }
  recalculate(data, target.passageId || q.passageId);
  if (!q.wrongWordIds.includes(target.id)) q.wrongWordIds.push(target.id);
  for (let i = q.queue.length - 1; i > q.index; i--) {
    if (q.queue[i].wordId === target.id) {
      q.queue.splice(i, 1);
    }
  }
  q.index++;
  q.feedback = null;
  finalizeQuizStep(data, q, now);
  return target;
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
  finalizeQuizStep(data, q, now);
  return true;
}
