# IELTS Reading Vocab Companion

深度绑定 IELTS-practice（IELTS Atlas）的雅思阅读真题生词伴侣与全真语境检阅系统。

## 🌟 核心理念

拒绝脱离语境死记硬背！本系统构建了 **“做题 → 篇章圈词 → 结合原句英中联想 → 重回篇章全真检阅”** 的四步完整备考闭环：

1. **做题记录同源自动嗅探**：通过 IndexedDB 自动捕获你在 IELTS-practice 刚做完的最新真题（examId、得分、做题时间）。
2. **全真篇章交互圈词**：1:1 原生还原长难句排版，划词即刻检索 20,000+ ECDICT 真题词典，自动截取真题原句存入生词本。
3. **大任务闪卡记忆（英 → 中）**：以一篇完整阅读的全部生词为一个独立攻克大任务，正面展示单词、音标与高亮原句，背面翻转释义，支持键盘 Space / 按钮盲测。
4. **重回原文·篇章挖空全真检阅**：背完所有生词后重回长难句，曾经圈出的陌生词自动变为遮盖掩码，用户通读并在语境中辨识词义，点击揭晓完成大任务。

## 🚀 启动与使用

建议与 IELTS-practice 放在同源本地静态服务器下运行，以自动同步做题记录：

```bash
python3 -m http.server 8000
```

在浏览器中打开：
- 访问主页：[http://localhost:8000/ielts-vocab-companion/](http://localhost:8000/ielts-vocab-companion/)
- 也可双击本地 `index.html` 体验样例真题（《A Brief History of Tea 茶叶简史》）。
