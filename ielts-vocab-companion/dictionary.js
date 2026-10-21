(function (global) {
  'use strict';
  const DictService = {
    _dictMap: null,
    _loadingPromise: null,

    async loadDictionary() {
      if (this._dictMap) return this._dictMap;
      if (this._loadingPromise) return this._loadingPromise;
      this._loadingPromise = new Promise((resolve) => {
        const finish = () => {
          const map = new Map();
          const localDicts = global.__LOCAL_DICTIONARIES__ || {};
          if (localDicts.ecdict && Array.isArray(localDicts.ecdict.entries)) {
            localDicts.ecdict.entries.forEach((entry) => {
              if (entry.w) map.set(entry.w.toLowerCase(), entry);
            });
          }
          this._dictMap = map;
          resolve(map);
        };
        if (global.__LOCAL_DICTIONARIES__ && global.__LOCAL_DICTIONARIES__.ecdict) {
          finish();
          return;
        }
        const script = document.createElement('script');
        script.src = './assets/wordlists/ecdict_reading.bundle.js';
        script.onload = () => finish();
        script.onerror = () => {
          this._dictMap = new Map();
          resolve(this._dictMap);
        };
        document.head.appendChild(script);
      });
      return this._loadingPromise;
    },

    async lookup(word) {
      if (!word) return null;
      const clean = word.toLowerCase().trim().replace(/[^a-z0-9'-]/g, '');
      if (!clean) return null;
      const map = await this.loadDictionary();
      if (map.has(clean)) {
        const e = map.get(clean);
        return {
          word: clean,
          meaning: e.t || e.d || '暂无详细释义',
          phonetic: e.p ? `/${e.p}/` : '',
          detail: e.d || ''
        };
      }
      if (clean.endsWith('s') && map.has(clean.slice(0, -1))) {
        const e = map.get(clean.slice(0, -1));
        return { word: clean, meaning: e.t || e.d, phonetic: e.p ? `/${e.p}/` : '' };
      }
      if (clean.endsWith('ed') && map.has(clean.slice(0, -2))) {
        const e = map.get(clean.slice(0, -2));
        return { word: clean, meaning: e.t || e.d, phonetic: e.p ? `/${e.p}/` : '' };
      }
      if (clean.endsWith('ing') && map.has(clean.slice(0, -3))) {
        const e = map.get(clean.slice(0, -3));
        return { word: clean, meaning: e.t || e.d, phonetic: e.p ? `/${e.p}/` : '' };
      }
      return {
        word: clean,
        meaning: '点击可手动补充释义',
        phonetic: ''
      };
    }
  };

  global.DictService = DictService;
})(typeof window !== 'undefined' ? window : globalThis);
