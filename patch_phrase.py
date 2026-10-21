
with open('IELTS_Dictation/static/index.html', 'r', encoding='utf-8') as f:
    html = f.read()

# 1. CSS for phrase hints and slots
phrase_css = '''
    /* 短语词数提示与分词插槽样式 */
    .phrase-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: rgba(99, 102, 241, 0.12);
      color: var(--primary);
      border: 1px solid rgba(99, 102, 241, 0.25);
      border-radius: 20px;
      padding: 3px 10px;
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.3px;
    }

    .phrase-slots-container {
      display: flex;
      justify-content: center;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
      min-height: 28px;
    }

    .phrase-slot {
      background: var(--input-bg);
      border: 1.5px dashed var(--card-border);
      border-radius: 8px;
      padding: 4px 10px;
      font-size: 0.84rem;
      font-family: ui-monospace, SFMono-Regular, monospace;
      color: var(--text-muted);
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.2s ease;
    }

    .phrase-slot.active {
      border-color: var(--primary);
      color: var(--primary);
      background: rgba(99, 102, 241, 0.08);
      font-weight: 700;
      box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
    }

    .phrase-slot.done {
      border-style: solid;
      border-color: rgba(16, 185, 129, 0.5);
      color: var(--success);
      background: rgba(16, 185, 129, 0.1);
      font-weight: 700;
    }
'''

html = html.replace('</style>', phrase_css + '\n  </style>')

# 2. Add slot container below typing input in HTML
old_input_zone = '''          <!-- 输入区 -->
          <div class="input-zone">
            <input 
              type="text" 
              id="typing-input" 
              class="typing-input" 
              placeholder="看中文释义，直接打出英文拼写..." 
              autocomplete="off" 
              autocorrect="off" 
              autocapitalize="off" 
              spellcheck="false"
            />
          </div>'''

new_input_zone = '''          <!-- 输入区 -->
          <div class="input-zone">
            <input 
              type="text" 
              id="typing-input" 
              class="typing-input" 
              placeholder="看中文释义，直接打出英文拼写..." 
              autocomplete="off" 
              autocorrect="off" 
              autocapitalize="off" 
              spellcheck="false"
            />
            <!-- 短语词数结构指引 (如果是短语则动态渲染分词槽) -->
            <div id="phrase-slots-wrap" class="phrase-slots-container" style="display: none;"></div>
          </div>'''

assert old_input_zone in html, 'old_input_zone not found'
html = html.replace(old_input_zone, new_input_zone, 1)

# 3. Update loadWordAt to parse phrase structure and update placeholder/badges/slots
old_load_tail = '''      const tagBox = document.getElementById('word-tags');
      tagBox.innerHTML = '<span class="badge-tag">' + (w.section || 'Section') + '</span>' +
        '<span class="badge-stage">' + (STAGE_NAMES[w.stage || 0] || 'Stage ' + w.stage) + '</span>';'''

new_load_tail = '''      const targetWord = (w.word || '').trim();
      const tokens = targetWord.split(/\s+/).filter(Boolean);
      const isPhrase = tokens.length > 1;

      const tagBox = document.getElementById('word-tags');
      let tagsHtml = '<span class="badge-tag">' + (w.section || 'Section') + '</span>' +
        '<span class="badge-stage">' + (STAGE_NAMES[w.stage || 0] || 'Stage ' + w.stage) + '</span>';
      
      if (isPhrase) {
        tagsHtml += '<span class="phrase-badge" title="这是一个包含 ' + tokens.length + ' 个单词的固定搭配/短语">🧩 ' + tokens.length + ' 词短语搭配</span>';
      }
      tagBox.innerHTML = tagsHtml;'''

assert old_load_tail in html, 'old_load_tail not found'
html = html.replace(old_load_tail, new_load_tail, 1)

# Also update input placeholder and slots initialization in loadWordAt
old_input_reset = '''      const input = document.getElementById('typing-input');
      input.value = '';
      input.className = 'typing-input';
      document.getElementById('diff-box').style.display = 'none';
      document.getElementById('hint-text').innerText = '快捷键: Tab';'''

