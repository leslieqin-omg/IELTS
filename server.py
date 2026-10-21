#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
IELTS Dictation Server Launcher
允许直接在根目录运行: python3 server.py
"""
import os
import sys

base_dir = os.path.dirname(os.path.abspath(__file__))
dictation_dir = os.path.join(base_dir, "IELTS_Dictation")
sys.path.insert(0, dictation_dir)

if __name__ == "__main__":
    import server
    server.run_server()

