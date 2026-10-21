import { normalizeSync } from './model.js';

export const CHANNEL = 'ielts_practice_sync';
export const SYNC_KEY = 'ielts_practice_sync_event';

export class Bridge {
  constructor(onEvent, onStatus) {
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.cursor = 0;
    this.stopped = false;
  }

  async api(path, options = {}) {
    const response = await fetch(path, {
      ...options, headers: { ...options.headers, Authorization: `Bearer ${this.config.token}` },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(response.status === 409 ? '文件版本冲突，请刷新后继续' : `本地服务 HTTP ${response.status}`);
    return response.json();
  }

  async connect() {
    try {
      const response = await fetch('/api/config', { signal: AbortSignal.timeout(1500) });
      if (!response.ok) throw new Error();
      this.config = await response.json();
    } catch { this.onStatus('同源模式；跨端口请使用 npm start'); }
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
            'Chrome 桥接在线' : '本地服务在线，等待 Chrome 阅读页面');
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

  async loadExam(id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('篇章 ID 无效');
    const registry = globalThis.__READING_EXAM_DATA__ ||= {
      exams: {}, register(key, data) { this.exams[key] = data; }, get(key) { return this.exams[key]; }
    };
    if (registry.get(id)) return registry.get(id);
    const paths = [this.config ? `/practice/assets/generated/reading-exams/${id}.js` :
      `../IELTS-practice/assets/generated/reading-exams/${id}.js`, `./assets/demo-exams/${id}.js`];
    for (const path of paths) {
      const ok = await new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = path;
        script.onload = () => { script.remove(); resolve(true); };
        script.onerror = () => { script.remove(); resolve(false); };
        document.head.append(script);
      });
      if (ok && registry.get(id)) return registry.get(id);
    }
    return null;
  }
}
