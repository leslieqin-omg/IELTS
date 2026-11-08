import { normalizeSync } from './model.js';

export const CHANNEL = 'ielts_practice_sync';
export const SYNC_KEY = 'ielts_practice_sync_event';

export class Bridge {
  constructor(onEvent, onStatus) {
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.cursor = 0;
    this.stopped = false;
    this.baseUrl = '';
  }

  async api(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options, headers: { ...options.headers, Authorization: `Bearer ${this.config.token}` },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(response.status === 409 ? '文件版本冲突，请刷新后继续' : `本地服务 HTTP ${response.status}`);
    return response.json();
  }

  async connect() {
    const candidates = [''];
    if (location.port !== '47832') candidates.push('http://127.0.0.1:47832');
    for (const base of candidates) {
      try {
        const response = await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(1200) });
        if (!response.ok) continue;
        this.config = await response.json();
        this.baseUrl = base;
        break;
      } catch { /* Fall through to next candidate */ }
    }
    if (!this.config) this.onStatus('同源实时同步已就绪（BroadcastChannel / IndexedDB）');
    return this.config ? {
      load: () => this.api('/api/state'),
      save: (state, expectedRevision) => this.api('/api/state', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, expectedRevision })
      })
    } : null;
  }

  start() {
    const receive = (raw) => {
      try {
        if (raw?.channel === CHANNEL || raw?.payload || raw?.examId || raw?.passageId) {
          Promise.resolve(this.onEvent(normalizeSync(raw))).catch((error) => this.onStatus(error.message));
        }
      } catch (error) { this.onStatus(error.message); }
    };
    try {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (event) => receive(event.data);
    } catch { this.onStatus('BroadcastChannel 不可用，仍监听 storage'); }
    this.storageHandler = (event) => {
      if (event.key === SYNC_KEY && event.newValue) {
        try { receive(JSON.parse(event.newValue)); } catch { this.onStatus('忽略无效同步消息'); }
      }
    };
    window.addEventListener('storage', this.storageHandler);
    try {
      const saved = localStorage.getItem(SYNC_KEY);
      if (saved) receive(JSON.parse(saved));
    } catch { /* Storage events and local HTTP bridge remain independent. */ }
    const poll = async () => {
      if (this.stopped) return;
      if (this.config) {
        try {
          const result = await this.api(`/api/events?after=${this.cursor}`);
          for (const item of result.events) {
            const processed = await this.onEvent(normalizeSync(item.event));
            if (!processed) break;
            await this.api('/api/ack', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids: [item.event.id] })
            });
            this.cursor = item.seq;
          }
          this.onStatus(result.lastSeen && Date.now() - result.lastSeen < 15000 ?
            'Chrome 桥接在线' : '本地服务在线，等待阅读页面同步');
        } catch (error) { this.onStatus(`同步中断，将自动重连：${error.message}`); }
      }
      this.timer = setTimeout(poll, 1500);
    };
    poll();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.channel?.close();
    window.removeEventListener('storage', this.storageHandler);
  }

  async loadManifest() {
    if (globalThis.__READING_EXAM_MANIFEST__) return globalThis.__READING_EXAM_MANIFEST__;
    const paths = this.config && !this.baseUrl
      ? ['/practice/assets/generated/reading-exams/manifest.js', '../assets/generated/reading-exams/manifest.js']
      : ['../assets/generated/reading-exams/manifest.js', '/assets/generated/reading-exams/manifest.js', '/practice/assets/generated/reading-exams/manifest.js'];
    for (const src of paths) {
      const ok = await new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => resolve(true);
        script.onerror = () => { script.remove(); resolve(false); };
        document.head.append(script);
      });
      if (ok && globalThis.__READING_EXAM_MANIFEST__) return globalThis.__READING_EXAM_MANIFEST__;
    }
    return null;
  }

  async loadExam(id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('篇章 ID 无效');
    if (!globalThis.__READING_EXAM_DATA__ || typeof globalThis.__READING_EXAM_DATA__.register !== 'function') {
      const exams = {};
      globalThis.__READING_EXAM_DATA__ = {
        exams,
        register(key, data) { exams[key] = data; },
        get(key) { return exams[key]; }
      };
    } else if (!globalThis.__READING_EXAM_DATA__.get) {
      globalThis.__READING_EXAM_DATA__.exams ||= {};
      const origRegister = globalThis.__READING_EXAM_DATA__.register;
      globalThis.__READING_EXAM_DATA__.register = function(key, data) {
        globalThis.__READING_EXAM_DATA__.exams[key] = data;
        if (typeof origRegister === 'function') origRegister.call(this, key, data);
      };
      globalThis.__READING_EXAM_DATA__.get = function(key) {
        return globalThis.__READING_EXAM_DATA__.exams[key];
      };
    }
    const registry = globalThis.__READING_EXAM_DATA__;
    if (registry.get(id)) return registry.get(id);
    const paths = this.config && !this.baseUrl
      ? [
          `./assets/demo-exams/${id}.js`,
          `/practice/assets/generated/reading-exams/${id}.js`,
          `../assets/generated/reading-exams/${id}.js`
        ]
      : [
          `../assets/generated/reading-exams/${id}.js`,
          `/assets/generated/reading-exams/${id}.js`,
          `./assets/demo-exams/${id}.js`,
          `/practice/assets/generated/reading-exams/${id}.js`,
          `/IELTS-practice/assets/generated/reading-exams/${id}.js`
        ];
    for (const path of paths) {
      const ok = await new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = path;
        script.onload = () => { resolve(true); };
        script.onerror = () => { script.remove(); resolve(false); };
        document.head.append(script);
      });
      if (ok && registry.get(id)) return registry.get(id);
    }
    return null;
  }
}
