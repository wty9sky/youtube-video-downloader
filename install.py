#!/usr/bin/env python3
import argparse
import json
import re
import shlex
import shutil
import sys
from pathlib import Path

from host.host import HOST

BROWSERS = {"chrome": Path("Google/Chrome"), "edge": Path("Microsoft Edge")}
SUPPORT = Path.home() / "Library" / "Application Support"
HOST_DIR = SUPPORT / "YouTube Video Downloader"
SOURCE = Path(__file__).resolve().parent


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="注册 YouTube 视频下载扩展的本机组件")
    parser.add_argument("browser", choices=BROWSERS)
    parser.add_argument("extension_id", help="浏览器扩展管理页显示的 32 位 ID")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("此安装程序适用于 macOS。")
    if not re.fullmatch(r"[a-p]{32}", args.extension_id):
        parser.error("扩展 ID 应为 32 个 a–p 字母，请从浏览器扩展管理页复制。")

    config = {name: shutil.which(name) for name in ("yt-dlp", "ffmpeg", "deno")}
    missing = [name for name, path in config.items() if not path]
    if missing:
        parser.error("缺少 " + "、".join(missing) + "。请运行 brew install yt-dlp ffmpeg deno。")
    config = {name: str(Path(path).absolute()) for name, path in config.items()}

    HOST_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SOURCE / "host" / "host.py", HOST_DIR / "host.py")
    write_json(HOST_DIR / "config.json", config)
    launcher = HOST_DIR / "launch"
    command = shlex.join([sys.executable, str(HOST_DIR / "host.py")])
    launcher.write_text("#!/bin/sh\nexec " + command + ' "$@"\n', encoding="utf-8")
    launcher.chmod(0o700)
    manifest = SUPPORT / BROWSERS[args.browser] / "NativeMessagingHosts" / (HOST + ".json")
    write_json(manifest, {
        "name": HOST,
        "description": "YouTube video downloader native host",
        "path": str(launcher),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{args.extension_id}/"],
    })
    print(f"已注册 {args.browser} 的本机组件。现在可以打开扩展下载视频。")


if __name__ == "__main__":
    main()
