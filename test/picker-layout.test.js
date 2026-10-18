// 选择器（shell/picker.js）的布局规则。这里测的是一条**布局约束**，而不是像素：
//
// `.sp-pick` 是 `overflow:auto` 的滚动容器，同时又是 flex 容器 —— 这两件事凑在一起时，如果还做垂直居中
// （`align-items:center`），**溢出到起始边（上方）的内容永远滚不到**。服务器列表一长，最上面几条就永久看不见，
// 玩家只能"删掉底下的才看得到上面的"（issue #22 的原话）。
//
// 这种坏法是纯 CSS 的、没有异常、没有日志，只能靠钉住源码里的那两行。所以这条测试读的是 picker.js 里那段
// 内联 CSS 本身，而不是渲染结果。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'shell', 'picker.js'), 'utf8');

/** 取出 `选择器{ … }` 这条规则（字面查找，不拼正则：这两条规则里没有嵌套，第一个 } 就是结尾）。 */
function rule(selector) {
  const at = SOURCE.indexOf(`${selector}{`);
  if (at < 0) return '';
  const open = SOURCE.indexOf('{', at);
  const close = SOURCE.indexOf('}', open);
  if (close < 0) return '';
  return SOURCE.slice(open + 1, close);
}

function declarations(body) {
  const out = {};
  for (const part of body.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

test('滚动遮罩层不做垂直居中 —— 否则溢出到上方的那部分永远滚不到', () => {
  const overlay = rule('.sp-pick');
  assert.ok(overlay, '没找到 .sp-pick 规则（选择器改名了就把这条测试一起改）');
  const d = declarations(overlay);
  assert.equal(d['overflow'], 'auto', '这一层必须还是滚动容器');
  assert.equal(d['align-items'], 'flex-start',
    'align-items 必须是 flex-start：center + overflow:auto 会让顶部内容不可达（issue #22）');
});

test('居中交给盒子自己的 auto 外边距：有空间时居中，没空间时能滚到顶', () => {
  const box = rule('.sp-pick__box');
  assert.ok(box, '没找到 .sp-pick__box 规则');
  const d = declarations(box);
  assert.match(String(d.margin || ''), /auto/,
    '盒子要有 auto 外边距，否则去掉 align-items:center 之后就变成永远贴顶、不再居中');
});

test('矮屏那档不能把 align-items 改回 center（它只是缩小间距，不是换布局）', () => {
  const media = /@media[^{]*\{([\s\S]*?)\n\}/.exec(SOURCE);
  if (!media) return; // 没有媒体查询就不必管
  assert.ok(!/\.sp-pick\{[^}]*align-items:\s*center/.test(media[1]),
    '媒体查询里也不能把 .sp-pick 改回 center');
});
