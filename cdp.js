// Shared Chrome DevTools Protocol helpers for inject.js / remove.js.
// Node >= 22: uses the built-in fetch and WebSocket (no npm deps).
const fs = require('fs');
const path = require('path');

const STYLE_ID = 'ag-custom-fonts';
const PATCH_VERSION = '20261019-cc-zh-v6';
const PORT_FILE = path.join(process.env.APPDATA || '', 'Antigravity', 'DevToolsActivePort');
const PID_FILE = path.join(__dirname, '.watch.pid');

// Returns the CDP port, or null when Antigravity has not written one.
// AG_CDP_PORT overrides the file (handy if you launch with a fixed port).
function readPort() {
  if (process.env.AG_CDP_PORT) return parseInt(process.env.AG_CDP_PORT, 10);
  let text;
  try {
    text = fs.readFileSync(PORT_FILE, 'utf8');
  } catch {
    return null;
  }
  const port = parseInt(text.split(/\r?\n/)[0].trim(), 10);
  return Number.isInteger(port) && port > 0 ? port : null;
}

// The port file survives a crash/quit, so a port is only trusted once the
// endpoint actually answers. Returns app windows (type "page"), skipping
// DevTools windows, plugin iframes and the hidden data: splash window.
async function listPages(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2000),
  });
  const targets = await res.json();
  return targets.filter(
    (t) =>
      t.type === 'page' &&
      t.webSocketDebuggerUrl &&
      !t.url.startsWith('devtools://') &&
      !t.url.startsWith('data:')
  );
}

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.onClose = null;
    this.listeners = new Map(); // CDP event method -> [callback]
    ws.addEventListener('message', (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (msg.method) {
        for (const cb of this.listeners.get(msg.method) || []) cb(msg.params);
        return;
      }
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
      if (this.onClose) this.onClose();
    });
  }

  static connect(wsUrl, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('CDP connect timeout'));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpSession(ws));
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP connect failed'));
      }, { once: true });
    });
  }

  send(method, params = {}, timeoutMs = 5000) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, callback) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(callback);
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result.value;
  }

  close() {
    if (!this.closed) this.ws.close();
  }
}

const { REVERT_EXPRESSION } = require('./i18n');
const { MODE_DESTROY_EXPRESSION } = require('./modes');
const { TITLE_DESTROY_EXPRESSION } = require('./titles');
const { HIDE_DESTROY_EXPRESSION } = require('./projects');

// Every target (pages, webviews, iframes); used to find the Gemini webview.
async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
  return res.json();
}

async function browserUserAgent(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
  return (await res.json())['User-Agent'];
}

// Page-side injection. Idempotent: reuses one <style id>, skips the rewrite
// when the CSS is unchanged, and re-appends it so it stays last in <head>.
// Only touches our own <style> and data attributes on <html>; never writes
// localStorage or anything React owns. `i18nScript` (from i18n.js) is
// optional; an empty string leaves the UI in English. `look` picks variants in
// theme.css through attributes on <html>: themeStyle (data-ag-style: clay |
// classic), latinFont (data-ag-latin: claude | system) and cjkFont
// (data-ag-cjk: wenkai | system).
function buildInjectExpression(css, i18nScript = '', look = {}) {
  const style = look.themeStyle === 'classic' ? 'classic' : 'clay';
  const latin = look.latinFont === 'system' ? 'system' : 'claude';
  const cjk = look.cjkFont === 'system' ? 'system' : 'wenkai';
  return `(() => {
    const css = ${JSON.stringify(css)};
    const apply = () => {
      let style = document.getElementById(${JSON.stringify(STYLE_ID)});
      if (!style) {
        style = document.createElement('style');
        style.id = ${JSON.stringify(STYLE_ID)};
      }
      if (style.textContent !== css) style.textContent = css;
      if (style.parentNode !== document.head || document.head.lastElementChild !== style) {
        document.head.appendChild(style);
      }
      document.documentElement.setAttribute('data-ag-preset', 'high-contrast');
      document.documentElement.setAttribute('data-ag-style', ${JSON.stringify(style)});
      document.documentElement.setAttribute('data-ag-latin', ${JSON.stringify(latin)});
      document.documentElement.setAttribute('data-ag-cjk', ${JSON.stringify(cjk)});
      document.documentElement.setAttribute('data-ag-patch', ${JSON.stringify(PATCH_VERSION)});
      window.__ag_patch_version = ${JSON.stringify(PATCH_VERSION)};
    };
    if (document.head) apply();
    else document.addEventListener('DOMContentLoaded', apply, { once: true });

    let i18n = 'off';
    try {
      ${REVERT_EXPRESSION}
      ${i18nScript}
      if (window.__agI18n) i18n = window.__agI18n.locale;
    } catch (e) {
      i18n = 'error: ' + e.message;
    }

    return {
      version: ${JSON.stringify(PATCH_VERSION)},
      theme: document.body ? (document.body.classList.contains('theme-dark') ? 'dark' : 'light') : 'loading',
      style: ${JSON.stringify(style)},
      i18n,
    };
  })()`;
}

const REMOVE_EXPRESSION = `(() => {
  const nodes = document.querySelectorAll('style#${STYLE_ID}, style[id^="ag-custom"]');
  nodes.forEach((n) => n.remove());
  document.documentElement.removeAttribute('data-ag-preset');
  document.documentElement.removeAttribute('data-ag-patch');
  document.documentElement.removeAttribute('data-ag-style');
  document.documentElement.removeAttribute('data-ag-latin');
  document.documentElement.removeAttribute('data-ag-cjk');
  delete window.__ag_patch_version;
  ${REVERT_EXPRESSION}
  ${MODE_DESTROY_EXPRESSION}
  ${TITLE_DESTROY_EXPRESSION}
  ${HIDE_DESTROY_EXPRESSION}
  return { removed: nodes.length };
})()`;

function readCss() {
  return fs.readFileSync(path.join(__dirname, 'theme.css'), 'utf8');
}

module.exports = {
  STYLE_ID,
  PATCH_VERSION,
  PORT_FILE,
  PID_FILE,
  readPort,
  listPages,
  listTargets,
  browserUserAgent,
  CdpSession,
  buildInjectExpression,
  REMOVE_EXPRESSION,
  readCss,
};
