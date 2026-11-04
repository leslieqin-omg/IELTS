/**
 * api.js - REST API Client Connector for IELTS_Dictation_v2
 * ========================================================
 * Provides clean asynchronous interface for all server endpoints:
 * - /api/{module}/words
 * - /api/{module}/stats
 * - /api/{module}/checkin
 * - /api/{module}/session
 * - /api/{module}/session/start
 * - /api/{module}/session/save
 * - /api/{module}/session/clear
 * - /api/{module}/review
 * - /api/{module}/settings
 * - /api/judge
 * - /api/network
 */

(function(window) {
  'use strict';

  const Api = {
    /**
     * Send HTTP request with error handling and JSON body parsing
     */
    async request(path, options = {}) {
      const url = path.startsWith('/') ? path : '/' + path;
      const headers = Object.assign({
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }, options.headers || {});

      const fetchOptions = {
        method: options.method || 'GET',
        headers: headers
      };

      if (options.body !== undefined && options.body !== null) {
        if (typeof options.body === 'string') {
          fetchOptions.body = options.body;
        } else {
          fetchOptions.body = JSON.stringify(options.body);
        }
      }

      let res;
      try {
        res = await fetch(url, fetchOptions);
      } catch (networkErr) {
        const err = new Error('无法连接到服务器，请检查后端运行状态。');
        err.network = true;
        throw err;
      }

      let data;
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        try {
          data = await res.json();
        } catch (parseErr) {
          data = { error: '解析服务器返回结果失败' };
        }
      } else {
        const text = await res.text();
        data = { text: text };
      }

      if (!res.ok) {
        const errMsg = (data && data.error) ? data.error : `HTTP ${res.status}`;
        const err = new Error(errMsg);
        err.status = res.status;
        err.data = data;
        throw err;
      }

      return data;
    },

    // 1. Vocabulary & Stats Endpoints
    async getWords(module) {
      return this.request(`/api/${module}/words`);
    },

    async getStats(module) {
      return this.request(`/api/${module}/stats`);
    },

    async getCheckin(module) {
      return this.request(`/api/${module}/checkin`);
    },

    // 2. Session Lifecycle Endpoints
    async getSession(module) {
      return this.request(`/api/${module}/session`);
    },

    async startSession(module) {
      return this.request(`/api/${module}/session/start`, {
        method: 'POST',
        body: {}
      });
    },

    async saveSession(module, sessionData) {
      return this.request(`/api/${module}/session/save`, {
        method: 'POST',
        body: sessionData || {}
      });
    },

    async clearSession(module) {
      return this.request(`/api/${module}/session/clear`, {
        method: 'POST',
        body: {}
      });
    },

    // 3. Word Review Recording
    async submitReview(module, word, correct, retry_pass = false) {
      return this.request(`/api/${module}/review`, {
        method: 'POST',
        body: {
          word: word,
          correct: Boolean(correct),
          retry_pass: Boolean(retry_pass)
        }
      });
    },

    // 4. Module Settings
    async getSettings(module) {
      return this.request(`/api/${module}/settings`);
    },

    async saveSettings(module, settings) {
      return this.request(`/api/${module}/settings`, {
        method: 'POST',
        body: settings
      });
    },

    // 5. Spelling Judge Endpoint
    async judge(user_input, target_word, accepted_answers = []) {
      return this.request('/api/judge', {
        method: 'POST',
        body: {
          user_input: user_input,
          target_word: target_word,
          accepted_answers: accepted_answers
        }
      });
    },

    // 6. Network Info (LAN access)
    async getNetwork() {
      return this.request('/api/network');
    }
  };

  window.Api = Api;
})(window);
