# agent.md — 模块声明：玩家自由匹配 + 去中心化服务

> 这是**单个 AI 工作模块**的自我声明。项目总说明书是仓库根的 `AGENTS.md`，两者不重叠。
> 依据：用户 2026-10-06 指令「有 AI 在开发模块，你要声明自己的工作模块、申请权限、写好 agent.md 和权限区域.md，以免 git 冲突」。

## 0. 身份

| 字段 | 值 | 怎么核对 |
|---|---|---|
| 模块 ID | `p2p-match` | 本目录名 |
| 模块名 | 玩家自由匹配 + 去中心化服务 | — |
| 仓库 | `lilyco-42/StrongholdProtocolClient` | `git remote -v` |
| 工作目录 | `D:\Code\StrongholdProtocolClient` | — |
| 分支 | `feat/p2p-match`（**不直接推 `main`**） | `git branch --show-current` |
| 声明时间 | 2026-10-06 | — |
| 状态 | **已声明 / 未开工** | — |

## 1. 目标与验收

**一句话**：让玩家**不依赖中心房间服务器**也能自动找到彼此并开局。

**现状（已核对）**：房间存在中心服的单进程内存里（`AGENTS.md` §2：「`systemctl restart stronghold` = 杀掉所有进行中的对局」）；
玩家必须知道一个 `wss://<host>/ws` 地址才能进 —— `shell/picker*` 就是选这个地址的 UI。
玩家之间**没有任何互相发现的通道**。

**验收标准（可执行、可证伪）**：

| # | 判据 | 怎么测 |
|---|---|---|
| A1 | 两个客户端在**不填任何服务器地址**的情况下能互相发现 | 启动两个客户端，不碰选择页的地址框，双方出现在同一房间列表 |
| A2 | 中心服**停机**时 A1 仍成立 | `systemctl stop stronghold` 后重跑 A1（本机用 `localhost:3000` 空跑代替） |
| A3 | 匹配过程对现有玩家零影响 | 不填地址时行为与今天完全一致；`npm test` 不低于**开工前实测基线**（见下） |
| A4 | 不引入新的外部依赖到产物 | `node tools/check-payload-offline.mjs <payload>` 仍 0 问题 |

**A3 的基线（2026-10-06 本机实测，不是引用文档）**：

```
npm test                                      → tests 95  / pass 95  / fail 0
SP_GAME_ROOT=D:/Code/Stronghold-Protocol-upstream npm test → tests 113 / pass 113 / fail 0
```

⚠️ 本仓库 `AGENTS.md` §6 记的是「94 项 / 94 过」「111 项 / 111 过」，与本次实测差 **+1 / +2** ——
**说明有别的 AI 在这之后加了测试**。这也正是本模块要做权限声明的原因：
**基线数字会漂，判据只能是「同一时刻我自己跑出来的数」**，不能引用文档里的旧数字。

## 2. 前置证据（不是推测，都是本机实测）

这条路的可行性我已在开工前单独验证过（见 `D:\Code\工程\nat-lab\`、`D:\Code\工程\p2p-netplay-lab\`）：

| 结论 | 证据 |
|---|---|
| 公共信令可达 | Trystero 默认 Nostr 中继 **25/29** 可达，延迟 0.6–1.8s |
| 浏览器端到端可通 | 两个标签页经公共中继互发现 + DataChannel 双向（RTT 2ms）+ 状态同步，**3/3 断言通过**（含截图） |
| 本机 NAT 对 P2P 友好 | `Endpoint-Independent Mapping`（6 个 STUN 交叉验证） |
| 打洞的理论边界 | 对称 NAT 不可打洞（RFC 4787），约 82% 的 NAT 可打 |

## 3. 技术选型（已定，不再重新论证）

**Trystero（MIT，2771★）** 作为去中心化信令与 P2P 传输。理由：不需要任何自建服务器、
浏览器原生（与本仓库的 Chromium 壳天然兼容）、支持 `turnConfig` 接免费 TURN 兜底那 15–25% 打不通的配对。

## 4. 里程碑（由简入繁，每个都能独立验收）

**M1 —— 只做「匹配」，不做「传输」（推荐第一步）** — **✅ 已实现并端到端验证（2026-10-06）**
用去中心化信令替代**选服务器**这一步：玩家开一个 P2P 房间，房间列表里出现彼此和各自的自建服地址。
数据仍走某个玩家的 `wss://`（可用 nat-lab 的洞或 EasyTier 打通）。
- 全部代码在**本仓库的壳里**，`patches/game-client.patch` 不用动
- A1/A2/A3/A4 四项验收都能达成

实测证据（全部本机复跑过，不是引用文档）：

