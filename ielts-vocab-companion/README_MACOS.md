# macOS 使用说明

这是重构后的 IELTS Vocab Companion，适合在 Mac 上与 Chrome 阅读窗口并排使用。

它是“本机 Node.js 服务 + 浏览器界面”，不是签名的 `.app` / `.dmg` 安装器。安装 Node.js 后可以双击启动；运行时不需要 `npm install`，也不需要 Python、Docker 或 Electron。包内是跨平台 JavaScript 源码，不包含 Linux 的 `node_modules` 或可执行程序。

## 1. 第一次准备

1. 解压 ZIP，把整个 `ielts-vocab-companion` 文件夹放到固定位置，例如 `~/Applications/ielts-vocab-companion`。不要只移动 `index.html`，也不要直接在压缩包内运行。
2. 安装 Node.js：访问官方页面 <https://nodejs.org/en/download>，选择 macOS 的 LTS 版本安装。按芯片选择 Apple Silicon / ARM64 或 Intel / x64。程序最低兼容版本是 18.19，但新安装请使用官方仍维护的 LTS，不建议安装已停止维护的 Node.js 18。
3. 安装完成后重新打开“终端”，运行：

```bash
node --version
npm --version
```

两条命令都能输出版本号即可。Node.js 安装是唯一必需的运行环境安装步骤。

## 2. 启动与停止

### 方法 A：双击启动

在 Finder 中双击 `Start.command`。它会检查 Node.js，启动本机服务，并在默认浏览器中打开：

```text
http://127.0.0.1:47832
```

请保留打开的终端窗口。停止服务时，在该窗口按 **Control + C**，不是 Command + C。仅关闭浏览器标签页不会停止服务。

如果脚本提示没有执行权限，在终端输入 `chmod +x `，将 `Start.command` 拖进终端，然后回车。之后再双击。

如果 macOS 阻止双击打开，先确认文件来自你自己打包的程序，可以改用下面的终端启动方式；不需要关闭 Gatekeeper 或全局安全检查。

### 方法 B：终端启动

假设你将程序放到了上述示例目录：

```bash
cd "$HOME/Applications/ielts-vocab-companion"
npm start
```

如果放在其他目录，在终端输入 `cd `，将整个程序文件夹拖进终端，再回车，随后输入 `npm start`。

终端出现 `IELTS Vocab Companion: http://127.0.0.1:47832` 后，在浏览器打开该地址。不要双击 `index.html`，`file://` 模式不能正常运行。

每天使用时只需要启动服务、打开页面，不需要重复安装 Node.js 或依赖。

## 3. 连接 Chrome 中的 IELTS-practice

伴侣和阅读页面必须在**同一台 Mac**上运行；本机桥接不会连接你之前那台电脑的服务。`IELTS-practice` 不包含在本压缩包中：可以继续使用你已有的本地部署，或原来使用的网页部署。

1. 启动伴侣，打开 `http://127.0.0.1:47832`。
2. 在 Chrome 中安装并启用 Tampermonkey 扩展，允许它在你的 IELTS-practice 页面运行用户脚本。
3. 在伴侣页面点击“设置与备份”，点击“安装 Chrome 桥接 Userscript”，在 Tampermonkey 中确认安装。请**从 Mac 上正在运行的伴侣安装**，不要直接导入包内未经配对的 `bridge.user.js`，也不要沿用旧电脑已安装的脚本。
4. 在伴侣中保持“自动接收并追踪阅读篇章”开启，打开或刷新 Chrome 中的 IELTS-practice 阅读页面。
5. 进入一篇文章后，伴侣顶部应显示“已检测到正在练习：[篇章名称]”。如果只有“Chrome 桥接在线”，请同时检查篇章名称和原文是否正确。

脚本默认支持 `http://localhost/*`、`http://127.0.0.1/*` 和 `https://sallowayma-git.github.io/IELTS-practice/*`。如果你的练习运行在其他域名、IP 地址或 HTTPS 本地域名，需要在 Tampermonkey 中编辑脚本的 `@match`，增加实际练习地址。安装后如果扩展提示需要额外用户脚本权限，请按该扩展的提示授权。

