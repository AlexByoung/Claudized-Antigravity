// Title-bar mode switcher: a ChatGPT-style dropdown at the left of the title
// bar ("Antigravity ⌄" / "Gemini ⌄") that replaces Antigravity's own title
// menu (its "Version" and "Check for Updates" items live in Settings now, see
// i18n.js). Hover or click opens it.
//
// In Gemini mode the title bar, the native window buttons and the menu take
// Gemini's own header color (sampled by dock.ps1), so the window reads as one
// surface; back in Antigravity mode the theme colors return.
const { readConfig } = require('./i18n');

const PARTITION = 'persist:ag-gemini';
const DEFAULT_URL = 'https://gemini.google.com/app';

// Engines for Gemini mode:
//   "edge" (default): a docked Microsoft Edge app window with its own profile,
//                     driven by dock.ps1 through the watcher. Google sign-in
//                     works, because it is a real browser.
//   "webview":        an in-app <webview>. Loads Gemini, but Google refuses to
//                     sign in inside embedded browsers, so it stays signed out.
function buildModeScript() {
  const config = readConfig();
  if (config.geminiMode === false) return '';
  const C = {
    url: config.geminiUrl || DEFAULT_URL,
    partition: PARTITION,
    zh: config.translate !== false,
    engine: config.geminiEngine === 'webview' ? 'webview' : 'edge',
    // "float": Antigravity stays, Gemini opens as a small floating window
    //          (title bar shows a Gemini button). Default.
    // "docked": the title-bar dropdown switches the whole window.
    layout: config.geminiEngine !== 'webview' && config.geminiLayout !== 'docked' ? 'float' : 'docked',
    hotkey: config.geminiHotkey === undefined ? 'Ctrl+Alt+G' : config.geminiHotkey,
    binding: '__agPatchGemini', // must match GEMINI_BINDING in gemini-dock.js
  };
  return `(${modeMain.toString()})(${JSON.stringify(C)});`;
}

