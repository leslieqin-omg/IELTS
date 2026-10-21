import { clone, emptyData, LEGACY_KEY, migrateLegacy, validateData } from './model.js';

export const STORAGE_KEY = 'ielts_vocab_companion_v2';
export const RECOVERY_KEY = `${STORAGE_KEY}_pending`;
export const DB_NAME = 'ielts-vocab-companion';

export class StorageService {
  constructor({ indexedDB = globalThis.indexedDB, localStorage = globalThis.localStorage,
    remote = null, onStatus = () => {}, debounceMs = 300, maxWaitMs = 2000 } = {}) {
    this.indexedDB = indexedDB;
    this.localStorage = localStorage;
    this.remote = remote;
    this.onStatus = onStatus;
    this.data = null;
    this.db = null;
    this.ready = false;
    this.tail = Promise.resolve();
    this.debounceMs = debounceMs;
    this.maxWaitMs = maxWaitMs;
    this.pending = null;
    this.saveTimer = null;
    this.maxTimer = null;
  }

  async open() {
    if (!this.indexedDB) return;
    this.db = await new Promise((resolve) => {
      let settled = false;
      const finish = (db) => { if (!settled) { settled = true; resolve(db); } else db?.close(); };
      const request = this.indexedDB.open(DB_NAME, 1);
      const timer = setTimeout(() => finish(null), 2000);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onsuccess = () => { clearTimeout(timer); finish(request.result); };
      request.onerror = request.onblocked = () => { clearTimeout(timer); finish(null); };
    });
    if (this.db) this.db.onversionchange = () => { this.db.close(); this.db = null; };
  }

