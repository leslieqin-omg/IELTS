import test from 'node:test';
import assert from 'node:assert/strict';
import { addWord, emptyData, LEGACY_KEY, schedule, validateData } from '../model.js';
import { startQuiz, answerQuiz } from '../quiz.js';
import { STORAGE_KEY, StorageManager } from '../store.js';
import { RECOVERY_KEY, StorageService } from '../storageService.js';

let IDBFactory;
try {
  ({ IDBFactory } = await import('fake-indexeddb'));
} catch {
  IDBFactory = class FallbackIDBFactory {
    constructor() { this.databases = new Map(); }
    open(name) {
      const req = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        const isNew = !this.databases.has(name);
        if (isNew) this.databases.set(name, new Map());
        const stores = this.databases.get(name);
        const db = {
          createObjectStore(storeName) {
            if (!stores.has(storeName)) stores.set(storeName, new Map());
          },
          transaction(storeName) {
            let aborted = false;
            const tx = {
              oncomplete: null,
              onabort: null,
              onerror: null,
              abort() {
                aborted = true;
                queueMicrotask(() => tx.onabort?.());
              },
              objectStore(sName) {
                const map = stores.get(sName) || new Map();
                return {
                  get(key) {
                    const r = { result: undefined, onsuccess: null, onerror: null };
                    queueMicrotask(() => {
                      if (aborted) return;
                      r.result = map.has(key) ? structuredClone(map.get(key)) : undefined;
                      r.onsuccess?.();
                      queueMicrotask(() => { if (!aborted) tx.oncomplete?.(); });
                    });
                    return r;
                  },
                  put(val, key) {
                    if (!aborted) map.set(key, structuredClone(val));
                    queueMicrotask(() => { if (!aborted) tx.oncomplete?.(); });
                  }
                };
              }
            };
            return tx;
          },
          close() {}
        };
        req.result = db;
        if (isNew) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    }
  };
}

class MemoryStorage {
  constructor() { this.values = new Map(); this.writes = 0; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.writes++; this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}
function savedData() {
  const data = emptyData();
  addWord(data, 'tea', { word: 'court', contextMeaning: '宫廷' });
  data.settings.activePassageId = 'tea';
  data.revision = 7;
  data.updatedAt = 1000;
  return data;
}

test('hydrate does not write initial empty state; local fallback survives reload', async () => {
  const local = new MemoryStorage();
  local.setItem(STORAGE_KEY, JSON.stringify(savedData()));
  const writes = local.writes;
  const store = new StorageManager({ indexedDB: null, localStorage: local });
  await store.hydrate();
  assert.equal(local.writes, writes);
  assert.ok(store.data.vocabRecords['tea:court']);
  await store.transaction((data) => { data.vocabRecords['tea:court'].errors++; });
  const reloaded = new StorageManager({ indexedDB: null, localStorage: local });
  await reloaded.hydrate();
  assert.equal(reloaded.data.vocabRecords['tea:court'].errors, 1);
});

test('mutation is blocked before hydration', async () => {
  const store = new StorageManager({ indexedDB: null, localStorage: new MemoryStorage() });
  await assert.rejects(store.transaction(() => {}), /水合/);
});

test('IndexedDB restores quiz queue and stable options after wrong answer', async () => {
  const indexedDB = new IDBFactory();
  const localStorage = new MemoryStorage();
  const store = new StorageManager({ indexedDB, localStorage });
  await store.hydrate();
  await store.transaction((data) => {
    const w = addWord(data, 'tea', { word: 'court', contextMeaning: '宫廷' });
    startQuiz(data, [w], [
      { word: 'one', contextMeaning: '资源' }, { word: 'two', contextMeaning: '证据' }, { word: 'three', contextMeaning: '森林' }
    ]);
    answerQuiz(data, null);
  });
  await store.flush();
  const snapshot = structuredClone(store.data.quizSession);
  const restored = new StorageManager({ indexedDB, localStorage: new MemoryStorage() });
  await restored.hydrate();
  assert.deepEqual(restored.data.quizSession, snapshot);
  store.db.close();
  restored.db.close();
});

test('newer valid replica wins over stale disk without initial writes', async () => {
  const localStorage = new MemoryStorage();
  const local = savedData();
  local.updatedAt = 5000;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(local));
  let writes = 0;
  const store = new StorageManager({ indexedDB: null, localStorage,
    remote: { load: async () => savedData(), save: async () => writes++ } });
  await store.hydrate();
  assert.equal(store.data.updatedAt, 5000);
  assert.equal(writes, 0);
});