### 生词与原句同步

同时开启下面两个开关，才会自动收录：

- 伴侣“设置与备份”中的“监听阅读划词 / 剪贴板导入”。
- Chrome 的 Tampermonkey 脚本菜单中的“开启 / 关闭划词及复制捕获”。

之后在阅读原文内单击英文单词、划选文字或复制英文词句，会携带原句归入对应篇章。没有中文释义的词可以手动补充。需要临时刷新篇章时，使用脚本菜单“立即同步当前篇章”；识别不到 ID 时可用“手动设置当前篇章 ID”。

不同端口通过带本机配对令牌的 HTTP 桥接通信，伴侣约每 1.5 秒接收一次；源页面还有每 5 秒兜底检查。服务中断后会重试，但不要在未发送完成时关闭阅读标签页，源发件箱只保存在该标签页的 sessionStorage 中。

### 篇章 ID 与词表

原题库实际使用 `p1-high-01` 等 `examId`，并非每篇都有 Book / Test / Passage 坐标。程序保留真实 ID，不会把它虚构为某一册剑雅；能够识别的剑雅坐标统一为 `Cam18-T1-P1` 形式。导入题库按来源隔离，避免同名 ID 混入同一本生词本。

同步后自动展示本篇核心词汇与同义参考，不会把所有候选词直接塞进生词本，也不会改变当前背诵 / 测试的固定批次。当前只内置茶叶简史 `p1-high-01` 的 10 个已校对语境词条；其他篇章按原文匹配离线词库，标记为“词典候选义”。通用近义参考不等于题目答案替换，请结合原文确认。

## 4. 如果还需要从本地题库直接读取文章

这是可选能力。Chrome 同步已经携带完整原文，不要求复制整个 IELTS-practice 到伴侣目录。

如果希望伴侣在没有 Chrome 同步时也能按 `examId` 读取本地文章，把两个项目放成同级目录：

```text
Applications/
  IELTS-practice/
    assets/generated/reading-exams/
  ielts-vocab-companion/
    Start.command
    server.mjs
```

如果题库放在其他地方，可以从终端指定：

```bash
cd "$HOME/Applications/ielts-vocab-companion"
IELTS_PRACTICE_DIR="/你的实际路径/IELTS-practice" npm start
```

伴侣只读取该目录的题库资源，不负责启动 IELTS-practice 本身。不提供本地题库时，仍可使用包内茶叶简史示例、Chrome 同步和手动粘贴。

## 5. 背词与测试

1. 确认候选词在当前文章中的中文含义，收录到生词本。
2. 勾选本篇单词，点击“背诵选中词”。
3. 背完后点击“测试刚刚学完的这批词”。题干只来自本批次，自动同步的新词不会混入。
4. 答错或“不确定”会展示正确释义和原句，再排入重测，直到本轮待重测词答对。

| 模式 | 按键 |
| --- | --- |
| 背词 | Space 展开 / 收起释义和原句 |
| 背词 | ← 或 1：需重背；→ 或 2：记住 |
| 测试 | 1 / 2 / 3 / 4：选择四个中文选项 |
| 测试 | Enter：作答后进入下一题 |

在输入框、弹窗或中文输入法组合输入时，不触发这些学习快捷键。可以用 macOS 分屏把伴侣窄窗口放在 Chrome 旁边。

## 6. 把旧电脑的学习记录带到 Mac

程序包**不包含任何个人学习记录或配对令牌**。只复制程序，不会自动迁移浏览器中的进度。

1. 在旧电脑打开伴侣，进入“设置与备份”，点击“导出学习数据 (JSON)”。
2. 将导出的 JSON 与本程序 ZIP 一起传到 Mac。备份包含阅读文本、词条与学习记录，请妥善保管。
3. 在 Mac 启动伴侣，在“设置与备份”中点击“导入备份 (JSON)”，选中该 JSON 并确认。
4. 检查篇章历史、生词数量和学习进度。导入是**替换当前学习数据，不是合并**；Mac 上已有记录时请先导出备份。

