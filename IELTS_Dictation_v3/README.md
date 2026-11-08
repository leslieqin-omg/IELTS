# IELTS Dictation v2

雅思听力词汇听写与复习工具。当前版本只保留听力听写，使用本机 Python 服务和浏览器界面；学习进度存储在 `data/listening.json`，不会依赖云端账号。

## macOS 使用

1. 将 `IELTS_Dictation_v2` 文件夹放在 Mac 本地磁盘，不要只在压缩包预览中运行。
2. 确认 Mac 已安装 Python 3。可在“终端”运行 `python3 --version` 检查。
3. 在 Finder 中双击 `Start.command`。首次运行如果被 macOS 拦截，在“系统设置 → 隐私与安全性”允许打开；也可以在“终端”中运行：

   ```bash
   cd /path/to/IELTS_Dictation_v2
   chmod +x Start.command
   ./Start.command
   ```

4. 程序会启动本机服务并打开浏览器页面 `http://127.0.0.1:8766`。使用期间请保持弹出的终端窗口开启。
5. 退出时切换到该终端窗口按 `Control-C`。学习进度和复习数据保存在项目目录的 `data/listening.json`。

服务默认只监听 `127.0.0.1`，仅允许这台 Mac 本机访问；不提供手机或局域网同步。

如需在终端启动，可运行 `./start.sh`；如端口已被本程序的残留进程占用，可运行 `./start.sh --restart`。默认端口为 `8766`，可通过 `PORT` 环境变量更改。

## 听写与复习

- 从首页开始一轮听写，听英音输入单词并按 Enter 提交；本地 MP3 不存在时浏览器会尝试使用英式英语语音合成。
- 错词会在本轮稍后重新出现，复习状态和进度写入本机数据文件。
- 复习周期为 `[1, 2, 4, 7, 15, 30]` 天，以 Asia/Shanghai 时区的日历日为基准。
- 可在复习设置中调整每轮复习上限和每日新词数。

## 备份

定期复制 `data/listening.json` 到安全位置。退出程序后再复制可避免复制时恰逢写入。导入词库或恢复数据前，建议先另存一份当前文件。

## 词库与音频

项目包含听力词库 `data/listening.json` 与前端资源。可用以下脚本重新导入词汇或下载发音：

```bash
python3 scripts/import_listening.py
python3 scripts/download_audio.py
```

重新导入不会覆盖已有单词的学习进度。

## 开发与测试

项目仅使用 Python 标准库。运行测试：

```bash
python3 -m unittest tests.test_audio_fallback tests.test_scheduling_backlog
```

核心目录：`server.py` 提供本机 HTTP 服务，`core/` 管理词库、拼写判断与复习排程，`static/` 提供界面。