test('corrupt storage is preserved and does not turn into an empty writable state', async () => {
  const local = new MemoryStorage();
  local.setItem(STORAGE_KEY, '{broken');
  const store = new StorageManager({ indexedDB: null, localStorage: local });
  await assert.rejects(store.hydrate(), /停止写入/);
  await assert.rejects(store.transaction(() => {}), /水合/);
  assert.equal(local.getItem(STORAGE_KEY), '{broken');
  await store.restore(savedData());
  assert.equal(store.ready, true);
  validateData(JSON.parse(local.getItem(STORAGE_KEY)));
});

test('valid fallback recovers from corrupt IndexedDB replica', async () => {
  const indexedDB = new IDBFactory();
  const localStorage = new MemoryStorage();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(savedData()));
  const store = new StorageManager({ indexedDB, localStorage });
  await store.open();
  await new Promise((resolve) => {
    const tx = store.db.transaction('state', 'readwrite');
    tx.objectStore('state').put({ broken: true }, 'current');
    tx.oncomplete = resolve;
  });
  store.db.close();
  await store.hydrate();
  assert.equal(store.ready, true);
  assert.ok(store.data.vocabRecords['tea:court']);
  store.db.close();
});

test('quota errors roll back in-memory transaction and preserve prior data', async () => {
  const localStorage = new MemoryStorage();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(savedData()));
  const store = new StorageManager({ indexedDB: null, localStorage });
  await store.hydrate();
  localStorage.setItem = () => { throw new Error('quota'); };
  await assert.rejects(store.transaction((data) => { data.vocabRecords['tea:court'].errors = 90; }), /写入失败/);
  assert.equal(store.data.vocabRecords['tea:court'].errors, 0);
});

test('stale second tab cannot overwrite the first tab', async () => {
  const indexedDB = new IDBFactory();
  const localStorage = new MemoryStorage();
  const a = new StorageManager({ indexedDB, localStorage });
  const b = new StorageManager({ indexedDB, localStorage });
  await a.hydrate();
  await b.hydrate();
  await a.transaction((data) => addWord(data, 'tea', { word: 'court', contextMeaning: '宫廷' }));
  await assert.rejects(b.transaction((data) => addWord(data, 'tea', { word: 'garden', contextMeaning: '庭院' })), /其他窗口/);
  a.db.close(); b.db.close();
  a.clearTimers(); b.clearTimers();
});

test('old localStorage task key migrates and invalid restore is atomic', async () => {
  const localStorage = new MemoryStorage();
  localStorage.setItem(LEGACY_KEY, JSON.stringify({ tea: { words: { court: { word: 'court', meaning: '宫廷', stage: 'known' } } } }));
  const store = new StorageManager({ indexedDB: null, localStorage });
  await store.hydrate();
  const prior = store.exportJSON();
  await assert.rejects(store.restore({ schemaVersion: 2 }), /无效/);
  assert.equal(store.exportJSON(), prior);
  assert.equal(store.data.vocabRecords['tea:court'].status, 'review');
});

test('debounce coalesces full snapshots and remote writes while checkpoints protect each change', async () => {
  const indexedDB = new IDBFactory();
  const localStorage = new MemoryStorage();
  const saved = [];
  const store = new StorageService({ indexedDB, localStorage, debounceMs: 30,
    remote: { load: async () => null, save: async (data) => saved.push(data.revision) } });
  await store.hydrate();
  for (let i = 0; i < 5; i++) {
    await store.transaction((data) => {
      const word = addWord(data, 'tea', { word: 'court', contextMeaning: '宫廷' });
      schedule(word, false, 1000 + i);
      data.settings.activePassageId = 'tea';
    });
  }
  assert.equal(saved.length, 0);
  assert.equal(await store.readIDB(), null);
  assert.equal(localStorage.getItem(STORAGE_KEY), null);
  assert.equal(JSON.parse(localStorage.getItem(RECOVERY_KEY)).vocabRecords['tea:court'].errors, 5);
  await new Promise((resolve) => setTimeout(resolve, 90));
  await store.tail;
  assert.deepEqual(saved, [5]);
  assert.equal((await store.readIDB()).vocabRecords['tea:court'].lastStudiedAt, 1004);
  assert.equal(JSON.parse(localStorage.getItem(STORAGE_KEY)).settings.activePassageId, 'tea');
  assert.equal(localStorage.getItem(RECOVERY_KEY), null);
  store.db.close();
});

