// Inject theme.css into every open Antigravity window over CDP.
//
//   node inject.js           one-shot: inject now, exit (lost on window reload)
//   node inject.js --watch   stay running: re-inject after reloads, new windows
//                            and Antigravity restarts (new port); hot-reloads
//                            theme.css when you save it, and serves the
//                            Settings > General language switch. Stop with remove.js.
const fs = require('fs');
const path = require('path');
const {
  PORT_FILE,
  PID_FILE,
  readPort,
  listPages,
  listTargets,
  browserUserAgent,
  CdpSession,
  buildInjectExpression,
  readCss,
} = require('./cdp');
const {
  LOCALE_BINDING,
  SETTING_BINDING,
  readConfig,
  localeFile,
  setLocale,
  setSetting,
  buildI18nScript,
} = require('./i18n');
const { buildModeScript, chromeOverride, isGeminiWebview } = require('./modes');
const { GEMINI_BINDING, GeminiDock } = require('./gemini-dock');
const { buildTitleScript } = require('./titles');
const { buildProjectHideScript } = require('./projects');

function buildExpression() {
  const config = readConfig();
  return buildInjectExpression(readCss(), buildI18nScript() + '\n' + buildModeScript() + '\n' + buildTitleScript(config) + '\n' + buildProjectHideScript(config), config);
}

function shortTitle(page) {
  const t = page.title || page.url;
  return t.length > 60 ? t.slice(0, 57) + "..." : t;
}

function describe(res) {
  return `主题: ${res.theme}${res.style === 'classic' ? '（经典）' : ''} · 界面语言: ${res.i18n === 'off' ? '英文原版' : res.i18n}`;
}

const WATCH = process.argv.includes('--watch');
const LOG_FILE = path.join(__dirname, 'watch.log');

function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.log(line);
  if (WATCH) {
    try {
      fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
    } catch {}
  }
}

async function injectOnce() {
  const port = readPort();
  if (!port) {
    throw new Error(`未找到调试端口文件，Antigravity 可能未运行: ${PORT_FILE}`);
  }
  let pages;
  try {
    pages = await listPages(port);
  } catch {
    throw new Error(`端口 ${port} 无响应：端口文件可能是上次运行的残留，请先启动 Antigravity`);
  }
  if (pages.length === 0) throw new Error('未找到 Antigravity 窗口页面');

  log(`[+] 调试端口 ${port}，共 ${pages.length} 个窗口`);
  const expr = buildExpression();
  for (const page of pages) {
    const session = await CdpSession.connect(page.webSocketDebuggerUrl);
    try {
      const res = await session.evaluate(expr);
      log(`[✓] ${shortTitle(page)}  (${describe(res)})`);
    } finally {
      session.close();
    }
  }
}

// ---------------------------------------------------------------- watch mode

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
    if (pid && pid !== process.pid && isAlive(pid)) {
      console.error(`[!] 守护进程已在运行 (PID ${pid})。如需重启请先运行 remove.bat`);
      process.exit(1);
    }
  } catch {}
  fs.writeFileSync(PID_FILE, String(process.pid));
  const release = () => {
    try {
      if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
    } catch {}
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.on(sig, () => process.exit(0));
  }
}

// Per-user fonts (LXGW WenKai…) are not always loaded by Windows at sign-in;
// fonts.ps1 loads them into the session. Antigravity only sees fonts that
// were there when it started, so this runs first thing (watcher autostarts
// at sign-in). Async: never delays the injection.
function loadFonts() {
  if (process.platform !== 'win32') return;
  const { execFile } = require('child_process');
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'fonts.ps1')],
    { windowsHide: true, timeout: 30000 },
    (err, stdout) => {
      if (err) return log(`[!] 加载字体失败: ${err.message.split('\n')[0]}`);
      const names = stdout.split(/\r?\n/).filter((l) => l.startsWith('loaded ')).map((l) => l.slice(7));
      if (names.length) log(`[字体] 已加载: ${names.join(', ')}`);
    }
  );
}

