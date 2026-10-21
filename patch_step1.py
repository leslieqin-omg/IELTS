
# -*- coding: utf-8 -*-
with open('IELTS_Dictation/static/index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. 注入 CSS
css_anchor = ".goal-preset-btn:hover, .goal-preset-btn.active {"
css_addition = '''
    /* 艾宾浩斯动态调度监控卡片 */
    .ebbinghaus-live-card {
      border-radius: 14px;
      padding: 18px 22px;
      margin-bottom: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      transition: all 0.3s ease;
      position: relative;
      overflow: hidden;
    }
    .ebbinghaus-live-card.due-active {
      background: linear-gradient(135deg, rgba(245, 158, 11, 0.12), rgba(239, 68, 68, 0.08));
      border: 1.5px solid rgba(245, 158, 11, 0.45);
      box-shadow: 0 4px 20px rgba(245, 158, 11, 0.15);
    }
    .ebbinghaus-live-card.waiting {
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.08), rgba(59, 130, 246, 0.05));
      border: 1.5px solid rgba(99, 102, 241, 0.28);
    }
    .eb-badge-icon {
      font-size: 2rem;
      line-height: 1;
    }
    .eb-title-row {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 1.05rem;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .eb-subtext {
      font-size: 0.88rem;
      color: var(--text-muted);
      line-height: 1.5;
    }
    .eb-highlight-num {
      color: #f59e0b;
      font-weight: 800;
      font-size: 1.25rem;
      font-family: ui-monospace, SFMono-Regular, monospace;
    }
    .eb-timer-display {
      font-size: 1.45rem;
      font-weight: 800;
      color: var(--primary);
      font-family: ui-monospace, SFMono-Regular, monospace;
      letter-spacing: 1px;
      background: var(--input-bg);
      padding: 4px 14px;
      border-radius: 8px;
      border: 1px solid var(--card-border);
      display: inline-block;
    }
    .eb-samples-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .eb-sample-pill {
      font-size: 0.78rem;
      background: var(--input-bg);
      border: 1px solid var(--card-border);
      padding: 3px 10px;
      border-radius: 12px;
      color: var(--text);
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .eb-btn-action {
      background: linear-gradient(135deg, #f59e0b, #d97706);
      color: #fff;
      border: none;
      padding: 12px 24px;
      border-radius: 10px;
      font-size: 0.96rem;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 4px 15px rgba(245, 158, 11, 0.35);
      transition: all 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      white-space: nowrap;
    }
    .eb-btn-action:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(245, 158, 11, 0.45);
    }
    .eb-pulse-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #10b981;
      display: inline-block;
      animation: ebPulse 1.6s infinite;
    }
    @keyframes ebPulse {
      0% { transform: scale(0.9); opacity: 0.8; box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
      70% { transform: scale(1.15); opacity: 1; box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); }
      100% { transform: scale(0.9); opacity: 0.8; box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }

    /* 本轮默写完成优雅模态卡片 */
    .summary-modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.68);
      display: none;
      justify-content: center;
      align-items: center;
      z-index: 1000;
      backdrop-filter: blur(5px);
      animation: fadeIn 0.2s ease;
    }
    .summary-modal-overlay.active {
      display: flex;
    }
    .summary-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 20px;
      width: 90%;
      max-width: 480px;
      padding: 30px 24px;
      text-align: center;
      box-shadow: 0 20px 45px rgba(0, 0, 0, 0.35);
      animation: popIn 0.25s ease;
    }
    .summary-stat-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin: 20px 0;
    }
    .summary-stat-item {
      background: var(--input-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 12px 6px;
    }
    .summary-stat-val {
      font-size: 1.55rem;
      font-weight: 800;
    }
    .summary-stat-lbl {
      font-size: 0.78rem;
      color: var(--text-muted);
      margin-top: 4px;
    }
'''

if css_anchor in content:
    content = content.replace(css_anchor, css_addition + "\n    " + css_anchor, 1)
    print("CSS injected successfully")
else:
    print("Warning: css_anchor not found")

with open('IELTS_Dictation/static/index.html', 'w', encoding='utf-8') as f:
    f.write(content)

