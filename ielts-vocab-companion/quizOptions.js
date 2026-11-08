const hasChinese = (value) => typeof value === 'string' && /[\u3400-\u9fff]/u.test(value);
const definition = (word) => word?.contextMeaning ?? word?.meaning ?? word?.translation;
const spelling = (word) => String(word?.word || '').normalize('NFKC').trim().toLowerCase();

export function meaningKey(value) {
  return String(value || '').normalize('NFKC').trim()
    .replace(/^(?:(?:adj|adv|vt|vi|prep|pron|conj|num|n|v|a)\s*[.\uFF0E]\s*)+/i, '')
    .replace(/[\p{P}\p{Z}\s]+/gu, '').toLowerCase();
}

function partsOfSpeech(value = '', meaning = '') {
  const aliases = { vt: 'v', vi: 'v', verb: 'v', noun: 'n', a: 'adj', adjective: 'adj', adverb: 'adv', phrase: 'phr' };
  const prefixMatch = String(meaning || '').trim().match(/^(?:(?:adj|adv|vt|vi|prep|pron|conj|num|phr|n|v|a)\s*[.\uFF0E]\s*)+/i);
  const raw = `${value || ''} ${prefixMatch ? prefixMatch[0] : ''}`;
  return new Set((raw.toLowerCase().match(/[a-z]+/g) || [])
    .map((part) => aliases[part] || part));
}

export function shuffle(items, random = Math.random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function buildQuestion(word, allVocabPool, random = Math.random) {
  const correct = definition(word)?.trim();
  if (!spelling(word) || !hasChinese(correct)) {
    throw new Error(`请先确认「${word?.word || ''}」的中文篇章释义`);
  }
  if (!Array.isArray(allVocabPool)) throw new Error('测试词库必须是数组');
  const targetPos = partsOfSpeech(word.pos, correct);
  const groups = [[], [], [], []];
  for (const candidate of allVocabPool) {
    if (!candidate || spelling(candidate) === spelling(word) ||
        (word.id && candidate.id === word.id) || !spelling(candidate) ||
        !hasChinese(definition(candidate))) continue;
    const isCircledRecord = Boolean(candidate.passageId);
    const candPos = partsOfSpeech(candidate.pos, definition(candidate));
    const samePos = targetPos.size > 0 && [...candPos].some((part) => targetPos.has(part));
    groups[(isCircledRecord ? 2 : 0) + (samePos ? 0 : 1)].push(candidate);
  }
  const seen = new Set([meaningKey(correct)]);
  const distractors = [];
  for (const group of groups) {
    for (const candidate of shuffle(group, random)) {
      const meaning = definition(candidate).trim();
      const key = meaningKey(meaning);
      if (seen.has(key)) continue;
      seen.add(key);
      distractors.push(meaning);
      if (distractors.length === 3) break;
    }
    if (distractors.length === 3) break;
  }
  if (distractors.length !== 3) throw new Error('中文干扰项不足，请加载离线词库或补充至少 3 个不同释义');
  const options = shuffle([correct, ...distractors], random);
  return { wordId: word.id, options, correctIndex: options.indexOf(correct) };
}

// Preserve the previous option-only API for existing callers.
export function generateQuizOptions(target, pool, fallback = [], random = Math.random) {
  const passageId = target.passageId || 'local-pool';
  return buildQuestion({ ...target, passageId }, [
    ...pool,
    ...fallback
  ], random).options;
}