async function watch() {
  acquireLock();
  try {
    fs.writeFileSync(LOG_FILE, '');
  } catch {}
  log(`[*] 守护模式启动 (PID ${process.pid})，每 2 秒检查一次窗口`);
  loadFonts();

  // targetId -> { session, scriptId }; a null session marks an attach in flight.
  const attached = new Map();

  // The Gemini window (small floating window, or docked full-size), managed
  // by dock.ps1. Its events are mirrored into every Antigravity window.
  const evalAll = (code) => {
    for (const entry of attached.values()) entry?.session.evaluate(code).catch(() => {});
  };
  const hotkeyStatusExpr = () =>
    `window.__agLangRow && window.__agLangRow.hotkeyStatus && window.__agLangRow.hotkeyStatus(${JSON.stringify(dock.hotkeyStatus)})`;
  const dock = new GeminiDock({
    getConfig: readConfig,
    log,
    onEvent: (name, detail) => {
      if (name === 'closed' || name === 'error') {
        // closed by the user (or failed): back to Antigravity / button off
        evalAll(`window.__agMode && (window.__agMode.setMode('agent', true), window.__agMode.setFloatOpen(false))`);
      } else if (name === 'shown' || name === 'hidden') {
        evalAll(`window.__agMode && window.__agMode.setFloatOpen(${name === 'shown'})`);
      } else if (name === 'colors') {
        // "#LEFT #RIGHT split": Gemini's sidebar / header colors; the title bar
        // follows them in docked mode
        const [left, right, split] = detail.split(' ');
        if (/^#[0-9A-F]{6}$/i.test(left) && /^#[0-9A-F]{6}$/i.test(right)) {
          evalAll(`window.__agMode && window.__agMode.setGeminiColors(${JSON.stringify(left)}, ${JSON.stringify(right)}, ${Number(split) || 0})`);
        }
      } else if (name === 'hotkey-pressed') {
        // docked layout: the global shortcut switches Antigravity <-> Gemini
        evalAll(`window.__agMode && window.__agMode.toggleFromHotkey()`);
      } else if (name.startsWith('hotkey-')) {
        evalAll(hotkeyStatusExpr()); // ok / fail / off, shown in Settings
      }
    },
  });
  process.on('exit', () => dock.stop());
  dock.configure(readConfig()); // registers the global shortcut right away
  let expr = buildExpression();

  async function apply(entry) {
    if (entry.scriptId) {
      await entry.session
        .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.scriptId })
        .catch(() => {});
    }
    // Persists across reloads for as long as this session stays attached.
    const { identifier } = await entry.session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: expr,
    });
    entry.scriptId = identifier;
    const res = await entry.session.evaluate(expr);
    entry.session.evaluate(hotkeyStatusExpr()).catch(() => {});
    return res;
  }

  async function attach(page) {
    attached.set(page.id, null);
    try {
      const session = await CdpSession.connect(page.webSocketDebuggerUrl);
      const entry = { session, scriptId: null };
      attached.set(page.id, entry);
      session.onClose = () => {
        attached.delete(page.id);
        log(`[-] 窗口已关闭: ${shortTitle(page)}`);
      };
      await session.send('Page.enable');
      // Settings > General > Language row calls this binding; we persist the
      // choice in config.json and the folder watcher below re-applies it.
      session.on('Runtime.bindingCalled', ({ name, payload }) => {
        if (name === GEMINI_BINDING) {
          try {
            const { action, top, rect } = JSON.parse(payload);
            dock.send(action, Number(top) || 0, rect);
          } catch {}
          return;
        }
        if (name === SETTING_BINDING) {
          // Settings > General > Gemini rows; validated, then config.json
          // changes and the folder watcher re-applies everything.
          try {
            const { key, value } = JSON.parse(payload);
            if (setSetting(key, value)) log(`[⚙] 设置已更新: ${key} = ${JSON.stringify(value)}`);
            else log(`[!] 忽略无效设置: ${String(key).slice(0, 40)}`);
          } catch {}
          return;
        }
        if (name !== LOCALE_BINDING) return;
        let locale;
        try {
          locale = JSON.parse(payload).locale;
        } catch {
          return;
        }
        if (setLocale(locale)) log(`[⇄] 界面语言切换为: ${locale}`);
        else log(`[!] 忽略未知的界面语言: ${String(locale).slice(0, 40)}`);
      });
      await session.send('Runtime.enable');
      await session.send('Runtime.addBinding', { name: LOCALE_BINDING });
      await session.send('Runtime.addBinding', { name: GEMINI_BINDING });
      await session.send('Runtime.addBinding', { name: SETTING_BINDING });
      const res = await apply(entry);
      log(`[✓] 已注入: ${shortTitle(page)}  (${describe(res)})`);
    } catch (err) {
      const entry = attached.get(page.id);
      if (entry) entry.session.close();
      attached.delete(page.id);
      log(`[!] 注入失败，稍后重试: ${shortTitle(page)} — ${err.message}`);
    }
  }

  let busy = false;
  let lastPort = null;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const port = readPort();
      if (!port) return;
      let pages;
      try {
        pages = await listPages(port);
      } catch {
        return; // Antigravity not running (or port file is stale) — keep waiting.
      }
      if (port !== lastPort) {
        log(`[+] 连接到调试端口 ${port}`);
        lastPort = port;
      }
      await Promise.all(pages.filter((p) => !attached.has(p.id)).map(attach));
      await attachGeminiViews(port);
    } finally {
      busy = false;
    }
  }

  // Gemini webviews: no theme or translation is injected; we only keep a CDP
  // session open that presents the guest as Chrome (UA + client hints), which
  // lasts for as long as the session stays attached.
  const geminiViews = new Map(); // targetId -> CdpSession | null (attaching)
  async function attachGeminiViews(port) {
    let targets;
    try {
      targets = (await listTargets(port)).filter((t) => isGeminiWebview(t) && !geminiViews.has(t.id));
    } catch {
      return;
    }
    for (const t of targets) {
      geminiViews.set(t.id, null);
      try {
        const session = await CdpSession.connect(t.webSocketDebuggerUrl);
        geminiViews.set(t.id, session);
        session.onClose = () => geminiViews.delete(t.id);
        await session.send('Emulation.setUserAgentOverride', chromeOverride(await browserUserAgent(port)));
        log('[✓] Gemini 视窗已接管（以 Chrome 身份访问 Google）');
      } catch (err) {
        geminiViews.get(t.id)?.close();
        geminiViews.delete(t.id);
        log(`[!] Gemini 视窗接管失败，稍后重试: ${err.message}`);
      }
    }
  }

  // Hot-reload theme.css, the locale dictionary and config.json (debounced:
  // editors often write a file twice). Watching the folder rather than each
  // file survives editors that save by replacing the file.
  const watched = () =>
    new Set(['theme.css', 'config.json', path.basename(localeFile(readConfig().locale))]);
  let reloadTimer = null;
  fs.watch(__dirname, (_event, name) => {
    if (!name || !watched().has(name)) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      try {
        expr = buildExpression();
      } catch (err) {
        log(`[!] 读取 ${name} 失败，保持上一版: ${err.message}`);
        return;
      }
      if (name === 'config.json') dock.configure(readConfig()); // layout / shortcut may have changed
      const entries = [...attached.values()].filter(Boolean);
      await Promise.all(entries.map((e) => apply(e).catch(() => {})));
      log(`[↻] ${name} 已更新，重新应用到 ${entries.length} 个窗口`);
    }, 200);
  });

  await tick();
  setInterval(tick, 2000);
}

if (WATCH) {
  watch().catch((err) => {
    log('[!] 守护进程异常退出:', err.message);
    process.exit(1);
  });
} else {
  injectOnce()
    .then(() => console.log('\n[🎉] 主题补丁注入完成（浅色暖纸 / 深色炭黑 随官方设置自动切换）'))
    .catch((err) => {
      console.error('[!] 注入失败:', err.message);
      process.exit(1);
    });
}
