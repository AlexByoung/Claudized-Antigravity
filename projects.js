// Hide the projects that plugins create for their sidecars.
//
// A plugin with a sidecar (e.g. Science's "Biomolecular Structure Viewer")
// gets a project of its own, listed in ~/.gemini/config/config.json under
// "sidecars". It never holds conversations, and deleting it does not stick:
// the plugin registers it again on the next start. This hides those projects
// from the sidebar, the Settings project list and project pickers, without
// touching the plugin or the project.

const fs = require('fs');
const os = require('os');
const path = require('path');

const GEMINI_CONFIG = path.join(os.homedir(), '.gemini', 'config', 'config.json');

function sidecarProjects() {
  try {
    const sidecars = JSON.parse(fs.readFileSync(GEMINI_CONFIG, 'utf8')).sidecars || {};
    return Object.entries(sidecars)
      .map(([name, v]) => ({ name, id: v && v.projectId }))
      .filter((p) => typeof p.id === 'string' && /^[\w-]+$/.test(p.id));
  } catch {
    return [];
  }
}

function buildProjectHideScript(config) {
  const C = { projects: config.hidePluginProjects === false ? [] : sidecarProjects() };
  return `(${hideMain.toString()})(${JSON.stringify(C)});`;
}

const HIDE_DESTROY_EXPRESSION = `
  try { window.__agHide && window.__agHide.destroy(); } catch {}
`;

// ---------------------------------------------------------------------------
// Page side.
function hideMain(C) {
  if (window.__agHide) {
    try { window.__agHide.destroy(); } catch {}
  }
  const ids = new Set(C.projects.map((p) => p.id));
  const names = new Set(C.projects.map((p) => p.name));
  if (!ids.size) return;

  const STYLE_ID = 'ag-hide-style';
  const MARK = 'data-ag-hidden';
  let last = '';

  // The sidebar is a virtual list: rows are absolutely positioned
  // (translateY), so after hiding a project's rows, the rows below are moved
  // up by the space they took. The offsets come from the list's own layout,
  // so this stays right if the list re-measures the hidden rows as empty.
  function sidebarRules() {
    const inner = document.querySelector('[data-sidebar-scroll-container] > div');
    if (!inner) return '';
    const rows = [...inner.children]
      .filter((r) => r.dataset && r.dataset.index != null)
      .map((r) => ({
        i: Number(r.dataset.index),
        top: parseFloat((/translateY\(([-\d.]+)px\)/.exec(r.style.transform) || [0, 0])[1]),
        hidden: ids.has(r.dataset.sidebarSectionDropId),
      }))
      .sort((a, b) => a.i - b.i);
    let shift = 0;
    const rules = [];
    for (let k = 0; k < rows.length; k++) {
      const r = rows[k];
      if (r.hidden) {
        const next = rows[k + 1];
        if (next && next.i === r.i + 1) shift += next.top - r.top;
        continue;
      }
      if (shift > 0) rules.push(`[data-index="${r.i}"]`);
    }
    if (shift > 0 && rows.length) {
      // rows not rendered yet (scrolled out of view) get the same offset
      const max = rows[rows.length - 1].i;
      for (let i = max + 1; i <= max + 200; i++) rules.push(`[data-index="${i}"]`);
    }
    return rules.length
      ? rules.map((s) => '[data-sidebar-scroll-container] > div > ' + s).join(',') + `{translate:0 ${-shift}px !important}`
      : '';
  }

  function update() {
    for (const n of document.querySelectorAll(
      '[role="dialog"] button, [role="dialog"] a, [role="option"], [role="menuitem"], [role="menuitemradio"]'
    )) {
      if (!n.hasAttribute(MARK) && names.has(n.textContent.trim())) n.setAttribute(MARK, '');
    }
    const css =
      [...ids].map((id) => `[data-sidebar-section-drop-id="${id}"]`).join(',') + `,[${MARK}]{display:none !important}` +
      sidebarRules();
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
      last = '';
    }
    if (css !== last) style.textContent = last = css;
  }

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      update();
      watchList();
    });
  };
  const observer = new MutationObserver(schedule);
  // row offsets change without any node being added: watch the list's styles
  const listObserver = new MutationObserver(schedule);
  let watchedList = null;
  function watchList() {
    const inner = document.querySelector('[data-sidebar-scroll-container] > div');
    if (inner === watchedList) return;
    listObserver.disconnect();
    watchedList = inner;
    if (inner) listObserver.observe(inner, { attributes: true, attributeFilter: ['style'], subtree: true });
  }
  const start = () => {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    update();
    watchList();
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });

  window.__agHide = {
    destroy() {
      observer.disconnect();
      listObserver.disconnect();
      document.getElementById(STYLE_ID)?.remove();
      document.querySelectorAll('[' + MARK + ']').forEach((n) => n.removeAttribute(MARK));
      delete window.__agHide;
    },
  };
}

module.exports = { buildProjectHideScript, HIDE_DESTROY_EXPRESSION, sidecarProjects };
