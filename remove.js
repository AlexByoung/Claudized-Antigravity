// Undo the patch: stop the --watch daemon (if any), then strip the injected
// <style> and marker attributes from every open Antigravity window.
const fs = require('fs');
const { PID_FILE, readPort, listPages, CdpSession, REMOVE_EXPRESSION } = require('./cdp');
const { readConfig } = require('./i18n');
const { closeGeminiWindow } = require('./gemini-dock');

function stopWatcher() {
  let pid;
  try {
    pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
  } catch {
    return;
  }
  try {
    process.kill(pid);
    console.log(`[✓] 已停止守护进程 (PID ${pid})`);
  } catch {}
  try {
    fs.unlinkSync(PID_FILE);
  } catch {}
}

async function remove() {
  // Stop the daemon first, otherwise it would re-inject on the next reload.
  stopWatcher();

  // Close the docked Gemini (Edge) window gracefully, so Edge saves its
  // profile; the Google login stays for next time. --keep-gemini skips this
  // (useful when only restarting the watcher).
  if (!process.argv.includes('--keep-gemini') && closeGeminiWindow(readConfig())) {
    console.log('[✓] 已关闭 Gemini 窗口（登录状态保留在独立配置中）');
  }

  const port = readPort();
  let pages;
  try {
    pages = port ? await listPages(port) : [];
  } catch {
    pages = [];
  }
  if (pages.length === 0) {
    console.log('[i] Antigravity 未运行：样式只存在于运行时，重启后本就不会保留。');
    return;
  }

  for (const page of pages) {
    const session = await CdpSession.connect(page.webSocketDebuggerUrl);
    try {
      const res = await session.evaluate(REMOVE_EXPRESSION);
      console.log(`[✓] ${page.title}  (移除 ${res.removed} 个样式节点)`);
    } finally {
      session.close();
    }
  }
}

remove()
  .then(() => console.log('\n[✓] 已撤销 Antigravity 界面补丁，恢复原生状态。'))
  .catch((err) => {
    console.error('[!] 撤销失败:', err.message);
    process.exit(1);
  });
