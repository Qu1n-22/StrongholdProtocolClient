#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把某一刀的 payload 清单变成**频道指针**（`stable.json`）—— 客户端靠它知道最新是哪一份。

为什么要有这个文件：清单与代码增量的名字都带版本号（`sp-client-manifest-v0.3.0-c46.json`、
`sp-client-code-v0.3.0-c46.tar.gz`），**没有一个固定的「最新」URL**，客户端没法猜。
指针的职责就是变 —— 这与「绝不覆盖玩家手里的永久下载 URL」不冲突：被覆盖的只有这一个
几 KB 的指针，而真正的包仍按版本命名、永久不变（docs/AUTO-UPDATE.md §3）。

指针自己带 `schema`：客户端不认的版本一律不应用，宁可不更（文档 §2/§4 那条「不挡启动、
失败退回内置那份」的底线）。

用法：
    make-stable-pointer.py --manifest sp-client-manifest-v0.3.0-c46.json \
        --out stable.json \
        --base https://lain42.top/downloads/stronghold/v0.3.0-c46 \
        --fallback https://github.com/OWNER/REPO/releases/download/payload-v0.3.0-c46
"""

import argparse
import datetime
import json
import sys

POINTER_SCHEMA = 1


def build_pointer(manifest, base, fallback, channel='stable', updated_at=None):
    """把一份清单变成指针。清单里缺关键字段就抛错 —— 一个含糊的指针比没有指针更糟：
    客户端会照着它去取一个并不存在的包。"""
    for key in ('code', 'art'):
        if not isinstance(manifest.get(key), dict):
            raise ValueError(f'清单缺 {key} 字段（或不是对象）：无法生成指针')
    code = manifest['code']
    for key in ('file', 'sha256', 'bytes'):
        if key not in code:
            raise ValueError(f'清单的 code 缺 {key}：客户端要先验 sha256 再解包，没有它没法验')

    ver = str(manifest.get('version') or '')
    cut = str(manifest.get('cut') or '')
    return {
        'schema': POINTER_SCHEMA,
        'channel': channel,
        'cut': cut,
        'version': ver,
        'game': manifest.get('game'),
        'updatedAt': updated_at or datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        # 主源是国内的 lain42.top（大陆连 GitHub 时好时坏，文档 §4 记过实测 ECONNRESET），
        # 取不到时客户端退回 GitHub。两份指向的是同一批字节，sha256 相同。
        'base': base.rstrip('/'),
        'manifest': str(code.get('file') or '').replace('sp-client-code-', 'sp-client-manifest-').replace('.tar.gz', '.json'),
        'code': {
            'file': code['file'],
            'sha256': code['sha256'],
            'bytes': code['bytes'],
            'files': code.get('files'),
        },
        'art': {
            'digest': manifest['art'].get('digest'),
            'files': manifest['art'].get('files'),
            'bytes': manifest['art'].get('bytes'),
        },
        'artFrom': manifest.get('artFrom'),
        'minShell': manifest.get('minShell', 1),
        'fallbackBase': fallback.rstrip('/') if fallback else '',
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description='把 payload 清单变成频道指针 stable.json')
    ap.add_argument('--manifest', required=True, help='sp-client-manifest-<版本>.json 的路径')
    ap.add_argument('--out', required=True, help='指针文件输出路径')
    ap.add_argument('--base', required=True, help='这一刀的下载根地址（国内主源）')
    ap.add_argument('--fallback', default='', help='备用下载根地址（取不到主源时用）')
    ap.add_argument('--channel', default='stable', help='频道名：stable / canary')
    ap.add_argument('--updated-at', default=None, help='覆盖时间戳（测试用，默认取当前 UTC）')
    args = ap.parse_args(argv)

    with open(args.manifest, encoding='utf-8') as f:
        manifest = json.load(f)

    pointer = build_pointer(
        manifest,
        base=args.base,
        fallback=args.fallback,
        channel=args.channel,
        updated_at=args.updated_at,
    )
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(pointer, f, ensure_ascii=False, indent=2)
        f.write('\n')

    print(f"指针 {args.out}: channel={pointer['channel']} version={pointer['version']} "
          f"code={pointer['code']['file']} ({pointer['code']['bytes']} B) base={pointer['base']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
