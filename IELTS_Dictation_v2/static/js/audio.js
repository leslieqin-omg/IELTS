/**
 * audio.js - Audio Playback Engine & SpeechSynthesis Fallback for IELTS_Dictation_v2
 * =================================================================================
 * Compliance Contract:
 * 1. Plays local audio file at `/static/audio/<word>.mp3` with proper URL encoding.
 * 2. Hooks `onerror`: automatically falls back to `window.speechSynthesis` when file is missing (404) or fails.
 * 3. Fallback uses `SpeechSynthesisUtterance` explicitly configured with `lang = 'en-GB'` (British English).
 * 4. Provides unlimited replays via `replay()` method triggered by UI button or keyboard shortcut.
 * 5. Provides visual audio state listeners (playing waveform, speaker icon pulse).
 */

(function(window) {
  'use strict';

  class AudioPlayer {
    constructor() {
      this.currentWord = null;
      this.currentAudio = null;
      this.isPlaying = false;
      this.currentSource = null; // 'local' | 'synth'
      this.listeners = [];

      // Warm up SpeechSynthesis voices if supported
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        if (window.speechSynthesis.onvoiceschanged !== undefined) {
          window.speechSynthesis.onvoiceschanged = () => {
            this._getBritishVoice();
          };
        }
      }
    }

    /**
     * Subscribe to playback status updates (isPlaying: boolean, source: 'local'|'synth'|null)
     */
    addStatusListener(fn) {
      if (typeof fn === 'function') {
        this.listeners.push(fn);
      }
    }

    _notify(isPlaying, source = null) {
      this.isPlaying = isPlaying;
      this.currentSource = isPlaying ? source : null;
      for (const fn of this.listeners) {
        try {
          fn(this.isPlaying, this.currentSource, this.currentWord);
        } catch (e) {
          console.error('Audio status listener error:', e);
        }
      }
    }

    /**
     * Find best British English voice available in browser
     */
    _getBritishVoice() {
      if (!('speechSynthesis' in window)) return null;
      const voices = window.speechSynthesis.getVoices();
      if (!voices || voices.length === 0) return null;

      // Prefer explicit en-GB voices (e.g. Daniel, Serena, Oliver, George, Kate)
      const gbVoice = voices.find(v => 
        (v.lang === 'en-GB' || v.lang === 'en_GB') && !v.name.includes('Compact')
      ) || voices.find(v => 
        v.lang === 'en-GB' || v.lang === 'en_GB'
      ) || voices.find(v => 
        v.lang && v.lang.toLowerCase().startsWith('en') && (v.name.includes('UK') || v.name.includes('British') || v.name.includes('England'))
      );

      return gbVoice || null;
    }

    /**
     * Stop any currently playing audio or speech synthesis
     */
    stop() {
      if (this.currentAudio) {
        try {
          this.currentAudio.pause();
          this.currentAudio.currentTime = 0;
          this.currentAudio.onerror = null;
          this.currentAudio.onended = null;
          this.currentAudio.onplay = null;
        } catch (e) {}
        this.currentAudio = null;
      }

      if ('speechSynthesis' in window) {
        try {
          window.speechSynthesis.cancel();
        } catch (e) {}
      }

      this._notify(false, null);
    }

    /**
     * Play word pronunciation.
     * First attempts local MP3 (/static/audio/<word>.mp3).
     * If 404 or loading error occurs, seamlessly falls back to British English SpeechSynthesis.
     */
    playWord(word) {
      if (!word) return;
      const cleanWord = String(word).trim();
      if (!cleanWord) return;

      this.currentWord = cleanWord;
      this.stop();

      const encodedWord = encodeURIComponent(cleanWord);
      const audioUrl = `/static/audio/${encodedWord}.mp3`;
      const audio = new Audio();
      this.currentAudio = audio;

      let fallbackHandled = false;
      const self = this;

      const runFallback = () => {
        if (fallbackHandled) return;
        fallbackHandled = true;
        self.playSpeechSynthesis(cleanWord);
      };

      // Contract requirement: onerror triggers SpeechSynthesis fallback
      audio.onerror = function(err) {
        runFallback();
      };

      audio.onplay = function() {
        self._notify(true, 'local');
      };

      audio.onended = function() {
        self._notify(false, null);
      };

      try {
        audio.src = audioUrl;
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise.catch(function(err) {
            // Error playing (e.g. 404 Not Found or browser policy) -> trigger fallback
            runFallback();
          });
        }
      } catch (err) {
        runFallback();
      }
    }

    /**
     * Fallback pronunciation using browser Web Speech API (speechSynthesis)
     * Configured with British English ('en-GB')
     */
    playSpeechSynthesis(word) {
      if (!('speechSynthesis' in window)) {
        console.warn('Browser does not support window.speechSynthesis Web Speech API');
        this._notify(false, null);
        return;
      }

      try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(word);
        
        // Contract requirement: British English voice configuration
        utterance.lang = 'en-GB';
        utterance.rate = 0.92; // Natural clear pacing for IELTS listening
        utterance.pitch = 1.0;

        const voice = this._getBritishVoice();
        if (voice) {
          utterance.voice = voice;
        }

        const self = this;
        utterance.onstart = function() {
          self._notify(true, 'synth');
        };

        utterance.onend = function() {
          self._notify(false, null);
        };

        utterance.onerror = function(e) {
          console.warn('SpeechSynthesis playback error:', e);
          self._notify(false, null);
        };

        window.speechSynthesis.speak(utterance);
      } catch (err) {
        console.error('SpeechSynthesis error:', err);
        this._notify(false, null);
      }
    }

    /**
     * Replay the currently loaded word (unlimited replays)
     */
    replay() {
      if (this.currentWord) {
        this.playWord(this.currentWord);
      }
    }
  }

  // Export singleton to window
  window.audioPlayer = new AudioPlayer();
})(window);
