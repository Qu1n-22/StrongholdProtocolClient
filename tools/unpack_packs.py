#!/usr/bin/env python3
"""把四个 chunked 资源包(essential/fx/voice/skin)解到 payload 目录。

包格式: zip 内 stronghold-resources.json = {files: [{path: 'resources/N', url: '/assets/...'|'/fonts/...', ...}]}
本包无需校验哈希(构建产物由 APK 整体签名兜底), 只做展开。
用法: python3 tools/unpack_packs.py <pack1.zip> [<pack2.zip> ...] --out build/client/www
"""
import json
import os
import sys
import zipfile


def unpack(pack_path: str, out_root: str) -> int:
    z = zipfile.ZipFile(pack_path)
    idx = json.loads(z.read("stronghold-resources.json"))
    n = 0
    for f in idx["files"]:
        url = f["url"]
        if not url.startswith(("/assets/", "/fonts/")):
            continue
        dst = os.path.join(out_root, url.lstrip("/"))
        d = os.path.dirname(dst)
        if d:
            os.makedirs(d, exist_ok=True)
        with z.open(f["path"]) as src, open(dst, "wb") as out:
            while True:
                chunk = src.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
        n += 1
    return n


def main() -> None:
    args = [a for a in sys.argv[1:] if a != "--out"]
    out = "build/client/www"
    if "--out" in sys.argv:
        out = sys.argv[sys.argv.index("--out") + 1]
    total = 0
    for p in args:
        n = unpack(p, out)
        total += n
        print(f"{os.path.basename(p)}: {n} files")
    print(f"total unpacked: {total}")


if __name__ == "__main__":
    main()
