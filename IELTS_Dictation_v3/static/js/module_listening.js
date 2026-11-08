/**
 * module_listening.js - Listening Dictation Module for IELTS_Dictation_v2
 * =====================================================================
 * Requirement R5 Compliance:
 * 1. Flow: plays British English (en-GB) pronunciation on card presentation.
 *    Chinese meaning (glossZh) and English spelling are strictly hidden.
 * 2. User types English word and presses Enter to judge. Only then is Chinese meaning revealed!
 * 3. Unlimited audio replays via UI button and keyboard shortcut (Ctrl+R / Space / F2).
 * 4. Spelling judgment:
 *    - Trim leading/trailing whitespace.
 *    - General vocabulary: case-insensitive.
 *    - Months and country names: STRICT leading capital letter required.
 * 5. Full state preservation across tab switches.
 */

(function(window) {
  'use strict';

  // Case-sensitive word list for client-side instant zero-latency evaluation
  const CASE_SENSITIVE_SET = new Set([
    // Months
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
    // Countries and regions
    'africa', 'america', 'argentina', 'asia', 'china', 'europe',
    'france', 'germany', 'india', 'italy', 'japan', 'mexico',
    'north africa', 'russia', 'scotland', 'south africa',
    'southeast asian', 'spain', 'sweden', 'the usa', 'west european',
    // Days of week
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'
  ]);

  const ListeningModule = {
    queue: [],
    currentIndex: 0,
    currentWord: null,
    isCompleted: false,
    isJudged: false,
    hasErrorOnCurrent: false,
    sessionStats: {
      total: 0,
      correct: 0,
      wrong: 0,
      startTime: null
    },

    /**
     * Initialize DOM elements and event listeners
     */
    init() {
      this.cacheDom();
      this.bindEvents();
      this.refreshDashboard();
      this.restoreActiveSession();
    },

    cacheDom() {
      // Views
      this.dashboardView = document.getElementById('listening-dashboard');
      this.dictationView = document.getElementById('listening-dictation');
      this.completedView = document.getElementById('listening-completed');

      // Dashboard elements
      this.btnStart = document.getElementById('btn-listening-start');
      this.btnResume = document.getElementById('btn-listening-resume');
      this.dueCountBadge = document.getElementById('listening-due-count');
      this.totalCountBadge = document.getElementById('listening-total-count');
      this.newCountBadge = document.getElementById('listening-new-count');
      this.masteredCountBadge = document.getElementById('listening-mastered-count');
      this.resumeBanner = document.getElementById('listening-resume-banner');
      this.resumeDesc = document.getElementById('listening-resume-desc');

      // Dictation card elements
      this.cardCategory = document.getElementById('listening-word-category');
      this.cardStage = document.getElementById('listening-word-stage');
      this.cardProgressText = document.getElementById('listening-progress-text');
      this.cardProgressFill = document.getElementById('listening-progress-fill');
      this.slotGuide = document.getElementById('listening-slot-guide');
      this.btnReplay = document.getElementById('btn-listening-replay');
      this.waveform = document.getElementById('listening-audio-waveform');
      this.typingInput = document.getElementById('listening-input');
      this.feedbackBox = document.getElementById('listening-feedback');
      this.answerRevealBox = document.getElementById('listening-answer-reveal');
      this.revealedSpelling = document.getElementById('listening-revealed-spelling');
      this.revealedMeaning = document.getElementById('listening-revealed-meaning');
      this.revealedPhonetic = document.getElementById('listening-revealed-phonetic');
      this.btnNextWord = document.getElementById('btn-listening-next');
      this.btnExitSession = document.getElementById('btn-listening-exit');

      // Completion elements
      this.compTotal = document.getElementById('listening-comp-total');
      this.compAccuracy = document.getElementById('listening-comp-accuracy');
      this.compCorrect = document.getElementById('listening-comp-correct');
      this.compWrong = document.getElementById('listening-comp-wrong');
      this.btnCompRestart = document.getElementById('btn-listening-comp-restart');
      this.btnCompBack = document.getElementById('btn-listening-comp-back');
    },

    bindEvents() {
      if (this.btnStart) {
        this.btnStart.addEventListener('click', () => this.startNewSession());
      }
      if (this.btnResume) {
        this.btnResume.addEventListener('click', () => this.resumeSession());
      }
      if (this.btnReplay) {
        this.btnReplay.addEventListener('click', () => this.replayAudio());
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

        // Clear warning state on input
        this.typingInput.addEventListener('input', () => {
          if (!this.isJudged) {
            this.typingInput.classList.remove('wrong', 'correct');
            if (this.feedbackBox) this.feedbackBox.style.display = 'none';
          }
          this.updateSlotHighlight();
        });
      }

      // Listen to audio player events for waveform animation
      if (window.audioPlayer) {
        window.audioPlayer.addStatusListener((isPlaying, source, word) => {
          if (this.waveform) {
            if (isPlaying && this.currentWord && (this.currentWord.word === word || this.currentWord.id === word)) {
              this.waveform.classList.add('active');
            } else {
              this.waveform.classList.remove('active');
            }
          }
        });
      }
    },

    /**
     * Restore session from backend if one was saved
     */
    async restoreActiveSession() {
      try {
        const res = await Api.getSession('listening');
        if (res && res.session && Array.isArray(res.session.queue) && res.session.queue.length > 0) {
          const idx = res.session.currentIndex || 0;
          if (idx < res.session.queue.length) {
            this.queue = res.session.queue;
            this.currentIndex = idx;
            this.showResumeBanner(res.session);
          }
        }
      } catch (e) {
        console.warn('Could not restore listening session:', e);
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
        this.btnStart.innerText = '🚀 开始听力默写';
        this.btnStart.classList.remove('btn-secondary');
        this.btnStart.classList.add('btn-primary');
      }
    },

    /**
     * Refresh dashboard statistics from backend
     */
    async refreshDashboard() {
      try {
        const stats = await Api.getStats('listening');
        if (this.dueCountBadge) this.dueCountBadge.innerText = stats.due_count || 0;
        if (this.totalCountBadge) this.totalCountBadge.innerText = stats.total || 0;
        if (this.newCountBadge) this.newCountBadge.innerText = stats.new_count || 0;
        if (this.masteredCountBadge) this.masteredCountBadge.innerText = stats.mastered_count || 0;

        if (this.btnStart && (!this.queue || this.queue.length === 0)) {
          if (stats.due_count > 0) {
            this.btnStart.innerHTML = `⚡️ 开始艾宾浩斯复习 (${stats.due_count} 词待复习)`;
          } else {
            this.btnStart.innerHTML = '🚀 开始听力默写';
          }
        }
      } catch (e) {
        console.error('Failed to load listening stats:', e);
      }
    },

    /**
     * Start brand-new dictation session
     */
    async startNewSession() {
      try {
        if (this.btnStart) this.btnStart.disabled = true;
        const res = await Api.startSession('listening');
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
          alert('暂无需要复习或学习的听力词汇！');
        }
      } catch (e) {
        alert('启动听力默写失败: ' + (e.message || e));
      } finally {
        if (this.btnStart) this.btnStart.disabled = false;
      }
    },

    /**
     * Resume active session
     */
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

      // Clear session from backend
      Api.clearSession('listening').catch(() => {});
      this.queue = [];
      this.currentIndex = 0;
      this.hideResumeBanner();
      if (window.App && typeof window.App.refreshHeaderStats === 'function') {
        window.App.refreshHeaderStats();
      }
    },

    /**
     * Load word card at specific queue index
     */
    loadCardAt(idx) {
      if (idx >= this.queue.length) {
        this.showCompletedView();
        return;
      }

      this.currentIndex = idx;
      this.currentWord = this.queue[idx];
      this.isJudged = false;
      this.hasErrorOnCurrent = false;

      // Persist session index to backend
      Api.saveSession('listening', {
        currentIndex: idx,
        queue: this.queue
      }).catch(() => {});

      const w = this.currentWord;
      const targetWord = (w.word || w.id || '').trim();

      // 1. Update card indicators
      if (this.cardProgressText) {
        this.cardProgressText.innerText = `${idx + 1} / ${this.queue.length}`;
      }
      if (this.cardProgressFill) {
        const pct = Math.round((idx / this.queue.length) * 100);
        this.cardProgressFill.style.width = pct + '%';
      }

      if (this.cardCategory) {
        const cat = w.category || (w.parts ? `Part ${w.parts.join('/')}` : 'IELTS');
        this.cardCategory.innerText = cat;
      }

      if (this.cardStage) {
        const stage = w.stage || 0;
        this.cardStage.innerText = stage === 0 ? '🆕 新词' : `第 ${stage} 轮复习`;
      }

      // 2. Hide spelling and Chinese meaning strictly before answer submission
      if (this.answerRevealBox) this.answerRevealBox.style.display = 'none';
      if (this.feedbackBox) this.feedbackBox.style.display = 'none';
      if (this.btnNextWord) this.btnNextWord.style.display = 'none';

      // 3. Render slot guide (e.g. number of letters, phrase breakdown)
      this.renderSlotGuide(targetWord);

      // 4. Reset input
      if (this.typingInput) {
        this.typingInput.value = '';
        this.typingInput.className = 'typing-input';
        this.typingInput.disabled = false;
        setTimeout(() => this.typingInput.focus(), 50);
      }

      // 5. Play audio automatically in British English (en-GB)
      this.playCurrentAudio();
    },

    renderSlotGuide(targetWord) {
      if (!this.slotGuide) return;
      const tokens = targetWord.split(/\s+/).filter(Boolean);
      let html = '';

      if (tokens.length > 1) {
        html += `<div class="phrase-guide-pill">🧩 短语搭配：共 ${tokens.length} 词（空格隔开）</div>`;
        html += '<div class="phrase-slots-row">';
        tokens.forEach((token, i) => {
          const len = token.replace(/[^a-zA-Z0-9]/g, '').length || token.length;
          html += `<div class="slot-chip" id="slot-chip-${i}"><span>词 ${i + 1}</span> <strong>(${len}字母)</strong></div>`;
        });
        html += '</div>';
      } else {
        const len = targetWord.length;
        html += `<div class="single-word-guide">🔤 目标单词长度：<strong>${len} 个字母</strong></div>`;
      }

      this.slotGuide.innerHTML = html;
    },

    updateSlotHighlight() {
      if (!this.currentWord || !this.typingInput) return;
      const targetWord = (this.currentWord.word || this.currentWord.id || '').trim();
      const tokens = targetWord.split(/\s+/).filter(Boolean);
      if (tokens.length <= 1) return;

      const typed = this.typingInput.value;
      const typedTokens = typed.split(/\s+/);
      const hasTrailingSpace = /\s$/.test(typed);
      const activeIdx = hasTrailingSpace ? typedTokens.filter(Boolean).length : Math.max(0, typedTokens.length - 1);

      tokens.forEach((token, i) => {
        const chip = document.getElementById(`slot-chip-${i}`);
        if (!chip) return;
        chip.classList.remove('active', 'done');
        if (i < activeIdx) {
          chip.classList.add('done');
        } else if (i === activeIdx) {
          chip.classList.add('active');
        }
      });
    },

    playCurrentAudio() {
      if (this.currentWord && window.audioPlayer) {
        const wordToPlay = this.currentWord.word || this.currentWord.id;
        window.audioPlayer.playWord(wordToPlay);
      }
    },

    replayAudio() {
      if (window.audioPlayer) {
        window.audioPlayer.replay();
      }
      if (this.typingInput) {
        this.typingInput.focus();
      }
    },

    /**
     * Evaluate user typed spelling against target word
     */
    judgeSpelling(userInput, targetWord, acceptedAnswers = []) {
      const cleanInput = (userInput || '').trim();
      const cleanTarget = (targetWord || '').trim();
      const cleanAccepted = (acceptedAnswers || []).map(a => (a || '').trim()).filter(Boolean);
      const allTargets = [cleanTarget, ...cleanAccepted];

      if (!cleanInput) {
        return { ok: false, reason: 'spelling_error' };
      }

      // Exact match succeeds immediately
      if (allTargets.includes(cleanInput)) {
        return { ok: true, reason: 'correct' };
      }

      // Case-sensitivity evaluation (Months and Country names)
      const isCaseSensitive = allTargets.some(t => CASE_SENSITIVE_SET.has(t.toLowerCase()));
      if (isCaseSensitive) {
        const firstChar = cleanInput.charAt(0);
        // User input MUST start with an uppercase letter
        if (!firstChar || firstChar !== firstChar.toUpperCase() || firstChar === firstChar.toLowerCase()) {
          return { ok: false, reason: 'capitalization_error' };
        }
      }

      // General vocabulary: case-insensitive
      const matches = allTargets.some(t => cleanInput.toLowerCase() === t.toLowerCase());
      if (matches) {
        return { ok: true, reason: 'correct' };
      }

      return { ok: false, reason: 'spelling_error' };
    },

    /**
     * Submit and check answer
     */
    async checkAnswer() {
      if (!this.currentWord || !this.typingInput) return;
      const userInput = this.typingInput.value;
      if (!userInput.trim()) {
        this.typingInput.focus();
        return;
      }

      const targetWord = (this.currentWord.word || this.currentWord.id || '').trim();
      const accepted = this.currentWord.acceptedAnswers || [];

      // Execute spelling judgment
      const result = this.judgeSpelling(userInput, targetWord, accepted);
      this.isJudged = true;

      // Reveal spelling and Chinese meaning strictly AFTER judgment
      this.revealAnswer(result);

      if (result.ok) {
        this.typingInput.classList.remove('wrong');
        this.typingInput.classList.add('correct');
        this.sessionStats.correct++;

        // Submit review to backend
        Api.submitReview('listening', this.currentWord.id || targetWord, true).catch(err => {
          console.error('Failed to submit listening review:', err);
        });

        if (this.feedbackBox) {
          this.feedbackBox.style.display = 'block';
          this.feedbackBox.className = 'feedback-banner feedback-success';
          this.feedbackBox.innerHTML = '<span>🎉 回答正确！</span> <small>(按 Enter 进入下一词)</small>';
        }

        if (this.btnNextWord) {
          this.btnNextWord.style.display = 'inline-flex';
          this.btnNextWord.innerText = '下一词 ➔';
        }

        // Optional short auto-advance
        // Users can press Enter immediately to advance, or it will advance automatically
      } else {
        this.typingInput.classList.remove('correct');
        this.typingInput.classList.add('wrong');
        this.hasErrorOnCurrent = true;
        this.sessionStats.wrong++;

        const isPretest = this.isPretest || (this.currentWord && this.currentWord._isPretest);

        // Submit failure to backend
        Api.submitReview('listening', this.currentWord.id || targetWord, false, { is_pretest: isPretest }).catch(err => {
          console.error('Failed to submit listening review:', err);
        });

        // Re-queue this word for retry later in this session ONLY in regular dictation, NOT in pretest
        if (!isPretest) {
          this.requeueCurrentWord();
        }

        if (this.feedbackBox) {
          this.feedbackBox.style.display = 'block';
          this.feedbackBox.className = 'feedback-banner feedback-error';
          if (isPretest) {
            this.feedbackBox.innerHTML = `<span>❌ 摸底初测未拼对</span> <small>已规划入待背生词（不进行错词重测）。正确拼写: <strong>${targetWord}</strong></small>`;
          } else if (result.reason === 'capitalization_error') {
            this.feedbackBox.innerHTML = '<span>⚠️ 首字母必须大写！</span> <small>月份、国家及专有名词必须首字母大写</small>';
          } else {
            this.feedbackBox.innerHTML = `<span>❌ 拼写错误！</span> <small>正确拼写为: <strong>${targetWord}</strong></small>`;
          }
        }

        if (this.btnNextWord) {
          this.btnNextWord.style.display = 'inline-flex';
          this.btnNextWord.innerText = isPretest ? '下一词 ➔' : '记住了，继续 ➔';
        }
      }

      if (window.App && typeof window.App.refreshHeaderStats === 'function') {
        window.App.refreshHeaderStats();
      }
    },

    revealAnswer(result) {
      if (!this.answerRevealBox || !this.currentWord) return;
      this.answerRevealBox.style.display = 'block';

      const targetWord = (this.currentWord.word || this.currentWord.id || '').trim();
      if (this.revealedSpelling) {
        this.revealedSpelling.innerText = targetWord;
      }

      if (this.revealedMeaning) {
        const gloss = this.currentWord.glossZh || this.currentWord.meaning || '暂无释义';
        this.revealedMeaning.innerText = gloss;
      }

      if (this.revealedPhonetic) {
        if (this.currentWord.ukphone) {
          this.revealedPhonetic.innerText = `/${this.currentWord.ukphone}/`;
          this.revealedPhonetic.style.display = 'inline';
        } else {
          this.revealedPhonetic.style.display = 'none';
        }
      }
    },

    requeueCurrentWord() {
      if (!this.currentWord || this.isPretest || (this.currentWord && this.currentWord._isPretest)) return;
      // Re-insert 4 cards later or at the end
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

    showHint() {
      if (this.isJudged || !this.currentWord) return;
      const targetWord = (this.currentWord.word || this.currentWord.id || '').trim();
      if (!targetWord) return;
      const firstChar = targetWord.charAt(0);
      if (this.typingInput && !this.typingInput.value) {
        this.typingInput.value = firstChar;
        this.updateSlotHighlight();
      }
    },

    advanceNext() {
      this.loadCardAt(this.currentIndex + 1);
    },

    exitSession() {
      if (confirm('确定要暂停当前的听力默写进度吗？进度已自动保存，随时可继续。')) {
        this.showDashboard();
      }
    }
  };

  window.ListeningModule = ListeningModule;
})(window);
