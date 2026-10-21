import { chineseMeaning } from './model.js';

export function normalizeEntry(entry) {
  const translation = entry.t || '';
  const pos = translation.match(/\b(adj|adv|vt|vi|v|n|a|prep|pron|conj|num)\./i)?.[1] || '';
  const meaning = translation.split(/[；\n]/u)[0].trim().slice(0, 1800);
  return {
    word: entry.w.toLowerCase(), phonetic: entry.p ? `/${entry.p}/` : '',
    contextMeaning: chineseMeaning(meaning) ? meaning : '', dictionaryMeaning: translation,
    meaningSource: 'dictionary', pos, synonyms: []
  };
}

export class Dictionary {
  async load() {
    if (this.loading) return this.loading;
    this.loading = new Promise((resolve, reject) => {
      const finish = () => {
        const entries = globalThis.__LOCAL_DICTIONARIES__?.ecdict?.entries;
        if (!entries?.length) { reject(new Error('离线词库为空')); return; }
        this.map = new Map(entries.map((e) => [e.w.toLowerCase(), e]));
        this.fallback = entries.filter((e) => e.tags?.some((tag) => ['ielts', 'toefl', 'cet6'].includes(tag)))
          .map(normalizeEntry).filter((e) => e.contextMeaning && !/人名|缩写|abbr\./i.test(e.contextMeaning));
        resolve(this);
      };
      if (globalThis.__LOCAL_DICTIONARIES__?.ecdict) return finish();
      const script = document.createElement('script');
      script.src = './assets/wordlists/ecdict_reading.bundle.js';
      script.onload = finish;
      script.onerror = () => reject(new Error('离线词库加载失败，请重新加载'));
      document.head.append(script);
    }).catch((error) => { this.loading = null; throw error; });
    return this.loading;
  }

  async lookup(word) {
    await this.load();
    const clean = word.trim().toLowerCase();
    const candidates = [clean, clean.replace(/ies$/, 'y'), clean.replace(/es$/, ''),
      clean.replace(/s$/, ''), clean.replace(/ied$/, 'y'), clean.replace(/ed$/, ''),
      clean.replace(/d$/, ''), clean.replace(/ing$/, ''), clean.replace(/ing$/, 'e'),
      clean.replace(/([a-z])\1(?:ed|ing)$/, '$1')];
    const entry = candidates.map((candidate) => this.map.get(candidate)).find(Boolean);
    return entry ? { ...normalizeEntry(entry), word: clean } :
      { word: clean, phonetic: '', contextMeaning: '', dictionaryMeaning: '', pos: '', synonyms: [], meaningSource: 'dictionary' };
  }
}
