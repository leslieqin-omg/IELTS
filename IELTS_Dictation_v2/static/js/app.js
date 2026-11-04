/**
 * app.js - Main Application Controller for IELTS_Dictation_v2
 * ===========================================================
 * 1. Top tabs switching logic:
 *    - Strict dual-container DOM visibility toggling (display: none / block).
 *    - Complete state, input text, and queue preservation across tab switches.
 * 2. Settings modal management:
 *    - Independent settings for Listening and Writing modules.
 *    - Strict validation: review_cap >= 1, daily_new_words >= 0.
 *    - Immediate persistence and UI synchronization.
 * 3. Global keyboard shortcuts:
 *    - Ctrl+R / F2 / Ctrl+Space for audio replay in Listening module (with preventDefault).
 *    - Space for replay when input is not actively focused.
 *    - Escape closes modals.
 * 4. Theme toggle (dark/light mode).
 * 5. Dynamic header stats & check-in progress.
 */

(function(window) {
  'use strict';

  const App = {
    activeTab: 'listening', // 'listening' | 'writing'

    init() {
      this.cacheDom();
      this.bindEvents();
      this.initTheme();

      // Initialize submodules
      if (window.ListeningModule && typeof window.ListeningModule.init === 'function') {
        window.ListeningModule.init();
      }
      if (window.WritingModule && typeof window.WritingModule.init === 'function') {
        window.WritingModule.init();
      }

      // Restore active tab
      const savedTab = localStorage.getItem('ielts_v2_active_tab') || 'listening';
      this.switchTab(savedTab, false);

      // Load initial settings and header stats
      this.loadSettings();
      this.refreshHeaderStats();
    },

    cacheDom() {
      // Nav Tabs
      this.tabBtnListening = document.getElementById('tab-btn-listening');
      this.tabBtnWriting = document.getElementById('tab-btn-writing');
      this.containerListening = document.getElementById('container-listening');
      this.containerWriting = document.getElementById('container-writing');

      // Header actions & badges
      this.btnSettings = document.getElementById('btn-header-settings');
      this.btnThemeToggle = document.getElementById('btn-header-theme');
      this.checkinBadge = document.getElementById('header-checkin-badge');
      this.streakBadge = document.getElementById('header-streak-badge');

      // Settings Modal
      this.settingsModal = document.getElementById('settings-modal');
      this.settingsCloseBtn = document.getElementById('settings-close-btn');
      this.settingsCancelBtn = document.getElementById('settings-cancel-btn');
      this.settingsSaveBtn = document.getElementById('settings-save-btn');
      this.settingsErrorMsg = document.getElementById('settings-error-msg');

      // Settings Inputs
      this.inputListeningCap = document.getElementById('setting-listening-review-cap');
      this.inputListeningNew = document.getElementById('setting-listening-daily-new');
      this.inputWritingCap = document.getElementById('setting-writing-review-cap');
      this.inputWritingNew = document.getElementById('setting-writing-daily-new');

      // Toast notification container
      this.toastContainer = document.getElementById('toast-container');
    },

    bindEvents() {
      // Tab Buttons
      if (this.tabBtnListening) {
        this.tabBtnListening.addEventListener('click', () => this.switchTab('listening'));
      }
      if (this.tabBtnWriting) {
        this.tabBtnWriting.addEventListener('click', () => this.switchTab('writing'));
      }

      // Settings Modal
      if (this.btnSettings) {
        this.btnSettings.addEventListener('click', () => this.openSettingsModal());
      }
      if (this.settingsCloseBtn) {
        this.settingsCloseBtn.addEventListener('click', () => this.closeSettingsModal());
      }
      if (this.settingsCancelBtn) {
        this.settingsCancelBtn.addEventListener('click', () => this.closeSettingsModal());
      }
      if (this.settingsSaveBtn) {
        this.settingsSaveBtn.addEventListener('click', () => this.saveSettings());
      }

      // Theme Toggle
      if (this.btnThemeToggle) {
        this.btnThemeToggle.addEventListener('click', () => this.toggleTheme());
      }

      // Global Keyboard Shortcuts
      window.addEventListener('keydown', (e) => this.handleGlobalShortcuts(e));
    },

    /**
     * Switch between Listening and Writing modules.
     * Guaranteed state preservation: ONLY toggles CSS display, NEVER destroys DOM.
     */
    switchTab(tabName, saveState = true) {
      const target = (tabName || '').toLowerCase() === 'writing' ? 'writing' : 'listening';
      this.activeTab = target;

      if (saveState) {
        localStorage.setItem('ielts_v2_active_tab', target);
      }

      if (target === 'listening') {
        if (this.tabBtnListening) this.tabBtnListening.classList.add('active');
        if (this.tabBtnWriting) this.tabBtnWriting.classList.remove('active');

        if (this.containerListening) this.containerListening.style.display = 'block';
        if (this.containerWriting) this.containerWriting.style.display = 'none';

        // Focus listening input if in dictation mode
        setTimeout(() => {
          const lInput = document.getElementById('listening-input');
          if (lInput && lInput.offsetParent !== null) {
            lInput.focus();
          }
        }, 50);
      } else {
        if (this.tabBtnWriting) this.tabBtnWriting.classList.add('active');
        if (this.tabBtnListening) this.tabBtnListening.classList.remove('active');

        if (this.containerWriting) this.containerWriting.style.display = 'block';
        if (this.containerListening) this.containerListening.style.display = 'none';

        // Focus writing input if in dictation mode
        setTimeout(() => {
          const wInput = document.getElementById('writing-input');
          if (wInput && wInput.offsetParent !== null) {
            wInput.focus();
          }
        }, 50);
      }

      this.refreshHeaderStats();
    },

    /**
     * Global keyboard shortcuts handler
     */
    handleGlobalShortcuts(e) {
      const activeElement = document.activeElement;
      const isInputFocused = activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA');

      // 1. Audio Replay Shortcuts for Listening Dictation: Ctrl+R, F2, Ctrl+Space
      const isCtrlR = (e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R');
      const isF2 = e.key === 'F2';
      const isCtrlSpace = (e.ctrlKey || e.metaKey) && (e.code === 'Space' || e.key === ' ');

      if (this.activeTab === 'listening' && (isCtrlR || isF2 || isCtrlSpace)) {
        e.preventDefault(); // Prevent browser refresh!
        if (window.audioPlayer) {
          window.audioPlayer.replay();
        }
        return;
      }

      // 2. Space shortcut when cursor is NOT inside text input
      if (this.activeTab === 'listening' && (e.code === 'Space' || e.key === ' ') && !isInputFocused) {
        e.preventDefault();
        if (window.audioPlayer) {
          window.audioPlayer.replay();
        }
        return;
      }

      // 3. Escape closes modals
      if (e.key === 'Escape') {
        if (this.settingsModal && this.settingsModal.classList.contains('active')) {
          this.closeSettingsModal();
        }
      }
    },

    /**
     * Refresh header check-in status and streak badge
     */
    async refreshHeaderStats() {
      try {
        const checkinData = await Api.getCheckin(this.activeTab);
        if (this.checkinBadge) {
          const count = checkinData.today_count || 0;
          const goal = checkinData.goal || 20;
          const completed = checkinData.today_completed || (count >= goal);
          const icon = completed ? '🎉' : '🎯';
          this.checkinBadge.innerHTML = `<span class="badge-icon">${icon}</span> 今日打卡: <strong>${count}/${goal}</strong> 词`;
          if (completed) {
            this.checkinBadge.classList.add('completed');
          } else {
            this.checkinBadge.classList.remove('completed');
          }
        }

        if (this.streakBadge) {
          const streak = checkinData.streak || 0;
          this.streakBadge.innerHTML = `<span class="badge-icon">🔥</span> 连续 <strong>${streak}</strong> 天`;
        }
      } catch (e) {
        console.warn('Could not refresh header stats:', e);
      }
    },

    /**
     * Open Settings modal dialog
     */
    async openSettingsModal() {
      if (this.settingsErrorMsg) this.settingsErrorMsg.style.display = 'none';
      await this.loadSettings();
      if (this.settingsModal) {
        this.settingsModal.classList.add('active');
      }
    },

    closeSettingsModal() {
      if (this.settingsModal) {
        this.settingsModal.classList.remove('active');
      }
    },

    async loadSettings() {
      try {
        const [listeningSettings, writingSettings] = await Promise.all([
          Api.getSettings('listening'),
          Api.getSettings('writing')
        ]);

        if (this.inputListeningCap) {
          this.inputListeningCap.value = listeningSettings.review_cap !== undefined ? listeningSettings.review_cap : 40;
        }
        if (this.inputListeningNew) {
          this.inputListeningNew.value = listeningSettings.daily_new_words !== undefined ? listeningSettings.daily_new_words : 10;
        }
        if (this.inputWritingCap) {
          this.inputWritingCap.value = writingSettings.review_cap !== undefined ? writingSettings.review_cap : 30;
        }
        if (this.inputWritingNew) {
          this.inputWritingNew.value = writingSettings.daily_new_words !== undefined ? writingSettings.daily_new_words : 10;
        }
      } catch (e) {
        console.warn('Failed to load settings:', e);
      }
    },

    async saveSettings() {
      if (this.settingsErrorMsg) this.settingsErrorMsg.style.display = 'none';

      const listeningCap = parseInt(this.inputListeningCap?.value, 10);
      const listeningNew = parseInt(this.inputListeningNew?.value, 10);
      const writingCap = parseInt(this.inputWritingCap?.value, 10);
      const writingNew = parseInt(this.inputWritingNew?.value, 10);

      // Validation
      if (isNaN(listeningCap) || listeningCap < 1) {
        this.showSettingsError('听力模块复习上限必须为大于等于 1 的整数！');
        return;
      }
      if (isNaN(listeningNew) || listeningNew < 0) {
        this.showSettingsError('听力模块每日新词数必须为大于等于 0 的整数！');
        return;
      }
      if (isNaN(writingCap) || writingCap < 1) {
        this.showSettingsError('写作模块复习上限必须为大于等于 1 的整数！');
        return;
      }
      if (isNaN(writingNew) || writingNew < 0) {
        this.showSettingsError('写作模块每日新词数必须为大于等于 0 的整数！');
        return;
      }

      try {
        if (this.settingsSaveBtn) this.settingsSaveBtn.disabled = true;

        await Promise.all([
          Api.saveSettings('listening', {
            review_cap: listeningCap,
            daily_new_words: listeningNew
          }),
          Api.saveSettings('writing', {
            review_cap: writingCap,
            daily_new_words: writingNew
          })
        ]);

        this.closeSettingsModal();
        this.showToast('✅ 系统设置保存成功！已在下一次默写会话生效。');

        // Refresh stats on both modules
        if (window.ListeningModule && typeof window.ListeningModule.refreshDashboard === 'function') {
          window.ListeningModule.refreshDashboard();
        }
        if (window.WritingModule && typeof window.WritingModule.refreshDashboard === 'function') {
          window.WritingModule.refreshDashboard();
        }
      } catch (e) {
        this.showSettingsError('保存设置失败: ' + (e.message || e));
      } finally {
        if (this.settingsSaveBtn) this.settingsSaveBtn.disabled = false;
      }
    },

    showSettingsError(msg) {
      if (this.settingsErrorMsg) {
        this.settingsErrorMsg.innerText = msg;
        this.settingsErrorMsg.style.display = 'block';
      } else {
        alert(msg);
      }
    },

    showToast(message, duration = 3000) {
      if (!this.toastContainer) return;
      const toast = document.createElement('div');
      toast.className = 'toast-pill';
      toast.innerText = message;
      this.toastContainer.appendChild(toast);

      setTimeout(() => {
        toast.classList.add('show');
      }, 10);

      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
          if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 300);
      }, duration);
    },

    initTheme() {
      const savedTheme = localStorage.getItem('ielts_v2_theme') || 'dark';
      document.documentElement.setAttribute('data-theme', savedTheme);
      this.updateThemeButton(savedTheme);
    },

    toggleTheme() {
      const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
      const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', nextTheme);
      localStorage.setItem('ielts_v2_theme', nextTheme);
      this.updateThemeButton(nextTheme);
    },

    updateThemeButton(theme) {
      if (this.btnThemeToggle) {
        this.btnThemeToggle.innerHTML = theme === 'dark' ? '☀️ 亮色' : '🌙 暗色';
      }
    }
  };

  window.App = App;

  // Auto-initialize once DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => App.init());
  } else {
    App.init();
  }
})(window);
