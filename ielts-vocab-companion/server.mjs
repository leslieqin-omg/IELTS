import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename, stat, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeSync, validateData } from './model.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PRACTICE_DIR = existsSync(path.resolve(ROOT, '../assets/generated/reading-exams'))
  ? path.resolve(ROOT, '..')
  : path.join(ROOT, '../IELTS-practice');
const MAX_BODY = 32 * 1024 * 1024;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.md': 'text/plain' };
const httpError = (status, message) => Object.assign(new Error(message), { status });

async function readJSON(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function atomicJSON(file, value) {
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, file);
}

async function bodyJSON(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw httpError(413, '请求过大');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'JSON 无效'); }
}

export async function createServer({ dataDir = process.env.IELTS_DATA_DIR ||
  path.join(homedir(), '.ielts-vocab-companion'),
  practiceDir = process.env.IELTS_PRACTICE_DIR || DEFAULT_PRACTICE_DIR } = {}) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const tokenFile = path.join(dataDir, '.bridge-token');
  let token;
  try { token = (await readFile(tokenFile, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    token = randomBytes(32).toString('hex');
    await writeFile(tokenFile, token, { mode: 0o600 });
  }
  const stateFile = path.join(dataDir, 'data.json');
  const eventFile = path.join(dataDir, 'pending-sync.json');
  let journal = await readJSON(eventFile, { seq: 0, events: [], lastSeen: 0 });
  let writes = Promise.resolve();
  const serialize = (action) => {
    const result = writes.then(action);
    writes = result.catch(() => {});
    return result;
  };
  const json = (response, status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const host = request.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw httpError(403, '仅限本机访问');
      const base = `http://${host}`;
      const url = new URL(request.url, base);
      const origin = request.headers.origin;
      const isLocalOrigin = !origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
      if (origin && !isLocalOrigin) throw httpError(403, '不允许的来源');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw httpError(403, '拒绝跨站请求');
      if (origin && isLocalOrigin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        return response.end();
      }
      if (url.pathname === '/api/config' && request.method === 'GET') {
        return json(response, 200, { token, dataFile: stateFile });
      }
      if (url.pathname.startsWith('/api/')) {
        const hasValidToken = request.headers.authorization === `Bearer ${token}`;
        const allowLocalSync = url.pathname === '/api/sync' && Boolean(origin) && isLocalOrigin;
        if (!hasValidToken && !allowLocalSync) throw httpError(401, '同步令牌无效');
        if (url.pathname === '/api/state' && request.method === 'GET') {
          const data = await readJSON(stateFile, null);
          return json(response, 200, data ? validateData(data) : null);
        }
        if (url.pathname === '/api/state' && request.method === 'PUT') {
          const input = await bodyJSON(request);
          const next = validateData(input.state);
          await serialize(async () => {
            const current = await readJSON(stateFile, null);
            if (current) validateData(current);
            if ((current?.revision || 0) !== input.expectedRevision) throw httpError(409, '记录已被其他窗口更新');
            await atomicJSON(stateFile, next);
          });
          return json(response, 200, { saved: true, revision: next.revision });
        }
        if (url.pathname === '/api/sync' && request.method === 'POST') {
          const input = await bodyJSON(request);
          if (input.kind === 'heartbeat') {
            journal.lastSeen = Date.now();
            return json(response, 200, { received: true });
          }
          const normalized = normalizeSync(input);
          input.id = normalized.id;
          input.sentAt = normalized.sentAt;
          await serialize(async () => {
            if (journal.events.some((entry) => entry.event.id === input.id)) return;
            // Never evict an unacknowledged selection or result.
            if (journal.events.length >= 5000) throw httpError(507, '同步队列已满，请打开伴侣处理后重试');
            const next = {
              seq: journal.seq + 1, lastSeen: Date.now(),
              events: [...journal.events, { seq: journal.seq + 1, event: input }]
            };
            await atomicJSON(eventFile, next);
            journal = next;
          });
          return json(response, 200, { received: true });
        }
        if (url.pathname === '/api/events' && request.method === 'GET') {
          const after = Number(url.searchParams.get('after')) || 0;
          return json(response, 200, {
            events: journal.events.filter((item) => item.seq > after).slice(0, 50),
            lastSeen: journal.lastSeen
          });
        }
        if (url.pathname === '/api/ack' && request.method === 'POST') {
          const { ids } = await bodyJSON(request);
          if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw httpError(400, '确认消息无效');
          await serialize(async () => {
            const next = { ...journal, events: journal.events.filter((e) => !ids.includes(e.event.id)) };
            await atomicJSON(eventFile, next);
            journal = next;
          });
          return json(response, 200, { acknowledged: true });
        }
        throw httpError(404, '接口不存在');
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw httpError(405, '不支持的方法');
      if (url.pathname === '/bridge.user.js') {
        const source = (await readFile(path.join(ROOT, 'bridge.user.js'), 'utf8'))
          .replaceAll('__BRIDGE_TOKEN__', token).replaceAll('__BRIDGE_ORIGIN__', base);
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return response.end(source);
      }
      const practice = url.pathname.startsWith('/practice/');
      const relative = decodeURIComponent(practice ? url.pathname.slice('/practice/'.length) : url.pathname.slice(1));
      if (practice && !/^(assets\/generated\/reading-exams\/[a-zA-Z0-9_-]+\.js|assets\/wordlists\/ecdict_reading\.bundle\.js)$/.test(relative)) {
        throw httpError(403, '仅开放阅读题库资源');
      }
      const root = practice ? practiceDir : ROOT;
      const file = path.resolve(root, relative || 'index.html');
      if (!file.startsWith(`${path.resolve(root)}${path.sep}`) ||
          relative.split('/').some((part) => part.startsWith('.')) ||
          (!practice && /^(tests|node_modules)\//.test(relative)) ||
          ['server.mjs', 'package-lock.json', 'package.json'].includes(relative)) throw httpError(403, '路径不可访问');
      const real = await realpath(file);
      if (!real.startsWith(`${await realpath(root)}${path.sep}`)) throw httpError(403, '路径不可访问');
      if (!(await stat(real)).isFile()) throw httpError(404, '资源不存在');
      response.setHeader('Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self' http://127.0.0.1:47832 http://localhost:47832 https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      response.writeHead(200, { 'Content-Type': `${MIME[path.extname(real)] || 'application/octet-stream'}; charset=utf-8` });
      response.end(request.method === 'HEAD' ? undefined : await readFile(real));
    } catch (error) {
      json(response, error.status || (error.code === 'ENOENT' ? 404 : 400), { error: error.message });
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT) || 47832;
  const server = await createServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`IELTS Vocab Companion: http://127.0.0.1:${port}`);
    console.log('Chrome: 在设置中安装本地桥接 Userscript；仅监听本机。');
  });
}