```
test/p2p-rooms.test.js                        14 项全过（纯函数 + vendor 离线闸门）
                                              ⤷ 接进 picker 后是 20 项（+6 项 withDiscovered），见下
两个真实 Chrome 页面，无任何服务器配置：
  T1 互相发现            甲 2 行 / 乙 2 行
  T2 对端地址+归一化      wss://b.example/play/ws → wss://b.example/ws
  T3 WebRTC 对端已连接    peers=1/1，selfId 互异
  T4 无 onJoinError       两页均无
  T5 恰好两行（去重）     甲 2 / 乙 2
npm test：不带 checkout 95→109、带 checkout 112→126，两种模式都恰好 +14，零回归
vendor 的 trystero 0.26.0 过闸门 13 条 OUTBOUND 正则 0 命中（sha256 a7ca3dfd…）
```

**M1 的收尾 —— 接进 `shell/picker.js` 的 UI** — **✅ 代码已写（2026-10-11，在 `feat/p2p-match` 上，未合并）**

在选服页的「多人游戏」页打开 lobby，把听到的 advert 折进服务器列表；玩家不填任何地址也能看到彼此。
实测（`D:/Code/wt-p2p-ui`，工作树，非引用）：

```
node --test                                  tests 196 / pass 195 / fail 0 / skipped 1   （基线 190 / 189 / 0 / 1 → +6）
SP_GAME_ROOT=<game> node --test              tests 217 / pass 217 / fail 0 / skipped 0   （基线 211 / 211 / 0 / 0 → +6）
tools/check-payload-offline.mjs 的 13 条 OUTBOUND 正则跑改动过的三个文件：link.js / rooms.js / picker.js 全部 0 命中
node --check 三个文件：通过
```

⚠️ **仍未验证**：picker UI 的**浏览器端到端**（两个真页面互相发现）没重跑 —— 本机不编译/不运行产物是红线，
M1 收尾的真实验收要么等 owner 在 runner/真机上跑，要么在 `demo/` 页上复验（demo 走的不是 picker 这条路径）。

**M2 —— 房间发现自动化**
M1 之上加「自由匹配」：不是选房间，而是按人数/延迟自动配对。

**M3 —— 端到端 P2P 对局（需拍板，见 §6）**
对局数据本身也走 P2P，彻底不需要任何 `wss://`。

## 5. 对外契约（别的模块可以依赖我什么）

| 我提供 | 形态 | 谁会用 |
|---|---|---|
| `shell/p2p/rooms.js` | 纯函数：advert 的归一化/合并/去重（`makeAdvert` / `mergeAdverts` / `roomKey`），以及把听到的结果折进选服列表的 `withDiscovered(base, discovered, httpOf)`。无 DOM、无 socket、无存储 | `shell/p2p/link.js`、`shell/picker.js` |
| `shell/p2p/link.js` | Trystero 封装：`openLobby()` 返回 `{ publish, state, subscribe, ping, close }`；`DOMESTIC_ICE_SERVERS` 是国内可用的 STUN 默认值 | `shell/picker.js`（唯一订阅者） |
| `globalThis.__SP_P2P__` | 运行期开关，默认 `undefined`（= 功能关闭，行为与今天一致）；`false` 时 `startLobby()` 直接返回 | 全部 |

**我不改的对外行为**：`shell/picker.js` 现有的 `serverList` / `candidateWsUrls` / `probe` / `showPicker` 导出签名一律不动。

## 6. 已知分叉 —— 需要人拍板，我不擅自决定

| 分叉 | 做法 | 代价 |
|---|---|---|
| **M3-甲：壳内起本地服务** | 桌面壳（Node）在 `127.0.0.1:<port>` 起 WS，把对局权威逻辑跑在自己进程里 | 需要游戏仓库 `server/` 的逻辑 —— 那是另一个仓库的代码 |
| **M3-乙：改 `js/net.js` 走 P2P** | 补丁让 net.js 支持 P2P 传输 | 动 `patches/game-client.patch` → **3 文件 7 hunk 的计数会变**，牵连 `test/packaging.test.js` ×2 与 `docs/PACKAGING.md`；且按 `AGENTS.md` §4，游戏行为应提上游 PR |
| **M3-丙：不做** | 停在 M2 | 中心服仍需有人自建，只是不需要玩家手填地址 |

**我的建议**：先做 M1，拿到可验收的「玩家自由匹配」；M3 等 M1 落地、有人拍板后再动。

## 7. 我不做的事（明确的非目标）

- **不改游戏仓库**（`Stronghold-Protocol-upstream` / `lilyco-42/Stronghold-Protocol`）。需要改就走 fork + PR，见 `AGENTS.md` §1。
- **不碰 `patches/game-client.patch`**（M1/M2 阶段）。
- **不碰 CI 闸门**（`.github/workflows/build-clients.yml` 的五道闸门），除非我新增 job 并与人对齐。
- **不动线上**（`game.starst.site` / `sp.lain42.top`）。
- **不引入需要自建服务器的依赖** —— 这是本模块存在的理由。

## 8. 权限

见同目录 [`权限区域.md`](权限区域.md)。
