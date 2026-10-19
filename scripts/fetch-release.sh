#!/usr/bin/env bash
# 把一个 Release 的九个形态下齐（为上传到夸克做准备）。用法：`fetch-release.sh v0.3.1-c51`。
#
# 三条都是实测踩出来的：
#  1) 传输会**中途静默断开** —— curl 退出码是 0，文件却只有一半。所以不能只跑一次，也不能信退出码，
#     必须**按字节数**核对，不够就 `-C -` 接着下，直到对上为止。
#  2) 每个文件只允许**一个**进程写 —— 之前两个后台任务同时写同一个文件，把它写大了 100~300 MB。
#  3) 别把 quarkpan 的完整输出重定向到日志文件：它刷二维码倒计时，两小时能写 40 GB，把 D 盘撑满。

set -uo pipefail
TAG="${1:-v0.3.1-c51}"
STAMP="${TAG#v}"                       # v0.3.1-c51 → 0.3.1-c51
BASE="https://github.com/lilyco-42/StrongholdProtocolClient/releases/download/${TAG}"
DIR="${2:-/d/_artifacts/${STAMP}}"
REPO="lilyco-42/StrongholdProtocolClient"

mkdir -p "$DIR"
cd "$DIR" || exit 1
gh release view "$TAG" -R "$REPO" --json assets --jq '.assets[]|"\(.name) \(.size)"' > .expected
if [ ! -s .expected ]; then echo "取不到 ${TAG} 的资产清单（Release 还没建好？）" >&2; exit 2; fi

fetch() { # 名字 期望字节
  local name="$1" want="$2" got=0 i
  for i in $(seq 1 40); do
    got=$(stat -c%s "$name" 2>/dev/null || echo 0)
    [ "$got" -ge "$want" ] && return 0
    if [ "$got" -gt 0 ]; then
      curl -sL -C - --max-time 900 -o "$name" "${BASE}/${name}" >/dev/null 2>&1
    else
      curl -sL --max-time 900 -o "$name" "${BASE}/${name}" >/dev/null 2>&1
    fi
    sleep 2
  done
}

while read -r name size; do fetch "$name" "$size" & done < .expected
wait

bad=0
while read -r name size; do
  got=$(stat -c%s "$name" 2>/dev/null || echo 0)
  if [ "$got" -eq "$size" ]; then printf "OK    %-46s %s MB\n" "$name" "$(( size / 1048576 ))"
  else printf "SHORT %-46s %s / %s MB\n" "$name" "$(( got / 1048576 ))" "$(( size / 1048576 ))"; bad=1; fi
done < .expected
exit $bad
