import { chineseMeaning } from './model.js';

export function sentenceFor(text, word, offset = -1) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![a-z])${escaped}(?![a-z])`, 'i');
  for (const match of text.matchAll(/[^.!?\n]+[.!?]?/g)) {
    if (offset >= 0 ? offset >= match.index && offset < match.index + match[0].length : pattern.test(match[0])) {
      return match[0].trim();
    }
  }
  return '';
}

export function wordForms(word) {
  return [...new Set([word, word.replace(/ies$/, 'y'), word.replace(/es$/, ''),
    word.replace(/s$/, ''), word.replace(/ied$/, 'y'), word.replace(/ed$/, ''),
    word.replace(/d$/, ''), word.replace(/ing$/, ''), word.replace(/ing$/, 'e'),
    word.replace(/([a-z])\1(?:ed|ing)$/, '$1')])];
}

// Suggestions are derived from this passage only; they never mutate a study batch.
export function buildPassageVocabulary(passage, pool = [], catalog = {}, saved = []) {
  const text = passage.activeText || '';
  const entries = new Map(pool.map((entry) => [entry.word.toLowerCase(), entry]));
  const curated = catalog.passages?.[passage.id] || [];
  const suggestions = new Map();
  for (const entry of curated) {
    const sentence = sentenceFor(text, entry.word);
    if (!sentence) continue;
    suggestions.set(entry.word, { ...entries.get(entry.word), ...entry, sentence,
      meaningSource: 'source', reference: '篇章校对义', contextual: true });
  }
  for (const token of text.matchAll(/[a-z]+(?:['-][a-z]+)*/gi)) {
    const word = token[0].toLowerCase();
    if (suggestions.has(word)) continue;
    const entry = wordForms(word).map((form) => entries.get(form)).find(Boolean);
    if (!entry || !chineseMeaning(entry.contextMeaning) || word.length < 4) continue;
    suggestions.set(word, { ...entry, word, sentence: sentenceFor(text, word, token.index),
      synonyms: catalog.synonyms?.[entry.word] || [], contextual: false,
      meaningSource: 'dictionary', reference: '词典候选义，请确认语境' });
  }
  const coreWords = [...suggestions.values()].slice(0, 40);
  const synonyms = new Map();
  for (const entry of [...coreWords, ...saved]) {
    if (!entry.synonyms?.length || !sentenceFor(text, entry.word)) continue;
    synonyms.set(entry.word, { ...entry, reference: entry.meaningSource === 'manual' ?
      '已保存的篇章替换' : entry.contextual ? '篇章近义参考' : '通用近义参考，非题目替换结论' });
  }
  return { coreWords, synonyms: [...synonyms.values()] };
}
