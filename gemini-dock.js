// Watcher-side manager for the Gemini helper: dock.ps1 on Windows (docks an
// Edge app window, dedicated profile, into Antigravity), dock-mac.swift on
// macOS (a WebKit panel). Both speak the same stdin/stdout protocol; see
// dock.ps1 for the how.
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_MAC = process.platform === 'darwin';
const DOCK_SCRIPT = path.join(__dirname, 'dock.ps1');
const MAC_SOURCE = path.join(__dirname, 'dock-mac.swift');
const MAC_HELPER = path.join(__dirname, '.build', 'gemini-dock');
const PROFILE_DIR = path.join(process.env.LOCALAPPDATA || '', 'AntigravityPatch', 'EdgeGemini');
const GEMINI_BINDING = '__agPatchGemini';
const DEFAULT_HOTKEY = 'Ctrl+Alt+G';

// "Ctrl+Alt+G" -> { mods, vk } for RegisterHotKey, or null if invalid.
// At least one modifier is required, so a plain key is never taken globally.
// Cmd (macOS) and Win are the same bit.
const MODS = { Ctrl: 2, Alt: 1, Shift: 4, Win: 8, Cmd: 8 };
function parseHotkey(text) {
  if (typeof text !== 'string' || !text) return null;
  const parts = text.split('+');
  const key = parts.pop();
  let mods = 0;
  for (const p of parts) {
    if (!MODS[p] || mods & MODS[p]) return null;
    mods |= MODS[p];
  }
  if (!mods) return null;
  let vk = 0;
  if (/^[A-Z0-9]$/.test(key)) vk = key.charCodeAt(0);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) vk = 0x6f + Number(key.slice(1));
  else vk = { Space: 0x20, '`': 0xc0, Enter: 0x0d, Tab: 0x09, '/': 0xbf, ';': 0xba, ',': 0xbc, '.': 0xbe }[key] || 0;
  return vk ? { mods, vk } : null;
}

