import { chineseMeaning } from './model.js';

export const AI_CONFIG_KEY = 'ielts_vocab_ai_config';

export function getAIConfig() {
  try {
    const raw = globalThis.localStorage?.getItem(AI_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        enabled: parsed.enabled !== false,
        endpoint: String(parsed.endpoint || '').trim(),
        apiKey: String(parsed.apiKey || '').trim(),
        model: String(parsed.model || '').trim()
      };
    }
  } catch { /* Ignore storage errors */ }
  return { enabled: true, endpoint: '', apiKey: '', model: '' };
}

export function saveAIConfig(config) {
  try {
    globalThis.localStorage?.setItem(AI_CONFIG_KEY, JSON.stringify({
      enabled: config.enabled !== false,
      endpoint: String(config.endpoint || '').trim(),
      apiKey: String(config.apiKey || '').trim(),
      model: String(config.model || '').trim()
    }));
  } catch { /* Ignore storage errors */ }
}

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
      const paths = [
        './assets/wordlists/ecdict_reading.bundle.js',
        '../assets/wordlists/ecdict_reading.bundle.js',
        '/assets/wordlists/ecdict_reading.bundle.js'
      ];
      const tryLoad = (index) => {
        if (index >= paths.length) {
          reject(new Error('离线词库加载失败，请重新加载'));
          return;
        }
        const script = document.createElement('script');
        script.src = paths[index];
        script.onload = finish;
        script.onerror = () => {
          script.remove();
          tryLoad(index + 1);
        };
        document.head.append(script);
      };
      tryLoad(0);
    }).catch((error) => { this.loading = null; throw error; });
    return this.loading;
  }

  async lookup(word) {
    const clean = word.trim().toLowerCase().replace(/\s+/g, ' ');
    const isPhrase = clean.includes(' ');
    try { await this.load(); } catch { /* Allow manual or AI lookup even if offline bundle fails */ }
    const lookupSingle = (w) => {
      if (!this.map) return null;
      const candidates = [w, w.replace(/ies$/, 'y'), w.replace(/es$/, ''),
        w.replace(/s$/, ''), w.replace(/ied$/, 'y'), w.replace(/ed$/, ''),
        w.replace(/d$/, ''), w.replace(/ing$/, ''), w.replace(/ing$/, 'e'),
        w.replace(/([a-z])\1(?:ed|ing)$/, '$1')];
      return candidates.map((candidate) => this.map.get(candidate)).find(Boolean) || null;
    };
    if (this.map) {
      const direct = this.map.get(clean);
      if (direct) return { ...normalizeEntry(direct), word: clean };
      if (!isPhrase) {
        const entry = lookupSingle(clean);
        if (entry) return { ...normalizeEntry(entry), word: clean };
      } else {
        const parts = clean.split(' ').filter(Boolean);
        const partEntries = parts.map((p) => {
          const found = lookupSingle(p);
          return found ? { part: p, norm: normalizeEntry(found) } : null;
        }).filter(Boolean);
        if (partEntries.length) {
          const refText = partEntries
            .map(({ part, norm }) => `${part}: ${norm.contextMeaning || norm.dictionaryMeaning}`)
            .join(' ｜ ');
          return {
            word: clean,
            phonetic: '',
            contextMeaning: '',
            dictionaryMeaning: `逐词离线参考：${refText}`,
            pos: 'phr.',
            synonyms: [],
            meaningSource: 'dictionary'
          };
        }
      }
    }
    return {
      word: clean,
      phonetic: '',
      contextMeaning: '',
      dictionaryMeaning: '',
      pos: isPhrase ? 'phr.' : '',
      synonyms: [],
      meaningSource: 'dictionary'
    };
  }

  async aiLookup(word, sentence = '') {
    const clean = word.trim().toLowerCase().replace(/\s+/g, ' ');
    const isPhrase = clean.includes(' ');
    const cfg = getAIConfig();
    const prompt = [
      '你是雅思阅读词汇专家。请结合给定的英文原句，分析目标单词或短语在该语境中的确切含义。',
      `目标词/短语: "${clean}"`,
      sentence ? `原句语境: "${sentence.slice(0, 600)}"` : '',
      '请严格只输出一个 JSON 对象（不要输出 markdown 代码块或其他文字），格式如下：',
      '{"pos":"词性缩写，如 n. / v. / adj. / adv. / phr.","phonetic":"/音标/","contextMeaning":"词性. 在本句中的简明中文释义（12字以内，适合做四选一测试选项）","synonyms":["同义词或同义短语1","同义词2"],"sentenceTranslation":"原句的中文翻译"}'
    ].filter(Boolean).join('\n');

    let endpoint = cfg.endpoint || 'https://text.pollinations.ai/openai';
    if (cfg.endpoint && !cfg.endpoint.endsWith('/chat/completions') && !cfg.endpoint.includes('pollinations.ai')) {
      endpoint = cfg.endpoint.replace(/\/+$/, '') + '/chat/completions';
    }
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    const body = {
      model: cfg.model || (cfg.apiKey ? 'deepseek-chat' : 'openai'),
      messages: [
        { role: 'system', content: 'You are a helpful IELTS vocabulary assistant that outputs only valid JSON.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2
    };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(9000)
      });
      if (!res.ok) throw new Error(`AI HTTP ${res.status}`);
      const data = await res.json();
      const rawContent = data?.choices?.[0]?.message?.content || '';
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const pos = String(parsed.pos || (isPhrase ? 'phr.' : '')).trim().slice(0, 30);
        let meaning = String(parsed.contextMeaning || parsed.meaning || '').trim();
        if (pos && meaning && !/^[a-z]+\./i.test(meaning)) {
          meaning = `${pos} ${meaning}`;
        }
        const synonyms = Array.isArray(parsed.synonyms)
          ? parsed.synonyms.map((s) => String(s).trim()).filter(Boolean).slice(0, 6)
          : [];
        const sentenceTrans = String(parsed.sentenceTranslation || '').trim();
        const refParts = [];
        if (synonyms.length) refParts.push(`同义替换：${synonyms.join(' / ')}`);
        if (sentenceTrans) refParts.push(`原句译文：${sentenceTrans}`);
        return {
          word: clean,
          pos,
          phonetic: String(parsed.phonetic || '').trim().slice(0, 100),
          contextMeaning: meaning.slice(0, 500),
          dictionaryMeaning: refParts.join(' · ') || meaning,
          synonyms,
          meaningSource: 'dictionary',
          fromAI: true
        };
      }
    } catch { /* Fall back to lightweight web translation */ }

    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(clean)}&langpair=en|zh-CN`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        const translated = String(data?.responseData?.translatedText || '').trim();
        if (chineseMeaning(translated)) {
          const pos = isPhrase ? 'phr.' : '';
          return {
            word: clean,
            pos,
            phonetic: '',
            contextMeaning: pos ? `${pos} ${translated}` : translated,
            dictionaryMeaning: `在线翻译：${translated}`,
            synonyms: [],
            meaningSource: 'dictionary',
            fromAI: true
          };
        }
      }
    } catch { /* Ignore fallback error */ }

    return null;
  }
}
