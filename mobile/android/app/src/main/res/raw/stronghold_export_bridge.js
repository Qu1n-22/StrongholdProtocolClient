// Android WebView does not implement Blob-URL <a download> reliably.
// Intercept only this game's generated JSON exports; the native bridge asks the player
// where to save the file using Android's system document picker.
(() => {
  if (globalThis.__SP_ANDROID_EXPORT_HOOKED__) return;
  if (globalThis.location?.hostname !== 'localhost') return;
  if (!globalThis.StrongholdSaveBridge?.saveJson) return;
  globalThis.__SP_ANDROID_EXPORT_HOOKED__ = true;
  document.addEventListener('click', (event) => {
    const anchor = event.target?.closest?.('a[download]');
    if (!anchor) return;
    const filename = anchor.getAttribute('download') || '';
    if (!/^stronghold-(?:loadout|ownership|diy|stats)-[0-9]{8}-[0-9]{4}\.json$/.test(filename)) return;
    const url = anchor.href;
    if (!url?.startsWith('blob:')) return;
    event.preventDefault();
    // Fetch starts while the Blob URL still exists. The game revokes it shortly
    // after clicking; a started response keeps its own Blob handle.
    fetch(url).then((res) => {
      if (!res.ok) throw new Error('Blob read failed');
      return res.text();
    }).then((content) => {
      if (content.length > 1_000_000) throw new Error('Export is too large');
      globalThis.StrongholdSaveBridge.saveJson(filename, content);
    }).catch((error) => {
      console.error('[android-export] could not open save dialog:', error);
      alert('导出失败：无法读取配置，请尝试复制文本或重试。');
    });
  }, true);
})();
