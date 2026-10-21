#!/bin/bash
# 雅思单词听写打字系统一键启动脚本
cd "$(dirname "$0")"
python3 IELTS_Dictation/server.py --restart

