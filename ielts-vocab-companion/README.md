# IELTS Vocab Companion

面向 macOS 分屏阅读的本地雅思生词伴侣。保留原项目的离线词库与示例阅读，使用原生 ES Modules，无需打包即可运行。Windows / Linux Chrome 也可使用；它是 Web 应用，不是 Electron 应用。

**Mac 首次使用请先阅读 [README_MACOS.md](./README_MACOS.md)**，包含双击启动、Chrome 配对和旧电脑学习数据迁移。`Start.command` 可启动本机服务并打开页面；运行时不需要安装 npm 依赖。

## 启动

需要 Node.js 18.19 或更新版本。应用运行本身无第三方运行时依赖：

```bash
cd '/home/galbot/文档/ChatGPT/其他/ielts-vocab-companion'
npm start
```

打开 **http://127.0.0.1:47832**。请固定使用同一个地址；`localhost` 与 `127.0.0.1` 是不同浏览器存储空间。

推荐目录结构：

```text
其他/
  IELTS-practice/           # 原练习项目，不需要修改源码
  ielts-vocab-companion/    # 本项目
```

服务默认仅监听 `127.0.0.1`，不会开放到局域网。可选环境变量：

```bash
PORT=47832 \
IELTS_DATA_DIR="$HOME/.ielts-vocab-companion" \
IELTS_PRACTICE_DIR="/absolute/path/to/IELTS-practice" \
npm start
```

## Chrome 实时同步

不同端口、Chrome 窗口或 Web 应用容器不能直接共享 BroadcastChannel / IndexedDB。推荐使用已实现的本地 HTTP 桥接：

1. 在 Chrome 安装 Tampermonkey，允许其在练习页面运行用户脚本。
2. 启动本项目，打开“设置与备份”，点击“安装 Chrome 桥接 Userscript”，在扩展中确认安装。必须从正在运行的伴侣安装，脚本才包含本机配对令牌。已安装旧脚本时也请重新安装，升级至 2.1.0。
3. 在 Chrome 打开或刷新 IELTS-practice 阅读页面。脚本监听 URL、篇章 DOM 和精读浮层变化，并每 5 秒兜底检查；伴侣每 1.5 秒接收事件。无需修改练习项目源码。
4. 需要收集生词时，同时开启伴侣“监听阅读划词 / 剪贴板导入”和 Userscript 菜单“开启 / 关闭划词及复制捕获”。在阅读原文内单击生词、鼠标划选、Shift 键盘选词或复制英文词句，自动携带所在原句归入对应篇章。
5. 顶部持续显示“已检测到正在练习：[篇章名称]”，并在刷新后恢复。状态栏显示“Chrome 桥接在线”只表示近期收到心跳；篇章下拉列表和“本篇阅读错题”可检查实际内容。

脚本匹配本机 HTTP 页面和 `https://sallowayma-git.github.io/IELTS-practice/*`。如果练习部署在其他域名，需要在已安装脚本中增加对应 `@match`。脚本没有发现阅读容器和有效篇章 ID 时不会上传。

自动识别使用实际 `examId`；能识别剑雅坐标时归一为 `Cam18-T1-P1`。原题库使用 `p1-high-01` 等 ID 时会保留原 ID，不凭空猜测 Book / Test / Passage。可通过脚本菜单手动设置当前页面 ID，跳转到不同 URL 后恢复自动识别。

对应关系来源是 `IELTS-practice/assets/generated/reading-exams/manifest.js` 的 `examId` / `dataKey`，以及阅读页 URL、`body[data-exam-id]` 和 `ReadingVocabReader.currentExamId`。精读浮层优先于底层页面；导入题库按 `[来源 ID, examId]` 生成 `imported_` 前缀的独立 ID，防止两个题库的同名文章混入一本生词本。后台标签页不反复抢占当前篇章，套题提交中的其他篇章仅更新各自结果，不借用当前可见原文。

同步内容包括阅读原文、篇章信息、提交结果中的错题，以及明确授权的划词。错误答案来源于练习项目的 `answerComparison` / 结果表，不根据原文猜答案。脚本识别原项目的会话、篇章切换、普通练习与套题提交消息。

