(function () {
  'use strict';

  const state = {
    currentExamId: null,
    currentExamData: null,
    currentTask: null,
    currentView: 'extract',
    activeReviewIndex: 0,
    reviewWordList: [],
    isCardRevealed: false,
    selectedTokenElement: null
  };

  const elements = {
    articleTitle: document.getElementById('article-title'),
    articleCategory: document.getElementById('article-category'),
    articleExamId: document.getElementById('article-exam-id'),
    articleScore: document.getElementById('article-score'),
    recentSelect: document.getElementById('recent-exams-select'),
    wordsPoolList: document.getElementById('words-pool-list'),
    poolCountBadge: document.getElementById('pool-count-badge'),
    passageContainer: document.getElementById('passage-content-container'),
    verifyPassageContainer: document.getElementById('verify-passage-container'),
    dictPopup: document.getElementById('dict-popup'),
    popupWord: document.getElementById('popup-word'),
    popupPhonetic: document.getElementById('popup-phonetic'),
    popupMeaning: document.getElementById('popup-meaning'),
    popupAddBtn: document.getElementById('popup-add-btn'),
    flowNavExtract: document.getElementById('nav-btn-extract'),
    flowNavMemorize: document.getElementById('nav-btn-memorize'),
    flowNavVerify: document.getElementById('nav-btn-verify'),
    viewExtract: document.getElementById('view-extract'),
    viewMemorize: document.getElementById('view-memorize'),
    viewVerify: document.getElementById('view-verify'),
    startTaskBtn: document.getElementById('start-task-btn'),
    flashcard: document.getElementById('memorize-card'),
    cardWord: document.getElementById('card-word'),
    cardPhonetic: document.getElementById('card-phonetic'),
    cardContext: document.getElementById('card-context'),
    cardMeaning: document.getElementById('card-meaning'),
    toggleRevealBtn: document.getElementById('btn-toggle-reveal'),
    markKnownBtn: document.getElementById('btn-mark-known'),
    markUnknownBtn: document.getElementById('btn-mark-unknown'),
    taskProgressFill: document.getElementById('task-progress-fill'),
    taskProgressText: document.getElementById('task-progress-text'),
    startVerifyBtn: document.getElementById('btn-start-verify'),
    finishTaskBtn: document.getElementById('btn-finish-task'),
    modalOverlay: document.getElementById('modal-overlay'),
    modalTitle: document.getElementById('modal-title'),
    modalDesc: document.getElementById('modal-desc'),
    modalConfirmBtn: document.getElementById('modal-confirm-btn')
  };

  async function init() {
    setupEventListeners();
    window.DictService.loadDictionary().catch(() => {});
    await loadRecentPractices();
  }

  function setupEventListeners() {
    elements.flowNavExtract.addEventListener('click', () => switchView('extract'));
    elements.flowNavMemorize.addEventListener('click', () => switchView('memorize'));
    elements.flowNavVerify.addEventListener('click', () => switchView('verify'));
    elements.recentSelect.addEventListener('change', (e) => {
      if (e.target.value) switchExam(e.target.value);
    });
    elements.startTaskBtn.addEventListener('click', () => switchView('memorize'));
    elements.toggleRevealBtn.addEventListener('click', toggleCardReveal);
    elements.flashcard.addEventListener('click', toggleCardReveal);
    elements.markKnownBtn.addEventListener('click', () => handleReviewWord(true));
    elements.markUnknownBtn.addEventListener('click', () => handleReviewWord(false));
    elements.startVerifyBtn.addEventListener('click', () => switchView('verify'));
    elements.finishTaskBtn.addEventListener('click', finishFullCycle);
    elements.modalConfirmBtn.addEventListener('click', () => {
      elements.modalOverlay.style.display = 'none';
    });
    document.addEventListener('click', (e) => {
      if (!elements.dictPopup.contains(e.target) && !e.target.classList.contains('vocab-token')) {
        elements.dictPopup.style.display = 'none';
      }
    });
  }

  function switchView(viewName) {
    state.currentView = viewName;
    elements.flowNavExtract.classList.toggle('active', viewName === 'extract');
    elements.flowNavMemorize.classList.toggle('active', viewName === 'memorize');
    elements.flowNavVerify.classList.toggle('active', viewName === 'verify');
    elements.viewExtract.classList.toggle('active', viewName === 'extract');
    elements.viewMemorize.classList.toggle('active', viewName === 'memorize');
    elements.viewVerify.classList.toggle('active', viewName === 'verify');
    if (viewName === 'memorize') setupMemorizeSession();
    if (viewName === 'verify') setupVerifySession();
  }

  async function loadRecentPractices() {
    const records = await window.VocabBridge.getRecentReadingPractices();
    elements.recentSelect.innerHTML = '';
    if (!records || records.length === 0) {
      const opt = document.createElement('option');
      opt.value = 'p1-high-01';
      opt.textContent = '茶叶简史 (p1-high-01 · 样例精读)';
      elements.recentSelect.appendChild(opt);
      await switchExam('p1-high-01');
      return;
    }
    records.forEach((r) => {
      const opt = document.createElement('option');
      opt.value = r.examId;
      opt.textContent = `${r.title} (${r.category} · 得分: ${r.score !== null ? r.score : '-'})`;
      elements.recentSelect.appendChild(opt);
    });
    await switchExam(records[0].examId);
  }

  async function switchExam(examId) {
    state.currentExamId = examId;
    state.currentTask = window.VocabTaskStore.getTask(examId);
    state.currentExamData = await window.VocabBridge.loadExamData(examId);
    if (!state.currentExamData) {
      elements.articleTitle.textContent = `无法加载题库: ${examId}`;
      return;
    }
    elements.articleTitle.textContent = state.currentExamData.meta.title || examId;
    elements.articleCategory.textContent = state.currentExamData.meta.category || 'P1';
    elements.articleExamId.textContent = examId;
    renderPassageTokens();
    renderPoolWords();
  }

  function renderPassageTokens() {
    const blocks = state.currentExamData.passage?.blocks || [];
    const rawHtml = blocks.map((b) => b.html || '').join('');
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = rawHtml;
    wrapTextNodes(tempDiv);
    elements.passageContainer.innerHTML = '';
    while (tempDiv.firstChild) {
      elements.passageContainer.appendChild(tempDiv.firstChild);
    }
    highlightSelectedTokens();
  }

  function wrapTextNodes(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.trim().length > 0) {
        textNodes.push(node);
      }
    }
    textNodes.forEach((tn) => {
      const text = tn.nodeValue;
      const fragment = document.createDocumentFragment();
      const parts = text.split(/([a-zA-Z0-9'-]+)/g);
      parts.forEach((part) => {
        if (/^[a-zA-Z0-9'-]+$/.test(part)) {
          const span = document.createElement('span');
          span.className = 'vocab-token';
          span.textContent = part;
          span.dataset.word = part.toLowerCase();
          span.addEventListener('click', (ev) => handleTokenClick(ev, span));
          fragment.appendChild(span);
        } else {
          fragment.appendChild(document.createTextNode(part));
        }
      });
      if (tn.parentNode) tn.parentNode.replaceChild(fragment, tn);
    });
  }

  function highlightSelectedTokens() {
    const words = state.currentTask.words || {};
    const tokens = elements.passageContainer.querySelectorAll('.vocab-token');
    tokens.forEach((t) => {
      const w = t.dataset.word;
      t.classList.toggle('selected-word', Boolean(words[w]));
    });
  }

  async function handleTokenClick(event, tokenSpan) {
    event.stopPropagation();
    const word = tokenSpan.dataset.word;
    state.selectedTokenElement = tokenSpan;
    const parentP = tokenSpan.closest('p') || tokenSpan.closest('div') || tokenSpan.parentNode;
    const sentence = parentP ? parentP.textContent.trim() : '';
    const rect = tokenSpan.getBoundingClientRect();
    const popup = elements.dictPopup;
    popup.style.top = `${window.scrollY + rect.bottom + 8}px`;
    popup.style.left = `${Math.min(window.scrollX + rect.left, window.innerWidth - 340)}px`;
    popup.style.display = 'block';
    elements.popupWord.textContent = word;
    elements.popupPhonetic.textContent = '查询中...';
    elements.popupMeaning.textContent = '';
    const dictInfo = await window.DictService.lookup(word);
    elements.popupPhonetic.textContent = dictInfo.phonetic || '';
    elements.popupMeaning.textContent = dictInfo.meaning || '点击加入生词本';
    const isAlreadyAdded = Boolean(state.currentTask.words[word]);
    elements.popupAddBtn.textContent = isAlreadyAdded ? '移出生词本' : '加入生词本';
    elements.popupAddBtn.className = isAlreadyAdded ? 'btn btn-danger' : 'btn btn-primary';
    elements.popupAddBtn.onclick = () => {
      if (isAlreadyAdded) {
        window.VocabTaskStore.removeWord(state.currentExamId, word);
      } else {
        window.VocabTaskStore.addWord(state.currentExamId, {
          word,
          phonetic: dictInfo.phonetic || '',
          meaning: dictInfo.meaning || '',
          sentence
        });
      }
      popup.style.display = 'none';
      state.currentTask = window.VocabTaskStore.getTask(state.currentExamId);
      highlightSelectedTokens();
      renderPoolWords();
    };
  }

  function renderPoolWords() {
    const words = Object.values(state.currentTask.words || {});
    elements.poolCountBadge.textContent = `${words.length} 词`;
    elements.wordsPoolList.innerHTML = '';
    if (words.length === 0) {
      elements.wordsPoolList.innerHTML = '<div class="empty-state"><div class="empty-icon">✍️</div><p>点击左侧文章中的单词，将其圈入本篇生词本</p></div>';
      elements.startTaskBtn.disabled = true;
      elements.startTaskBtn.style.opacity = '0.5';
      return;
    }
    elements.startTaskBtn.disabled = false;
    elements.startTaskBtn.style.opacity = '1';
    words.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'word-card-mini';
      card.innerHTML = `
        <div class="word-head">
          <span class="word-text">${item.word}</span>
          <span class="word-phonetic">${item.phonetic}</span>
          <button class="word-remove-btn" title="移出">×</button>
        </div>
        <div class="word-meaning">${item.meaning}</div>
        <div class="word-context-snippet">“${item.sentence.replace(/</g, '&lt;')}”</div>
      `;
      card.querySelector('.word-remove-btn').addEventListener('click', () => {
        window.VocabTaskStore.removeWord(state.currentExamId, item.word);
        state.currentTask = window.VocabTaskStore.getTask(state.currentExamId);
        highlightSelectedTokens();
        renderPoolWords();
      });
      elements.wordsPoolList.appendChild(card);
    });
  }

  function setupMemorizeSession() {
    state.currentTask = window.VocabTaskStore.getTask(state.currentExamId);
    const words = Object.values(state.currentTask.words || {});
    if (words.length === 0) {
      switchView('extract');
      return;
    }
    state.reviewWordList = words.sort((a, b) => (a.stage === 'known' ? 1 : -1));
    state.activeReviewIndex = 0;
    renderCurrentCard();
  }

  function renderCurrentCard() {
    const total = state.reviewWordList.length;
    if (state.activeReviewIndex >= total) {
      renderMemorizeCompletion();
      return;
    }
    const current = state.reviewWordList[state.activeReviewIndex];
    state.isCardRevealed = false;
    elements.flashcard.classList.remove('revealed');
    elements.cardWord.textContent = current.word;
    elements.cardPhonetic.textContent = current.phonetic || '';
    elements.cardMeaning.textContent = current.meaning || '暂无释义';
    if (current.sentence) {
      const reg = new RegExp(`\\b(${current.word})\\b`, 'gi');
      const highlighted = current.sentence.replace(reg, '<strong>$1</strong>');
      elements.cardContext.innerHTML = `<strong>真题语境：</strong>“${highlighted}”`;
      elements.cardContext.style.display = 'block';
    } else {
      elements.cardContext.style.display = 'none';
    }
    const progress = Math.round((state.activeReviewIndex / total) * 100);
    elements.taskProgressFill.style.width = `${progress}%`;
    elements.taskProgressText.textContent = `${state.activeReviewIndex + 1} / ${total}`;
  }

  function toggleCardReveal() {
    state.isCardRevealed = !state.isCardRevealed;
    elements.flashcard.classList.toggle('revealed', state.isCardRevealed);
  }

  function handleReviewWord(isKnown) {
    const current = state.reviewWordList[state.activeReviewIndex];
    if (!current) return;
    window.VocabTaskStore.updateWordStage(state.currentExamId, current.word, isKnown ? 'known' : 'review');
    state.activeReviewIndex++;
    renderCurrentCard();
  }

  function renderMemorizeCompletion() {
    elements.taskProgressFill.style.width = '100%';
    elements.taskProgressText.textContent = '全部过完！';
    elements.flashcard.classList.remove('revealed');
    elements.cardWord.textContent = '🎉 阶段达成';
    elements.cardPhonetic.textContent = '本篇所有陌生单词已建立英文至中文联想！';
    elements.cardContext.innerHTML = '下一步：<strong>重回篇章进行全真语境检阅</strong>，检验在长难句中是否能瞬间辨识。';
    elements.cardContext.style.display = 'block';
    elements.toggleRevealBtn.style.display = 'none';
    elements.markKnownBtn.style.display = 'none';
    elements.markUnknownBtn.style.display = 'none';
    elements.startVerifyBtn.style.display = 'inline-flex';
  }

  function setupVerifySession() {
    state.currentTask = window.VocabTaskStore.getTask(state.currentExamId);
    const words = state.currentTask.words || {};
    const blocks = state.currentExamData.passage?.blocks || [];
    const rawHtml = blocks.map((b) => b.html || '').join('');
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = rawHtml;
    wrapTextNodes(tempDiv);
    const tokens = tempDiv.querySelectorAll('.vocab-token');
    tokens.forEach((t) => {
      const w = t.dataset.word;
      if (words[w]) {
        t.classList.add('masked-test-word');
        t.title = '点击检验词义';
        t.addEventListener('click', (e) => {
          e.stopPropagation();
          if (t.classList.contains('masked-test-word')) {
            t.classList.remove('masked-test-word');
            t.classList.add('verified-tested');
            showInlineFeedback(t, words[w].meaning);
          }
        });
      }
    });
    elements.verifyPassageContainer.innerHTML = '';
    while (tempDiv.firstChild) {
      elements.verifyPassageContainer.appendChild(tempDiv.firstChild);
    }
  }

  function showInlineFeedback(tokenElement, meaning) {
    const tip = document.createElement('span');
    tip.style.fontSize = '0.8rem';
    tip.style.color = '#34d399';
    tip.style.marginLeft = '4px';
    tip.textContent = `[${meaning}]`;
    tokenElement.parentNode.insertBefore(tip, tokenElement.nextSibling);
  }

  function finishFullCycle() {
    const task = window.VocabTaskStore.getTask(state.currentExamId);
    task.status = 'completed';
    window.VocabTaskStore.saveTask(task);
    elements.modalTitle.textContent = '🏆 恭喜通关！';
    elements.modalDesc.textContent = `你已成功攻克《${state.currentExamData.meta.title}》的全部生词，并在整篇语境中完成全真复验！`;
    elements.modalOverlay.style.display = 'flex';
  }

  window.addEventListener('DOMContentLoaded', init);
})();