// Runs in the Antigravity page.
function modeMain(C) {
  const VERSION = 7; // bump when this function changes in a way refresh() can't apply
  // Hot reload of the same version: keep the live Gemini view, refresh texts.
  if (window.__agMode && window.__agMode.version === VERSION) {
    window.__agMode.refresh(C);
    return;
  }
  // An older instance (or a broken one): tear it down, even if its own
  // destroy() throws, then start fresh.
  if (window.__agMode) {
    try {
      window.__agMode.destroy();
    } catch {}
    for (const id of ['ag-mode-switch', 'ag-mode-menu', 'ag-gemini-btn', 'ag-mode-style']) document.getElementById(id)?.remove();
    delete window.__agMode;
  }

  // macOS: no in-window menu bar; the title bar is the main pane's top row,
  // whose left cluster (past the traffic lights) holds the switcher.
  const MAC = /Mac/.test(navigator.platform);
  const KEY = 'ag-patch-mode'; // sessionStorage: survives reloads within one launch
  const BG_KEY = 'ag-patch-gemini-bg';
  // (What each mode is for is explained in Settings > General > Gemini.)
  const TEXT = {
    zh: {
      label: '切换工作模式',
      floatOpen: '打开 Gemini 小窗',
      floatClose: '收起 Gemini 小窗',
      opening: '正在打开 Gemini…',
      noWatcher: `Gemini 窗口需要后台守护进程（${MAC ? 'watch.sh' : 'watch.bat'}）运行。`,
    },
    en: {
      label: 'Switch mode',
      floatOpen: 'Open Gemini',
      floatClose: 'Hide Gemini',
      opening: 'Opening Gemini…',
      noWatcher: `The Gemini window needs the background watcher (${MAC ? 'watch.sh' : 'watch.bat'}).`,
    },
  };
  const ICON = {
    agent:
      '<svg viewBox="0 0 180 180" aria-hidden="true"><path fill="currentColor" d="M144.248 149.062C151.748 154.688 162.998 150.938 152.685 140.625C121.748 110.625 128.31 28.125 89.8727 28.125C51.4352 28.125 57.9977 110.625 27.0602 140.625C15.8102 151.875 27.9977 154.688 35.4977 149.062C64.5602 129.375 62.6852 94.6875 89.8727 94.6875C117.06 94.6875 115.185 129.375 144.248 149.062Z"/></svg>',
    gemini:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="ag-gem-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4796E3"/><stop offset=".55" stop-color="#9177C7"/><stop offset="1" stop-color="#CA6673"/></linearGradient></defs><path fill="url(#ag-gem-grad)" d="M12 2c.35 5.35 4.65 9.65 10 10-5.35.35-9.65 4.65-10 10-.35-5.35-4.65-9.65-10-10 5.35-.35 9.65-4.65 10-10z"/></svg>',
    chevron:
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    check:
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const NAMES = { agent: 'Antigravity', gemini: 'Gemini' };

  const css = `
    /* Antigravity's own title menu (Version / Check for Updates): replaced by
       this switcher; those two items are in Settings > Application now. */
    [data-testid="title-menu-bar"] > div:first-child { display: none !important; }

    #ag-mode-switch { position: relative; display: inline-flex; align-items: center; -webkit-app-region: no-drag; z-index: 5; }
    #ag-mode-trigger {
      all: unset; -webkit-app-region: no-drag; box-sizing: border-box; cursor: pointer;
      display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 7px 0 8px;
      border-radius: 8px; font-size: 13px; font-weight: 600; letter-spacing: -0.01em;
      color: var(--ag-bar-fg, var(--foreground));
      transition: background-color 120ms ease;
    }
    #ag-mode-trigger:hover, #ag-mode-switch.ag-open #ag-mode-trigger {
      background: var(--ag-bar-hover, color-mix(in srgb, var(--foreground) 7%, transparent));
    }
    #ag-mode-trigger:focus-visible { outline: 2px solid var(--ag-focus, rgba(198,97,63,.55)); outline-offset: 1px; }
    /* small-window layout: a single Gemini button instead of the dropdown */
    #ag-gemini-btn {
      all: unset; -webkit-app-region: no-drag; box-sizing: border-box; cursor: pointer;
      display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 10px 0 8px;
      border-radius: 8px; font-size: 13px; font-weight: 600; letter-spacing: -0.01em;
      color: var(--foreground); transition: background-color 120ms ease, box-shadow 120ms ease;
    }
    #ag-gemini-btn:hover { background: color-mix(in srgb, var(--foreground) 7%, transparent); }
    #ag-gemini-btn[aria-pressed="true"] {
      background: var(--card); box-shadow: 0 0 0 1px var(--card-border), 0 1px 2px rgba(0, 0, 0, 0.06);
    }
    #ag-gemini-btn:focus-visible { outline: 2px solid var(--ag-focus, rgba(198,97,63,.55)); outline-offset: 1px; }
    #ag-gemini-btn .ag-icon { width: 14px; height: 14px; display: inline-flex; }
    #ag-gemini-btn .ag-icon svg { width: 100%; height: 100%; }

    #ag-mode-trigger .ag-icon { width: 14px; height: 14px; display: inline-flex; }
    #ag-mode-trigger .ag-icon svg, .ag-mode-item .ag-item-icon svg { width: 100%; height: 100%; }
    #ag-mode-trigger .ag-chev { width: 12px; height: 12px; display: inline-flex; opacity: .55; transition: transform 160ms ease; }
    #ag-mode-switch.ag-open .ag-chev { transform: rotate(180deg); }

    #ag-mode-menu {
      --m-bg: var(--card); --m-fg: var(--foreground); --m-muted: var(--muted-foreground);
      --m-hover: var(--secondary); --m-border: var(--card-border); --m-icon: var(--muted);
      position: fixed; min-width: 200px; padding: 5px; box-sizing: border-box;
      background: var(--m-bg); color: var(--m-fg);
      border: 1px solid var(--m-border); border-radius: 14px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.06);
      -webkit-app-region: no-drag; z-index: 2147483600;
      opacity: 0; transform: translateY(-4px); pointer-events: none;
      transition: opacity 120ms ease, transform 120ms ease;
    }
    #ag-mode-menu.ag-open { opacity: 1; transform: none; pointer-events: auto; }
    .ag-mode-item {
      all: unset; box-sizing: border-box; cursor: pointer; width: 100%;
      display: grid; grid-template-columns: 26px 1fr 16px; align-items: center; gap: 10px;
      padding: 6px 10px 6px 6px; border-radius: 9px;
    }
    .ag-mode-item:hover, .ag-mode-item:focus-visible { background: var(--m-hover); }
    .ag-mode-item .ag-item-icon {
      width: 26px; height: 26px; border-radius: 7px; padding: 6px; box-sizing: border-box;
      display: flex; background: var(--m-icon); color: var(--m-fg);
    }
    .ag-mode-item .ag-item-title { font-size: 13.5px; font-weight: 600; letter-spacing: -0.01em; color: var(--m-fg); }
    .ag-mode-item .ag-check { width: 16px; height: 16px; color: var(--m-fg); visibility: hidden; }
    .ag-mode-item[aria-checked="true"] .ag-check { visibility: visible; }

    /* Gemini mode: the title bar takes Gemini's header color */
    html.ag-gemini-on [data-testid="title-menu-bar"],
    html.ag-gemini-on [class*="@container/titlebar"] { background: var(--ag-gemini-bar, var(--ag-gemini-bg)) !important; }
    /* Over Gemini the menu sits in an exactly-shaped hole: no outer shadow */
    html.ag-gemini-on #ag-mode-menu { box-shadow: none; }
    html.ag-gemini-on #ag-mode-menu {
      --m-bg: #FFFFFF; --m-fg: #1F1F1F; --m-muted: #5F6368;
      --m-hover: #F0F4F9; --m-border: rgba(0, 0, 0, 0.08); --m-icon: #F0F4F9;
    }
    html.ag-gemini-on.ag-gemini-dark #ag-mode-menu {
      --m-bg: #1E1F20; --m-fg: #E3E3E3; --m-muted: #A8ABAF;
      --m-hover: #2D2E30; --m-border: rgba(255, 255, 255, 0.10); --m-icon: #2D2E30;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    }

    #ag-gemini-host {
      position: fixed; left: 0; right: 0; bottom: 0; top: 35px;
      background: var(--ag-gemini-bar, var(--ag-gemini-bg, var(--background))); z-index: 2147483000;
      visibility: hidden; pointer-events: none;
    }
    #ag-gemini-host.ag-on { visibility: visible; pointer-events: auto; }
    #ag-gemini-host webview { width: 100%; height: 100%; display: flex; border: 0; }
    #ag-gemini-host .ag-gemini-hint {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      color: var(--ag-bar-fg, var(--muted-foreground)); opacity: .6; font-size: 13px; pointer-events: none;
    }
  `;

  let cfg = C;
  let mode = 'agent';
  let destroyed = false; // a frame queued before destroy() must not rebuild anything
  let geminiBg = null;
  try {
    if (sessionStorage.getItem(KEY) === 'gemini') mode = 'gemini';
    geminiBg = sessionStorage.getItem(BG_KEY);
  } catch {}
  if (!geminiBg) geminiBg = matchMedia('(prefers-color-scheme: dark)').matches ? '#1B1C1D' : '#F8FAFD';

  const t = () => (cfg.zh ? TEXT.zh : TEXT.en);
  const isEdge = () => cfg.engine === 'edge';
  const isFloat = () => isEdge() && cfg.layout === 'float';
  // Looked up on use: when the watcher runs this at document start (after a
  // reload), <html> does not exist yet; a captured null broke setMode().
  const html = () => document.documentElement;
  let floatOpen = false; // small window currently shown (reported by the helper)
  if (isFloat()) mode = 'agent'; // nothing to restore: Antigravity always stays

  const style = document.createElement('style');
  style.id = 'ag-mode-style';
  style.textContent = css;

  let host = null;
  let webview = null;
  const cleanUA = navigator.userAgent.replace(/\s(Antigravity|Electron)\/\S+/g, '');

  // ── Watcher bridge (Edge engine) ─────────────────────────────────────
  function titleBar() {
    return document.querySelector('[data-testid="title-menu-bar"]') ||
      (MAC ? document.querySelector('[class*="@container/titlebar"] > div:first-child') : null);
  }
  function barBottom() {
    const bar = titleBar();
    const b = bar ? bar.getBoundingClientRect().bottom : 35;
    return b > 0 ? b : 35;
  }
  function dockCall(action, rect) {
    const send = window[cfg.binding];
    if (typeof send !== 'function') return false;
    send(JSON.stringify({ action, top: Math.round(barBottom() * devicePixelRatio), rect: rect || null, win: MAC ? winGeometry() : undefined }));
    return true;
  }
  // macOS: the helper places Gemini from the page's own window geometry
  // (screen points), so docked Gemini follows moves and resizes through this.
  function winGeometry() {
    return [screenX, screenY, outerWidth, outerHeight, innerHeight, devicePixelRatio];
  }
  let lastGeo = '';
  const geoTimer = MAC
    ? setInterval(() => {
        if (destroyed || cfg.layout !== 'docked' || mode !== 'gemini') return;
        const g = winGeometry().join(' ');
        if (g !== lastGeo) {
          lastGeo = g;
          dockCall('top');
        }
      }, 250)
    : null;

  // ── Colors ───────────────────────────────────────────────────────────
  function isDark(hex) {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
  }
  function setOverlay(color, symbolColor) {
    try {
      window.electronNative?.setTitleBarOverlay?.({ color, symbolColor });
    } catch {}
  }
  // Gemini's colors along its top row: `geminiLeft` over its sidebar (when
  // open, up to `splitPx` physical px from the left), `geminiBg` elsewhere.
  let geminiLeft = null;
  let splitPx = 0;
  function applyColors() {
    const root = html();
    if (!root) return;
    const on = mode === 'gemini';
    root.classList.toggle('ag-gemini-on', on);
    const props = ['--ag-gemini-bg', '--ag-gemini-bar', '--ag-bar-fg', '--ag-bar-hover'];
    if (on) {
      const right = geminiBg;
      const left = geminiLeft || right;
      const split = Math.round(splitPx / devicePixelRatio);
      // Above Gemini's open sidebar the bar takes the sidebar color, above the
      // conversation the header color: one continuous surface either way.
      const bar = split > 0 && left !== right ? `linear-gradient(to right, ${left} 0 ${split}px, ${right} ${split}px 100%)` : right;
      const darkLeft = isDark(left); // the switcher and its menu sit on the left
      const darkRight = isDark(right); // the window buttons sit on the right
      root.classList.toggle('ag-gemini-dark', darkLeft);
      root.style.setProperty('--ag-gemini-bg', right);
      root.style.setProperty('--ag-gemini-bar', bar);
      root.style.setProperty('--ag-bar-fg', darkLeft ? '#E3E3E3' : '#1F1F1F');
      root.style.setProperty('--ag-bar-hover', darkLeft ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)');
      setOverlay(right, darkRight ? '#E3E3E3' : '#1F1F1F');
    } else {
      root.classList.remove('ag-gemini-dark');
      for (const p of props) root.style.removeProperty(p);
      // same source the app itself uses for the overlay
      const cs = getComputedStyle(document.body || root);
      setOverlay(cs.getPropertyValue('--sidebar').trim() || '#FFFFFF', cs.getPropertyValue('--foreground').trim() || '#000000');
    }
  }
  const HEX = /^#[0-9A-F]{6}$/i;
  function setGeminiColors(left, right, split) {
    if (!HEX.test(left) || !HEX.test(right)) return;
    geminiLeft = left.toUpperCase();
    geminiBg = right.toUpperCase();
    splitPx = Math.max(0, Number(split) || 0);
    try {
      sessionStorage.setItem(BG_KEY, geminiBg);
    } catch {}
    if (mode === 'gemini') applyColors();
  }
  function setGeminiColor(hex) {
    setGeminiColors(hex, hex, 0);
  }

  // ── Gemini host (placeholder for Edge, or the webview) ───────────────
  function hintText() {
    return isEdge() && typeof window[cfg.binding] !== 'function' ? t().noWatcher : t().opening;
  }
  function ensureHost() {
    if (host && host.isConnected) return host;
    host = document.getElementById('ag-gemini-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'ag-gemini-host';
      host.setAttribute('data-ag-no-i18n', '');
      document.body.appendChild(host);
    }
    if (isEdge()) {
      // Only a placeholder: the docked Edge window sits on top of it.
      let hint = host.querySelector('.ag-gemini-hint');
      if (!hint) {
        hint = document.createElement('div');
        hint.className = 'ag-gemini-hint';
        host.appendChild(hint);
      }
      hint.textContent = hintText();
    } else if (!host.querySelector('webview')) {
      const hint = document.createElement('div');
      hint.className = 'ag-gemini-hint';
      hint.textContent = t().opening;
      host.appendChild(hint);
      webview = document.createElement('webview');
      webview.setAttribute('partition', cfg.partition);
      webview.setAttribute('useragent', cleanUA);
      webview.setAttribute('allowpopups', '');
      webview.setAttribute('src', cfg.url);
      const clearHint = () => hint.remove();
      for (const ev of ['dom-ready', 'did-stop-loading', 'did-finish-load', 'did-fail-load']) {
        webview.addEventListener(ev, clearHint, { once: true });
      }
      setTimeout(clearHint, 15000);
      host.appendChild(webview);
    } else {
      webview = host.querySelector('webview');
    }
    fit();
    return host;
  }
  function fit() {
    if (host) host.style.top = Math.round(barBottom()) + 'px';
  }

  // fromDock: the change came from the Edge window itself (closed / failed),
  // so don't send show/hide back.
  function setMode(next, fromDock) {
    if (destroyed) return;
    mode = next;
    try {
      sessionStorage.setItem(KEY, mode);
    } catch {}
    if (mode === 'gemini') ensureHost();
    if (host) host.classList.toggle('ag-on', mode === 'gemini');
    applyColors();
    if (isEdge()) {
      if (!fromDock) dockCall(mode === 'gemini' ? 'show' : 'hide');
    } else if (mode === 'gemini' && webview) {
      webview.focus();
    }
    paint();
  }

  // ── Dropdown ─────────────────────────────────────────────────────────
  // The trigger lives in the title bar; the menu is mounted on <body>, since
  // the title bar's stacking layer sits below the page content.
  let closeTimer = null;
  function sw() {
    return document.getElementById('ag-mode-switch');
  }
  function menuEl() {
    return document.getElementById('ag-mode-menu');
  }
  // The menu's exact box and corner radius in physical px: the helper cuts a
  // matching rounded hole, so nothing but the menu shows through.
  function menuRectPx() {
    const m = menuEl();
    if (!m) return null;
    const r = m.getBoundingClientRect();
    const radius = parseFloat(getComputedStyle(m).borderTopLeftRadius) || 0;
    const d = devicePixelRatio;
    return [r.left * d, r.top * d, r.width * d, r.height * d, radius * d].map((v) => Math.max(0, Math.round(v)));
  }
  function openMenu() {
    const s = sw();
    const m = menuEl();
    if (!s || !m || destroyed) return;
    clearTimeout(closeTimer);
    if (m.classList.contains('ag-open')) return;
    const trig = s.querySelector('#ag-mode-trigger').getBoundingClientRect();
    m.style.left = Math.max(6, Math.round(trig.left)) + 'px';
    m.style.top = Math.round(barBottom() + 4) + 'px';
    s.classList.add('ag-open');
    m.classList.add('ag-open');
    s.querySelector('#ag-mode-trigger').setAttribute('aria-expanded', 'true');
    // Over the docked Gemini window, open a hole so the menu shows through.
    if (isEdge() && mode === 'gemini') dockCall('cut', menuRectPx());
  }
  function closeMenu(now) {
    const s = sw();
    const m = menuEl();
    if (!s || !m) return;
    const doClose = () => {
      if (!m.classList.contains('ag-open')) return;
      s.classList.remove('ag-open');
      m.classList.remove('ag-open');
      s.querySelector('#ag-mode-trigger').setAttribute('aria-expanded', 'false');
      if (isEdge() && mode === 'gemini') setTimeout(() => dockCall('cut', null), 130); // after the fade
    };
    clearTimeout(closeTimer);
    if (now) doClose();
    else closeTimer = setTimeout(doClose, 180); // grace period to travel from trigger to menu
  }

  function buildMenu() {
    const menu = document.createElement('div');
    menu.id = 'ag-mode-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('data-ag-no-i18n', '');
    for (const id of ['agent', 'gemini']) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'ag-mode-item';
      item.setAttribute('role', 'menuitemradio');
      item.dataset.mode = id;
      item.innerHTML =
        '<span class="ag-item-icon">' + ICON[id] + '</span>' +
        '<span class="ag-item-title"></span>' +
        '<span class="ag-check">' + ICON.check + '</span>';
      item.querySelector('.ag-item-title').textContent = NAMES[id];
      item.addEventListener('click', () => {
        closeMenu(true);
        if (id !== mode) setMode(id);
      });
      menu.appendChild(item);
    }
    menu.addEventListener('mouseenter', () => clearTimeout(closeTimer));
    menu.addEventListener('mouseleave', () => closeMenu(false));
    menu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeMenu(true);
        document.getElementById('ag-mode-trigger')?.focus();
      }
    });
    return menu;
  }

  function buildSwitch() {
    const s = document.createElement('nav'); // not a <div>: the title-bar CSS hides div children
    s.id = 'ag-mode-switch';
    s.setAttribute('data-ag-no-i18n', '');
    s.innerHTML =
      '<button type="button" id="ag-mode-trigger" aria-haspopup="menu" aria-expanded="false">' +
      '<span class="ag-icon"></span><span class="ag-name"></span><span class="ag-chev">' + ICON.chevron + '</span></button>';
    const trig = s.querySelector('#ag-mode-trigger');
    trig.addEventListener('click', () => (menuEl()?.classList.contains('ag-open') ? closeMenu(true) : openMenu()));
    s.addEventListener('mouseenter', openMenu);
    s.addEventListener('mouseleave', () => closeMenu(false));
    s.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeMenu(true);
        trig.focus();
      }
    });
    return s;
  }

  // ── Small-window layout: one Gemini button ───────────────────────────
  function hotkeyText() {
    if (!cfg.hotkey) return '';
    if (MAC) return cfg.hotkey.split('+').map((k) => ({ Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘', Win: '⌘' }[k] || k)).join('');
    return cfg.hotkey.split('+').join(' + ');
  }
  function buildGeminiButton() {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = 'ag-gemini-btn';
    b.setAttribute('data-ag-no-i18n', '');
    b.innerHTML = '<span class="ag-icon">' + ICON.gemini + '</span><span>Gemini</span>';
    b.addEventListener('click', () => {
      if (!dockCall(floatOpen ? 'hide' : 'show')) b.title = t().noWatcher;
    });
    return b;
  }
  function paintFloat() {
    const b = document.getElementById('ag-gemini-btn');
    if (!b) return;
    b.setAttribute('aria-pressed', String(floatOpen));
    const hk = hotkeyText();
    b.title = (floatOpen ? t().floatClose : t().floatOpen) + (hk ? (cfg.zh ? '（' + hk + '）' : ' (' + hk + ')') : '');
  }
  function setFloatOpen(open) {
    floatOpen = !!open;
    paintFloat();
  }
  // Docked layout: the global shortcut switches the whole window.
  function toggleFromHotkey() {
    if (!isFloat()) setMode(mode === 'gemini' ? 'agent' : 'gemini');
  }

  function paint() {
    paintFloat();
    const s = sw();
    if (s) {
      s.querySelector('.ag-icon').innerHTML = ICON[mode];
      s.querySelector('.ag-name').textContent = NAMES[mode];
      s.querySelector('#ag-mode-trigger').setAttribute('aria-label', t().label + ': ' + NAMES[mode]);
    }
    const m = menuEl();
    if (!m) return;
    for (const item of m.querySelectorAll('.ag-mode-item')) {
      item.setAttribute('aria-checked', String(item.dataset.mode === mode));
    }
  }

  function ensure() {
    if (destroyed) return;
    if (!style.isConnected && document.head) document.head.appendChild(style);
    const bar = titleBar();
    if (isFloat()) {
      // small window: a Gemini button, no dropdown
      document.getElementById('ag-mode-switch')?.remove();
      menuEl()?.remove();
      if (bar && !bar.querySelector('#ag-gemini-btn')) {
        bar.appendChild(buildGeminiButton());
        paintFloat();
      }
      return;
    }
    document.getElementById('ag-gemini-btn')?.remove();
    if (bar && !bar.querySelector('#ag-mode-switch')) {
      bar.appendChild(buildSwitch());
      paint();
    }
    if (document.body && !menuEl()) {
      document.body.appendChild(buildMenu());
      paint();
    }
    if (mode === 'gemini' && !(host && host.isConnected)) setMode('gemini');
    fit();
  }

  function onResize() {
    fit();
    if (isEdge() && mode === 'gemini') dockCall('top'); // display scale may have changed
  }
  function onDocPointer(e) {
    const m = menuEl();
    const s = sw();
    if (m && m.classList.contains('ag-open') && !m.contains(e.target) && !(s && s.contains(e.target))) closeMenu(true);
  }

  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      ensure();
    });
  });
  observer.observe(document, { childList: true, subtree: true });
  window.addEventListener('resize', onResize);
  document.addEventListener('pointerdown', onDocPointer, true);
  if (document.body) {
    ensure();
    applyColors();
  }

  window.__agMode = {
    version: VERSION,
    get mode() {
      return mode;
    },
    setMode,
    setGeminiColor,
    setGeminiColors,
    setFloatOpen,
    toggleFromHotkey,
    refresh(next) {
      // Layout switched to the small window while Gemini filled the window:
      // return to Antigravity first (the helper hides Gemini on a layout change).
      if (next.layout === 'float' && cfg.layout !== 'float' && mode === 'gemini') setMode('agent', true);
      cfg = next;
      if (isFloat()) {
        mode = 'agent';
        host?.classList.remove('ag-on');
        applyColors();
      }
      ensure();
      paint();
      const hint = host && host.querySelector('.ag-gemini-hint');
      if (hint) hint.textContent = hintText();
    },
    destroy() {
      if (isEdge() && (mode === 'gemini' || floatOpen)) dockCall('hide');
      document.getElementById('ag-gemini-btn')?.remove();
      destroyed = true;
      if (geoTimer) clearInterval(geoTimer);
      mode = 'agent';
      applyColors(); // restore the theme's title bar and window-button colors
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('pointerdown', onDocPointer, true);
      document.getElementById('ag-mode-switch')?.remove();
      document.getElementById('ag-mode-menu')?.remove();
      document.getElementById('ag-gemini-host')?.remove();
      style.remove();
      try {
        sessionStorage.removeItem(KEY);
      } catch {}
      delete window.__agMode;
    },
  };
}

