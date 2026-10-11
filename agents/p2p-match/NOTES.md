# NOTES.md — `p2p-match` 的现场记录

> 按 [`权限区域.md`](权限区域.md) §6 的规程：发现别人的改动碰到我的区域，就记在这里。

## 2026-10-06 —— 发现未推送的并行改动，且正好落在我的协商区

**观察**：本仓库本地 `main` 比 `origin/main` 多一个**未推送**提交：

```
$ git log --oneline origin/main..main
e46b05a picker: 默认网友服 5 → 10 台，播种批次 SEED_VERSION 升到 2

$ git log -1 --format='%an %ad' --date=iso e46b05a
lilyco-42 <251102081+lilyco-42@users.noreply.github.com>  2026-10-06 15:21:03 +0800

$ git show --stat --format='' e46b05a
 shell/picker-core.js      | 21 +++++++++++++++++----
 test/picker-probe.test.js | 17 +++++++++++++++++
```

**影响评估**：

1. **撞区**：`shell/picker-core.js` 是我的协商区（`权限区域.md` §2，标注「尽量不改」）。
   该提交把 `COMMUNITY_SERVERS` 从 5 台改到 10 台并升了 `SEED_VERSION`。
2. **它解释了我观测到的测试数漂移**：本仓库 `AGENTS.md` §6 记的是 94/94、111/111，
   我 2026-10-06 实测是 **95/95、113/113**。差值就是 `test/picker-probe.test.js` 新增的用例。
   → 印证了 `agent.md` §1 A3 的判断：**基线只能现跑，不能引用文档**。
3. **我的处置**：建 `feat/p2p-match` 时最初从**本地 main** 切出，导致该未推送提交被一并推到了
   我的分支上。已用 `git rebase --onto origin/main e46b05a` 把分支重置为**只含我自己的提交**，
   并 `--force-with-lease` 覆盖。本地 `main` 上的 `e46b05a` **原样保留，未做任何改动**。

**对后续实现的约束（我给自己加的）**：

- 我的 P2P 房间发现必须**纯增量**：不得依赖 `COMMUNITY_SERVERS` 的具体条数或 `SEED_VERSION` 的值。
  否则 `e46b05a` 这类改动会让我的代码静默失效。
- `shell/picker-core.js` 的改动权应优先让给这条并行线。我的纯函数一律放 `shell/p2p/rooms.js`。

**留给人的问题**：`e46b05a` 该由谁推送？它现在只存在于这台机器的本地 `main` 上，
任何人在别的机器上 `git push origin main` 都会绕过它。**这是当前最大的一处 git 冲突风险点。**

## 2026-10-11 —— M1 收尾（接进 picker UI）：超出我自己定的 hunk 预算，请 owner 裁决

**做了什么**：`shell/p2p/**` 此前**没有任何调用方**（全仓 grep 只有定义与测试），
所以 M1 停在「可用的模块」。这次把它接进 `shell/picker.js` 的「多人游戏」页。

**自曝的问题**：`权限区域.md` §2 给我自己的预算是 `shell/picker.js` **≤ 3 hunk**，实际是 **6 hunk / +81 行**。

| # | hunk | 能不能省 |
|---|---|---|
| 1 | 状态块（6 个 `let`） | 不能 —— 都是闭包状态 |
| 2 | `publishSelf()` + `startLobby()` 两个函数 | 不能 —— lobby 句柄的所有者是 picker（`link.js` 注明「One subscriber — the picker owns this handle」） |
| 3 | `renderList()` 末尾调 `publishSelf()` | 不能 —— 换选中项走的是 `renderList()` 而非 `loadList()`，不在这里调就永远不重发 advert |
| 4 | `loadList()` 调 `withDiscovered` | 不能 —— 这就是功能本体 |
| 5 | `layout()` 多分支 `void startLobby()` | 不能 —— 按需打开，不能在模块加载时就开 |
| 6 | `destroy()` 里 `void lobby?.close()` | 不能 —— 不关就留一个 relay socket，且自己一直出现在别人列表里 |

4 个调用点在文件里彼此相隔数百行，diff 上下文不重叠 → **不可能并成更少 hunk**。
要压回 3 hunk，唯一出路是把 lobby 生命周期挪进 `shell/p2p/` 的新模块、picker 只做注入，
代价是 `SHELL_FILES` 再多一行（再动一次 🟡 的 `tools/package-client.mjs`）。
**我没有擅自这么做，也没有去改 §2 那个「≤ 3 hunk」的数字** —— 那是 owner 定的预算，不是我事后可以调的。

**顺带修正两处文档与代码不符**（都在我 🟢 的 `agents/p2p-match/**` 里）：

1. `agent.md` §5 契约表原来写 `shell/p2p/link.js` 提供 `openRoom()` / `listRooms()` / `close()`，
   且「谁会用」写的是 `shell/p2p/rooms.js`。**实际相反**：导出的是 `openLobby()`，
   而且 `link.js` 依赖 `rooms.js`（`link.js:14`），不是反过来。已改成实际形态。
2. 同一个表把 `rooms.js` 描述成「房间列表的排序/去重/过滤」。实际还有 `withDiscovered()`（折进选服列表），已补。

**给 owner 的问题**：这 6 hunk 接受，还是要求按上面那条路拆成 3 hunk？PR 里我按「未决」标注。
