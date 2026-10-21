
# -*- coding: utf-8 -*-
with open('IELTS_Dictation/static/index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. 查找 DOMContentLoaded 并在末尾加入 startGlobalEbbinghausMonitor
target_dcl = "updateResumeBanner();\n    });"
replacement_dcl = """updateResumeBanner();
      startGlobalEbbinghausMonitor();
    });"""

if target_dcl in content:
    content = content.replace(target_dcl, replacement_dcl, 1)
    print("1. DOMContentLoaded updated with startGlobalEbbinghausMonitor")
else:
    print("Warning: target_dcl not found")

# 2. 查找 checkAnswer 中拼错分支，加入单轮错词队尾追加
target_wrong = """      } else {
        appState.hasErrorOnCurrent = true;
        appState.sessionWrong++;
        updateSessionAcc();

        input.classList.remove('correct');
        input.classList.add('wrong');
        showLetterDiff(typed, target);
      }"""

replacement_wrong = """      } else {
        appState.hasErrorOnCurrent = true;
        appState.sessionWrong++;
        updateSessionAcc();

        input.classList.remove('correct');
        input.classList.add('wrong');
        showLetterDiff(typed, target);

        // 单轮错词队尾重测机制
        if (!appState.currentWord._requeued) {
          const retryWord = Object.assign({}, appState.currentWord, { _requeued: true });
          appState.dictationQueue.push(retryWord);
          saveDictationSession();
          const totalEl = document.getElementById('total-count');
          if (totalEl) totalEl.innerText = appState.dictationQueue.length;
        }
      }"""

if target_wrong in content:
    content = content.replace(target_wrong, replacement_wrong, 1)
    print("2. checkAnswer updated with in-session requeueing")
else:
    print("Warning: target_wrong not found")

# 3. 查找 loadWordAt 中 tags 渲染，加入 _requeued 提示
target_tags = """      if (isPhrase) {
        tagHtml += '<span class="badge-tag badge-phrase">🧩 ' + targetTokens.length + ' 词短语搭配</span>';
      }
      tagBox.innerHTML = tagHtml;"""

replacement_tags = """      if (isPhrase) {
        tagHtml += '<span class="badge-tag badge-phrase">🧩 ' + targetTokens.length + ' 词短语搭配</span>';
      }
      if (w._requeued) {
        tagHtml += '<span class="badge-tag" style="background: rgba(245, 158, 11, 0.15); color: #d97706; border: 1px solid rgba(245, 158, 11, 0.35); font-weight: 700;">🔁 本轮错词强化</span>';
      }
      tagBox.innerHTML = tagHtml;"""

if target_tags in content:
    content = content.replace(target_tags, replacement_tags, 1)
    print("3. loadWordAt tags updated with requeued badge")
else:
    print("Warning: target_tags not found")

# 4. 替换 finishSession 为优雅结算卡片
target_finish = """    function finishSession() {
      clearSavedSession();
      const total = appState.sessionCorrect + appState.sessionWrong;
      const rate = total === 0 ? 100 : Math.round((appState.sessionCorrect / total) * 100);
      switchTab('home');
      fetchStats();
      fetchCheckinInfo();
      if (checkinState && checkinState.today_completed) {
        triggerCheckinCelebration(checkinState);
      } else {
        alert('🎉 本轮默写完成！正确: ' + appState.sessionCorrect + ' 题，复习: ' + appState.sessionWrong + ' 题，正确率: ' + rate + '%');
      }
    }"""

replacement_finish = """    function finishSession() {
      clearSavedSession();
      const total = appState.sessionCorrect + appState.sessionWrong;
      const rate = total === 0 ? 100 : Math.round((appState.sessionCorrect / total) * 100);
      fetchStats();
      fetchCheckinInfo();

      if (checkinState && checkinState.today_completed) {
        triggerCheckinCelebration(checkinState);
      }
      showSessionSummaryModal({
        total: total,
        correct: appState.sessionCorrect,
        wrong: appState.sessionWrong,
        rate: rate
      });
    }

    function showSessionSummaryModal(summary) {
      const overlay = document.getElementById('session-summary-overlay');
      if (!overlay) {
        switchTab('home');
        alert('🎉 本轮默写完成！正确: ' + summary.correct + ' 题，巩固重练: ' + summary.wrong + ' 题，正确率: ' + summary.rate + '%');
        return;
      }

      document.getElementById('sum-rate').innerText = summary.rate + '%';
      document.getElementById('sum-correct').innerText = summary.correct;
      document.getElementById('sum-wrong').innerText = summary.wrong;

      const adviceEl = document.getElementById('sum-ebbinghaus-advice');
      if (summary.wrong > 0) {
        adviceEl.innerHTML = '💡 本轮有 <strong>' + summary.wrong + '</strong> 个词汇答错或进入重测，系统已自动重置为 Stage 0，将在 <strong>5 分钟后</strong> 到期提醒您进行第 1 次遗忘巩固！';
      } else {
        adviceEl.innerHTML = '🌟 太棒了！本轮所有词汇初测全部正确，艾宾浩斯复习间隔已成功向前推进一阶！';
      }

      const nextBtn = document.getElementById('btn-summary-next-due');
      if (nextBtn) {
        if (currentDueCount > 0) {
          nextBtn.style.display = 'inline-flex';
          nextBtn.innerText = '⚡️ 立即开始下一波复习 (' + currentDueCount + '词待复习)';
        } else {
          nextBtn.style.display = 'none';
        }
      }

      overlay.classList.add('active');
    }

    function closeSessionSummaryModal(action) {
      const overlay = document.getElementById('session-summary-overlay');
      if (overlay) overlay.classList.remove('active');

      if (action === 'next_due') {
        startDueDirectly();
      } else if (action === 'retry') {
        startDictation({ forceNew: true });
      } else {
        switchTab('home');
      }
    }"""

if target_finish in content:
    content = content.replace(target_finish, replacement_finish, 1)
    print("4. finishSession updated with showSessionSummaryModal")
else:
    print("Warning: target_finish not found")

# 5. 替换 updateResumeBanner 和 handleStartClick 以及增加 Ebbinghaus 监控函数
target_banner_block = """    function updateResumeBanner() {
      const banner = document.getElementById('resume-banner');
      const desc = document.getElementById('resume-desc');
      const startBtn = document.getElementById('btn-main-start');
      if (!banner) return;

      const saved = getSavedSession();
      if (saved) {
        const total = saved.queue.length;
        const curr = saved.currentIndex + 1;
        const pct = Math.round((saved.currentIndex / total) * 100);
        let infoText = '上次进行至第 ' + curr + ' / ' + total + ' 题（完成度 ' + pct + '%）';
        if (saved.filterSection && saved.filterSection !== 'all') {
          infoText += ' · 单元: ' + saved.filterSection;
        }
        if (desc) desc.innerText = infoText;
        banner.style.display = 'block';

        if (startBtn) {
          startBtn.innerText = '▶️ 继续上次默写 (第 ' + curr + '/' + total + ' 题)';
          startBtn.style.background = 'linear-gradient(135deg, #10b981, #059669)';
          startBtn.style.boxShadow = '0 4px 15px rgba(16, 185, 129, 0.35)';
        }
      } else {
        banner.style.display = 'none';
        if (startBtn) {
          startBtn.innerText = '🚀 开始默写';
          startBtn.style.background = 'linear-gradient(135deg, var(--primary), var(--accent))';
          startBtn.style.boxShadow = '0 4px 15px rgba(56, 189, 248, 0.3)';
        }
      }
    }

    function onFilterConfigChange() {
      const saved = getSavedSession();
      const startBtn = document.getElementById('btn-main-start');
      if (saved && startBtn) {
        const currentSec = document.getElementById('filter-section')?.value || 'all';
        const currentScope = document.getElementById('filter-scope')?.value || 'due';
        if (currentSec !== saved.filterSection || currentScope !== saved.filterScope) {
          startBtn.innerText = '🚀 开启新条件默写 (第 1 题起)';
          startBtn.style.background = 'linear-gradient(135deg, var(--primary), var(--accent))';
          startBtn.style.boxShadow = '0 4px 15px rgba(56, 189, 248, 0.3)';
        } else {
          updateResumeBanner();
        }
      }
    }

    function handleStartClick() {
      const saved = getSavedSession();
      if (saved) {
        const currentSec = document.getElementById('filter-section')?.value || 'all';
        const currentScope = document.getElementById('filter-scope')?.value || 'due';
        if (currentSec !== saved.filterSection || currentScope !== saved.filterScope) {
          if (confirm('您更改了单元或范围筛选。是否放弃之前的进度，以新筛选条件重新开始新一轮？\n\n【确定】：以新条件从第 1 题重新开始\n【取消】：继续上次未完成进度')) {
            startDictation({ forceNew: true });
          } else {
            resumeDictation();
          }
        } else {
          resumeDictation();
        }
      } else {
        startDictation({ forceNew: true });
      }
    }"""

replacement_banner_block = """    let currentDueCount = 0;
    let localNextDueSec = null;
    let ebbinghausTimer = null;
    let lastStatsData = null;

    function formatSeconds(totalSec) {
      if (totalSec === null || totalSec === undefined || isNaN(totalSec) || totalSec < 0) {
        return '00:00';
      }
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      if (m >= 60) {
        const h = Math.floor(m / 60);
        const rm = m % 60;
        return h + '小时' + (rm < 10 ? '0' : '') + rm + '分';
      }
      return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }

    function updateEbbinghausCard(stats) {
      lastStatsData = stats;
      const card = document.getElementById('ebbinghaus-live-card');
      if (!card) return;

      const due = stats.due_count || 0;
      currentDueCount = due;

      if (due > 0) {
        card.className = 'ebbinghaus-live-card due-active';
        card.innerHTML = 
          '<div style="display: flex; align-items: center; gap: 14px; flex: 1; min-width: 260px;">' +
            '<div class="eb-badge-icon">⚡️</div>' +
            '<div>' +
              '<div class="eb-title-row" style="color: #d97706;">' +
                '<span class="eb-pulse-dot" style="background: #f59e0b;"></span>' +
                '<span>艾宾浩斯复习窗口已到期！</span>' +
              '</div>' +
              '<div class="eb-subtext">' +
                '当前共有 <strong class="eb-highlight-num">' + due + '</strong> 个词汇达到遗忘临界点，立即默写复习能最大化记忆留存率！' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">' +
            '<button type="button" class="eb-btn-action" onclick="startDueDirectly()">' +
              '⚡️ 立即开始复习到期词 (' + due + ' 词)' +
            '</button>' +
          '</div>';
      } else {
        card.className = 'ebbinghaus-live-card waiting';
        const sec = stats.next_due_in_sec;
        localNextDueSec = sec;
        const formatted = formatSeconds(sec);

        let sampleHtml = '';
        if (stats.next_due_samples && stats.next_due_samples.length > 0) {
          sampleHtml = stats.next_due_samples.slice(0, 4).map(s => 
            '<span class="eb-sample-pill">📌 ' + escapeHtml(s.word) + ' (' + (STAGE_NAMES[s.stage] || 'Stage '+s.stage) + ')</span>'
          ).join('');
        }

        card.innerHTML = 
          '<div style="display: flex; align-items: center; gap: 14px; flex: 1; min-width: 260px;">' +
            '<div class="eb-badge-icon">🧠</div>' +
            '<div>' +
              '<div class="eb-title-row" style="color: var(--primary);">' +
                '<span class="eb-pulse-dot" style="background: #10b981;"></span>' +
                '<span>艾宾浩斯记忆周期实时监控中</span>' +
              '</div>' +
              '<div class="eb-subtext">' +
                '今日待复习词汇已清空！下一批复习将在下方倒计时结束后自动开启：' +
              '</div>' +
              (sampleHtml ? '<div class="eb-samples-row">' + sampleHtml + '</div>' : '') +
            '</div>' +
          '</div>' +
          '<div style="text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 6px;">' +
            '<div style="font-size: 0.8rem; color: var(--text-muted); font-weight: 600;">⏳ 距离下批到期倒计时</div>' +
            '<div class="eb-timer-display" id="live-countdown-text">' + formatted + '</div>' +
            '<div style="font-size: 0.75rem; color: var(--text-muted);">到期自动刷新 · 实时提醒</div>' +
          '</div>';
      }

      renderStatsSchedule(stats);
    }

    function renderStatsSchedule(stats) {
      const badge = document.getElementById('stats-due-badge');
      const timerText = document.getElementById('stats-countdown-text');
      const upcomingList = document.getElementById('stats-upcoming-list');
      if (!upcomingList) return;

      const due = stats.due_count || 0;
      if (badge) {
        if (due > 0) {
          badge.style.display = 'inline-flex';
          badge.innerText = due + ' 词已到期待复习';
        } else {
          badge.style.display = 'none';
        }
      }

      if (timerText) {
        timerText.innerText = formatSeconds(localNextDueSec !== null ? localNextDueSec : stats.next_due_in_sec);
      }

      if (stats.next_due_samples && stats.next_due_samples.length > 0) {
        upcomingList.innerHTML = stats.next_due_samples.map(s => {
          const parsed = parseMeaning(s.meaning || '');
          const sampleDueIn = s.due_in_sec !== undefined ? formatSeconds(s.due_in_sec) : '--';
          return '<div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: var(--input-bg); border: 1px solid var(--card-border); border-radius: 10px; margin-bottom: 8px;">' +
            '<div>' +
              '<div style="font-weight: 700; color: var(--text);">' + escapeHtml(s.word) + '</div>' +
              '<div style="font-size: 0.82rem; color: var(--text-muted); margin-top: 2px;">' + escapeHtml(parsed.pureMeaning || s.meaning || '') + '</div>' +
            '</div>' +
            '<div style="text-align: right;">' +
              '<span class="badge-stage">' + (STAGE_NAMES[s.stage] || 'Stage '+s.stage) + '</span>' +
              '<div style="font-size: 0.78rem; color: var(--primary); font-family: ui-monospace, SFMono-Regular, monospace; margin-top: 4px; font-weight: 600;">约 ' + sampleDueIn + ' 后到期</div>' +
            '</div>' +
          '</div>';
        }).join('');
      } else {
        upcomingList.innerHTML = '<div style="color: var(--text-muted); font-size: 0.9rem;">暂无后续到期词汇排程</div>';
      }
    }

    function startGlobalEbbinghausMonitor() {
      if (ebbinghausTimer) clearInterval(ebbinghausTimer);
      ebbinghausTimer = setInterval(() => {
        if (localNextDueSec !== null && localNextDueSec > 0) {
          localNextDueSec--;
          const formatted = formatSeconds(localNextDueSec);
          const homeTimer = document.getElementById('live-countdown-text');
          if (homeTimer) homeTimer.innerText = formatted;
          const statsTimer = document.getElementById('stats-countdown-text');
          if (statsTimer) statsTimer.innerText = formatted;

          if (localNextDueSec <= 0) {
            localNextDueSec = null;
            triggerDueNotification();
            fetchStats();
          }
        }
      }, 1000);

      setInterval(() => {
        fetchStats(true);
      }, 15000);

      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          fetchStats();
        }
      });
      window.addEventListener('focus', () => {
        fetchStats();
      });
    }

    function triggerDueNotification() {
      playGentleChime();
      showToast('🔔 艾宾浩斯复习周期已到达！新一批词汇已就绪，立即开始巩固练习！');
    }

    function playGentleChime() {
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(523.25, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(659.25, ctx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
      } catch (e) {}
    }

    function startDueDirectly() {
      const scopeEl = document.getElementById('filter-scope');
      if (scopeEl) scopeEl.value = 'due';
      clearSavedSession();
      startDictation({ forceNew: true });
    }

    async function mergeDueAndResume() {
      const saved = getSavedSession();
      if (!saved || !saved.queue) {
        startDueDirectly();
        return;
      }
      try {
        const res = await fetch('/api/words?only_due=true&limit=1000');
        const data = await res.json();
        const dueWords = data.words || [];
        const existingIds = new Set(saved.queue.map(w => (w.id || w.word || '').toLowerCase()));
        let addedCount = 0;
        for (const dw of dueWords) {
          const dwId = (dw.id || dw.word || '').toLowerCase();
          if (!existingIds.has(dwId)) {
            saved.queue.push(dw);
            existingIds.add(dwId);
            addedCount++;
          }
        }
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(saved));
        showToast('✅ 已将 ' + addedCount + ' 个新到期词成功合并追加至练习队尾！');
        resumeDictation();
      } catch (e) {
        console.error('Merge due error:', e);
        resumeDictation();
      }
    }

    function updateResumeBanner() {
      const banner = document.getElementById('resume-banner');
      const desc = document.getElementById('resume-desc');
      const startBtn = document.getElementById('btn-main-start');
      const dueAlert = document.getElementById('resume-due-alert');
      const btnDuePriority = document.getElementById('btn-due-priority');
      const btnResumeDirect = document.getElementById('btn-resume-direct');
      const btnMergeDue = document.getElementById('btn-merge-due');
      if (!banner) return;

      const saved = getSavedSession();
      if (saved && saved.queue && saved.queue.length) {
        const total = saved.queue.length;
        const curr = (saved.currentIndex || 0) + 1;
        const pct = Math.round((saved.currentIndex / total) * 100);
        let infoText = '上次进行至第 ' + curr + ' / ' + total + ' 题（完成度 ' + pct + '%）';
        if (saved.filterSection && saved.filterSection !== 'all') {
          infoText += ' · 单元: ' + saved.filterSection;
        }
        if (desc) desc.innerText = infoText;

        if (currentDueCount > 0) {
          if (dueAlert) {
            dueAlert.style.display = 'block';
            dueAlert.innerHTML = '⚡️ <strong>注意</strong>：期间已有 <strong>' + currentDueCount + '</strong> 个词汇达到遗忘复习周期！';
          }
          if (btnDuePriority) {
            btnDuePriority.style.display = 'inline-flex';
            btnDuePriority.innerHTML = '⚡️ 优先复习到期词 (' + currentDueCount + '词)';
          }
          if (btnMergeDue) {
            btnMergeDue.style.display = 'inline-flex';
          }
          if (btnResumeDirect) {
            btnResumeDirect.innerText = '▶️ 仅继续上次未完进度 (第 ' + curr + ' 题)';
          }
          if (startBtn) {
            startBtn.innerHTML = '⚡️ 立即复习到期词 (' + currentDueCount + ' 词)';
            startBtn.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
            startBtn.style.boxShadow = '0 4px 15px rgba(245, 158, 11, 0.35)';
          }
        } else {
          if (dueAlert) dueAlert.style.display = 'none';
          if (btnDuePriority) btnDuePriority.style.display = 'none';
          if (btnMergeDue) btnMergeDue.style.display = 'none';
          if (btnResumeDirect) {
            btnResumeDirect.innerText = '▶️ 继续上次默写 (第 ' + curr + '/' + total + ' 题)';
          }
          if (startBtn) {
            startBtn.innerText = '▶️ 继续上次默写 (第 ' + curr + '/' + total + ' 题)';
            startBtn.style.background = 'linear-gradient(135deg, #10b981, #059669)';
            startBtn.style.boxShadow = '0 4px 15px rgba(16, 185, 129, 0.35)';
          }
        }
        banner.style.display = 'block';
      } else {
        banner.style.display = 'none';
        if (startBtn) {
          if (currentDueCount > 0) {
            startBtn.innerHTML = '⚡️ 开始艾宾浩斯复习 (' + currentDueCount + ' 词待复习)';
            startBtn.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
            startBtn.style.boxShadow = '0 4px 15px rgba(245, 158, 11, 0.35)';
          } else {
            startBtn.innerText = '🚀 开始默写';
            startBtn.style.background = 'linear-gradient(135deg, var(--primary), var(--accent))';
            startBtn.style.boxShadow = '0 4px 15px rgba(56, 189, 248, 0.3)';
          }
        }
      }
    }

    function onFilterConfigChange() {
      const saved = getSavedSession();
      const startBtn = document.getElementById('btn-main-start');
      if (saved && startBtn) {
        const currentSec = document.getElementById('filter-section')?.value || 'all';
        const currentScope = document.getElementById('filter-scope')?.value || 'due';
        if (currentSec !== saved.filterSection || currentScope !== saved.filterScope) {
          startBtn.innerText = '🚀 开启新条件默写 (第 1 题起)';
          startBtn.style.background = 'linear-gradient(135deg, var(--primary), var(--accent))';
          startBtn.style.boxShadow = '0 4px 15px rgba(56, 189, 248, 0.3)';
        } else {
          updateResumeBanner();
        }
      }
    }

    function handleStartClick() {
      const currentScope = document.getElementById('filter-scope')?.value || 'due';
      const saved = getSavedSession();

      if (currentScope === 'due') {
        if (currentDueCount > 0) {
          if (saved && saved.queue && saved.currentIndex < saved.queue.length) {
            const curr = (saved.currentIndex || 0) + 1;
            const total = saved.queue.length;
            if (confirm('检测到当前有 ' + currentDueCount + ' 个艾宾浩斯到期词汇等待复习！\n\n【确定】：⚡️ 立即开启最新的 ' + currentDueCount + ' 个到期词默写（推荐）\n【取消】：▶️ 继续上次未完成进度（第 ' + curr + '/' + total + ' 题）')) {
              clearSavedSession();
              startDictation({ forceNew: true });
            } else {
              resumeDictation();
            }
            return;
          }
          clearSavedSession();
          startDictation({ forceNew: true });
          return;
        } else {
          if (saved && saved.queue && saved.currentIndex < saved.queue.length) {
            resumeDictation();
            return;
          }
          const countdownStr = localNextDueSec ? formatSeconds(localNextDueSec) : '即将到期';
          if (confirm('🎉 当前暂无超期复习词汇！下一批将在 ' + countdownStr + ' 后到期。\n\n是否立即复习当前范围所有词汇？\n\n【确定】：复习当前范围所有词汇\n【取消】：返回主页等待倒计时')) {
            document.getElementById('filter-scope').value = 'all';
            clearSavedSession();
            startDictation({ forceNew: true });
          }
          return;
        }
      }

      if (saved) {
        const currentSec = document.getElementById('filter-section')?.value || 'all';
        if (currentSec !== saved.filterSection || currentScope !== saved.filterScope) {
          if (confirm('您更改了单元或范围筛选。是否放弃之前的进度，以新筛选条件重新开始新一轮？\n\n【确定】：以新条件从第 1 题重新开始\n【取消】：继续上次未完成进度')) {
            startDictation({ forceNew: true });
          } else {
            resumeDictation();
          }
        } else {
          resumeDictation();
        }
      } else {
        startDictation({ forceNew: true });
      }
    }"""

if target_banner_block in content:
    content = content.replace(target_banner_block, replacement_banner_block, 1)
    print("5. updateResumeBanner and Ebbinghaus functions replaced successfully")
else:
    print("Warning: target_banner_block not found")

# 6. 查找 fetchStats 并升级
target_fetch_stats = """    async function fetchStats() {
      try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        document.getElementById('stat-due').innerText = data.due_count;
        document.getElementById('stat-error').innerText = data.error_count;
        document.getElementById('stat-mastered').innerText = data.mastered_count;
        document.getElementById('stat-total').innerText = data.total;

        const secSelect = document.getElementById('filter-section');
        const currentVal = secSelect.value;
        secSelect.innerHTML = '<option value="all">所有 Section 单元 (' + data.total + '词)</option>';
        if (data.sections) {
          for (let sec in data.sections) {
            const opt = document.createElement('option');
            opt.value = sec;
            opt.innerText = sec + ' (' + data.sections[sec] + '词)';
            secSelect.appendChild(opt);
          }
        }
        secSelect.value = currentVal || 'all';

        renderStages(data.ebbinghaus_stages);
        renderTopErrors(data.top_errors);
        fetchCheckinInfo();
      } catch (e) {
        console.error("Stats fetch error:", e);
      }
    }"""

replacement_fetch_stats = """    async function fetchStats(silent = false) {
      try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        document.getElementById('stat-due').innerText = data.due_count;
        document.getElementById('stat-error').innerText = data.error_count;
        document.getElementById('stat-mastered').innerText = data.mastered_count;
        document.getElementById('stat-total').innerText = data.total;

        currentDueCount = data.due_count || 0;
        localNextDueSec = (data.next_due_in_sec !== undefined) ? data.next_due_in_sec : null;

        updateEbbinghausCard(data);
        updateResumeBanner();

        const secSelect = document.getElementById('filter-section');
        if (secSelect) {
          const currentVal = secSelect.value;
          secSelect.innerHTML = '<option value="all">所有 Section 单元 (' + data.total + '词)</option>';
          if (data.sections) {
            for (let sec in data.sections) {
              const opt = document.createElement('option');
              opt.value = sec;
              opt.innerText = sec + ' (' + data.sections[sec] + '词)';
              secSelect.appendChild(opt);
            }
          }
          secSelect.value = currentVal || 'all';
        }

        renderStages(data.ebbinghaus_stages);
        renderTopErrors(data.top_errors);
        if (!silent) {
          fetchCheckinInfo();
        }
      } catch (e) {
        console.error("Stats fetch error:", e);
      }
    }"""

if target_fetch_stats in content:
    content = content.replace(target_fetch_stats, replacement_fetch_stats, 1)
    print("6. fetchStats upgraded successfully")
else:
    print("Warning: target_fetch_stats not found")

with open('IELTS_Dictation/static/index.html', 'w', encoding='utf-8') as f:
    f.write(content)