// Defensive: a broken instance's destroy() must not abort the rest of remove.
const MODE_DESTROY_EXPRESSION = `
  if (window.__agMode) { try { window.__agMode.destroy(); } catch (e) {} }
  for (const id of ['ag-mode-switch', 'ag-mode-menu', 'ag-gemini-btn', 'ag-mode-style', 'ag-gemini-host']) document.getElementById(id)?.remove();
  document.documentElement.classList.remove('ag-gemini-on', 'ag-gemini-dark');
  delete window.__agMode;
`;

// --------------------------------------------------------------------------
// Watcher side, webview engine only: make the Gemini webview look like Chrome
// to Google, including the Sec-CH-UA client hints.
function chromeOverride(userAgent) {
  const full = (/Chrome\/([\d.]+)/.exec(userAgent) || [])[1] || '152.0.0.0';
  const major = full.split('.')[0];
  const ua = userAgent.replace(/\s(Antigravity|Electron)\/\S+/g, '');
  const brands = [
    { brand: 'Google Chrome', version: major },
    { brand: 'Chromium', version: major },
    { brand: 'Not?A_Brand', version: '24' },
  ];
  return {
    userAgent: ua,
    userAgentMetadata: {
      brands,
      fullVersionList: brands.map((b) => ({ ...b, version: b.brand === 'Not?A_Brand' ? '24.0.0.0' : full })),
      fullVersion: full,
      platform: process.platform === 'darwin' ? 'macOS' : 'Windows',
      platformVersion: '15.0.0',
      architecture: process.arch === 'arm64' ? 'arm' : 'x86',
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false,
    },
  };
}

function isGeminiWebview(target) {
  return target.type === 'webview' && /^https:\/\/([a-z0-9-]+\.)*google\.com\//.test(target.url);
}

module.exports = { PARTITION, buildModeScript, MODE_DESTROY_EXPRESSION, chromeOverride, isGeminiWebview };
