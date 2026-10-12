# Android 配置导出（WebView Blob 下载）

在 Android 原生客户端里，网页使用 `URL.createObjectURL(new Blob(...))` 和
`<a download>` 下载调配 JSON。Android WebView 不保证执行这种 Blob URL 下载；
因此旧版本可能点击后完全没有文件，也不会有明确错误。

本仓库的原生壳在本地游戏 `https://localhost` 的页面加载完成后，注入
`mobile/android/app/src/main/res/raw/stronghold_export_bridge.js`，只拦截游戏
生成的 `stronghold-(loadout|ownership|diy|stats)-日期-时间.json` 文件。
JS 读取 Blob 文本后通过最小权限的 `StrongholdSaveBridge.saveJson` 接口交给
Android `ACTION_CREATE_DOCUMENT`，由系统弹出文件选择器。**保存到哪里由玩家决定**；
选「下载」目录会出现在下载目录，选别处就在所选位置。取消对话框不改游戏里的设置。

原生桥只接受限定名称和不大于 1,000,000 字符的 JSON 文本，
不读取目录、不传入路径、不申请宽泛存储权限。没有原生桥的网页版维持原先的下载行为。

验证：

```bash
node --test test/android-export.test.js
npm test
```

其中 JavaScript 行为由 Node 测试覆盖。原生文件选择器、系统文档提供器与
签名 APK 必须在 GitHub Actions 打包后由 Android 真机确认；单测通过不代表真机通过。

手动验收：进入「干员调配 → 导出」，选择「下载文件」，选择系统「下载」目录并保存。
确认出现 `stronghold-loadout-*.json`，随后再从该文件导入并确认干员皮肤、
潜能与调配仍完整；取消文件选择器不能影响当前设置，网页版行为不能回归。
