/**
 * module_writing.js - Writing Dictation Module for IELTS_Dictation_v2
 * ===================================================================
 * Requirement R3 Compliance:
 * 1. STRICTLY TEXT-ONLY: Zero audio playback, zero SpeechSynthesis invocations.
 * 2. Default mode: Prompts user with Chinese meaning; user types English spelling.
 * 3. Exact replication of original Ebbinghaus writing rules:
 *    - 9-stage second/minute-level intervals.
 *    - Pure Chinese definition shown before submission; notes in 【...】 and example sentences hidden.
 *    - 2-pass stage 0/1 rule for newly learned words.
 *    - Character alignment diff on errors with retry card re-insertion.
 * 4. Full queue and input state preservation across tab switches.
 */

(function(window) {
  'use strict';

  const STAGE_NAMES = {
    0: 'Stage 0 (5分钟)',
    1: 'Stage 1 (30分钟)',
    2: 'Stage 2 (12小时)',
    3: 'Stage 3 (1天)',
    4: 'Stage 4 (2天)',
    5: 'Stage 5 (4天)',
    6: 'Stage 6 (7天)',
    7: 'Stage 7 (15天)',
    8: 'Stage 8 (30天)'
  };

  const WritingModule = {
    queue: [],
    currentIndex: 0,
    currentWord: null,
    isJudged: false,
    hasErrorOnCurrent: false,
    sessionStats: {
      total: 0,
      correct: 0,
      wrong: 0,
      startTime: null
    },

    init() {
      this.cacheDom();
      this.bindEvents();
      this.refreshDashboard();
      this.restoreActiveSession();
    },

    cacheDom() {
      // Views
      this.dashboardView = document.getElementById('writing-dashboard');
      this.dictationView = document.getElementById('writing-dictation');
      this.completedView = document.getElementById('writing-completed');

      // Dashboard elements
      this.btnStart = document.getElementById('btn-writing-start');
      this.btnResume = document.getElementById('btn-writing-resume');
      this.dueCountBadge = document.getElementById('writing-due-count');
      this.totalCountBadge = document.getElementById('writing-total-count');
      this.newCountBadge = document.getElementById('writing-new-count');
      this.masteredCountBadge = document.getElementById('writing-mastered-count');
      this.resumeBanner = document.getElementById('writing-resume-banner');
      this.resumeDesc = document.getElementById('writing-resume-desc');

      // Dictation card elements
      this.cardSection = document.getElementById('writing-word-section');
      this.cardStage = document.getElementById('writing-word-stage');
      this.cardProgressText = document.getElementById('writing-progress-text');
      this.cardProgressFill = document.getElementById('writing-progress-fill');
      this.wordMeaningPrompt = document.getElementById('writing-meaning-prompt');
      this.phraseGuide = document.getElementById('writing-phrase-guide');
      this.typingInput = document.getElementById('writing-input');
      this.feedbackBox = document.getElementById('writing-feedback');
      this.diffBox = document.getElementById('writing-diff-box');
      this.revealedSpelling = document.getElementById('writing-revealed-spelling');
      this.revealedNotes = document.getElementById('writing-revealed-notes');
      this.revealedSentence = document.getElementById('writing-revealed-sentence');
      this.btnNextWord = document.getElementById('btn-writing-next');
      this.btnExitSession = document.getElementById('btn-writing-exit');

      // Completion elements
      this.compTotal = document.getElementById('writing-comp-total');
      this.compAccuracy = document.getElementById('writing-comp-accuracy');
      this.compCorrect = document.getElementById('writing-comp-correct');
      this.compWrong = document.getElementById('writing-comp-wrong');
      this.btnCompRestart = document.getElementById('btn-writing-comp-restart');
      this.btnCompBack = document.getElementById('btn-writing-comp-back');
    },

    bindEvents() {
      if (this.btnStart) {
        this.btnStart.addEventListener('click', () => this.startNewSession());
      }
      if (this.btnResume) {
        this.btnResume.addEventListener('click', () => this.resumeSession());
      }
      if (this.btnNextWord) {
        this.btnNextWord.addEventListener('click', () => this.advanceNext());
      }
      if (this.btnExitSession) {
        this.btnExitSession.addEventListener('click', () => this.exitSession());
      }
      if (this.btnCompRestart) {
        this.btnCompRestart.addEventListener('click', () => this.startNewSession());
      }
      if (this.btnCompBack) {
        this.btnCompBack.addEventListener('click', () => this.showDashboard());
      }

      // Input keydown handler
      if (this.typingInput) {
        this.typingInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (this.isJudged) {
              this.advanceNext();
            } else {
              this.checkAnswer();
            }
          } else if (e.key === 'Tab') {
            e.preventDefault();
            this.showHint();
          }
        });

        this.typingInput.addEventListener('input', () => {
          if (!this.isJudged) {
            this.typingInput.classList.remove('wrong', 'correct');
            if (this.feedbackBox) this.feedbackBox.style.display = 'none';
          }
          this.updatePhraseSlotHighlight();
        });
      }
    },

    async restoreActiveSession() {
      try {
        const res = await Api.getSession('writing');
        if (res && res.session && Array.isArray(res.session.queue) && res.session.queue.length > 0) {
          const idx = res.session.currentIndex || 0;
          if (idx < res.session.queue.length) {
            this.queue = res.session.queue;
            this.currentIndex = idx;
            this.showResumeBanner(res.session);
          }
        }
      } catch (e) {
        console.warn('Could not restore writing session:', e);
      }
    },

    showResumeBanner(session) {
      if (!this.resumeBanner) return;
      const total = session.queue.length;
      const curr = Math.min((session.currentIndex || 0) + 1, total);
      const pct = Math.round(((session.currentIndex || 0) / total) * 100);
      if (this.resumeDesc) {
        this.resumeDesc.innerText = `上次进行至第 ${curr} / ${total} 词（已完成 ${pct}%）`;
      }
      this.resumeBanner.style.display = 'block';
      if (this.btnStart) {
        this.btnStart.innerText = '🚀 重新开启新默写';
        this.btnStart.classList.remove('btn-primary');
        this.btnStart.classList.add('btn-secondary');
      }
    },

    hideResumeBanner() {
      if (this.resumeBanner) this.resumeBanner.style.display = 'none';
      if (this.btnStart) {
        this.btnStart.innerText = '🚀 开始写作默写';
        this.btnStart.classList.remove('btn-secondary');
        this.btnStart.classList.add('btn-primary');
      }
    },

    async refreshDashboard() {
      try {
        const stats = await Api.getStats('writing');
        if (this.dueCountBadge) this.dueCountBadge.innerText = stats.due_count || 0;
        if (this.totalCountBadge) this.totalCountBadge.innerText = stats.total || 0;
        if (this.newCountBadge) this.newCountBadge.innerText = stats.new_count || 0;
        if (this.masteredCountBadge) this.masteredCountBadge.innerText = stats.mastered_count || 0;

        if (this.btnStart && (!this.queue || this.queue.length === 0)) {
          if (stats.due_count > 0) {
            this.btnStart.innerHTML = `⚡️ 开始艾宾浩斯复习 (${stats.due_count} 词待复习)`;
          } else {
            this.btnStart.innerHTML = '🚀 开始写作默写';
          }
        }
      } catch (e) {
        console.error('Failed to load writing stats:', e);
      }
    },

    async startNewSession() {
      try {
        if (this.btnStart) this.btnStart.disabled = true;
        const res = await Api.startSession('writing');
        if (res && Array.isArray(res.queue) && res.queue.length > 0) {
          this.queue = res.queue;
          this.currentIndex = 0;
          this.sessionStats = {
            total: res.queue.length,
            correct: 0,
            wrong: 0,
            startTime: Date.now()
          };
          this.hideResumeBanner();
          this.showDictationView();
          this.loadCardAt(0);
        } else {
          alert('暂无需要复习或学习的写作词汇！');
        }
      } catch (e) {
        alert('启动写作默写失败: ' + (e.message || e));
      } finally {
        if (this.btnStart) this.btnStart.disabled = false;
      }
    },

    resumeSession() {
      if (this.queue && this.queue.length > 0) {
        this.showDictationView();
        this.loadCardAt(this.currentIndex);
      }
    },

    showDashboard() {
      this.dashboardView.style.display = 'block';
      this.dictationView.style.display = 'none';
      this.completedView.style.display = 'none';
      this.refreshDashboard();
    },

    showDictationView() {
      this.dashboardView.style.display = 'none';
      this.dictationView.style.display = 'block';
      this.completedView.style.display = 'none';
    },

    showCompletedView() {
      this.dashboardView.style.display = 'none';
      this.dictationView.style.display = 'none';
      this.completedView.style.display = 'block';

      const total = this.sessionStats.correct + this.sessionStats.wrong;
      const acc = total > 0 ? Math.round((this.sessionStats.correct / total) * 100) : 100;
      if (this.compTotal) this.compTotal.innerText = total;
      if (this.compAccuracy) this.compAccuracy.innerText = acc + '%';
      if (this.compCorrect) this.compCorrect.innerText = this.sessionStats.correct;
      if (this.compWrong) this.compWrong.innerText = this.sessionStats.wrong;

      Api.clearSession('writing').catch(() => {});
      this.queue = [];
      this.currentIndex = 0;
      this.hideResumeBanner();
      if (window.App && typeof window.App.refreshHeaderStats === 'function') {
        window.App.refreshHeaderStats();
      }
    },

    parseMeaning(raw) {
      if (!raw) return { pureMeaning: '', notes: '' };
      const idx = raw.indexOf('【');
      if (idx !== -1) {
        return {
          pureMeaning: raw.slice(0, idx).trim(),
          notes: raw.slice(idx).trim()
        };
      }
      return { pureMeaning: raw.trim(), notes: '' };
    },

    loadCardAt(idx) {
      if (idx >= this.queue.length) {
        this.showCompletedView();
        return;
      }

      this.currentIndex = idx;
      this.currentWord = this.queue[idx];
      this.isJudged = false;
      this.hasErrorOnCurrent = false;

      Api.saveSession('writing', {
        currentIndex: idx,
        queue: this.queue
      }).catch(() => {});

      const w = this.currentWord;
      const targetWord = (w.word || w.id || '').trim();

      // Update progress & tags
      if (this.cardProgressText) {
        this.cardProgressText.innerText = `${idx + 1} / ${this.queue.length}`;
      }
      if (this.cardProgressFill) {
        const pct = Math.round((idx / this.queue.length) * 100);
        this.cardProgressFill.style.width = pct + '%';
      }

      if (this.cardSection) {
        this.cardSection.innerText = w.section || '写作词汇';
      }

      if (this.cardStage) {
        const stage = w.stage || 0;
        this.cardStage.innerText = STAGE_NAMES[stage] || `Stage ${stage}`;
      }

      // Hide revealed information
      if (this.diffBox) this.diffBox.style.display = 'none';
      if (this.feedbackBox) this.feedbackBox.style.display = 'none';
      if (this.btnNextWord) this.btnNextWord.style.display = 'none';

      // Parse pure Chinese meaning and display
      const parsed = this.parseMeaning(w.meaning);
      if (this.wordMeaningPrompt) {
        this.wordMeaningPrompt.innerText = parsed.pureMeaning;
      }

      // Render phrase guide if applicable
      this.renderPhraseGuide(targetWord);

      // Reset typing input
      if (this.typingInput) {
        this.typingInput.value = '';
        this.typingInput.className = 'typing-input';
        this.typingInput.disabled = false;
        setTimeout(() => this.typingInput.focus(), 50);
      }
    },

    renderPhraseGuide(targetWord) {
      if (!this.phraseGuide) return;
      const tokens = targetWord.split(/\s+/).filter(Boolean);
      if (tokens.length > 1) {
        let html = `<div class="phrase-guide-pill">🧩 短语搭配：共 ${tokens.length} 词（空格隔开）</div>`;
        html += '<div class="phrase-slots-row">';
        tokens.forEach((token, i) => {
          const len = token.replace(/[^a-zA-Z0-9]/g, '').length || token.length;
          html += `<div class="slot-chip" id="writing-slot-chip-${i}"><span>词 ${i + 1}</span> <strong>(${len}字母)</strong></div>`;
        });
        html += '</div>';
        this.phraseGuide.innerHTML = html;
        this.phraseGuide.style.display = 'block';
      } else {
        const len = targetWord.length;
        this.phraseGuide.innerHTML = `<div class="single-word-guide">🔤 目标单词长度：<strong>${len} 个字母</strong></div>`;
        this.phraseGuide.style.display = 'block';
      }
    },

    updatePhraseSlotHighlight() {
      if (!this.currentWord || !this.typingInput) return;
      const targetWord = (this.currentWord.word || this.currentWord.id || '').trim();
      const tokens = targetWord.split(/\s+/).filter(Boolean);
      if (tokens.length <= 1) return;

      const typed = this.typingInput.value;
      const typedTokens = typed.split(/\s+/);
      const hasTrailingSpace = /\s$/.test(typed);
      const activeIdx = hasTrailingSpace ? typedTokens.filter(Boolean).length : Math.max(0, typedTokens.length - 1);

      tokens.forEach((token, i) => {
        const chip = document.getElementById(`writing-slot-chip-${i}`);
        if (!chip) return;
        chip.classList.remove('active', 'done');
        if (i < activeIdx) {
          chip.classList.add('done');
        } else if (i === activeIdx) {
          chip.classList.add('active');
        }
      });
    },

    normalizeAnswer(str) {
      return (str || '')
        .replace(/[\u2018\u2019\u201B\u2032\u00B4\u0060]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2010\u2011\u2012\u2013\u2014]/g, '-')
        .replace(/\u2026/g, '...')
        .replace(/\.{2,}/g, ' ')
        .replace(/\s*\/\s*/g, ' / ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    },

    getAcceptedAnswers(target) {
      const full = this.normalizeAnswer(target);
      const accepted = new Set([full]);
      const tokens = full.split(' ');
      if (tokens.includes('/')) {
        let variants = [[]];
        for (let i = 0; i < tokens.length; i++) {
          if (tokens[i + 1] === '/' && i + 2 < tokens.length) {
            const options = [tokens[i]];
            let j = i + 1;
            while (tokens[j] === '/' && j + 1 < tokens.length) {
              options.push(tokens[j + 1]);
              j += 2;
            }
            variants = variants.flatMap(v => options.map(o => v.concat(o)));
            i = j - 1;
          } else if (tokens[i] !== '/') {
            variants = variants.map(v => v.concat(tokens[i]));
          }
        }
        variants.forEach(v => accepted.add(v.join(' ')));
      }
      return accepted;
    },

    isAnswerAccepted(typed, target) {
      return this.getAcceptedAnswers(target).has(this.normalizeAnswer(typed));
    },

    alignTypedChars(typed, target) {
      if (!typed) return [];
      const tLower = typed.toLowerCase().trim();
      const tgtLower = target.toLowerCase().trim();
      if (tLower === tgtLower) {
        return typed.split('').map(c => ({ char: c, status: 'correct' }));
      }

      const m = typed.length, n = target.length;
      const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
      for (let i = 0; i <= m; i++) dp[i][0] = i;
      for (let j = 0; j <= n; j++) dp[0][j] = j;

      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          const cost = tLower[i - 1] === tgtLower[j - 1] ? 0 : 1;
          dp[i][j] = Math.min(
            dp[i - 1][j] + 1,
            dp[i][j - 1] + 1,
            dp[i - 1][j - 1] + cost
          );
        }
      }

      let i = m, j = n, aligned = [];
      while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && tLower[i - 1] === tgtLower[j - 1] && dp[i][j] === dp[i - 1][j - 1]) {
          aligned.push({ char: typed[i - 1], status: 'correct' });
          i--; j--;
        } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
          aligned.push({ char: typed[i - 1], status: 'wrong' });
          i--; j--;
        } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
          aligned.push({ char: typed[i - 1], status: 'wrong' });
          i--;
        } else {
          j--;
        }
      }
      aligned.reverse();
      return aligned;
    },

    async checkAnswer() {
      if (!this.currentWord || !this.typingInput) return;
      const userInput = this.typingInput.value;
      if (!userInput.trim()) {
        this.typingInput.focus();
        return;
      }

      const card = this.currentWord;
      const target = (card.word || card.id || '').trim();
      const currentStage = card.stage !== undefined ? card.stage : 0;
      const isRetryCard = Boolean(card._isRetry);
      const isFirstTry = !this.hasErrorOnCurrent;

      const accepted = this.isAnswerAccepted(userInput, target);
      this.isJudged = true;

      if (accepted) {
        this.typingInput.classList.remove('wrong');
        this.typingInput.classList.add('correct');
        this.sessionStats.correct++;

        // Stage 0/1 two-pass rule for writing
        const stage01PassCount = card._stage01PassCount || 0;
        const needsSecondPass = !isRetryCard && currentStage <= 1 && stage01PassCount === 0 && isFirstTry;

        if (needsSecondPass) {
          card._stage01PassCount = 1;
          const secondPassWord = Object.assign({}, card, { _stage01PassCount: 1 });
          const insertIdx = this.currentIndex + 4;
          if (insertIdx < this.queue.length) {
            this.queue.splice(insertIdx, 0, secondPassWord);
          } else {
            this.queue.push(secondPassWord);
          }
        } else {
          const isRetryPass = isRetryCard && isFirstTry;
          // Submit review to backend
          Api.submitReview('writing', card.id || target, true, isRetryPass).catch(err => {
            console.error('Failed to submit writing review:', err);
          });
        }

        this.revealDetails(target, true);

        if (this.feedbackBox) {
          this.feedbackBox.style.display = 'block';
          this.feedbackBox.className = 'feedback-banner feedback-success';
          this.feedbackBox.innerHTML = '<span>🎉 回答正确！</span> <small>(按 Enter 进入下一词)</small>';
        }

        if (this.btnNextWord) {
          this.btnNextWord.style.display = 'inline-flex';
          this.btnNextWord.innerText = '下一词 ➔';
        }
      } else {
        this.typingInput.classList.remove('correct');
        this.typingInput.classList.add('wrong');
        this.hasErrorOnCurrent = true;
        this.sessionStats.wrong++;

        // Record error on backend
        Api.submitReview('writing', card.id || target, false).catch(err => {
          console.error('Failed to submit writing review:', err);
        });

        // Re-queue card for retry 4 cards later
        this.requeueCurrentWord();

        this.revealDetails(target, false, userInput);

        if (this.feedbackBox) {
          this.feedbackBox.style.display = 'block';
          this.feedbackBox.className = 'feedback-banner feedback-error';
          this.feedbackBox.innerHTML = `<span>❌ 拼写错误！</span> <small>正确拼写为: <strong>${target}</strong></small>`;
        }

        if (this.btnNextWord) {
          this.btnNextWord.style.display = 'inline-flex';
          this.btnNextWord.innerText = '记住了，继续 ➔';
        }
      }

      if (window.App && typeof window.App.refreshHeaderStats === 'function') {
        window.App.refreshHeaderStats();
      }
    },

    requeueCurrentWord() {
      if (!this.currentWord) return;
      const retryCard = Object.assign({}, this.currentWord, {
        _isRetry: true,
        _stage: this.currentWord.stage
      });
      const insertIdx = this.currentIndex + 4;
      if (insertIdx < this.queue.length) {
        this.queue.splice(insertIdx, 0, retryCard);
      } else {
        this.queue.push(retryCard);
      }
      if (this.cardProgressText) {
        this.cardProgressText.innerText = `${this.currentIndex + 1} / ${this.queue.length}`;
      }
    },

    revealDetails(target, isCorrect, typed = '') {
      if (!this.diffBox || !this.currentWord) return;
      this.diffBox.style.display = 'block';

      if (this.revealedSpelling) {
        this.revealedSpelling.innerText = target;
      }

      const parsed = this.parseMeaning(this.currentWord.meaning);
      if (this.revealedNotes) {
        if (parsed.notes) {
          this.revealedNotes.innerText = parsed.notes;
          this.revealedNotes.style.display = 'block';
        } else {
          this.revealedNotes.style.display = 'none';
        }
      }

      if (this.revealedSentence) {
        if (this.currentWord.sentence) {
          this.revealedSentence.innerText = `例句: "${this.currentWord.sentence}"`;
          this.revealedSentence.style.display = 'block';
        } else {
          this.revealedSentence.style.display = 'none';
        }
      }
    },

    showHint() {
      if (this.isJudged || !this.currentWord) return;
      const targetWord = (this.currentWord.word || this.currentWord.id || '').trim();
      if (!targetWord) return;
      const firstChar = targetWord.charAt(0);
      if (this.typingInput && !this.typingInput.value) {
        this.typingInput.value = firstChar;
        this.updatePhraseSlotHighlight();
      }
    },

    advanceNext() {
      this.loadCardAt(this.currentIndex + 1);
    },

    exitSession() {
      if (confirm('确定要暂停当前的写作默写进度吗？进度已自动保存，随时可继续。')) {
        this.showDashboard();
      }
    }
  };

  window.WritingModule = WritingModule;
})(window);
