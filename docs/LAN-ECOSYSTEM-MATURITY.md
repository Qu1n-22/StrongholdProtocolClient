# LAN-ECOSYSTEM-MATURITY.md — 「EasyTier 虚拟局域网联机」在《我的世界》生态的成熟度

> 调研时间：2026-10-20 ｜ 方法：`gh api` 取仓库实数据 + HMCL 官方文档 + 社区评测文章
> 目的：判断我们客户端（`docs/FREE-LAN.md`）选的 EasyTier 方案，在 MC 圈是否已被验证到"可以放心用"的程度。

---

## 0. 一句话结论

**成熟度高，已从"个人工具"走到"主流启动器内置功能"。**
国内两个最大的第三方 MC 启动器 —— **HMCL（10.4k★，12 年历史）** 的官方「陶瓦联机（Terracotta）」和 **PCL2 的「联机回归」** —— 都是**基于 EasyTier** 做的；并且 HMCL 与 PCL CE 之间已通过 **Scaffolding 协议**实现互通。这不是"有人试过"，而是"装机量以百万计的默认路径"。

---

## 1. 先例清单（实测数据）

| 项目 | ★ | 语言 | 许可 | 最近推送 | 在我们这条链路里的角色 |
|---|---:|---|---|---|---|
| [EasyTier/EasyTier](https://github.com/EasyTier/EasyTier) | 14,172 | Rust | LGPL-3.0 | 2026-10-18 | **网络内核**（mesh VPN / P2P 打洞 + 中继） |
| [HMCL-dev/HMCL](https://github.com/HMCL-dev/HMCL) | 10,421 | Java | GPL-3.0 | 2026-10-20 | 主流启动器；官方内置「陶瓦联机」 |
| [burningtnt/Terracotta](https://github.com/burningtnt/Terracotta) | 227 | **Rust** | **AGPL-3.0** | 2026-10-18 | **与我们最像的参考实现**：房间码 + Scaffolding 协议 + 内嵌 EasyTier |
| [pmh1314520/MCTier](https://github.com/pmh1314520/MCTier) | 1,088 | TypeScript | 自定义 | 2026-10-13 | 游戏无关的 VLAN 工具（"兼容所有局域网游戏"） |
| [EasyTier/EasytierGame](https://github.com/EasyTier/EasytierGame) | 326 | Vue | Apache-2.0 | 2026-05-14 | 简易联机 UI，可抄交互 |
| Terracotta-server（社区实现） | — | Rust | AGPL-3.0 | — | 命令行专服版，**编译期用 `include_bytes!` 内嵌 EasyTier** |

---

## 2. 成熟度证据

### 2.1 被主流启动器采纳（最强信号）
HMCL 官方文档原话（[HMCL Docs · 多人联机](https://git.hmcl.net/huanghongxun/HMCL-docs/src/commit/36e4fb4e7638144296356f5a9293ad364a93258b/_multiplayer/help.md)）：

> "我们注意到了 EasyTier 项目。它提供了一种简单、安全、去中心化的异地组网方案，**足以承载 Minecraft 的联机需求**。在 EasyTier 开发团队的帮助下，我们决定重新在启动器内提供联机服务。"

- HMCL **3.7.0.300+** 起，左下角「多人联机」即可用陶瓦联机。
- **HMCL 与 PCL CE 已实现基本互通**（Scaffolding 协议）。
- 同一文档也坦白了边界："陶瓦联机不会比市面上基于服务器中继的联机方案稳定，但其开销将远远低于其他联机方案"，且"**不会更不能取代 Minecraft 服务器**"。

### 2.2 有独立的 Rust 参考实现
`burningtnt/Terracotta`（Rust，AGPL-3.0，活跃到 2026-10）不是简单的"包一个 EasyTier"，它定义了：
- **房间码**（`U/XXXX-XXXX-XXXX-XXXX`，base-34 编码）
- **Scaffolding 协议**（玩家追踪 / Ping / 身份交换）
- 与 HMCL、PCL 客户端互通

这几乎就是我们 `lan.rs` 想做的事的"完整版"。可以当架构参考（注意 AGPL：**抄代码会传染，抄协议/思路不会**）。

### 2.3 生态里已有"内嵌 EasyTier"的工程化范例
社区 `Terracotta-server` 用 Rust 把 EasyTier 二进制 **LZMA2 + BCJ 压缩后 `include_bytes!` 内嵌**，运行时释放到临时目录再拉起，做到"单文件、无外部依赖"。这验证了"把 EasyTier 当 sidecar 打包"是成熟做法（我们用的是 Tauri `externalBin`，同一思路）。

### 2.4 社区工具层也成形
`MCTier`（1,088★，TS）主打"兼容所有局域网游戏"，`EasytierGame`（326★，Vue）提供联机 UI —— 说明"EasyTier + 房间 UI"这个产品形态在**非 MC 游戏**里也被复制过。

---

## 3. 已知坑（文档不会写的）

1. **公共中继节点被打爆**：EasyTier 官方公共节点在 MC 社区大规模使用后过载，上游 issue **#1566** 明确要求游戏社区别过度混用共享节点。→ **必须自建中继**（我们已经在 `sp.lain42.top:11010` 自建，方向正确）。
2. **双 NAT / 校园网 / 运营商 CGNAT**：P2P 打洞成功率显著下降，必然退化到中继；中继带宽与延迟决定体验。
3. **P2P 不是专服**：HMCL 自己都说"不替代服务器"。房间列表/发现、权限、反作弊这些仍然要游戏侧自己解决。
4. **协议互通有门槛**：想和 HMCL/PCL 互认房间，需要实现 Scaffolding 协议；不实现就只能各自成网。
5. **许可证**：EasyTier 是 **LGPL-3.0**（sidecar 独立进程可规避静态链接传染）；Terracotta 是 **AGPL-3.0**（直接改它的代码并分发，义务更重）。

---

## 4. 对我们（卫戍协议）的启示

| 维度 | MC 圈现状 | 我们已有 | 差距 / 可借鉴 |
|---|---|---|---|
| 网络内核 | EasyTier | ✅ 同款（v2.6.4 sidecar） | 版本跟进即可 |
| 中继 | 自建 + 公共兜底 | ✅ 自建 `sp.lain42.top:11010` | **建议加第二节点**（冗余） |
| 房间发现 | Scaffolding + 房间码 / 启动器内置 | ⚠️ 有目录服务，但 c51 的 `directoryUrl` 为空（已修，c52 起生效） | 可参考"房间码"降低跨启动器摩擦 |
| 打包 | Tauri extraResources / include_bytes | ✅ Tauri `externalBin` | 已验证 |
| 小白体验 | 启动器里点一下 | ✅ 选服页一张卡 | 与 MC 圈同水平 |

**结论**：我们不是在"无人之境"，而是在一条**已被 HMCL/PCL2 验证过的成熟路径**上，且实现深度（sidecar + 自建中继 + 目录 + 状态机 + 管理员权限提示）与社区最佳实践一致。

---

## 5. 建议的下一步（按 ROI 排序）

1. **多中继冗余**：在第二台机器起 `easytier-core`（同一 `networkName/secret`），`SP_LAN_PEERS` 追加；新构建生效。
2. **房间码/Scaffolding 风格的发现**（可选）：让玩家不依赖"目录服务 URL"也能互连；对小白最友好。
3. **版本跟进**：EasyTier 上游活跃（14k★，2026-10 仍在推），定期跟 v2.6.x 的修复。

---

## 6. 来源

- HMCL 官方文档（陶瓦联机）：https://git.hmcl.net/huanghongxun/HMCL-docs/src/commit/36e4fb4e7638144296356f5a9293ad364a93258b/_multiplayer/help.md
- HMCL 官网（12 年 / 110+ 贡献者 / GPLv3）：https://hmcl.huangyuhui.net/
- Terracotta 仓库（Rust / AGPL-3.0 / 227★）：https://github.com/burningtnt/Terracotta
- EasyTier 仓库（Rust / LGPL-3.0 / 14,172★）：https://github.com/EasyTier/EasyTier
- MCTier（1,088★）：https://github.com/pmh1314520/MCTier
- EasytierGame（326★ / Apache-2.0）：https://github.com/EasyTier/EasytierGame
- Terracotta-server（内嵌 EasyTier 的工程范例）：https://onlybits.org/BeiChenStanly/Terracotta-server
- 社区评测（HMCL 陶瓦 / PCL2 联机回归均基于 EasyTier）：https://www.mczfw.com/blog/15875.html
- 本项目实现：`docs/FREE-LAN.md`、`tauri/src-tauri/src/lan.rs`