new_input_reset = '''      const input = document.getElementById('typing-input');
      input.value = '';
      input.className = 'typing-input';
      
      if (isPhrase) {
        input.placeholder = '短语默写（共 ' + tokens.length + ' 个单词，词间用空格隔开）...';
      } else {
        input.placeholder = '看中文释义，直接打出英文拼写...';
      }

      renderPhraseSlots(tokens, '');

      document.getElementById('diff-box').style.display = 'none';
      document.getElementById('hint-text').innerText = '快捷键: Tab';'''

assert old_input_reset in html, 'old_input_reset not found'
html = html.replace(old_input_reset, new_input_reset, 1)

# 4. Add helper functions renderPhraseSlots and update input listener
phrase_functions = '''
    function renderPhraseSlots(tokens, currentTyped) {
      const wrap = document.getElementById('phrase-slots-wrap');
      if (!wrap) return;

      if (!tokens || tokens.length <= 1) {
        wrap.style.display = 'none';
        wrap.innerHTML = '';
        return;
      }

      wrap.style.display = 'flex';
      const typedWords = currentTyped.trim().length > 0 ? currentTyped.trim().split(/\s+/) : [];
      const hasTrailingSpace = /\s$/.test(currentTyped);
      let activeIndex = 0;
      if (typedWords.length === 0) {
        activeIndex = 0;
      } else if (hasTrailingSpace) {
        activeIndex = typedWords.length;
      } else {
        activeIndex = typedWords.length - 1;
      }

      let html = '';
      tokens.forEach((t, i) => {
        let statusClass = '';
        let icon = '';
        if (i < activeIndex) {
          statusClass = ' done';
          icon = '✓ ';
        } else if (i === activeIndex) {
          statusClass = ' active';
          icon = '✎ ';
        } else {
          statusClass = '';
          icon = (i + 1) + '. ';
        }

        const lettersHint = t.length + ' 字母';
        html += '<div class="phrase-slot' + statusClass + '" title="第 ' + (i + 1) + ' 个词 (' + lettersHint + ')">' +
                  '<span>' + icon + '词 ' + (i + 1) + '</span>' +
                  '<span style="font-size: 0.72rem; opacity: 0.85;">(' + lettersHint + ')</span>' +
                '</div>';
      });

      wrap.innerHTML = html;
    }
'''

# 插入到 setupKeyboard 之前
html = html.replace('function setupKeyboard() {', phrase_functions + '\n    function setupKeyboard() {')

# 5. 在 setupKeyboard 里为 input 添加 'input' 事件监听，实时响应输入并高亮短语卡槽
old_setup_kb = '''    function setupKeyboard() {
      const input = document.getElementById('typing-input');
      if (!input) return;

      input.addEventListener('keydown', (e) => {'''

new_setup_kb = '''    function setupKeyboard() {
      const input = document.getElementById('typing-input');
      if (!input) return;

      input.addEventListener('input', (e) => {
        if (appState.currentWord) {
          const targetWord = (appState.currentWord.word || '').trim();
          const tokens = targetWord.split(/\s+/).filter(Boolean);
          if (tokens.length > 1) {
            renderPhraseSlots(tokens, e.target.value);
          }
        }
      });

      input.addEventListener('keydown', (e) => {'''

assert old_setup_kb in html, 'old_setup_kb not found'
html = html.replace(old_setup_kb, new_setup_kb, 1)

# 6. 更新 showFirstLetterHint，如果是短语，支持给每个单词的首字母或者提示短语结构
old_hint = '''    function showFirstLetterHint() {
      const target = appState.currentWord.word.trim();
      const hint = target.slice(0, 1) + '... (共 ' + target.length + ' 字符)';
      document.getElementById('hint-text').innerText = hint;
    }'''

new_hint = '''    function showFirstLetterHint() {
      const target = appState.currentWord.word.trim();
      const tokens = target.split(/\s+/).filter(Boolean);
      let hint = '';
      if (tokens.length > 1) {
        const initials = tokens.map(t => t[0] + '..(' + t.length + ')').join(' ');
        hint = initials + ' [共' + tokens.length + '词]';
      } else {
        hint = target.slice(0, 1) + '... (共 ' + target.length + ' 字母)';
      }
      document.getElementById('hint-text').innerText = hint;
    }'''

assert old_hint in html, 'old_hint not found'
html = html.replace(old_hint, new_hint, 1)

with open('IELTS_Dictation/static/index.html', 'w', encoding='utf-8') as f:
    f.write(html)

print('Phrase enhancement patched successfully!')