### 篇章词表与同义参考

篇章同步后，“本篇核心词汇 · 同义替换参考”自动加载与当前原文匹配的词。确认收录后才加入生词本，不会自动改变正在背诵或测试的批次；活动批次锁定时，新篇章先进入历史，顶部提示其名称。

原练习项目没有统一的逐篇核心词汇 / 同义替换资产。本项目优先使用 `assets/passage-vocab.json` 中的篇章校对表，目前内置茶叶简史 `p1-high-01` 的 10 个语境词条。其他篇章从实际原文匹配离线雅思词库，明确标记“词典候选义”；通用近义参考也单独标记，不冒充题目答案替换。没有匹配数据时明确显示暂无，不混入其他篇章词表。

可按真实篇章 ID 扩充校对表，只有出现在当前原文中的词才会展示：

```json
{
  "passages": {
    "Cam18-T1-P1": [
      {
        "word": "court",
        "pos": "n.",
        "contextMeaning": "宫廷",
        "synonyms": ["royal household"]
      }
    ]
  },
  "synonyms": {
    "increase": ["rise", "grow"]
  }
}
```

此例仅说明格式，不代表 `Cam18-T1-P1` 原文包含该词。修改表后刷新伴侣；已确认的词义和学习进度不会被候选词覆盖。

同源部署时，应用还监听 `BroadcastChannel('ielts_practice_sync')` 和 localStorage 键 `ielts_practice_sync_event`。其他发送端可发送如下事件：

```js
const event = {
  channel: 'ielts_practice_sync',
  id: crypto.randomUUID(),
  sentAt: Date.now(),
  payload: {
    book: 18, test: 1, passage: 1,
    activeText: 'The royal court imported porcelain.',
    wrongQuestions: [{ id: '7', answer: 'wood', correctAnswer: 'porcelain' }],
    words: [{
      word: 'court', phonetic: '/kɔːt/', pos: 'n.',
      contextMeaning: '宫廷', sentence: 'The royal court imported porcelain.',
      synonyms: ['royal household']
    }]
  }
};
const channel = new BroadcastChannel('ielts_practice_sync');
channel.postMessage(event);
localStorage.setItem('ielts_practice_sync_event', JSON.stringify(event));
```

不要省略稳定的事件 ID；重复投递会按 ID 去重。省略 `wrongQuestions` 保留原错题，明确发送 `[]` 才清空。自动同步关闭时，本地 HTTP 待收队列保留，重新开启后继续处理。脚本的待发送队列保存在当前标签页 sessionStorage，伴侣的待接收队列持久化到磁盘；不要在桥接离线时关闭尚未发送完的源标签页。

不安装脚本也能使用“手动关联篇章”、历史下拉切换及粘贴导入。浏览器禁止网页在后台静默读取整个系统剪贴板，故自动剪贴板读取仅在伴侣前台、获得权限后尝试；拒绝授权后停止轮询，点击“读取剪贴板”可重试。Chrome 后台复制请使用脚本捕获。捕获关闭时不收集阅读划词。

## 背词与测试

1. 点阅读原文中的单词，或粘贴英文原句识别候选词。添加 / 编辑词条时保存该篇中文释义、音标、原句和同义替换。
2. 勾选本篇待学词，点击“背诵选中词”。本批 ID 立即固定，后续收录的单词不会自动加入。
3. 背完点击“测试刚刚学完的这批词”，或直接测试手动勾选词。题干只来自指定篇章 / 批次；释义与选项在测试开始时快照固定。
4. 每题四个中文选项：一个本篇释义、三个去重干扰项。优先顺序为同篇章同词性、同篇章其他词性、全局同词性、全局其他词性；全局池包含已保存词条及离线雅思 / 托福 / CET6 标记词库。词性缩写归一化，释义忽略词性前缀、空白和标点后去重，同拼写词不作干扰项。使用 Fisher-Yates 洗牌，刷新或重渲染不会重新洗牌。有效中文释义不足四个时明确报错，不生成空选项。
5. 答错或“不确定”会立即展示正确释义、高亮原句，并把词追加队尾。再次出现前至少安排两道间隔题；队列不足时仅从本批目标词插入巩固题，不用外部词作题干。若只有一个目标词，或其他目标词也处于错误冷却期，则不可能提供两道其他词题目：此时明确展示不计分的复习间隔页，按 Enter 逐步继续，绝不把它伪装成已完成两道题。
6. 所有待重测词答对后结束。成绩分别显示首答正确率和含重测 / 巩固题正确率，复习间隔页不计入作答次数，不把重测后的全对误报为 100% 首答成绩。错题、冷却间隔、选项与队列均可刷新恢复。

