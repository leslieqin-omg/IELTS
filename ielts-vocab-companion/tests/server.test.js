import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../server.mjs';
import { addWord, emptyData } from '../model.js';

async function setup(t, dataDir) {
  dataDir ||= await mkdtemp(path.join(tmpdir(), 'vocab-test-'));
  const server = await createServer({ dataDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${origin}/api/config`)).json();
  const request = (url, method = 'GET', body, extra = {}) => fetch(`${origin}${url}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (!t.keepDir) await rm(dataDir, { recursive: true, force: true });
  });
  return { origin, request, dataDir, token };
}

test('localhost server persists atomically, rejects stale versions, serves UI and tokenized script', async (t) => {
  const { request, origin, dataDir, token } = await setup(t);
  assert.equal(await (await request('/api/state')).json(), null);
  const data = emptyData();
  addWord(data, 'tea', { word: 'court', contextMeaning: '宫廷' });
  data.revision = 1;
  assert.equal((await request('/api/state', 'PUT', { state: data, expectedRevision: 0 })).status, 200);
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'data.json'), 'utf8')).vocabRecords['tea:court'].word, 'court');
  assert.equal((await request('/api/state', 'PUT', { state: data, expectedRevision: 0 })).status, 409);
  const script = await (await fetch(`${origin}/bridge.user.js`)).text();
  assert.ok(script.includes(token));
  assert.ok(!script.includes('__BRIDGE_TOKEN__'));
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/server.mjs')).status, 403);
  assert.equal((await request('/node_modules/playwright/package.json')).status, 403);
  assert.equal((await request('/practice/README.md')).status, 403);
});

test('unknown origins and unauthenticated bridge requests are rejected', async (t) => {
  const { request, origin } = await setup(t);
  assert.equal((await fetch(`${origin}/api/events`)).status, 401);
  assert.equal((await request('/api/config', 'GET', null, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/sync', 'POST', { payload: { examId: '../secret' } })).status, 400);
  const status = await new Promise((resolve, reject) => {
    const req = http.get(`${origin}/api/config`, { headers: { Host: 'evil.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(status, 403);
});

test('bridge outbox deduplicates, acknowledges and survives service restart', async (t) => {
  const first = await setup(t);
  t.keepDir = true;
  const event = { id: 'retry-1', sentAt: Date.now(), payload: {
    book: 18, test: 1, passage: 1, activeText: 'The court.', wrongQuestions: [{ id: 'q1', answer: 'a', correctAnswer: 'b' }]
  } };
  assert.equal((await first.request('/api/sync', 'POST', event)).status, 200);
  await first.request('/api/sync', 'POST', event);
  assert.equal((await (await first.request('/api/events')).json()).events.length, 1);
  const second = await createServer({ dataDir: first.dataDir });
  await new Promise((resolve) => second.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    second.closeAllConnections();
    await new Promise((resolve) => second.close(resolve));
    await rm(first.dataDir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${second.address().port}`;
  const events = await (await fetch(`${origin}/api/events`, { headers: { Authorization: `Bearer ${first.token}` } })).json();
  assert.equal(events.events[0].event.id, 'retry-1');
  await first.request('/api/ack', 'POST', { ids: ['retry-1'] });
  assert.equal((await (await first.request('/api/events')).json()).events.length, 0);
});

test('corrupt disk data is never silently replaced by empty state', async (t) => {
  const { request, dataDir } = await setup(t);
  await writeFile(path.join(dataDir, 'data.json'), '{broken');
  assert.equal((await request('/api/state')).status, 400);
  assert.equal((await request('/api/state', 'PUT', { state: emptyData(), expectedRevision: 0 })).status, 400);
  assert.equal(await readFile(path.join(dataDir, 'data.json'), 'utf8'), '{broken');
});
