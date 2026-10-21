const fs = require('fs');

let html = fs.readFileSync('IELTS_Dictation/static/index.html', 'utf8');

const jsCode = `
    /* ===== 每日打卡与目标系统 JS ===== */
    let checkinState = {
      daily_goal: 20,
      today_count: 0,
      today_completed: false,
      today_completed_at: null,
      streak: 0,
      total_checkin_days: 0,
      total_practice_words: 0,
      recent_days: []
    };

    async function fetchCheckinInfo() {
      try {
        const res = await fetch('/api/checkin');
        const data = await res.json();
        checkinState = data;
        renderCheckinUI(data);
      } catch (e) {
        console.error("Checkin fetch error:", e);
      }
    }

    function renderCheckinUI(data) {
      if (!data) return;
      const todayCount = data.today_count || 0;
      const goal = data.daily_goal || 20;
      const streak = data.streak || 0;
      const completed = !!data.today_completed;

      // 首页卡片更新
      const todayEl = document.getElementById('checkin-today-num');
      const targetEl = document.getElementById('checkin-target-num');
      const btnGoalEl = document.getElementById('btn-goal-num');
      const pctEl = document.getElementById('checkin-pct-label');
      const fillEl = document.getElementById('checkin-bar-fill');
      const streakEl = document.getElementById('streak-days');
      const badgeEl = document.getElementById('checkin-status-badge');

      if (todayEl) todayEl.innerText = todayCount;
      if (targetEl) targetEl.innerText = goal;
      if (btnGoalEl) btnGoalEl.innerText = goal;
      if (streakEl) streakEl.innerText = streak;

      const pct = Math.min(100, Math.round((todayCount / goal) * 100));
      if (pctEl) pctEl.innerText = pct + '%';
      if (fillEl) fillEl.style.width = pct + '%';

      if (badgeEl) {
        if (completed) {
          badgeEl.innerText = '✅ 今日打卡已达成';
          badgeEl.style.background = 'rgba(16, 185, 129, 0.15)';
          badgeEl.style.color = '#059669';
          badgeEl.style.borderColor = 'rgba(16, 185, 129, 0.3)';
        } else {
          badgeEl.innerText = '🎯 距达成还差 ' + Math.max(0, goal - todayCount) + ' 词';
          badgeEl.style.background = 'rgba(99, 102, 241, 0.1)';
          badgeEl.style.color = 'var(--primary)';
          badgeEl.style.borderColor = 'rgba(99, 102, 241, 0.25)';
        }
      }

      // 统计页日历矩阵更新
      const totalDaysEl = document.getElementById('total-checkin-days');
      const totalWordsEl = document.getElementById('total-practice-words');
      if (totalDaysEl) totalDaysEl.innerText = data.total_checkin_days || 0;
      if (totalWordsEl) totalWordsEl.innerText = data.total_practice_words || 0;

      const matrixContainer = document.getElementById('checkin-matrix-container');
      if (matrixContainer && data.recent_days) {
        let matrixHtml = '';
        data.recent_days.forEach(day => {
          const isTodayClass = day.is_today ? ' today' : '';
          const isCompClass = day.completed ? ' completed' : '';
          const icon = day.completed ? '🎖️' : (day.count > 0 ? '📝' : '⚪');
          matrixHtml += `
            <div class="matrix-day${isTodayClass}${isCompClass}" title="${day.date} 完成 ${day.count} 词">
              <span class="matrix-icon">${icon}</span>
              <span style="font-weight: 700;">${day.day_label}</span>
              <span class="matrix-date">${day.weekday}</span>
              <span style="font-size: 0.7rem; color: ${day.completed ? '#059669' : 'var(--text-muted)'};">${day.count}词</span>
            </div>
          `;
        });
        matrixContainer.innerHTML = matrixHtml;
      }
    }

    function openGoalModal() {
      const input = document.getElementById('custom-goal-input');
      if (input) input.value = checkinState.daily_goal || 20;
      highlightGoalPreset(checkinState.daily_goal || 20);
      document.getElementById('goal-modal').classList.add('active');
    }

    function closeGoalModal(e) {
      document.getElementById('goal-modal').classList.remove('active');
    }

    function selectPresetGoal(num) {
      const input = document.getElementById('custom-goal-input');
      if (input) input.value = num;
      highlightGoalPreset(num);
    }

    function highlightGoalPreset(num) {
      const btns = document.querySelectorAll('.goal-preset-btn');
      btns.forEach(btn => {
        if (parseInt(btn.innerText) === num) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });
    }

    async function saveDailyGoal() {
      const input = document.getElementById('custom-goal-input');
      let goal = parseInt(input.value);
      if (isNaN(goal) || goal < 1) {
        alert('请输入有效的每日目标词数（至少 1 词）');
        return;
      }
      try {
        const res = await fetch('/api/checkin/goal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goal: goal })
        });
        const data = await res.json();
        if (data.success) {
          checkinState = data.checkin;
          renderCheckinUI(data.checkin);
          closeGoalModal();
        }
      } catch (e) {
        console.error("Save goal err:", e);
        alert('保存目标失败，请检查服务连接');
      }
    }

    function triggerCheckinCelebration(checkin) {
      const celebModal = document.getElementById('celebrate-modal');
      if (!celebModal) return;

      const celebToday = document.getElementById('celeb-today-count');
      const celebStreak = document.getElementById('celeb-streak');
      const celebTotal = document.getElementById('celeb-total-days');

      if (celebToday) celebToday.innerText = (checkin.today_count || 0) + ' 词';
      if (celebStreak) celebStreak.innerText = (checkin.streak || 1) + ' 天';
      if (celebTotal) celebTotal.innerText = (checkin.total_checkin_days || 1) + ' 天';

      celebModal.classList.add('active');
    }

    function closeCelebrateModal(e) {
      document.getElementById('celebrate-modal').classList.remove('active');
    }
`;

