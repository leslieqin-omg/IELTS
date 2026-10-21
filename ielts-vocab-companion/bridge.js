(function (global) {
  'use strict';
  const DB_NAME = 'IELTSAtlasDataV2';
  const DB_VERSION = 2;
  const SUMMARY_STORE = 'practiceSummaries';
  const DETAILS_STORE = 'practiceDetails';

  const Bridge = {
    async openDB() {
      if (!window.indexedDB) return null;
      return new Promise((resolve) => {
        const req = window.indexedDB.open(DB_NAME, DB_VERSION);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });
    },

    async getRecentReadingPractices() {
      try {
        const db = await this.openDB();
        if (!db) return [];
        return new Promise((resolve) => {
          if (!db.objectStoreNames.contains(SUMMARY_STORE)) {
            db.close();
            return resolve([]);
          }
          const tx = db.transaction([SUMMARY_STORE], 'readonly');
          const store = tx.objectStore(SUMMARY_STORE);
          const req = store.getAll();
          req.onsuccess = () => {
            db.close();
            const items = req.result || [];
            const readingOnly = items.filter((row) => {
              const data = row.data || row;
              const type = data.type || data.practiceType || (data.metadata && data.metadata.type);
              const examId = data.examId || (data.metadata && data.metadata.examId);
              return (type === 'reading' || !type) && Boolean(examId);
            }).map((row) => {
              const d = row.data || row;
              return {
                id: d.id || row.id,
                examId: d.examId || (d.metadata && d.metadata.examId),
                title: d.title || (d.metadata && d.metadata.title) || d.examId,
                category: d.category || (d.metadata && d.metadata.category) || 'P1',
                score: d.score !== undefined ? d.score : (d.correctCount !== undefined ? d.correctCount : null),
                total: d.totalQuestions || d.questionCount || 13,
                timestamp: d.timestamp || d.createdAt || Date.now()
              };
            }).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            resolve(readingOnly);
          };
          req.onerror = () => {
            db.close();
            resolve([]);
          };
        });
      } catch (e) {
        console.warn('[VocabBridge] Failed to read IndexedDB:', e);
        return [];
      }
    },

    async loadExamData(examId) {
      if (!examId) return null;
      if (!global.__READING_EXAM_DATA__) {
        global.__READING_EXAM_DATA__ = {
          _exams: {},
          register(id, data) {
            this._exams[id] = data;
          },
          get(id) {
            return this._exams[id];
          }
        };
      }
      if (global.__READING_EXAM_DATA__.get(examId)) {
        return global.__READING_EXAM_DATA__.get(examId);
      }
      return new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = `../IELTS-practice/assets/generated/reading-exams/${examId}.js`;
        script.onload = () => {
          resolve(global.__READING_EXAM_DATA__.get(examId) || null);
        };
        script.onerror = (err) => {
          const fallbackScript = document.createElement('script');
          fallbackScript.src = `./assets/demo-exams/${examId}.js`;
          fallbackScript.onload = () => {
            resolve(global.__READING_EXAM_DATA__.get(examId) || null);
          };
          fallbackScript.onerror = () => {
            console.error('[VocabBridge] Script load error for exam:', examId);
            resolve(null);
          };
          document.head.appendChild(fallbackScript);
        };
        document.head.appendChild(script);
      });
    }
  };

  global.VocabBridge = Bridge;
})(typeof window !== 'undefined' ? window : globalThis);