模块入口为 `startQuiz(data, targetWords, allVocabPool)`，`targetWords` 是题干唯一来源，启动时深拷贝并固定快照；`buildQuestion(word, allVocabPool)` 返回 `{ wordId, options, correctIndex }`，词库仅用于干扰项。背诵入口直接传入刚完成批次的单词数组，手动入口只传入勾选单词。

**语境释义边界**：离线 ECDICT 仅提供候选义，不具备自动判定任意熟词僻义的语义模型。源页面已提供的篇章义优先；没有时需要你结合高亮原句确认。“词典候选义”与“已确认篇章义”会明确区分，不会把词典首义伪装成精准语境翻译。

学习状态为 `new | learning | review | mastered`。简化 SM-2 调度：答对熟练度 +1，复习间隔依次为 1 天、3 天、前次间隔乘 ease；连续正确两次标记 mastered。答错熟练度降低、错误次数增加、连续正确计数清零，10 分钟后进入到期复习。学习自评和测试都会更新调度；mastered 表示当前调度状态，不代表永久记住。

### 键盘

| 模式 | 快捷键 |
| --- | --- |
| 背词 | Space 展开 / 收起释义与例句 |
| 背词 | ← 或 1 标记需重背 |
| 背词 | → 或 2 标记记住 |
| 测试 | 1 / 2 / 3 / 4 选择 A / B / C / D |
| 测试 | Enter 进入下一题，须先作答 |

输入框、下拉框、可编辑内容、弹窗、中文输入法组合过程及带 Command / Control / Option 的按键不触发学习快捷键。活动批次会锁定篇章，Chrome 新文章仍入历史，但不会替换正在背诵 / 测试的范围。

## 存储与备份

启动时先读取并校验所有可用副本（包括尚未完成批量保存的恢复日志），优先选择修订号最高的有效记录，再水合 UI。水合期间禁止修改，不以初始空数据自动覆盖旧记录；已恢复的活动批次不再无条件触发初始化写入。

| 层 | 位置 / 用途 |
| --- | --- |
| IndexedDB | `ielts-vocab-companion` 数据库，主存储 |
| localStorage | `ielts_vocab_companion_v2`，镜像及降级 |
| 浏览器恢复日志 | `ielts_vocab_companion_v2_pending`，保护防抖期间尚未镜像的修改 |
| 本地文件 | `~/.ielts-vocab-companion/data.json`，通过 Node 服务原子写入 |
| 桥接日志 | 同目录 `pending-sync.json`，处理成功后确认移除 |
| 配对令牌 | 同目录 `.bridge-token`，不要上传或分享 |

`storageService.js` 提供独立的 `StorageService`，通过 `hydrate()`、`transaction(mutator)`、`flush()`、`exportJSON()`、`restore(data)` 管理状态；`store.js` 保留旧导入兼容。每次变更先同步写入恢复日志，常规 localStorage 镜像、IndexedDB 与本地文件按 300ms 防抖保存，连续操作最长等待 2 秒。恢复日志是防止关闭丢失的必要即时写入，不参与防抖；若它不可写则立即落盘到 IndexedDB，全部不可写时拒绝变更并提示。页面隐藏或关闭时尝试 `flush()`，但不依赖浏览器一定完成异步卸载操作来保障数据。