function findEdge(config = {}) {
  const candidates = [
    config.edgePath,
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// macOS: the compiled dock-mac.swift, rebuilt when the source is newer.
// Needs the Xcode Command Line Tools (xcode-select --install) for swiftc.
function macHelper(log) {
  try {
    const built = fs.existsSync(MAC_HELPER) && fs.statSync(MAC_HELPER).mtimeMs >= fs.statSync(MAC_SOURCE).mtimeMs;
    if (!built) {
      fs.mkdirSync(path.dirname(MAC_HELPER), { recursive: true });
      log && log('[Gemini] 正在编译 macOS 小窗程序（首次约 20 秒）…');
      execFileSync('xcrun', ['swiftc', '-O', '-o', MAC_HELPER, MAC_SOURCE], { stdio: 'pipe', timeout: 300000 });
    }
    return MAC_HELPER;
  } catch (err) {
    log && log(`[!] 编译 Gemini 小窗失败（需要 Xcode 命令行工具：xcode-select --install）: ${String(err.stderr || err.message).trim().split('\n')[0]}`);
    return null;
  }
}

function helperArgs(edge, url, extra = []) {
  return [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DOCK_SCRIPT,
    '-EdgePath', edge, '-ProfileDir', PROFILE_DIR, '-Url', url, ...extra,
  ];
}

class GeminiDock {
  // onEvent(name, detail) receives the helper's events: shown | hidden | closed | error
  constructor({ getConfig, log, onEvent }) {
    this.getConfig = getConfig;
    this.log = log;
    this.onEvent = onEvent;
    this.child = null;
    this.hotkeyStatus = 'off'; // ok | fail | off (last reported by the helper)
  }

  // Apply config.json: start the helper right away (so the global shortcut
  // works before Gemini was ever opened) and send layout + shortcut.
  configure(config) {
    if (config.geminiMode === false || config.geminiEngine === 'webview') {
      if (this.child) this.child.stdin.write('hotkey 0 0\n');
      return;
    }
    const fresh = !this.child;
    if (this.start() && !fresh) this.sendConfig(config); // a fresh one got it in start()
  }

  // macOS: the helper has no way to find Antigravity's window by itself, so
  // the page reports it: [screenX, screenY, outerWidth, outerHeight, innerHeight, dpr]
  sendFrame(win) {
    if (!IS_MAC || !this.child || !Array.isArray(win) || win.length !== 6 || !win.every(Number.isFinite)) return;
    this.child.stdin.write(`frame ${win.map((v) => Math.round(v * 100) / 100).join(' ')}\n`);
  }

  sendConfig(config) {
    const layout = config.geminiLayout === 'docked' ? 'docked' : 'float';
    const hk = parseHotkey(config.geminiHotkey === undefined ? DEFAULT_HOTKEY : config.geminiHotkey);
    this.child.stdin.write(`layout ${layout}\n`);
    this.child.stdin.write(hk ? `hotkey ${hk.mods} ${hk.vk}\n` : 'hotkey 0 0\n');
  }

  start() {
    if (this.child) return true;
    const config = this.getConfig();
    if (IS_MAC) return this.startMac(config);
    const edge = findEdge(config);
    if (!edge) {
      this.log('[!] 未找到 Microsoft Edge，无法打开 Gemini 窗口（可在 config.json 设置 edgePath）');
      this.onEvent('error', 'edge-not-found');
      return false;
    }
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    const args = helperArgs(edge, config.geminiUrl || 'https://gemini.google.com/app', ['-ParentPid', String(process.pid)]);
    // Started through cmd.exe on purpose: Node puts its children in a
    // kill-on-close job, so a killed watcher would take the helper down before
    // it could hide Gemini. That job lets grandchildren break away silently,
    // so the helper (a grandchild) survives, sees the watcher is gone, hides
    // Gemini and exits. cmd passes the stdio pipes straight through.
    const quote = (s) => (/[\s()&^]/.test(s) ? `"${s}"` : s);
    const commandLine = `/d /s /c "powershell.exe ${args.map(quote).join(' ')}"`;
    const child = spawn('cmd.exe', [commandLine], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    this.child = child;
    this.listen(child);
    // A (re)started helper knows nothing yet: give it layout + shortcut first.
    this.sendConfig(config);
    return true;
  }

  startMac(config) {
    const helper = macHelper(this.log);
    if (!helper) {
      this.onEvent('error', 'helper-build-failed');
      return false;
    }
    const url = config.geminiUrl || 'https://gemini.google.com/app';
    const child = spawn(helper, ['-Url', url, '-ParentPid', String(process.pid)], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.listen(child);
    this.sendConfig(config);
    return true;
  }

  listen(child) {
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const [name, ...rest] = line.split(' ');
        if (name.startsWith('hotkey-') && name !== 'hotkey-pressed') this.hotkeyStatus = name.slice(7);
        if (!['ready', 'colors', 'hotkey-pressed', 'hotkey-ok', 'hotkey-off'].includes(name)) this.log(`[Gemini] ${line}`);
        this.onEvent(name, rest.join(' '));
      }
    });
    child.stderr.on('data', (d) => this.log(`[Gemini helper] ${String(d).trim().slice(0, 300)}`));
    child.on('error', (err) => this.log(`[!] Gemini 小窗启动失败: ${err.message}`));
    child.on('exit', () => {
      if (this.child === child) this.child = null;
    });
  }

  // action: show | hide | top | cut
  //   topPx: title-bar height in physical pixels (show, top)
  //   rect:  [x, y, w, h] in Antigravity client pixels to cut a hole for a
  //          menu, or null to close it (cut)
  //   win:   Antigravity's window geometry (macOS, see sendFrame)
  send(action, topPx, rect, win) {
    if (!['show', 'hide', 'top', 'cut', 'toggle'].includes(action)) return;
    if (!this.child && action !== 'show') return; // nothing to hide or cut yet
    if (!this.start()) return;
    this.sendFrame(win);
    let line = action;
    if ((action === 'show' || action === 'top') && topPx) line += ' ' + Math.round(topPx);
    if (action === 'cut' && Array.isArray(rect) && (rect.length === 4 || rect.length === 5) && rect.every(Number.isFinite)) {
      line += ' ' + rect.map((v) => Math.round(v)).join(' ');
    }
    this.child.stdin.write(line + '\n');
  }

  // Watcher shutdown: closing stdin makes the helper hide Gemini and exit;
  // the Edge window stays alive for the next watcher to reuse.
  stop() {
    if (this.child) this.child.stdin.end();
  }
}

// remove.js: close the Gemini window gracefully (Edge saves the profile).
function closeGeminiWindow(config = {}) {
  if (IS_MAC) {
    // the helper exits with the watcher; this only catches a stray one
    const r = spawnSync('pkill', ['-f', MAC_HELPER]);
    return r.status === 0;
  }
  const edge = findEdge(config) || 'msedge.exe';
  const r = spawnSync('powershell.exe', helperArgs(edge, 'about:blank', ['-Close']), {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
  return (r.stdout || '').trim() === 'closed';
}

module.exports = {
  GEMINI_BINDING,
  PROFILE_DIR,
  DEFAULT_HOTKEY,
  GeminiDock,
  closeGeminiWindow,
  findEdge,
  parseHotkey,
};