  async readIDB() {
    if (!this.db) return null;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('state', 'readonly');
      const request = tx.objectStore('state').get('current');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  hydrate() {
    if (this.ready) return Promise.resolve(clone(this.data));
    if (!this.hydrating) {
      this.hydrating = this.load().finally(() => { this.hydrating = null; });
    }
    return this.hydrating;
  }

  async load() {
    if (this.ready) return clone(this.data);
    this.ready = false;
    try { await this.open(); } catch { this.db = null; }
    const candidates = [];
    let recoveryRevision = -1;
    let corrupt = false;
    let readable = false;
    try {
      const value = await this.readIDB();
      if (this.db) readable = true;
      if (value) candidates.push(validateData(value));
    } catch (error) { corrupt = true; this.onStatus(`IndexedDB 读取失败：${error.message}`); }
    for (const key of [STORAGE_KEY, RECOVERY_KEY, LEGACY_KEY]) {
      try {
        const raw = this.localStorage?.getItem(key);
        if (this.localStorage) readable = true;
        if (raw && (key !== LEGACY_KEY || !candidates.length)) {
          const value = key === LEGACY_KEY ? migrateLegacy(JSON.parse(raw)) : validateData(JSON.parse(raw));
          candidates.push(value);
          if (key === RECOVERY_KEY || key === LEGACY_KEY) recoveryRevision = value.revision;
        }
      } catch (error) { corrupt = true; this.onStatus(`浏览器备份 ${key} 读取失败：${error.message}`); }
    }
    if (this.remote) {
      try {
        const disk = await this.remote.load();
        readable = true;
        if (disk) candidates.push(validateData(disk));
        this.remoteRevision = disk?.revision || 0;
      } catch (error) { this.onStatus(`本地文件暂不可用：${error.message}`); }
    }
    if (!candidates.length && (corrupt || !readable)) {
      throw new Error('无法安全读取已有存储。已停止写入，避免空状态覆盖记录；请恢复浏览器权限或导入备份。');
    }
    candidates.sort((a, b) => b.revision - a.revision || b.updatedAt - a.updatedAt);
    this.data = candidates[0] || emptyData();
    if (recoveryRevision === this.data.revision ||
        (this.remoteRevision !== undefined && this.remoteRevision < this.data.revision)) {
      this.pending = this.data;
    }
    this.ready = true;
    this.onStatus(this.db ? 'IndexedDB 已水合' : '已启用 localStorage 降级');
    return clone(this.data);
  }

  async latestRevision() {
    const snapshots = [];
    try {
      const value = await this.readIDB();
      if (value) snapshots.push(validateData(value));
    } catch { this.onStatus('IndexedDB 暂不可读，使用浏览器恢复日志'); }
    for (const key of [STORAGE_KEY, RECOVERY_KEY]) {
      try {
        const raw = this.localStorage?.getItem(key);
        if (raw) snapshots.push(validateData(JSON.parse(raw)));
      } catch { /* A valid hydrated replica may repair an unreadable mirror. */ }
    }
    return Math.max(0, ...snapshots.map((value) => Number(value.revision) || 0));
  }

  async assertCurrent(previousRevision) {
    if (await this.latestRevision() > previousRevision) {
      throw new Error('其他窗口已更新记录，请刷新后继续');
    }
  }

  async persist(next, previousRevision, force = false) {
    if (!force) await this.assertCurrent(previousRevision);
    let saved = false;
    const locations = [];
    if (this.db) {
      try {
        await new Promise((resolve, reject) => {
          const tx = this.db.transaction('state', 'readwrite');
          const store = tx.objectStore('state');
          const request = store.get('current');
          let conflict = false;
          request.onsuccess = () => {
            if (!force && request.result && request.result.revision > previousRevision) {
              conflict = true;
              tx.abort();
            } else store.put(next, 'current');
          };
          tx.oncomplete = resolve;
          tx.onabort = tx.onerror = () => reject(new Error(conflict ? 'STORAGE_CONFLICT' : 'IndexedDB 写入失败'));
        });
        saved = true;
        locations.push('IndexedDB');
      } catch (error) {
        if (error.message === 'STORAGE_CONFLICT') throw new Error('其他窗口已更新记录，请刷新后继续');
        this.onStatus('IndexedDB 写入失败，尝试 localStorage 降级');
      }
    }
    try {
      if (this.localStorage) {
        this.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        saved = true;
        locations.push('localStorage');
      }
    } catch (error) {
      if (!saved) throw new Error('本地存储写入失败，未变更学习记录，请先导出备份');
      this.onStatus('浏览器降级备份未能写入，IndexedDB 记录仍安全');
    }
    if (!saved) throw new Error('没有可用的持久化存储，未变更记录');
    try {
      const raw = this.localStorage?.getItem(RECOVERY_KEY);
      if (raw && JSON.parse(raw).revision <= next.revision) this.localStorage.removeItem(RECOVERY_KEY);
    } catch { /* Keep the recovery journal if cleanup is unavailable. */ }
    if (this.remote) {
      try {
        await this.remote.save(next, this.remoteRevision || 0);
        this.remoteRevision = next.revision;
        this.onStatus('已保存到浏览器及本地 data.json');
      } catch (error) {
        this.onStatus(`浏览器已保存；本地文件未同步：${error.message}。请导出备份，重启时会尝试恢复。`);
      }
    } else this.onStatus(`已保存到 ${locations.join(' / ')}`);
  }

  enqueue(run) {
    const locked = () => globalThis.navigator?.locks ?
      globalThis.navigator.locks.request('ielts-vocab-write', run) : run();
    const task = this.tail.then(locked);
    this.tail = task.catch(() => {});
    return task;
  }

  clearTimers() {
    clearTimeout(this.saveTimer);
    clearTimeout(this.maxTimer);
    this.saveTimer = null;
    this.maxTimer = null;
  }

  scheduleSave() {
    const save = () => {
      this.flush().catch((error) => this.onStatus(`批量保存未完成：${error.message}；恢复日志仍保留，请导出备份。`));
    };
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(save, this.debounceMs);
    if (!this.maxTimer) this.maxTimer = setTimeout(save, this.maxWaitMs);
    this.saveTimer.unref?.();
    this.maxTimer.unref?.();
  }

  flush() {
    this.clearTimers();
    return this.enqueue(async () => {
      if (!this.ready || !this.pending) return;
      const snapshot = this.pending;
      await this.persist(snapshot, snapshot.revision);
      this.pending = null;
      this.clearTimers();
    });
  }

  async transaction(mutator) {
    const run = async () => {
      if (!this.ready) throw new Error('尚未完成本地状态水合');
      const next = clone(this.data);
      const result = mutator(next);
      if (result?.then) throw new Error('存储事务中不能执行异步操作');
      next.revision = this.data.revision + 1;
      next.updatedAt = Date.now();
      validateData(next);
      await this.assertCurrent(this.data.revision);
      let checkpointed = false;
      try {
        if (this.localStorage) {
          // This synchronous checkpoint survives closing inside the debounce window.
          this.localStorage.setItem(RECOVERY_KEY, JSON.stringify(next));
          checkpointed = true;
        }
      } catch { this.onStatus('恢复日志不可写，改为立即写入 IndexedDB'); }
      if (!checkpointed) await this.persist(next, this.data.revision);
      this.data = next;
      if (checkpointed) {
        this.pending = next;
        this.scheduleSave();
        this.onStatus('进度已保护，正在等待批量保存');
      } else {
        this.pending = null;
        this.clearTimers();
      }
      return result;
    };
    return this.enqueue(run);
  }

  async restore(input) {
    const restored = input.schemaVersion ? validateData(input) : migrateLegacy(input);
    const run = async () => {
      // Import may be requested while startup is still reading a slow replica.
      await this.hydrating?.catch(() => {});
      restored.revision = Math.max(restored.revision, this.data?.revision || 0,
        await this.latestRevision(), this.remoteRevision || 0) + 1;
      restored.updatedAt = Date.now();
      await this.persist(restored, this.data?.revision || 0, true);
      this.data = restored;
      this.ready = true;
      this.pending = null;
      this.clearTimers();
    };
    return this.enqueue(run);
  }

  exportJSON() {
    if (!this.data) throw new Error('没有可导出的记录');
    return JSON.stringify(this.data, null, 2);
  }
}
