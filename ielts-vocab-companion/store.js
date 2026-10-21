(function (global) {
  'use strict';
  const STORAGE_KEY = 'ielts_reading_vocab_tasks_v1';

  const TaskStore = {
    getAllTasks() {
      try {
        const storage = (typeof window !== 'undefined' && window.localStorage) ? window.localStorage : (global.localStorage || null);
        if (!storage) return {};
        const raw = storage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch (e) {
        return {};
      }
    },

    getTask(examId) {
      if (!examId) return null;
      const all = this.getAllTasks();
      return all[examId] || {
        examId,
        words: {},
        status: 'extracting',
        testedCount: 0,
        updatedAt: Date.now()
      };
    },

    saveTask(task) {
      if (!task || !task.examId) return;
      task.updatedAt = Date.now();
      const all = this.getAllTasks();
      all[task.examId] = task;
      try {
        const storage = (typeof window !== 'undefined' && window.localStorage) ? window.localStorage : (global.localStorage || null);
        if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(all));
      } catch (e) {
        console.warn('[TaskStore] Failed to save task:', e);
      }
    },

    addWord(examId, wordData) {
      const task = this.getTask(examId);
      const wordKey = wordData.word.toLowerCase();
      task.words[wordKey] = {
        word: wordData.word,
        phonetic: wordData.phonetic || '',
        meaning: wordData.meaning || '',
        sentence: wordData.sentence || '',
        stage: 'new',
        reviewCount: 0,
        addedAt: Date.now()
      };
      this.saveTask(task);
      return task;
    },

    removeWord(examId, word) {
      const task = this.getTask(examId);
      const wordKey = word.toLowerCase();
      if (task.words[wordKey]) {
        delete task.words[wordKey];
        this.saveTask(task);
      }
      return task;
    },

    updateWordStage(examId, word, stage) {
      const task = this.getTask(examId);
      const wordKey = word.toLowerCase();
      if (task.words[wordKey]) {
        task.words[wordKey].stage = stage;
        task.words[wordKey].reviewCount = (task.words[wordKey].reviewCount || 0) + 1;
        this.saveTask(task);
      }
      return task;
    }
  };

  global.VocabTaskStore = TaskStore;
})(typeof window !== 'undefined' ? window : globalThis);