Mac 上的存储位置：

- 浏览器：IndexedDB 和 localStorage，按页面地址隔离。
- 本地镜像：`~/.ielts-vocab-companion/data.json`。
- 待接收同步队列：`~/.ielts-vocab-companion/pending-sync.json`。
- 本机配对令牌：`~/.ielts-vocab-companion/.bridge-token`，不要分享或上传。

Finder 中按 **Command + Shift + G**，输入 `~/.ielts-vocab-companion` 可以查看该隐藏目录。日常优先用界面的 JSON 导出 / 导入功能备份和迁移，不要手工覆盖正在运行的服务数据。

请固定使用 `http://127.0.0.1:47832`，不要与 `localhost` 或其他端口混用。即使磁盘镜像可能恢复记录，这些地址仍属于不同的浏览器存储空间。清理浏览器缓存前先导出 JSON。

## 7. 常见问题

### `node: command not found`

安装 Node.js LTS 后重新打开终端。双击脚本会检查常见的官方安装 / Homebrew 路径；如果使用 nvm 等版本管理器，请在已激活 Node.js 的终端中运行 `npm start`。

### `EADDRINUSE` / 端口已被占用

先检查是否已经开过一个伴侣终端窗口。已启动时直接打开网页即可，不需要再次启动。关闭旧实例后重试；不要随意结束不认识的系统进程。

确需更换端口时：

```bash
PORT=47833 bash ./Start.command
```

之后使用新地址，并从新地址重新安装配对脚本。新端口有独立的浏览器存储空间，切换前建议导出备份。

### Chrome 篇章没有同步

检查服务终端是否仍在运行、扩展及脚本是否启用、`@match` 是否覆盖练习地址、伴侣自动同步是否开启。刷新练习页面，必要时使用脚本菜单“立即同步当前篇章”。新 Mac 或重建了 `.bridge-token` 后必须重新安装配对脚本。

### 篇章同步了，但没有捕获生词

确认两个捕获开关都已开启，并在真正的阅读原文区域操作；输入框、按钮和链接不触发点击取词。自动读取系统剪贴板还受浏览器权限和前台焦点限制，Chrome 后台复制请依靠 Userscript 捕获。

### 顶部检测到了新篇章，但词卡仍是旧篇章

当前背诵或测试批次正在锁定范围，属于预期保护。新篇章已存入历史，结束或退出当前批次后再切换。

### 页面空白、模块加载错误或文件丢失

不要使用 `file://`；通过 `Start.command` 或 `npm start` 启动，并保持包内目录结构完整。不要只传输 HTML 或遗漏 `assets`。

### 升级版本

先导出学习 JSON，停止旧服务，再用新程序文件夹启动。正式数据保存在用户目录，通常不会因替换程序而删除；仍建议升级前备份。根据新版本说明更新配对脚本。

## 8. 包内容与验证范围

包内包括程序源码、离线词库、示例文章、篇章词表、启动脚本和测试源码；不包括 Node.js、Tampermonkey、IELTS-practice 完整项目、个人数据、Linux 依赖目录或测试截图。

重构版本已通过 58 项单元测试和 14 项真实 Chrome 端到端流程。打包时还会检查独立解压后的启动与静态资源。当前测试环境是 Linux，尚未在你的 macOS、Finder 和 Tampermonkey 安装环境实际操作，不能视为已经完成 macOS 原生验收。

日常运行不需要安装开发依赖。仅在需要运行测试时执行：

```bash
npm ci
npm test
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run test:e2e
```

端到端完整流程还需要旁边存在 IELTS-practice 源码。程序结构、数据格式与高级配置见 `README.md`。ECDICT 词库来源和 MIT 许可见 `assets/wordlists/ECDICT_LICENSE.txt`；阅读材料权利归原权利人。
