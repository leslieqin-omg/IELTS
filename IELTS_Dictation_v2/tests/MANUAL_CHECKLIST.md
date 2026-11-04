# Manual Verification Checklist: IELTS_Dictation_v2

This checklist outlines the manual verification steps for features that involve interactive browser UX, audio playback, speech synthesis fallback, and UI state preservation.

---

## 1. Prerequisites & Server Launch

- [ ] **Port Check**:
  ```bash
  lsof -i :8765
  lsof -i :8766
  ```
  Ensure port 8765 remains running untouched (if original server was running). Ensure port 8766 is available.
- [ ] **Start v2 Server**:
  ```bash
  cd /Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation_v2
  ./start.sh
  ```
  Verify console outputs:
  - Startup scanning message for capitalized vocabulary words.
  - Server listening message: `Running on http://127.0.0.1:8766`.
- [ ] **Open Browser**: Navigate to `http://127.0.0.1:8766` in Chrome, Safari, or Edge.

---

## 2. Module Navigation & Top-Level Tabs

- [ ] **Top-Level Tabs Display**:
  - Verify two tabs appear in the top navigation bar: `[ 🎧 听力默写 (Listening) ]` and `[ ✍️ 写作默写 (Writing) ]`.
  - Verify that the Listening tab is active by default on initial page load.
- [ ] **Theme Toggle**:
  - Click theme toggle icon (dark/light mode).
  - Verify all colors and cards adapt cleanly with proper contrast.

---

## 3. Listening Dictation & Audio Playback

- [ ] **Initial Audio & Card State**:
  - In the Listening module, click **"开始默写"** (Start Dictation).
  - Confirm British English (`en-GB`) audio plays automatically for the first card.
  - Confirm the English word is **hidden**.
  - Confirm the Chinese gloss (`glossZh`) is **hidden**.
  - Confirm the cursor automatically focuses inside the answer input box.
- [ ] **Replay Button**:
  - Click the **"🔊 重播发音"** (Replay Audio) button.
  - Confirm the audio plays again clearly without reloading the page or altering the text input.
  - Confirm unlimited replays can be triggered.
- [ ] **Keyboard Shortcut Replay**:
  - With the cursor inside the text box, press the configured shortcut (`Ctrl+R` or `Space` / `F2`).
  - Confirm the audio plays immediately and the input text is not lost or overwritten.
- [ ] **SpeechSynthesis Fallback (Missing Audio)**:
  - Open browser DevTools (F12) -> Network tab.
  - If a word lacks a local MP3 file (`/static/audio/<word>.mp3` returns 404), verify that:
    - No unhandled runtime error appears in the Console.
    - The browser's Web Speech API (`window.speechSynthesis.speak`) is invoked with `utterance.lang = 'en-GB'`.
    - Clear British English speech is heard through the speakers.

---

## 4. Two-Tier Spelling Judgment & Capitalization

- [ ] **Month Name Capitalization**:
  - When prompted with a month word (e.g. `January`), type lowercase `january` and press Enter.
  - Confirm the submission is evaluated as **Incorrect** (reason: capitalization error).
  - Retype `January` with leading capital letter and press Enter.
  - Confirm it is evaluated as **Correct**.
  - Confirm that **only after** submission, the Chinese gloss and phonetic guide are displayed.
- [ ] **Country Name Capitalization**:
  - When prompted with a country/region (e.g. `France`), type `france` and press Enter -> confirm evaluated as **Incorrect**.
  - Retype `France` -> confirm evaluated as **Correct**.
- [ ] **General Vocabulary (Case-Insensitive)**:
  - When prompted with a regular word (e.g. `danger` or `creative`), type `danger` -> confirm accepted.
  - If target was capitalized in raw data (`Carpets` or `Water`), type lowercase `carpets` or `water` -> confirm accepted as **Correct**.
- [ ] **Trimming**:
  - Type leading or trailing spaces (e.g. `  station  `) -> confirm spaces are trimmed and word is accepted.

---

## 5. Writing Dictation Replication

- [ ] **Switch to Writing Module**:
  - Click the `[ ✍️ 写作默写 (Writing) ]` tab.
- [ ] **Audio Absence**:
  - Click **"开始默写"** in the Writing module.
  - Confirm **NO audio** plays (writing module is text-only).
- [ ] **Prompt Display**:
  - Confirm the default prompt shows the **Chinese definition** and word length/hint.
  - Confirm notes in `【...】` and example sentences are hidden until submission.
- [ ] **Answer Submission**:
  - Type the English word and press Enter.
  - Confirm instant evaluation against migrated writing vocabulary (230 words).

---

## 6. Cross-Module Tab State Preservation

- [ ] **In-Session Input Preservation**:
  - In the Listening module during an active session, type half of a word into the input box (e.g. `libra`).
  - Do NOT submit.
  - Click the `[ ✍️ 写作默写 (Writing) ]` tab.
  - Confirm the Writing module view is shown.
  - Click back to the `[ 🎧 听力默写 (Listening) ]` tab.
  - Verify that:
    - The active session was NOT reset.
    - The current word card index remains the same.
    - The input field still contains `libra`.
- [ ] **Browser Refresh Persistence**:
  - Advance 3 cards in Listening.
  - Refresh the browser (F5 / Cmd+R).
  - Verify the active session queue resumes at the exact same card.

---

## 7. Settings Isolation & Persistence

- [ ] **Listening Settings Update**:
  - Open the **设置** (Settings) panel under the Listening tab.
  - Set `单次复习上限 (Review Cap)` to `45`.
  - Set `每日新词数 (Daily New Words)` to `15`.
  - Click **保存设置** (Save). Confirm success message.
- [ ] **Writing Settings Verification**:
  - Switch to the Writing tab and open its Settings panel.
  - Confirm that Writing `Review Cap` is still `30` and `Daily New Words` is still `10` (unaffected).
- [ ] **Validation Error Handling**:
  - In Writing Settings, set Review Cap to `0` or `-5` and click Save.
  - Confirm clear error message: review cap must be at least 1.
  - Set Daily New Words to `-1` -> confirm clear error message.
- [ ] **Server Restart Persistence**:
  - Stop the server (Ctrl+C).
  - Restart the server with `./start.sh`.
  - Reload the browser.
  - Open Listening Settings: confirm Review Cap is still `45` and Daily New Words is still `15`.
  - Open Writing Settings: confirm Review Cap is still `30`.

---

## 8. Original Directory Verification

- [ ] Run terminal command:
  ```bash
  python3 -m unittest tests/test_original_hash.py
  ```
  Confirm 0 modifications to `/Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation`.