数据版本为 `schemaVersion: 2`，包含 `passageProgress`、按“篇章:单词”独立存储的 `vocabRecords`、`quizHistory`、可恢复的 `learningSession` / `quizSession`、设置与去重 ID。同一单词在不同文章中可以有不同释义和进度。当前篇章保存在 `settings.activePassageId`；词条保存 `status`（`new` / `learning` / `review` / `mastered`）、`errors`、`lastStudiedAt`（未学习为 0）等。编辑释义不会改变上次学习时间；旧版备份缺失该字段时，已学词以旧 `updatedAt` 作为兼容估计值。

原版 localStorage 键 `ielts_reading_vocab_tasks_v1` 会在同浏览器、同源首次读取时迁移，保留原始键；新版备份和原版任务对象均可导入。“导出学习数据 (JSON) / 导入备份 (JSON)”位于设置中；导出包含最新内存状态，即使镜像写入失败也可备份；导入严格校验并要求确认，恢复是替换而不是合并，并清除导入前尚未落盘的旧批次。

浏览器主存储损坏且没有有效副本时停止写入；磁盘副本损坏时不会静默覆写。出现存储错误请先导出有效浏览器记录，手动保留损坏文件再处理。多标签页写入使用 Web Locks / 修订号冲突检查，旧窗口不会覆盖更新的记录；冲突时刷新旧窗口。

本地文件写入失败不影响已成功写入的浏览器记录，状态栏会提示，不会谎报磁盘备份成功。只有通过 `npm start` 启动才有文件备份与跨端口桥接。

### 纯静态模式

也可在父目录运行：

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

打开 `http://127.0.0.1:8000/ielts-vocab-companion/`。仅提供浏览器持久化、同源消息和手动导入，不提供本地文件镜像 / 跨端口桥接。不要双击 `file://` 页面：ES Modules 和浏览器存储依赖正常 HTTP 源。

## 开发与验证

```bash
npm ci
npm test
npm run test:e2e
```

单元测试覆盖全部保留词库的解析、迁移、复习算法、精准批次、去重四选项、错词闭环、损坏备份保护、IndexedDB 降级 / 冲突、本地服务鉴权 / 队列重启恢复，以及篇章词表、原句定位和被动结果不抢占当前文章。

浏览器测试使用 Playwright 驱动真实 Chrome，默认可执行路径 `/usr/bin/google-chrome`，可按环境指定：

```bash
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run test:e2e
```

测试在临时目录启动随机端口，不读取或覆盖你的正式学习数据；截图输出 `test-results/`。Userscript 测试运行真实脚本并模拟扩展的 GM 网络接口，覆盖实际跨端口 HTTP；不等同于已在你的 macOS / Tampermonkey 安装环境实测。应用端到端流程、320–1280px 布局、暗色和减少动态效果均有自动验证。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `model.js` | 数据模型、迁移、完整性校验、SRS、同步归一化 |
| `storageService.js` | 水合、事务、恢复日志、防抖、IndexedDB / localStorage / 磁盘副本 |
| `store.js` | 旧存储模块名称兼容出口 |
| `quiz.js` | targetWords 固定批次、答题、错题间隔 / 重测、成绩 |
| `quizOptions.js` | buildQuestion、释义与词性归一化、四选项 / Fisher-Yates 洗牌 |
| `bridge.js` | BroadcastChannel、storage、本地 API 收件 / 确认 |
| `bridge.user.js` | Chrome 练习页监测、复制捕获、重试发件箱 |
| `server.mjs` | 本机静态服务、鉴权桥接、原子 JSON 备份 |
| `dictionary.js` | 离线词典查询、形态兜底、干扰项池 |
| `passageVocabulary.js` | 按本篇原文匹配核心词、语境校对义和近义参考 |
| `assets/passage-vocab.json` | 可扩充的逐篇校对词表与明确标记的通用近义参考 |
| `app.js` / `index.html` / `app.css` | 原生 DOM 界面、键盘、设置及响应式布局 |

原有 `assets/wordlists/ecdict_reading.bundle.js` 与 `assets/demo-exams/p1-high-01.js` 保留未改。词库来自 ECDICT，继续保留原文件中的来源 / 许可信息；阅读原文与题库内容的权利归各自权利人。本次重构没有改动相邻 IELTS-practice 仓库或原始 ZIP。
