#!/usr/bin/env bash
# 把一个 Release 的九个形态传到夸克网盘：GitHub-Releases/lilyco/<tag>
# 用法：`upload-release-to-quark.sh v0.3.1-c51`（文件已在 /d/_artifacts/<tag> 里，用 fetch-release.sh 下）。
#
# 两个实测踩过的坑：
#  1) --folder **不能带前导斜杠**（它会去建一个叫 "C:" 的目录），必须写相对路径。
#  2) 别把 quarkpan 的完整输出重定向到日志：未登录时它一直刷二维码倒计时，两小时能写 40 GB 撑满 D 盘。
#     所以只留最后 4 KB，并且**先跑一次 `quarkpan list-dirs` 扫二维码登录**再来跑这个脚本。
#
# 上传顺序按玩家用量排：Windows 安装版 → 便携版 → Android apk → 其余。
# 传完一个删一个（7 GB 的盘占不起），传失败的文件保留在本地可手工重传。

set -uo pipefail
TAG="${1:-v0.3.1-c51}"
STAMP="${TAG#v}"
DIR="${2:-/d/_artifacts/${STAMP}}"
FOLDER="GitHub-Releases/lilyco/${TAG}"
QUARK="/c/Users/liuqi/.local/bin/quarkpan.exe"
LOG="${DIR}/upload.log"

cd "$DIR" || { echo "没有 ${DIR}（先跑 fetch-release.sh $TAG）" >&2; exit 2; }
[ -s .expected ] || gh release view "$TAG" -R lilyco-42/StrongholdProtocolClient --json assets --jq '.assets[]|"\(.name) \(.size)"' > .expected

say() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

say "开始：${DIR} → ${FOLDER}"

upload_one() { # 文件名
  local f="$1" size
  [ -s "$f" ] || { say "  - ${f} 不在本地，跳过"; return 1; }
  size=$(stat -c%s "$f")
  say "--- 上传 ${f}（$(( size / 1048576 )) MB）"
  # file_path 是**位置参数**（这个版本没有 --file；README 里的 --file 实测报 No such option）
  "$QUARK" upload "$f" --folder "$FOLDER" --create-dirs -c 2>&1 | tail -c 4000 >> "$LOG"
  if [ ${PIPESTATUS[0]} -eq 0 ]; then
    say "  ✓ ${f} 已上传"
    rm -f "$f"
  else
    say "  ✗ ${f} 上传失败（保留本地文件，可手工重传）"
    return 1
  fi
}

# 按玩家用量顺序传
for f in \
  "StrongholdProtocol-0.3.1-Setup.exe" \
  "StrongholdProtocol-0.3.1-portable.exe" \
  "Stronghold-0.3.1-${STAMP}-release.apk" \
  "StrongholdProtocol-0.3.1.msi" \
  "StrongholdProtocol-desktop-win-0.3.1-${STAMP}.zip" \
  "StrongholdProtocolTauri-0.3.1-${STAMP}-setup.exe" \
  "Stronghold-0.3.1-${STAMP}-ios-unsigned.ipa" \
  "StrongholdProtocol-0.3.1-mac-x64.dmg" \
  "StrongholdProtocol-0.3.1-mac-arm64.dmg"; do
  upload_one "$f"
done

# 兜底：.expected 里上述名单没覆盖到的（改名 / 新形态）
while read -r name size; do
  [ -s "$name" ] && upload_one "$name"
done < .expected

say "全部处理完。核对：$QUARK ls 进 ${FOLDER}"