// 插入到 script 中
html = html.replace('async function fetchNetworkInfo() {', jsCode + '\n\n    async function fetchNetworkInfo() {');

// 替换 recordBackendReview
const oldRecordBackend = `    async function recordBackendReview(word, correct) {
      try {
        await fetch('/api/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ word: word, correct: correct })
        });
      } catch (e) {
        console.error("Save review error:", e);
      }
    }`;

const newRecordBackend = `    async function recordBackendReview(word, correct) {
      try {
        const res = await fetch('/api/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ word: word, correct: correct })
        });
        const data = await res.json();
        if (data && data.checkin) {
          checkinState = data.checkin;
          renderCheckinUI(data.checkin);
          if (data.just_completed) {
            triggerCheckinCelebration(data.checkin);
          }
        }
      } catch (e) {
        console.error("Save review error:", e);
      }
    }`;

if (!html.includes('async function recordBackendReview')) {
  throw new Error('recordBackendReview not found');
}
html = html.replace(oldRecordBackend, newRecordBackend);

// 在 fetchStats() 中也拉取 fetchCheckinInfo()
html = html.replace(
  'renderTopErrors(data.top_errors);\n      } catch (e) {',
  'renderTopErrors(data.top_errors);\n        fetchCheckinInfo();\n      } catch (e) {'
);

// 在 switchTab('stats') 时拉取 fetchCheckinInfo()
html = html.replace(
  'if (tab === \'stats\') {\n        fetchStats();\n      }',
  'if (tab === \'stats\') {\n        fetchStats();\n        fetchCheckinInfo();\n      }'
);

// 在 finishSession 时如果今天已完成目标但尚未弹过，也可以展示
const oldFinishSession = `    function finishSession() {
      const total = appState.sessionCorrect + appState.sessionWrong;
      const rate = total === 0 ? 100 : Math.round((appState.sessionCorrect / total) * 100);
      alert('本轮默写完成！正确: ' + appState.sessionCorrect + ' 题，复习: ' + appState.sessionWrong + ' 题，正确率: ' + rate + '%');
      switchTab('home');
      fetchStats();
    }`;

const newFinishSession = `    function finishSession() {
      const total = appState.sessionCorrect + appState.sessionWrong;
      const rate = total === 0 ? 100 : Math.round((appState.sessionCorrect / total) * 100);
      switchTab('home');
      fetchStats();
      fetchCheckinInfo();
      if (checkinState && checkinState.today_completed) {
        // 如果今天已经打卡完成，弹出战报卡片
        triggerCheckinCelebration(checkinState);
      } else {
        alert('🎉 本轮默写完成！正确: ' + appState.sessionCorrect + ' 题，复习: ' + appState.sessionWrong + ' 题，正确率: ' + rate + '%');
      }
    }`;

html = html.replace(oldFinishSession, newFinishSession);

// 在页面初始化最后调用 fetchCheckinInfo()
html = html.replace(
  'fetchNetworkInfo();\n    fetchStats();',
  'fetchNetworkInfo();\n    fetchStats();\n    fetchCheckinInfo();'
);

fs.writeFileSync('IELTS_Dictation/static/index.html', html, 'utf8');
console.log('JS Logic successfully injected!');

