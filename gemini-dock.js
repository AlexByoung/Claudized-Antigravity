// Watcher-side manager for dock.ps1, the helper that docks an Edge app window
// (Gemini, dedicated profile) into Antigravity. See dock.ps1 for the how.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DOCK_SCRIPT = path.join(__dirname, 'dock.ps1');
const PROFILE_DIR = path.join(process.env.LOCALAPPDATA || '', 'AntigravityPatch', 'EdgeGemini');
const GEMINI_BINDING = '__agPatchGemini';
const DEFAULT_HOTKEY = 'Ctrl+Alt+G';

// "Ctrl+Alt+G" -> { mods, vk } for RegisterHotKey, or null if invalid.
// At least one modifier is required, so a plain key is never taken globally.
const MODS = { Ctrl: 2, Alt: 1, Shift: 4, Win: 8 };
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

  sendConfig(config) {
    const layout = config.geminiLayout === 'docked' ? 'docked' : 'float';
    const hk = parseHotkey(config.geminiHotkey === undefined ? DEFAULT_HOTKEY : config.geminiHotkey);
    this.child.stdin.write(`layout ${layout}\n`);
    this.child.stdin.write(hk ? `hotkey ${hk.mods} ${hk.vk}\n` : 'hotkey 0 0\n');
  }

  start() {
    if (this.child) return true;
    const config = this.getConfig();
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
    child.on('exit', () => {
      if (this.child === child) this.child = null;
    });
    // A (re)started helper knows nothing yet: give it layout + shortcut first.
    this.sendConfig(config);
    return true;
  }

  // action: show | hide | top | cut
  //   topPx: title-bar height in physical pixels (show, top)
  //   rect:  [x, y, w, h] in Antigravity client pixels to cut a hole for a
  //          menu, or null to close it (cut)
  send(action, topPx, rect) {
    if (!['show', 'hide', 'top', 'cut', 'toggle'].includes(action)) return;
    if (!this.child && action !== 'show') return; // nothing to hide or cut yet
    if (!this.start()) return;
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