test('closing before debounce finishes restores selected passage, vocabulary and study state', async () => {
  const localStorage = new MemoryStorage();
  const store = new StorageService({ indexedDB: null, localStorage, debounceMs: 60000 });
  await store.hydrate();
  await store.transaction((data) => {
    const word = addWord(data, 'Cam18-T1-P1', { word: 'court', contextMeaning: '宫廷' });
    schedule(word, false, 1700000000000);
    data.settings.activePassageId = 'Cam18-T1-P1';
  });
  store.clearTimers(); // Simulate process termination without pagehide or flush.
  const restored = new StorageService({ indexedDB: null, localStorage });
  const writes = localStorage.writes;
  await restored.hydrate();
  assert.equal(localStorage.writes, writes);
  assert.equal(restored.data.settings.activePassageId, 'Cam18-T1-P1');
  const word = restored.data.vocabRecords['Cam18-T1-P1:court'];
  assert.equal(word.status, 'learning');
  assert.equal(word.errors, 1);
  assert.equal(word.lastStudiedAt, 1700000000000);
  assert.deepEqual(restored.data.passageProgress['Cam18-T1-P1'].wordIds, [word.id]);
  await restored.flush();
  assert.equal(localStorage.getItem(RECOVERY_KEY), null);
  assert.equal(JSON.parse(localStorage.getItem(STORAGE_KEY)).revision, 1);
});

test('slow and concurrent hydration blocks mutations and never replaces saved data with defaults', async () => {
  const localStorage = new MemoryStorage();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(savedData()));
  let release;
  const store = new StorageService({ indexedDB: null, localStorage,
    remote: { load: () => new Promise((resolve) => { release = resolve; }), save: async () => {} } });
  const first = store.hydrate();
  const second = store.hydrate();
  assert.equal(first, second);
  await assert.rejects(store.transaction(() => {}), /水合/);
  const writes = localStorage.writes;
  release(null);
  await first;
  assert.equal(localStorage.writes, writes);
  assert.equal(store.data.settings.activePassageId, 'tea');
  assert.equal(Object.keys(store.data.vocabRecords).length, 1);
});

test('unavailable localStorage immediately persists to IndexedDB rather than deferring unsafe changes', async () => {
  const indexedDB = new IDBFactory();
  const store = new StorageService({ indexedDB, localStorage: null });
  await store.hydrate();
  await store.transaction((data) => addWord(data, 'tea', { word: 'court' }));
  assert.ok((await store.readIDB()).vocabRecords['tea:court']);
  assert.equal(store.pending, null);
  store.db.close();
});

test('older version 2 backups acquire lastStudiedAt without discarding progress', () => {
  const backup = savedData();
  const word = backup.vocabRecords['tea:court'];
  delete word.lastStudiedAt;
  assert.equal(validateData(backup).vocabRecords[word.id].lastStudiedAt, 0);
  word.status = 'mastered';
  word.updatedAt = 12345;
  assert.equal(validateData(backup).vocabRecords[word.id].lastStudiedAt, 12345);
  assert.equal(word.lastStudiedAt, undefined);
  word.lastStudiedAt = -1;
  assert.throws(() => validateData(backup), /无效/);
});

test('editing definitions does not change the actual last study time', () => {
  const data = savedData();
  schedule(data.vocabRecords['tea:court'], true, 5000);
  addWord(data, 'tea', { word: 'court', contextMeaning: '法庭', manual: true });
  assert.equal(data.vocabRecords['tea:court'].lastStudiedAt, 5000);
});

test('import discards pending pre-import snapshot and flush cannot resurrect replaced records', async () => {
  const localStorage = new MemoryStorage();
  const store = new StorageService({ indexedDB: null, localStorage });
  await store.hydrate();
  await store.transaction((data) => addWord(data, 'old', { word: 'garden' }));
  await store.restore(savedData());
  await store.flush();
  assert.equal(store.pending, null);
  const reloaded = new StorageService({ indexedDB: null, localStorage });
  await reloaded.hydrate();
  assert.ok(reloaded.data.vocabRecords['tea:court']);
  assert.equal(reloaded.data.vocabRecords['old:garden'], undefined);
});

