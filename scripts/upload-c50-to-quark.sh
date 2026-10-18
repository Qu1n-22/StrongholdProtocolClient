#!/usr/bin/env bash
# 把 v0.3.1-c50 的九个形态传到夸克网盘 /GitHub-Releases/lilyco/v0.3.1-c50
#
# 为什么是这个形状：本机到 GitHub 只有 ~180 KB/s（8 线程也一样，是全局限速），
# 而下完 7 GB 再一起传要 10 小时以上。所以改成"下一个传一个"，下完立刻删，
# 磁盘只占一个文件的量，且传完一个就有一个可用（不必等全部）。
#
# 顺序按玩家用量排：Windows 安装版 → 便携版 → Android apk → 其余。
# 断点续传：下载用 curl -C -，上传用 quarkpan 的 -c。

set -uo pipefail

TAG="v0.3.1-c50"
BASE="https://gh-proxy.com/https://github.com/lilyco-42/StrongholdProtocolClient/releases/download/${TAG}"
DIR="/d/_artifacts/c50"
# 前导斜杠会把路径解析器带偏（实测它去建了一个叫 "C:" 的目录），必须写成相对路径
FOLDER="GitHub-Releases/lilyco/${TAG}"
QUARK="/c/Users/liuqi/.local/bin/quarkpan.exe"
LOG="/d/_artifacts/c50/upload.log"

FILES=(
  "StrongholdProtocol-0.3.1-Setup.exe"
  "StrongholdProtocol-0.3.1-portable.exe"
  "Stronghold-0.3.1-c50-android-release.apk"
  "StrongholdProtocol-0.3.1.msi"
  "StrongholdProtocol-desktop-win-0.3.1-c50.zip"
  "StrongholdProtocolTauri-0.3.1-c50-setup.exe"
  "Stronghold-0.3.1-c50-ios-unsigned.ipa"
  "StrongholdProtocol-0.3.1-mac-x64.dmg"
  "StrongholdProtocol-0.3.1-mac-arm64.dmg"
)

mkdir -p "$DIR"
say() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

say "开始：目标 $FOLDER"

for f in "${FILES[@]}"; do
  local_file="${DIR}/${f}"
  say "--- 下载 ${f}"
  for attempt in 1 2 3; do
    # `-C -` 只在文件已存在时才给：对不存在的文件它会立刻失败（实测第一秒就退出）
    if [ -s "$local_file" ]; then R="-C -"; else R=""; fi
    curl -sL $R --max-time 7200 -o "$local_file" "${BASE}/${f}" && break
    say "  下载第 ${attempt} 次没成，10 秒后继续（已下的会续上）"
    sleep 10
  done
  size=$(stat -c%s "$local_file" 2>/dev/null || echo 0)
  if [ "$size" -lt 1000000 ]; then say "  ✗ ${f} 只有 ${size}B，跳过"; continue; fi
  say "  下完 $(( size / 1048576 )) MB，开始上传"
  # file_path 是**位置参数**，这个版本没有 --file（README 里那是 --file，实测报 No such option）
  "$QUARK" upload "$local_file" --folder "$FOLDER" --create-dirs -c >> "$LOG" 2>&1
  if [ $? -eq 0 ]; then
    say "  ✓ ${f} 已上传"
    rm -f "$local_file"
  else
    say "  ✗ ${f} 上传失败（保留本地文件，可手工重传）"
  fi
done

say "全部处理完。核对：quarkpan ls 进 ${FOLDER}"
