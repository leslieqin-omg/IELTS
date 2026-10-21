
# -*- coding: utf-8 -*-
with open('IELTS_Dictation/static/index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. 插入 ebbinghaus-live-card
target1 = '      </div>\n\n      <div class="action-box">'
replacement1 = '''      </div>

      <!-- 艾宾浩斯记忆周期实时动态卡片 -->
      <div id="ebbinghaus-live-card" class="ebbinghaus-live-card waiting">
        <div style="display: flex; align-items: center; gap: 14px; flex: 1; min-width: 260px;">
          <div class="eb-badge-icon">🧠</div>
          <div>
            <div class="eb-title-row" style="color: var(--primary);">
              <span class="eb-pulse-dot"></span>
              <span>艾宾浩斯记忆周期实时监控中</span>
            </div>
            <div class="eb-subtext" id="eb-status-text">
              正在同步艾宾浩斯复习调度状态...
            </div>
            <div class="eb-samples-row" id="eb-samples-box"></div>
          </div>
        </div>
        <div style="text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 6px;">
          <div style="font-size: 0.8rem; color: var(--text-muted); font-weight: 600;">⏳ 距离下批到期倒计时</div>
          <div class="eb-timer-display" id="live-countdown-text">--:--</div>
          <div style="font-size: 0.75rem; color: var(--text-muted);">到期自动刷新 · 实时提醒</div>
        </div>
      </div>

      <div class="action-box">'''

if target1 in content:
    content = content.replace(target1, replacement1, 1)
    print("1. ebbinghaus-live-card inserted")
else:
    print("Warning: target1 not found")

# 2. 升级 resume-banner
target2 = '''<!-- 未完成进度提示与快速接续卡片 -->
        <div id="resume-banner" style="display: none; background: rgba(59, 130, 246, 0.08); border: 1.5px solid rgba(59, 130, 246, 0.35); border-radius: 12px; padding: 16px 20px; margin: 16px 0 20px; text-align: left;">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
            <div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 1.1rem;">📌</span>
                <span style="font-weight: 700; font-size: 1rem; color: var(--primary);">检测到上次未完成的默写进度</span>
                <span style="font-size: 0.75rem; background: rgba(16, 185, 129, 0.15); color: var(--success); font-weight: 700; padding: 2px 8px; border-radius: 12px;">已自动保存</span>
              </div>
              <div style="font-size: 0.88rem; color: var(--text-muted); margin-top: 5px;" id="resume-desc">
                上次进行至第 1 / 10 题（已完成 0%）
              </div>
            </div>
            <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
              <button type="button" class="btn-start" id="btn-resume-direct" onclick="resumeDictation()" style="padding: 10px 22px; font-size: 0.95rem; background: linear-gradient(135deg, #10b981, #059669); box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);">
                ▶️ 继续上次默写
              </button>
              <button type="button" onclick="confirmRestartDictation()" style="background: var(--input-bg); border: 1px solid var(--card-border); color: var(--text-muted); padding: 9px 16px; border-radius: 10px; font-size: 0.88rem; font-weight: 600; cursor: pointer; transition: all 0.2s;">
                🔄 重新开始新一轮
              </button>
            </div>
          </div>
        </div>'''

replacement2 = '''<!-- 未完成进度提示与快速接续卡片 -->
        <div id="resume-banner" style="display: none; background: rgba(59, 130, 246, 0.08); border: 1.5px solid rgba(59, 130, 246, 0.35); border-radius: 12px; padding: 16px 20px; margin: 16px 0 20px; text-align: left;">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
            <div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 1.1rem;">📌</span>
                <span style="font-weight: 700; font-size: 1rem; color: var(--primary);">检测到上次未完成的默写进度</span>
                <span style="font-size: 0.75rem; background: rgba(16, 185, 129, 0.15); color: var(--success); font-weight: 700; padding: 2px 8px; border-radius: 12px;">已自动保存</span>
              </div>
              <div style="font-size: 0.88rem; color: var(--text-muted); margin-top: 5px;" id="resume-desc">
                上次进行至第 1 / 10 题（已完成 0%）
              </div>
              <div id="resume-due-alert" style="display: none; font-size: 0.86rem; color: #f59e0b; margin-top: 5px; font-weight: 600;">
                ⚡️ 提醒：期间已有新词汇到达艾宾浩斯复习周期！
              </div>
            </div>
            <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
              <button type="button" class="btn-start" id="btn-due-priority" onclick="startDueDirectly()" style="display: none; padding: 9px 18px; font-size: 0.92rem; background: linear-gradient(135deg, #f59e0b, #d97706); box-shadow: 0 4px 12px rgba(245, 158, 11, 0.35);">
                ⚡️ 优先复习到期词
              </button>
              <button type="button" class="btn-start" id="btn-resume-direct" onclick="resumeDictation()" style="padding: 9px 18px; font-size: 0.92rem; background: linear-gradient(135deg, #10b981, #059669); box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);">
                ▶️ 继续上次默写
              </button>
              <button type="button" id="btn-merge-due" onclick="mergeDueAndResume()" style="display: none; background: var(--input-bg); border: 1.5px solid var(--primary); color: var(--primary); padding: 8px 14px; border-radius: 10px; font-size: 0.88rem; font-weight: 600; cursor: pointer;">
                ➕ 合并新到期词
              </button>
              <button type="button" onclick="confirmRestartDictation()" style="background: var(--input-bg); border: 1px solid var(--card-border); color: var(--text-muted); padding: 8px 14px; border-radius: 10px; font-size: 0.88rem; font-weight: 600; cursor: pointer; transition: all 0.2s;">
                🔄 重新开始
              </button>
            </div>
          </div>
        </div>'''

if target2 in content:
    content = content.replace(target2, replacement2, 1)
    print("2. resume-banner upgraded")
else:
    print("Warning: target2 not found")

# 3. 在 view-stats 中插入 stats-eb-schedule
target3 = '<div id="view-stats" class="view-panel">'
replacement3 = '''<div id="view-stats" class="view-panel">

      <!-- 艾宾浩斯复习实时排程与倒计时 -->
      <div class="action-box" id="stats-eb-schedule" style="text-align: left; margin-bottom: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
          <div>
            <h2 style="font-size: 1.2rem; margin: 0; display: flex; align-items: center; gap: 8px;">
              <span>⏰ 艾宾浩斯实时复习排程</span>
              <span id="stats-due-badge" class="badge-tag" style="background: rgba(245,158,11,0.15); color: #d97706; border: 1px solid rgba(245,158,11,0.3); font-weight: 700; display: none;">58 词已到期</span>
            </h2>
            <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 4px;" id="stats-schedule-desc">
              系统严格依据 5分钟 / 30分钟 / 12小时 / 1天 / 2天 / 4天 / 7天 / 15天 遗忘曲线动态调度。
            </div>
          </div>
          <div style="text-align: right;" id="stats-timer-box">
            <div style="font-size: 0.8rem; color: var(--text-muted); font-weight: 600;">距下批到期倒计时</div>
            <div class="eb-timer-display" id="stats-countdown-text">--:--</div>
          </div>
        </div>
        <div id="stats-upcoming-list" style="margin-top: 14px;">
          <!-- 动态展示即将到期的词汇与对应 Stage 倒数 -->
        </div>
      </div>'''

if target3 in content:
    content = content.replace(target3, replacement3, 1)
    print("3. stats-eb-schedule inserted")
else:
    print("Warning: target3 not found")

# 4. 插入 session-summary-overlay
target4 = '  <!-- 达成每日打卡目标仪式感弹窗 -->'
replacement4 = '''  <!-- 本轮默写完成仪式与艾宾浩斯排程结果卡片 -->
  <div id="session-summary-overlay" class="summary-modal-overlay" onclick="if(event.target===this)closeSessionSummaryModal('home')">
    <div class="summary-card">
      <div style="font-size: 2.8rem; margin-bottom: 8px;">🎉</div>
      <div style="font-size: 1.35rem; font-weight: 800; margin-bottom: 6px;">本轮雅思默写圆满完成！</div>
      <div style="font-size: 0.9rem; color: var(--text-muted);">艾宾浩斯遗忘曲线已实时为您同步记忆阶段</div>

      <div class="summary-stat-grid">
        <div class="summary-stat-item">
          <div class="summary-stat-val" id="sum-rate" style="color: var(--success);">100%</div>
          <div class="summary-stat-lbl">本轮正确率</div>
        </div>
        <div class="summary-stat-item">
          <div class="summary-stat-val" id="sum-correct" style="color: var(--primary);">0</div>
          <div class="summary-stat-lbl">初次拼对</div>
        </div>
        <div class="summary-stat-item">
          <div class="summary-stat-val" id="sum-wrong" style="color: var(--warning);">0</div>
          <div class="summary-stat-lbl">巩固重测</div>
        </div>
      </div>

      <div id="sum-ebbinghaus-advice" style="background: var(--input-bg); border: 1px dashed var(--card-border); border-radius: 12px; padding: 12px 16px; font-size: 0.88rem; line-height: 1.5; color: var(--text-muted); margin-bottom: 20px; text-align: left;">
        💡 艾宾浩斯记忆提醒
      </div>

      <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
        <button type="button" class="eb-btn-action" id="btn-summary-next-due" onclick="closeSessionSummaryModal('next_due')" style="display: none; padding: 10px 20px; font-size: 0.92rem;">
          ⚡️ 立即开始下一波复习
        </button>
        <button type="button" onclick="closeSessionSummaryModal('home')" style="background: var(--primary); color: #fff; border: none; padding: 10px 22px; border-radius: 10px; font-weight: 700; cursor: pointer;">
          🏠 返回主页 (查看倒计时)
        </button>
        <button type="button" onclick="closeSessionSummaryModal('retry')" style="background: var(--input-bg); border: 1px solid var(--card-border); color: var(--text); padding: 10px 18px; border-radius: 10px; font-weight: 600; cursor: pointer;">
          🔄 再练一轮
        </button>
      </div>
    </div>
  </div>

  <!-- 达成每日打卡目标仪式感弹窗 -->'''

if target4 in content:
    content = content.replace(target4, replacement4, 1)
    print("4. session-summary-overlay inserted")
else:
    print("Warning: target4 not found")

with open('IELTS_Dictation/static/index.html', 'w', encoding='utf-8') as f:
    f.write(content)

