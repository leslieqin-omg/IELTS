import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../server.mjs';

const dataDir = await mkdtemp(path.join(tmpdir(), 'vocab-browser-'));
const server = await createServer({ dataDir });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const { token } = await (await fetch(`${origin}/api/config`)).json();
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const state = async () => (await fetch(`${origin}/api/state`, { headers })).json();
const send = async (payload, kind = 'reading') => {
  const response = await fetch(`${origin}/api/sync`, {
    method: 'POST', headers,
    body: JSON.stringify({ id: randomUUID(), sentAt: Date.now(), kind, payload })
  });
  assert.equal(response.status, 200);
};
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: true, args: ['--no-sandbox']
});
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('dialog', (dialog) => dialog.accept());
let fixture;
let practice;
let checks = 0;

async function check(name, action) {
  await action();
  checks++;
  console.log(`PASS ${name}`);
}
async function until(predicate, description = 'state update') {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${description}`);
}
async function add(word, meaning, sentence) {
  await page.locator('#add-open').click();
  await page.locator('#edit-word').fill(word);
  await page.locator('#edit-meaning').fill(meaning);
  await page.locator('#edit-sentence').fill(sentence);
  await page.locator('#edit-pos').fill('n.');
  await page.locator('#word-form button[type=submit]').click();
  await page.locator('#word-dialog').waitFor({ state: 'hidden' });
  await until(async () => Boolean((await state()).vocabRecords[`p1-high-01:${word}`]));
}
async function chooseCorrect() {
  const { quizSession: q } = await state();
  const item = q.queue[q.index];
  const target = q.words.find((w) => w.id === item.wordId);
  await page.locator('body').click({ position: { x: 3, y: 3 } });
  await page.keyboard.press(String(item.options.indexOf(target.contextMeaning) + 1));
  await until(async () => (await state()).quizSession.feedback?.correct);
  await page.keyboard.press('Enter');
  await until(async () => (await state()).quizSession.index > q.index);
}
async function finishQuiz() {
  for (let steps = 0; steps < 30; steps++) {
    const { quizSession: q } = await state();
    if (q.completed) return;
    assert.ok(q.queue.every((item) => q.words.some((word) => word.id === item.wordId)));
    if (q.reviewBreak) {
      await page.locator('#next-question').click();
      await until(async () => (await state()).quizSession.reviewTurns > (q.reviewTurns || 0));
    } else await chooseCorrect();
  }
  throw new Error('Quiz did not finish within 30 steps');
}

try {
  await check('boot hydrates, loads the original offline reading and safely edits contextual words', async () => {
    await page.goto(origin);
    await page.locator('#app[aria-busy=false]').waitFor();
    await page.locator('#passage-content .token').first().waitFor();
    await page.locator('#core-list strong').filter({ hasText: /^court$/ }).waitFor();
    assert.match(await page.locator('#synonym-list').textContent(), /royal household/);
    assert.equal(await page.locator('.vocab-row').count(), 0);
    await add('court', '宫廷', 'Tea was introduced to the royal court.');
    await add('porcelain', '瓷器', 'The porcelain was imported from China.');
    assert.equal(await page.locator('.vocab-row').count(), 2);
    assert.equal((await state()).vocabRecords['p1-high-01:court'].meaningSource, 'manual');
  });

  await check('learning shortcuts, input focus guard and exact learned-batch quiz binding', async () => {
    await page.locator('#start-learn').click();
    await page.locator('#learn-controls').waitFor();
    await page.locator('body').click({ position: { x: 3, y: 3 } });
    await page.keyboard.press('Space');
    await page.locator('#learn-card .meaning').waitFor();
    assert.match(await page.locator('#learn-card mark').textContent(), /court/i);
    await page.locator('[data-view=extract]').click();
    await add('infusion', '浸泡液', 'An infusion of tea was offered to guests.');
    await page.locator('#capture-text').fill('court');
    await page.locator('[data-view=learn]').click();
    await page.locator('#settings-open').click();
    const before = (await state()).learningSession.index;
    await page.keyboard.press('2');
    assert.equal((await state()).learningSession.index, before);
    await page.locator('[data-close=settings-dialog]').click();
    await page.locator('body').click({ position: { x: 3, y: 3 } });
    await page.keyboard.press('ArrowRight');
    await until(async () => await page.locator('#learn-progress').getAttribute('value') === '1');
    await page.keyboard.press('ArrowLeft');
    await page.locator('#batch-quiz').waitFor();
    await page.locator('#batch-quiz').click();
    await page.locator('.quiz-option').first().waitFor();
    await until(async () => Boolean((await state()).quizSession));
    const q = (await state()).quizSession;
    assert.deepEqual(q.words.map((w) => w.word), ['court', 'porcelain']);
    assert.equal(await page.locator('.quiz-option').count(), 4);
    assert.equal(await page.locator('#quiz-content .meaning').count(), 0);
    assert.equal(new Set(q.queue[0].options).size, 4);
  });

  await check('stable choices, persisted wrong-answer feedback, automatic retry and first-answer scoring', async () => {
    const options = await page.locator('.quiz-option').allTextContents();
    await page.reload();
    await page.locator('.quiz-option').first().waitFor();
    assert.deepEqual(await page.locator('.quiz-option').allTextContents(), options);
    const initial = (await state()).quizSession.queue[0];
    const wrongIndex = (initial.correctIndex + 1) % 4;
    await page.locator('body').click({ position: { x: 3, y: 3 } });
    await page.keyboard.press(String(wrongIndex + 1));
    await page.locator('#quiz-feedback.failure').waitFor();
    await until(async () => Boolean((await state()).quizSession.feedback));
    assert.equal((await state()).quizSession.queue.length, 3);
    assert.match(await page.locator('#quiz-feedback').textContent(), /宫廷/);
    assert.match(await page.locator('#quiz-feedback mark').textContent(), /court/i);
    await page.keyboard.press('1');
    await page.keyboard.press('4');
    assert.equal((await state()).quizSession.answers.length, 1);
    await page.reload();
    await page.locator('#quiz-feedback.failure').waitFor();
    assert.equal(await page.locator('.quiz-option.correct').count(), 1);
    await send({ book: 18, test: 1, passage: 2, activeText: 'A new passage about astronomy.' });
    await until(async () => Boolean((await state()).passageProgress['Cam18-T1-P2']));
    assert.equal((await state()).settings.activePassageId, 'p1-high-01');
    await page.locator('body').click({ position: { x: 3, y: 3 } });
    await page.keyboard.press('Enter');
    await until(async () => (await state()).quizSession.index === 1);
    await finishQuiz();
    await page.locator('#quiz-content h2').filter({ hasText: '50%' }).waitFor();
    await until(async () => (await state()).quizHistory.length === 1);
    const data = await state();
    assert.equal(data.quizHistory[0].attempts, 4);
    const retryIndex = data.quizSession.answers.findLastIndex((a) => a.wordId === 'p1-high-01:court');
    assert.ok(retryIndex >= 3);
    assert.equal(data.quizHistory[0].wrongWordIds.length, 1);
    assert.equal(data.vocabRecords['p1-high-01:court'].errors, 1);
    assert.ok(data.vocabRecords['p1-high-01:court'].nextReviewAt > Date.now());
  });

  await check('single target uses global options, explicit non-scored intervals and refresh-safe keyboard retries', async () => {
    await page.locator('#quit-quiz').click();
    await page.locator('#view-extract').waitFor({ state: 'visible' });
    await until(async () => (await state()).quizSession === null);
    for (const checkbox of await page.locator('.vocab-row input[type=checkbox]').all()) {
      await checkbox.uncheck();
    }
    await page.getByRole('checkbox', { name: '选择 court', exact: true }).check();
    assert.equal(await page.locator('.vocab-row input:checked').count(), 1);
    await page.locator('#start-selected-quiz').click();
    await page.locator('.quiz-option').first().waitFor();
    await until(async () => (await state()).quizSession?.words.length === 1);
    await page.locator('#unsure').click();
    await page.locator('#quiz-feedback.failure').waitFor();
    await page.locator('#next-question').click();
    await page.locator('#quiz-content h2').filter({ hasText: '稍后再测' }).waitFor();
    await until(async () => (await state()).quizSession.reviewBreak === 2);
    assert.equal(await page.locator('.quiz-option').count(), 0);
    await page.reload();
    await page.locator('#quiz-content h2').filter({ hasText: '稍后再测' }).waitFor();
    await page.locator('body').click({ position: { x: 3, y: 3 } });
    await page.keyboard.press('1');
    assert.equal((await state()).quizSession.answers.length, 1);
    await page.keyboard.press('Enter');
    await until(async () => (await state()).quizSession.reviewBreak === 1);
    await page.keyboard.press('Enter');
    await until(async () => (await state()).quizSession.reviewBreak === 0);
    await chooseCorrect();
    const q = (await state()).quizSession;
    assert.equal(q.completed, true);
    assert.equal(q.answers.length, 2);
    assert.ok(q.queue.every((item) => item.wordId === 'p1-high-01:court'));
    assert.equal(q.reviewTurns, 2);
  });

  await check('BroadcastChannel and storage fallback sync, submit results, capture opt-in and safe text rendering', async () => {
    await page.locator('#quit-quiz').click();
    const sender = await context.newPage();
    await sender.goto(`${origin}/README.md`);
    await sender.evaluate(() => {
      const bc = new BroadcastChannel('ielts_practice_sync');
      bc.postMessage({ id: 'browser-bc-1', sentAt: Date.now(),
        payload: { book: 18, test: 2, passage: 1, activeText: 'The court was silent.' } });
      setTimeout(() => bc.close(), 100);
    });
    await until(async () => (await state()).settings.activePassageId === 'Cam18-T2-P1');
    await sender.evaluate(() => localStorage.setItem('ielts_practice_sync_event', JSON.stringify({
      id: 'browser-storage-1', sentAt: Date.now(), payload: {
        book: 18, test: 2, passage: 2, activeText: '<img src=x onerror=alert(1)> The court was silent.',
        wrongQuestions: [{ id: 'q3', answer: 'TRUE', correctAnswer: 'FALSE' }], selection: 'court'
      }
    })));
    await until(async () => (await state()).settings.activePassageId === 'Cam18-T2-P2');
    await page.bringToFront();
    assert.equal((await state()).passageProgress['Cam18-T2-P2'].wordIds.length, 0);
    assert.equal(await page.locator('#passage-content img').count(), 0);
    assert.equal(await page.locator('#wrong-count').textContent(), '1');
    await page.locator('#settings-open').click();
    await page.locator('#capture-enabled').check();
    await until(async () => (await state()).settings.capture);
    await page.locator('[data-close=settings-dialog]').click();
    await send({ book: 18, test: 2, passage: 2, activeText: 'The court was silent.',
      selection: 'court', selectionSentence: 'The court was silent.' }, 'selection');
    await until(async () => (await state()).passageProgress['Cam18-T2-P2'].wordIds.length === 1);
    assert.equal((await state()).passageProgress['Cam18-T2-P2'].wrongQuestions.length, 1);
    await sender.close();
  });

  await check('export/import round trip, invalid backups preserve records, keyboard ignores text input', async () => {
    await page.locator('#settings-open').click();
    const downloadEvent = page.waitForEvent('download');
    await page.locator('#export-data').click();
    const download = await downloadEvent;
    const exported = await readFile(await download.path());
    const backup = JSON.parse(exported);
    const before = (await state()).revision;
    await page.locator('#import-data').setInputFiles({
      name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{"schemaVersion":2}')
    });
    await page.locator('#message.error').filter({ hasText: '备份格式' }).waitFor();
    assert.equal((await state()).revision, before);
    await page.locator('#import-data').setInputFiles({
      name: 'backup.json', mimeType: 'application/json', buffer: exported
    });
    await page.locator('#settings-dialog').waitFor({ state: 'hidden' });
    await until(async () => (await state()).revision > before);
    assert.deepEqual((await state()).vocabRecords, backup.vocabRecords);
    await page.locator('#capture-text').fill('');
    await page.locator('#capture-text').pressSequentially('1234 ');
    assert.equal(await page.locator('#capture-text').inputValue(), '1234 ');
  });

  await check('real Userscript DOM detection, same-window result message, capture and manual ID override', async () => {
    const source = await (await fetch(`${origin}/bridge.user.js`)).text();
    fixture = http.createServer(async (req, res) => {
      if (req.url.startsWith('/real/')) {
        const root = path.resolve('../IELTS-practice');
        const file = path.resolve(root, `.${decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(5))}`);
        if (!file.startsWith(`${root}/`)) { res.writeHead(403); res.end(); return; }
        try {
          const content = await readFile(file);
          const type = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
            '.json': 'application/json' }[path.extname(file)] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
          res.end(content);
        } catch { res.writeHead(404); res.end(); }
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Fixture reading</title><div id="left"><p>The royal court imported porcelain.</p></div>');
    });
    await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    practice = await context.newPage();
    practice.on('pageerror', (error) => errors.push(error.message));
    practice.on('dialog', (dialog) => dialog.accept());
    await practice.exposeBinding('gmRequest', async (_, options) => {
      const response = await fetch(options.url, { method: options.method, headers: options.headers, body: options.data });
      return { status: response.status, responseText: await response.text() };
    });
    await practice.addInitScript(() => {
      window.GM_getValue = () => true;
      window.GM_setValue = () => {};
      window.GM_registerMenuCommand = (name, callback) => { (window.bridgeMenus ||= {})[name] = callback; };
      window.GM_xmlhttpRequest = (options) => window.gmRequest({
        url: options.url, method: options.method, headers: options.headers, data: options.data
      }).then(options.onload, options.onerror);
    });
    await practice.goto(`http://127.0.0.1:${fixture.address().port}/?examId=Cam19-T1-P1`);
    await practice.addScriptTag({ content: source });
    await until(async () => Boolean((await state()).passageProgress['Cam19-T1-P1']));
    await practice.evaluate(() => window.postMessage({
      type: 'PRACTICE_COMPLETE', data: { examId: 'Cam19-T1-P1',
        answerComparison: { '7': { isCorrect: false, userAnswer: 'wood', correctAnswer: 'porcelain' } } }
    }, location.origin));
    await until(async () => (await state()).passageProgress['Cam19-T1-P1'].wrongQuestions.length === 1);
    await practice.evaluate(() => {
      const text = document.querySelector('#left p').firstChild;
      const range = document.createRange();
      range.setStart(text, 10);
      range.setEnd(text, 15);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.querySelector('#left p').dispatchEvent(new Event('copy', { bubbles: true }));
    });
    await until(async () => Boolean((await state()).vocabRecords['Cam19-T1-P1:court']));
    await practice.evaluate(() => {
      window.prompt = () => 'Cam20-T3-P2';
      window.bridgeMenus['手动设置当前篇章 ID']();
    });
    await until(async () => (await state()).settings.activePassageId === 'Cam20-T3-P2');
    assert.equal((await state()).passageProgress['Cam20-T3-P2'].activeText, 'The royal court imported porcelain.');
    await page.bringToFront();
  });

  await check('fast URL/dataset switches, ordinary clicked words and exact second-sentence capture', async () => {
    await practice.bringToFront();
    await practice.evaluate(() => {
      getSelection().removeAllRanges();
      history.pushState({}, '', '?examId=cam21-t1-p1');
      document.body.dataset.examId = 'cam21-t1-p1';
      document.querySelector('#left p').textContent = 'The court met. The porcelain cracked.';
    });
    await until(async () => (await state()).settings.activePassageId === 'Cam21-T1-P1');
    const position = await practice.evaluate(() => {
      const text = document.querySelector('#left p').firstChild;
      const range = document.createRange();
      range.setStart(text, text.textContent.indexOf('porcelain'));
      range.setEnd(text, text.textContent.indexOf('porcelain') + 9);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    await practice.mouse.click(position.x, position.y);
    await until(async () => Boolean((await state()).vocabRecords['Cam21-T1-P1:porcelain']));
    assert.equal((await state()).vocabRecords['Cam21-T1-P1:porcelain'].sentence, 'The porcelain cracked.');
    await page.locator('#detected-passage').filter({ hasText: 'Cam21-T1-P1' }).waitFor();
  });

  await check('source capture opt-out and passive suite results do not leak words or switch the active passage', async () => {
    await practice.evaluate(() => {
      window.selectionSends = 0;
      const request = window.GM_xmlhttpRequest;
      window.GM_xmlhttpRequest = (options) => {
        if (JSON.parse(options.data).kind === 'selection') window.selectionSends++;
        request(options);
      };
      window.bridgeMenus['开启 / 关闭划词及复制捕获']();
      document.querySelector('#left p').innerHTML = 'The court met. The porcelain cracked. An <mark data-word="amber">amber</mark> bead remained.';
      const mark = document.querySelector('[data-word=amber]');
      getSelection().removeAllRanges();
      mark.click();
      const range = document.createRange();
      range.selectNodeContents(mark);
      getSelection().addRange(range);
      mark.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      mark.dispatchEvent(new Event('copy', { bubbles: true }));
    });
    assert.equal(await practice.evaluate(() => window.selectionSends), 0);
    await until(async () => (await state()).passageProgress['Cam21-T1-P1'].activeText.includes('amber'));
    assert.equal((await state()).vocabRecords['Cam21-T1-P1:amber'], undefined);
    await practice.evaluate(() => {
      window.bridgeMenus['开启 / 关闭划词及复制捕获']();
      getSelection().removeAllRanges();
      window.postMessage({ type: 'SIMULATION_SUBMIT', data: { suiteEntries: [
        { examId: 'cam21-t1-p1', answerComparison: {} },
        { examId: 'p2-low-06', answerComparison: {
          '8': { isCorrect: false, userAnswer: 'wood', correctAnswer: 'stone' }
        } }
      ] } }, location.origin);
    });
    await until(async () => (await state()).passageProgress['p2-low-06']?.wrongQuestions.length === 1);
    assert.equal((await state()).settings.activePassageId, 'Cam21-T1-P1');
    assert.ok(!(await state()).passageProgress['p2-low-06'].activeText.includes('porcelain cracked'));
    assert.equal((await state()).passageProgress['p2-low-06'].lastDetectedAt, 0);
  });

  await check('intensive-reader overlay takes precedence and imported libraries keep independent identities', async () => {
    await practice.evaluate(() => {
      getSelection().removeAllRanges();
      window.ReadingVocabReader = { _sourceReady: true, currentExamId: 'shared',
        currentSource: { kind: 'imported', id: 'library-A' },
        currentExam: { title: 'Library A article' }, currentPayload: { meta: { title: 'Library A article' } } };
      const overlay = document.createElement('div');
      overlay.id = 'reading-vocab-reader-overlay';
      overlay.innerHTML = '<div id="vocab-passage-content"><p>A <mark data-word="treaty">treaty</mark> was signed.</p></div>';
      document.body.append(overlay);
    });
    await until(async () => Object.values((await state()).passageProgress).some((p) => p.title === 'Library A article'));
    await practice.locator('[data-word=treaty]').click();
    await until(async () => Object.values((await state()).vocabRecords).some((word) =>
      word.word === 'treaty' && word.passageId.startsWith('imported_')));
    const first = (await state()).settings.activePassageId;
    await practice.evaluate(() => {
      window.ReadingVocabReader.currentSource.id = 'library-B';
      window.ReadingVocabReader.currentExam.title = 'Library B article';
      document.querySelector('#vocab-passage-content p').lastChild.textContent = ' was revised.';
    });
    await until(async () => (await state()).settings.activePassageId !== first);
    const second = (await state()).settings.activePassageId;
    assert.ok(first.startsWith('imported_') && second.startsWith('imported_'));
    assert.equal((await state()).passageProgress[second].wordIds.length, 0);
    await page.locator('#detected-passage').filter({ hasText: 'Library B article' }).waitFor();
  });

  await check('actual IELTS-practice reading runtime syncs its true ID, title, passage vocabulary and synonyms', async () => {
    await practice.goto(`http://127.0.0.1:${fixture.address().port}/real/assets/generated/reading-exams/reading-practice-unified.html?examId=p1-high-01&dataKey=p1-high-01`);
    await practice.locator('#left p').filter({ hasText: 'The story of tea began' }).waitFor();
    const source = await (await fetch(`${origin}/bridge.user.js`)).text();
    await practice.addScriptTag({ content: source });
    await until(async () => (await state()).settings.activePassageId === 'p1-high-01');
    await page.locator('#detected-passage').filter({ hasText: 'A Brief History of Tea' }).waitFor();
    await page.locator('#core-list strong').filter({ hasText: /^infused$/ }).waitFor();
    assert.match(await page.locator('#synonym-list').textContent(), /steeped/);
    const original = (await state()).vocabRecords['p1-high-01:court'];
    assert.equal(original.meaningSource, 'manual');
    assert.equal(original.contextMeaning, '宫廷');
    await practice.close();
    await page.reload();
    await page.locator('#app[aria-busy=false]').waitFor();
    await page.locator('#detected-passage').filter({ hasText: 'A Brief History of Tea' }).waitFor();
    await page.locator('#synonym-list').filter({ hasText: 'royal household' }).waitFor();
    await page.bringToFront();
  });

  await check('320–1280px split-view layout, dark mode, reduced motion and no uncaught browser errors', async () => {
    await mkdir('test-results', { recursive: true });
    for (const width of [320, 360, 420, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}px`);
    }
    await page.setViewportSize({ width: 360, height: 900 });
    await page.screenshot({ path: 'test-results/companion-narrow.png', fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
    await page.screenshot({ path: 'test-results/companion-dark.png', fullPage: true });
    assert.deepEqual(errors, []);
  });

  await check('blocked dictionary assets do not hide existing progress or prevent manual editing', async () => {
    await page.route('**/assets/wordlists/ecdict_reading.bundle.js', (route) => route.abort());
    await page.reload();
    await page.locator('#app[aria-busy=false]').waitFor();
    await page.locator('#message.error').filter({ hasText: '已有记录仍可查看' }).waitFor();
    assert.notEqual(await page.locator('#passage-title').textContent(), '正在恢复阅读进度');
    await page.locator('#add-open').click();
    await page.locator('#edit-word').fill('palace');
    await page.locator('#edit-meaning').fill('宫殿');
    await page.locator('#word-form button[type=submit]').click();
    await page.locator('#word-dialog').waitFor({ state: 'hidden' });
    await until(async () => Object.values((await state()).vocabRecords).some((w) => w.word === 'palace'));
  });

  await check('closing inside debounce without unload handlers restores passage, notebook and last study time', async () => {
    const persistence = await browser.newContext();
    try {
      // Simulate a browser that never delivers lifecycle events before termination.
      await persistence.addInitScript(() => {
        const original = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function (type, listener, options) {
          if ((this === window && type === 'pagehide') ||
              (this === document && type === 'visibilitychange')) return;
          return original.call(this, type, listener, options);
        };
      });
      await persistence.route('**/storageService.js', async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace('debounceMs = 300, maxWaitMs = 2000',
          'debounceMs = 60000, maxWaitMs = 60000');
        await route.fulfill({ response, body });
      });
      const studying = await persistence.newPage();
      studying.on('pageerror', (error) => errors.push(error.message));
      await studying.goto(origin);
      await studying.locator('#app[aria-busy=false]').waitFor();
      await studying.locator('#manual-switch summary').click();
      await studying.locator('#manual-id').fill('Cam20-T4-P3');
      await studying.locator('#manual-title').fill('Persistence regression');
      await studying.locator('#manual-text').fill('The landscape was ephemeral.');
      await studying.locator('#passage-form button[type=submit]').click();
      await studying.locator('#passage-title').filter({ hasText: 'Persistence regression' }).waitFor();
      await studying.locator('#add-open').click();
      await studying.locator('#edit-word').fill('ephemeral');
      await studying.locator('#edit-meaning').fill('短暂的');
      await studying.locator('#edit-sentence').fill('The landscape was ephemeral.');
      await studying.locator('#word-form button[type=submit]').click();
      await studying.locator('#word-dialog').waitFor({ state: 'hidden' });
      await studying.locator('#start-learn').click();
      await studying.locator('#unknown').click();
      await studying.locator('#batch-quiz').waitFor();
      const checkpoint = await studying.evaluate(() =>
        JSON.parse(localStorage.getItem('ielts_vocab_companion_v2_pending')));
      const id = 'Cam20-T4-P3:ephemeral';
      assert.equal(checkpoint.vocabRecords[id].errors, 1);
      assert.equal(checkpoint.vocabRecords[id].status, 'learning');
      assert.ok(checkpoint.vocabRecords[id].lastStudiedAt > 0);
      assert.equal((await state()).vocabRecords[id], undefined);
      await studying.close();
      const reopened = await persistence.newPage();
      reopened.on('pageerror', (error) => errors.push(error.message));
      await reopened.goto(origin);
      await reopened.locator('#app[aria-busy=false]').waitFor();
      await reopened.locator('#batch-quiz').waitFor();
      assert.equal(await reopened.locator('#passage-select').inputValue(), 'Cam20-T4-P3');
      await until(async () => Boolean((await state()).vocabRecords[id]));
      const recovered = await state();
      assert.deepEqual(recovered.vocabRecords[id], checkpoint.vocabRecords[id]);
      assert.equal(recovered.learningSession.index, 1);
      assert.deepEqual(errors, []);
    } finally { await persistence.close(); }
  });
  console.log(`\n${checks} browser workflows passed (real Chrome; temporary data only).`);
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (fixture) {
    fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
  }
  await rm(dataDir, { recursive: true, force: true });
}