test('a stale debounced flush cannot overwrite a newer window recovery checkpoint', async () => {
  const indexedDB = new IDBFactory();
  const localStorage = new MemoryStorage();
  const a = new StorageService({ indexedDB, localStorage });
  await a.hydrate();
  await a.transaction((data) => addWord(data, 'tea', { word: 'court' }));
  const b = new StorageService({ indexedDB, localStorage });
  await b.hydrate();
  await b.transaction((data) => addWord(data, 'tea', { word: 'garden' }));
  await assert.rejects(a.flush(), /其他窗口/);
  assert.equal(JSON.parse(localStorage.getItem(RECOVERY_KEY)).revision, 2);
  await b.flush();
  assert.ok((await b.readIDB()).vocabRecords['tea:garden']);
  a.clearTimers();
  a.db.close();
  b.db.close();
});

test('higher revision wins even when the clock moved backwards', async () => {
  const localStorage = new MemoryStorage();
  const old = savedData();
  old.updatedAt = 9000;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(old));
  const recent = savedData();
  recent.revision++;
  recent.updatedAt = 1000;
  recent.vocabRecords['tea:court'].errors = 2;
  localStorage.setItem(RECOVERY_KEY, JSON.stringify(recent));
  const store = new StorageService({ indexedDB: null, localStorage });
  await store.hydrate();
  assert.equal(store.data.vocabRecords['tea:court'].errors, 2);
});

test('import during delayed hydration waits so startup cannot overwrite the restored backup', async () => {
  const localStorage = new MemoryStorage();
  let release;
  const store = new StorageService({ indexedDB: null, localStorage,
    remote: { load: () => new Promise((resolve) => { release = resolve; }), save: async () => {} } });
  const hydration = store.hydrate();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const restoring = store.restore(savedData());
  release(emptyData());
  await Promise.all([hydration, restoring]);
  assert.equal(store.data.settings.activePassageId, 'tea');
  assert.ok(store.data.vocabRecords['tea:court']);
  assert.equal(JSON.parse(localStorage.getItem(STORAGE_KEY)).settings.activePassageId, 'tea');
});

test('explicit restore in a stale tab advances beyond newer cached revisions', async () => {
  const localStorage = new MemoryStorage();
  const a = new StorageService({ indexedDB: null, localStorage });
  await a.hydrate();
  const newer = savedData();
  newer.revision = 100;
  localStorage.setItem(RECOVERY_KEY, JSON.stringify(newer));
  await a.restore(emptyData());
  assert.equal(a.data.revision, 101);
  assert.equal(localStorage.getItem(RECOVERY_KEY), null);
  const b = new StorageService({ indexedDB: null, localStorage });
  await b.hydrate();
  assert.equal(Object.keys(b.data.vocabRecords).length, 0);
});

test('failed batched write retains recovery journal and exportable current progress', async () => {
  const localStorage = new MemoryStorage();
  const store = new StorageService({ indexedDB: null, localStorage });
  await store.hydrate();
  await store.transaction((data) => addWord(data, 'tea', { word: 'court' }));
  localStorage.setItem = () => { throw new Error('quota'); };
  await assert.rejects(store.flush(), /写入失败/);
  assert.ok(localStorage.getItem(RECOVERY_KEY));
  assert.ok(JSON.parse(store.exportJSON()).vocabRecords['tea:court']);
  const restored = new StorageService({ indexedDB: null, localStorage });
  await restored.hydrate();
  assert.ok(restored.data.vocabRecords['tea:court']);
});

test('corrupt primary snapshot does not prevent recovery from a valid journal', async () => {
  const localStorage = new MemoryStorage();
  localStorage.setItem(STORAGE_KEY, '{broken');
  localStorage.setItem(RECOVERY_KEY, JSON.stringify(savedData()));
  const store = new StorageService({ indexedDB: null, localStorage });
  await store.hydrate();
  await store.flush();
  assert.ok(JSON.parse(localStorage.getItem(STORAGE_KEY)).vocabRecords['tea:court']);
  assert.equal(localStorage.getItem(RECOVERY_KEY), null);
});
