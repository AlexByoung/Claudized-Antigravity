// UI localization for Antigravity, injected alongside theme.css.
//
// Design rules (each one fixes a way naive DOM translation breaks apps):
// - Allowlist by zone: chat content, code, inputs and names are never
//   translated, so a reply line or a conversation called "Settings" stays put.
// - Text nodes are edited in place (nodeValue), never replaced, so React keeps
//   owning them. When React later writes new English into a node we notice
//   (value != what we wrote) and translate the new value.
// - Every change is recorded with its original, so revert() restores the
//   exact English; re-injecting reverts first, then applies the new dictionary.
// - Translation runs inside the MutationObserver callback (a microtask), which
//   lands before the next paint: no English flash.
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'config.json');

function readConfig() {
  try {
    return { translate: true, locale: 'zh-CN', ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return { translate: true, locale: 'zh-CN' };
  }
}

function localeFile(locale) {
  return path.join(__dirname, `locale.${locale}.js`);
}

function loadLocale(locale) {
  const file = localeFile(locale);
  delete require.cache[require.resolve(file)];
  return require(file);
}

// Name of the CDP binding the Settings language row calls; inject.js (watch
// mode) registers it and writes config.json when it fires.
const LOCALE_BINDING = '__agPatchSetLocale';

// Locales available on disk: 'en' (original UI) plus every locale.<id>.js.
function listLocales() {
  const found = fs
    .readdirSync(__dirname)
    .map((f) => /^locale\.(.+)\.js$/.exec(f))
    .filter(Boolean)
    .map((m) => ({ id: m[1], label: loadLocale(m[1]).label || m[1] }));
  return [{ id: 'en', label: 'English' }, ...found];
}

// Persist a choice from the Settings row. Returns false for unknown ids, so a
// page can never make us write an arbitrary value.
function setLocale(id) {
  if (!listLocales().some((l) => l.id === id)) return false;
  const config = readConfig();
  const next = id === 'en' ? { ...config, translate: false } : { ...config, translate: true, locale: id };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n');
  return true;
}

// Settings rows other than the language: name of the CDP binding they call,
// and the only keys/values a page may write (anything else is rejected).
const SETTING_BINDING = '__agPatchSetting';
function setSetting(key, value) {
  // required lazily: gemini-dock.js is only needed for this validation
  const { parseHotkey } = require('./gemini-dock');
  const valid = {
    geminiLayout: (v) => v === 'float' || v === 'docked',
    geminiHotkey: (v) => v === '' || parseHotkey(v) !== null,
    chineseTitles: (v) => v === true || v === false,
    themeStyle: (v) => v === 'clay' || v === 'classic',
  };
  if (!Object.prototype.hasOwnProperty.call(valid, key) || !valid[key](value)) return false;
  const config = readConfig();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...config, [key]: value }, null, 2) + '\n');
  return true;
}

// Returns page-side JS (statements): the Settings language row, always, plus
// the translator when translation is on.
function buildI18nScript() {
  const config = readConfig();
  const current = config.translate ? config.locale : 'en';
  const locales = listLocales();
  const parts = [];
  let generalTitles = ['General'];
  let appTitles = ['Application'];
  let versionTitles = ['App version'];
  let appearanceTitles = ['Appearance'];
  if (config.translate) {
    const { dict, rules = [], timeRules = [], sentences = [] } = loadLocale(config.locale);
    const payload = JSON.stringify({ locale: config.locale, dict, rules, timeRules, sentences });
    parts.push(`(${pageMain.toString()})(${payload});`);
    if (typeof dict.General === 'string') generalTitles.push(dict.General);
    if (typeof dict.Application === 'string') appTitles.push(dict.Application);
    if (typeof dict['App version'] === 'string') versionTitles.push(dict['App version']);
    if (typeof dict.Appearance === 'string') appearanceTitles.push(dict.Appearance);
  }
  const gemini =
    config.geminiMode === false || config.geminiEngine === 'webview'
      ? null
      : {
          layout: config.geminiLayout === 'docked' ? 'docked' : 'float',
          hotkey: config.geminiHotkey === undefined ? 'Ctrl+Alt+G' : config.geminiHotkey,
        };
  const rowConfig = {
    current, locales, generalTitles, appTitles, versionTitles, gemini,
    chineseTitles: config.chineseTitles !== false,
    appearanceTitles,
    themeStyle: config.themeStyle === 'classic' ? 'classic' : 'clay',
    binding: LOCALE_BINDING, settingBinding: SETTING_BINDING,
  };
  parts.push(`(${langRowMain.toString()})(${JSON.stringify(rowConfig)});`);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Page side: extra Settings rows, built from the same markup and Tailwind
// classes as the native rows. React owns the panels, so each row is
// (re)appended whenever its panel renders without it.
//   - Settings > General: "Language" (switches the UI language)
//   - Settings > Application: "About" (version + Check for Updates; these
//     used to sit in the title-bar "Antigravity" menu, which the mode
//     switcher replaces)
function langRowMain(C) {
  if (window.__agLangRow) window.__agLangRow.destroy();
  const ID = 'ag-lang-row';
  const ABOUT_ID = 'ag-about-row';
  const zh = C.current !== 'en';
  const T = zh
    ? { heading: '语言', title: '界面语言', desc: '切换 Antigravity 的界面语言，对话内容不受影响。', noWatcher: '需要后台守护进程（watch.bat）运行才能切换。', switching: '正在切换…' }
    : { heading: 'Language', title: 'Display Language', desc: 'Interface language of Antigravity. Conversation content is not affected.', noWatcher: 'Switching requires the background watcher (watch.bat).', switching: 'Switching…' };
  const BTN =
    'inline-flex items-center justify-center transition-colors text-secondary-foreground outline-none cursor-pointer border-none shrink-0 select-none h-full hover:text-foreground data-[pressed]:bg-secondary data-[pressed]:text-foreground disabled:opacity-50 disabled:pointer-events-none text-sm px-2 rounded-md gap-1.5';

  function build() {
    const sec = document.createElement('div');
    sec.id = ID;
    sec.className = 'space-y-2';
    sec.setAttribute('data-ag-no-i18n', '');
    sec.innerHTML =
      '<div class="flex flex-col gap-1"><div class="flex items-center justify-between"><div class="flex items-center gap-1.5"><h3 class="m-0 text-sm font-medium"></h3></div></div></div>' +
      '<div><div class="bg-transparent rounded-xl border border-border overflow-hidden divide-y divide-border"><div class="w-full">' +
      '<div class="py-2 px-3 w-full bg-transparent flex justify-between gap-4 items-center">' +
      '<div class="flex-1 flex flex-col gap-0.5"><div class="flex items-center gap-1.5"><span class="text-sm" data-k="title"></span></div>' +
      '<span class="text-xs text-muted-foreground whitespace-pre-wrap" data-k="desc"></span></div>' +
      '<div class="shrink-0"><div role="group" aria-orientation="horizontal" class="inline-flex items-center rounded-lg border border-border bg-secondary/20 p-0.5 gap-0.5 select-none h-8"></div></div>' +
      '</div></div></div></div>';
    sec.querySelector('h3').textContent = T.heading;
    sec.querySelector('[data-k=title]').textContent = T.title;
    const desc = sec.querySelector('[data-k=desc]');
    desc.textContent = T.desc;
    const group = sec.querySelector('[role=group]');
    for (const loc of C.locales) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = BTN;
      b.textContent = loc.label;
      const on = loc.id === C.current;
      b.setAttribute('aria-pressed', String(on));
      if (on) b.setAttribute('data-pressed', '');
      b.addEventListener('click', () => {
        if (loc.id === C.current) return;
        const send = window[C.binding];
        if (typeof send !== 'function') {
          desc.textContent = T.noWatcher;
          return;
        }
        for (const x of group.children) {
          x.setAttribute('aria-pressed', String(x === b));
          x.toggleAttribute('data-pressed', x === b);
        }
        desc.textContent = T.switching;
        send(JSON.stringify({ locale: loc.id })); // watcher writes config.json, then re-injects
      });
      group.appendChild(b);
    }

    // Chinese conversation titles: [ On | Off ] (titles.js)
    const TT = zh
      ? { title: '中文对话标题', desc: '新对话的第一条消息是中文时，让当前选择的模型把自动生成的英文标题翻译成中文（约 10 秒，每个新对话多一次简短调用）；失败时用第一句代替。手动改过的标题不会被覆盖。', on: '开启', off: '关闭' }
      : { title: 'Chinese conversation titles', desc: 'When a new conversation starts in Chinese, the selected model translates its auto-generated English title (about 10 s, one short extra call per conversation); if that fails, the first sentence is used. Titles you edit are never overwritten.', on: 'On', off: 'Off' };
    const card = sec.querySelector('.divide-y');
    card.insertAdjacentHTML('beforeend', rowHtml('<div role="group" aria-orientation="horizontal" class="inline-flex items-center rounded-lg border border-border bg-secondary/20 p-0.5 gap-0.5 select-none h-8"></div>'));
    const row = card.lastElementChild;
    row.querySelector('[data-k=title]').textContent = TT.title;
    const titleDesc = row.querySelector('[data-k=desc]');
    titleDesc.textContent = TT.desc;
    const titleGroup = row.querySelector('[role=group]');
    for (const [on, label] of [[true, TT.on], [false, TT.off]]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = BTN;
      b.textContent = label;
      b.setAttribute('aria-pressed', String(on === C.chineseTitles));
      if (on === C.chineseTitles) b.setAttribute('data-pressed', '');
      b.addEventListener('click', () => {
        if (on === C.chineseTitles) return;
        const send = window[C.settingBinding];
        if (typeof send !== 'function') {
          titleDesc.textContent = T.noWatcher;
          return;
        }
        for (const x of titleGroup.children) {
          x.setAttribute('aria-pressed', String(x === b));
          x.toggleAttribute('data-pressed', x === b);
        }
        send(JSON.stringify({ key: 'chineseTitles', value: on })); // watcher writes config.json, then re-injects
      });
      titleGroup.appendChild(b);
    }
    return sec;
  }

  // ── About: version + Check for Updates (Settings > Application) ──────
  const A = zh
    ? {
        heading: '关于', version: '版本', check: '检查更新', install: '安装更新', restart: '重启以更新',
        latest: '已是最新版本', unavailable: '此版本不支持应用内更新', hint: '查看是否有新版本可用',
        states: {
          'checking for updates': '正在检查更新…', 'available for download': '发现新版本，正在准备下载…',
          downloading: '正在下载更新…', downloaded: '更新已下载，可以安装', updating: '正在安装更新…',
          ready: '更新已就绪，重启后生效', error: '检查更新失败，请稍后重试',
        },
      }
    : {
        heading: 'About', version: 'Version', check: 'Check for Updates', install: 'Install Update', restart: 'Restart to Update',
        latest: 'You are up to date', unavailable: 'In-app updates are not available in this build', hint: 'See if a newer version is available',
        states: {
          'checking for updates': 'Checking for updates…', 'available for download': 'Update found, preparing download…',
          downloading: 'Downloading update…', downloaded: 'Update downloaded, ready to install', updating: 'Installing update…',
          ready: 'Update ready, restart to finish', error: 'Could not check for updates, try again later',
        },
      };
  const APP_VERSION = (navigator.userAgent.match(/Antigravity\/([\d.]+)/) || [])[1] || '';
  // Same classes as the native secondary buttons ("Open", "Edit") in Settings.
  const ACTION_BTN =
    'inline-flex items-center font-medium transition-colors select-none outline-none cursor-pointer justify-center disabled:opacity-50 bg-secondary text-secondary-foreground hover:text-foreground border-none h-8 text-sm rounded-lg gap-1.5 px-2.5';

  // Preferred: a "Check for Updates" row inside the native "Version" card
  // (right under "App version"). Fallback: a standalone "About" section that
  // also shows the version.
  function buildAboutRow(standalone) {
    const sec = document.createElement('div');
    sec.id = ABOUT_ID;
    sec.className = 'w-full';
    sec.setAttribute('data-ag-no-i18n', '');
    sec.innerHTML =
      '<div class="py-2 px-3 w-full bg-transparent flex justify-between gap-4 items-center">' +
      '<div class="flex-1 flex flex-col gap-0.5"><div class="flex items-center gap-1.5"><span class="text-sm" data-k="title"></span></div>' +
      '<span class="text-xs text-muted-foreground whitespace-pre-wrap" data-k="desc"></span></div>' +
      '<div class="shrink-0"><button type="button"></button></div></div>';
    sec.querySelector('[data-k=title]').textContent = standalone ? 'Antigravity' : A.check;
    const prefix = standalone ? A.version + ' ' + APP_VERSION : '';
    const desc = sec.querySelector('[data-k=desc]');
    const btn = sec.querySelector('button');
    btn.className = ACTION_BTN;
    const updater = window.electronUpdater;
    let checkedAt = 0; // when the user last clicked "check"
    let poll = null;

    async function stateType() {
      try {
        const s = await updater.getState();
        return (s && s.type) || 'idle';
      } catch {
        return 'idle';
      }
    }
    async function render() {
      if (!sec.isConnected && poll) clearInterval(poll);
      let status = '';
      let type = 'idle';
      if (!updater) {
        status = A.unavailable;
      } else {
        type = await stateType();
        const justClicked = Date.now() - checkedAt < 1500; // state may not have left "idle" yet
        if (type === 'idle') status = checkedAt ? (justClicked ? A.states['checking for updates'] : A.latest) : '';
        else status = A.states[type] || type;
      }
      if (!status && !standalone) status = A.hint;
      desc.textContent = [prefix, status].filter(Boolean).join(' · ');
      btn.textContent = type === 'downloaded' ? A.install : type === 'ready' ? A.restart : A.check;
      btn.disabled = !updater || ['checking for updates', 'downloading', 'updating'].includes(type);
      return type;
    }
    btn.addEventListener('click', async () => {
      if (!updater) return;
      const type = await stateType();
      if (type === 'downloaded') updater.applyUpdate();
      else if (type === 'ready') updater.quitAndInstall(); // user asked: restart into the new version
      else {
        checkedAt = Date.now();
        updater.checkForUpdates(true); // same call as the old title-bar menu item
      }
      clearInterval(poll);
      let n = 0;
      poll = setInterval(() => {
        if (++n > 180 || !sec.isConnected) clearInterval(poll);
        render();
      }, 1000);
      render();
    });
    render();
    return sec;
  }

  function buildAboutSection() {
    const wrap = document.createElement('div');
    wrap.className = 'space-y-2';
    wrap.setAttribute('data-ag-no-i18n', '');
    wrap.innerHTML =
      '<div class="flex flex-col gap-1"><div class="flex items-center justify-between"><div class="flex items-center gap-1.5"><h3 class="m-0 text-sm font-medium"></h3></div></div></div>' +
      '<div><div class="bg-transparent rounded-xl border border-border overflow-hidden divide-y divide-border"></div></div>';
    wrap.querySelector('h3').textContent = A.heading;
    wrap.querySelector('.divide-y').appendChild(buildAboutRow(true));
    return wrap;
  }

  function ensureAbout() {
    const panel = panelByTitle(C.appTitles || ['Application']);
    if (!panel || panel.querySelector('#' + ABOUT_ID)) return;
    // Anchor on the native "App version" row and join its card.
    const titles = C.versionTitles || ['App version'];
    const label = [...panel.querySelectorAll('span.text-sm')].find((s) => titles.includes(s.textContent.trim()));
    const card = label && label.closest('.divide-y');
    if (card) {
      card.appendChild(buildAboutRow(false));
      return;
    }
    const sections = [...panel.querySelectorAll('div.space-y-2')].filter((s) => !s.id.startsWith('ag-'));
    const last = sections[sections.length - 1];
    if (last) last.parentElement.appendChild(buildAboutSection());
  }

  // ── Gemini: layout + global shortcut (Settings > General) ────────────
  const GEMINI_ID = 'ag-gemini-row';
  const G = zh
    ? {
        heading: 'Gemini',
        intro: 'Antigravity 是本地智能体工作台，可以读写代码、运行终端；Gemini 是 Google 官方网页版，与手机端的对话记录同步。两者可以并行使用，也可以整窗切换。',
        layout: '打开方式', float: '小窗', docked: '全屏切换',
        floatDesc: 'Antigravity 保持常驻，点击左上角的 Gemini 或按快捷键，Gemini 以浮动小窗打开。',
        dockedDesc: '在左上角的下拉菜单中切换，Antigravity 与 Gemini 各自占满整个窗口。',
        hotkey: '快捷键',
        hotkeyDesc: '在任何地方打开或收起 Gemini（全屏切换时为切换模式）。点击右侧按钮后按下新的组合键，Esc 取消，Backspace 关闭快捷键。',
        none: '未设置', recording: '请按下组合键…', needMod: '需要包含 Ctrl、Alt、Shift 或 Win',
        fail: '这个组合键已被其他程序占用，请换一个。', saving: '正在保存…',
      }
    : {
        heading: 'Gemini',
        intro: 'Antigravity is the local agent workspace for code and terminal; Gemini is Google\'s official web app, synced with your phone. Use them side by side, or switch the whole window.',
        layout: 'Layout', float: 'Small window', docked: 'Full window',
        floatDesc: 'Antigravity stays open; the Gemini button (top left) or the shortcut opens Gemini as a floating window.',
        dockedDesc: 'The top-left menu switches the whole window between Antigravity and Gemini.',
        hotkey: 'Shortcut',
        hotkeyDesc: 'Opens or hides Gemini from anywhere (switches modes in full-window layout). Click the button, then press a new combination; Esc cancels, Backspace turns it off.',
        none: 'Not set', recording: 'Press a combination…', needMod: 'Include Ctrl, Alt, Shift or Win',
        fail: 'Another program already uses this combination; pick another.', saving: 'Saving…',
      };
  const keyLabel = (s) => (s ? s.split('+').join(' + ') : G.none);
  // KeyboardEvent.code -> the key names gemini-dock.js understands
  function keyName(code) {
    let m;
    if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
    if ((m = /^Digit([0-9])$/.exec(code))) return m[1];
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    return { Space: 'Space', Backquote: '`', Enter: 'Enter', Tab: 'Tab', Slash: '/', Semicolon: ';', Comma: ',', Period: '.' }[code] || null;
  }
  let hotkeyRowDesc = null;
  let hotkeyState = 'ok';

  function rowHtml(right) {
    return (
      '<div class="w-full"><div class="py-2 px-3 w-full bg-transparent flex justify-between gap-4 items-center">' +
      '<div class="flex-1 flex flex-col gap-0.5"><div class="flex items-center gap-1.5"><span class="text-sm" data-k="title"></span></div>' +
      '<span class="text-xs text-muted-foreground whitespace-pre-wrap" data-k="desc"></span></div>' +
      '<div class="shrink-0">' + right + '</div></div></div>'
    );
  }

  function buildGemini() {
    const g = C.gemini;
    const save = (key, value, descEl) => {
      const send = window[C.settingBinding];
      if (typeof send !== 'function') {
        descEl.textContent = T.noWatcher;
        return;
      }
      descEl.textContent = G.saving;
      send(JSON.stringify({ key, value })); // watcher writes config.json, then re-injects
    };

    const sec = document.createElement('div');
    sec.id = GEMINI_ID;
    sec.className = 'space-y-2';
    sec.setAttribute('data-ag-no-i18n', '');
    sec.innerHTML =
      '<div class="flex flex-col gap-1"><div class="flex items-center justify-between"><div class="flex items-center gap-1.5"><h3 class="m-0 text-sm font-medium"></h3></div></div>' +
      '<div class="text-xs text-muted-foreground leading-relaxed" data-k="intro"></div></div>' +
      '<div><div class="bg-transparent rounded-xl border border-border overflow-hidden divide-y divide-border">' +
      rowHtml('<div role="group" aria-orientation="horizontal" class="inline-flex items-center rounded-lg border border-border bg-secondary/20 p-0.5 gap-0.5 select-none h-8"></div>') +
      rowHtml('<button type="button" data-k="rec"></button>') +
      '</div></div>';
    sec.querySelector('h3').textContent = G.heading;
    sec.querySelector('[data-k=intro]').textContent = G.intro;
    const [layoutRow, hotkeyRow] = sec.querySelectorAll('.divide-y > .w-full');

    // Layout: [ Small window | Full window ]
    layoutRow.querySelector('[data-k=title]').textContent = G.layout;
    const layoutDesc = layoutRow.querySelector('[data-k=desc]');
    layoutDesc.textContent = g.layout === 'float' ? G.floatDesc : G.dockedDesc;
    const group = layoutRow.querySelector('[role=group]');
    for (const [id, label] of [['float', G.float], ['docked', G.docked]]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = BTN;
      b.textContent = label;
      b.setAttribute('aria-pressed', String(id === g.layout));
      if (id === g.layout) b.setAttribute('data-pressed', '');
      b.addEventListener('click', () => {
        if (id === g.layout) return;
        for (const x of group.children) {
          x.setAttribute('aria-pressed', String(x === b));
          x.toggleAttribute('data-pressed', x === b);
        }
        save('geminiLayout', id, layoutDesc);
      });
      group.appendChild(b);
    }

    // Shortcut recorder
    hotkeyRow.querySelector('[data-k=title]').textContent = G.hotkey;
    const desc = hotkeyRow.querySelector('[data-k=desc]');
    hotkeyRowDesc = desc;
    const rec = hotkeyRow.querySelector('[data-k=rec]');
    rec.className = ACTION_BTN + ' font-mono';
    rec.textContent = keyLabel(g.hotkey);
    const paintDesc = () => {
      desc.textContent = G.hotkeyDesc + (hotkeyState === 'fail' && g.hotkey ? '\n' + G.fail : '');
    };
    paintDesc();
    let recording = false;
    const stop = () => {
      recording = false;
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onAway, true);
      rec.textContent = keyLabel(g.hotkey);
    };
    const onAway = (e) => {
      if (e.target !== rec) stop();
    };
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation(); // keep Antigravity's own shortcuts out while recording
      if (e.key === 'Escape') return stop();
      if (e.key === 'Backspace' || e.key === 'Delete') {
        stop();
        rec.textContent = G.none;
        return save('geminiHotkey', '', desc);
      }
      const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win'].filter(Boolean);
      const key = keyName(e.code);
      if (!key) {
        rec.textContent = mods.length ? mods.join(' + ') + ' + …' : G.recording;
        return;
      }
      if (!mods.length) {
        rec.textContent = G.needMod;
        return;
      }
      const combo = mods.concat(key).join('+');
      stop();
      rec.textContent = keyLabel(combo);
      if (combo !== g.hotkey) save('geminiHotkey', combo, desc);
    };
    rec.addEventListener('click', () => {
      if (recording) return stop();
      recording = true;
      rec.textContent = G.recording;
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('pointerdown', onAway, true);
    });
    sec._paintHotkeyDesc = paintDesc;
    return sec;
  }

  function panelByTitle(titles) {
    for (const h2 of document.querySelectorAll('[role="dialog"] h2')) {
      if (titles.includes(h2.textContent.trim())) return h2.closest('div.p-6') || null;
    }
    return null;
  }

  function appendSection(panel, id, buildFn) {
    if (!panel || panel.querySelector('#' + id)) return;
    const sections = [...panel.querySelectorAll('div.space-y-2')].filter((s) => !s.id.startsWith('ag-'));
    const last = sections[sections.length - 1];
    if (last) last.parentElement.appendChild(buildFn());
  }

  // ── Color style: Clay / Classic (Settings > Appearance) ──────────────
  const STYLE_ID = 'ag-style-row';
  const S = zh
    ? {
        heading: '配色风格', title: '风格', clay: '陶土', classic: '经典',
        clayDesc: '米白与炭灰底色，陶土红强调色。',
        classicDesc: '和 Claude Code 应用一致的白色与深色，蓝色选中和链接。',
        hint: '浅色、深色各有一套，跟随上方的主题切换。',
      }
    : {
        heading: 'Color Style', title: 'Style', clay: 'Clay', classic: 'Classic',
        clayDesc: 'Ivory and charcoal surfaces with clay-red accents.',
        classicDesc: 'Neutral white and dark like the Claude Code app, blue selection and links.',
        hint: 'Each has a light and a dark palette, following the theme above.',
      };
  function buildStyle() {
    const sec = document.createElement('div');
    sec.id = STYLE_ID;
    sec.className = 'space-y-2';
    sec.setAttribute('data-ag-no-i18n', '');
    sec.innerHTML =
      '<div class="flex flex-col gap-1"><div class="flex items-center justify-between"><div class="flex items-center gap-1.5"><h3 class="m-0 text-sm font-medium"></h3></div></div>' +
      '<div class="text-xs text-muted-foreground leading-relaxed" data-k="intro"></div></div>' +
      '<div><div class="bg-transparent rounded-xl border border-border overflow-hidden divide-y divide-border">' +
      rowHtml('<div role="group" aria-orientation="horizontal" class="inline-flex items-center rounded-lg border border-border bg-secondary/20 p-0.5 gap-0.5 select-none h-8"></div>') +
      '</div></div>';
    sec.querySelector('h3').textContent = S.heading;
    sec.querySelector('[data-k=intro]').textContent = S.hint;
    const row = sec.querySelector('.divide-y > .w-full');
    row.querySelector('[data-k=title]').textContent = S.title;
    const desc = row.querySelector('[data-k=desc]');
    desc.textContent = C.themeStyle === 'classic' ? S.classicDesc : S.clayDesc;
    const group = row.querySelector('[role=group]');
    for (const [id, label] of [['clay', S.clay], ['classic', S.classic]]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = BTN;
      b.textContent = label;
      b.setAttribute('aria-pressed', String(id === C.themeStyle));
      if (id === C.themeStyle) b.setAttribute('data-pressed', '');
      b.addEventListener('click', () => {
        if (id === C.themeStyle) return;
        const send = window[C.settingBinding];
        if (typeof send !== 'function') {
          desc.textContent = T.noWatcher;
          return;
        }
        for (const x of group.children) {
          x.setAttribute('aria-pressed', String(x === b));
          x.toggleAttribute('data-pressed', x === b);
        }
        desc.textContent = id === 'classic' ? S.classicDesc : S.clayDesc;
        // switch at once; the watcher then saves config.json and re-injects
        document.documentElement.setAttribute('data-ag-style', id);
        send(JSON.stringify({ key: 'themeStyle', value: id }));
      });
      group.appendChild(b);
    }
    return sec;
  }

  function ensure() {
    const general = panelByTitle(C.generalTitles);
    appendSection(general, ID, build);
    if (C.gemini) appendSection(general, GEMINI_ID, buildGemini);
    appendSection(panelByTitle(C.appearanceTitles || ['Appearance']), STYLE_ID, buildStyle);
    ensureAbout();
  }

  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued || !document.querySelector('[role="dialog"]')) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      ensure();
    });
  });
  observer.observe(document, { childList: true, subtree: true });
  if (document.body) ensure();

  window.__agLangRow = {
    // the helper's report on the global shortcut: ok | fail | off
    hotkeyStatus(s) {
      hotkeyState = s;
      document.getElementById(GEMINI_ID)?._paintHotkeyDesc?.();
    },
    destroy() {
      observer.disconnect();
      document.querySelectorAll('#' + ID + ', #' + ABOUT_ID + ', #' + GEMINI_ID + ', #' + STYLE_ID).forEach((n) => {
        const section = n.closest('div.space-y-2');
        // a standalone About section is ours entirely; a row inside the
        // native Version card is removed on its own
        (section && section.querySelector('h3')?.textContent === A.heading ? section : n).remove();
      });
      delete window.__agLangRow;
    },
  };
}

// ---------------------------------------------------------------------------
// Everything below runs inside the Antigravity page (serialized via toString).
function pageMain(L) {
  if (window.__agI18n) window.__agI18n.revert();

  // Never translate inside these: code, editing surfaces, raw markup.
  const HARD = [
    'script', 'style', 'noscript', 'svg', 'iframe',
    'code', 'pre', 'kbd', 'samp', 'textarea', 'input', 'select',
    '[contenteditable="true"]', '.monaco-editor', '.xterm', '.font-mono',
    '[data-ag-no-i18n]',
  ].join(',');
  // Chat content: its text is never translated, but buttons inside it (a
  // code block's "Copy code", the user bubble's hover toolbar) are UI.
  const CONTENT = [
    '[data-testid="planner-response-text"]',
    '[data-testid="user-input-step"] .bg-card',
    '[class*="_code:not(pre_code)"]', // the markdown renderer's container
    '.prose', '.markdown',
  ].join(',');
  // Names the user or agent chose: only relative times ("5d") are converted.
  const NAMES = [
    '[data-testid="conversation-row-sidebar"]',
    '[data-testid="breadcrumb-segment"]',
    '[data-testid="project-header"]',
    '[data-project-label]',
  ].join(',');
  const ATTRS = ['placeholder', 'aria-label', 'title', 'data-placeholder', 'data-tooltip-content'];

  const DICT = L.dict;
  const has = Object.prototype.hasOwnProperty;
  const compile = (list) => list.map(([src, flags, to]) => ({ re: new RegExp(src, flags), to }));
  const RULES = compile(L.rules);
  const TIME = compile(L.timeRules);

  // Fragmented sentences ("Type <code>/</code> and select …"): a fragment is
  // translated by its sentence's own table when an ancestor's original text
  // is that sentence. Lets "Type" be a verb here and a noun elsewhere.
  const SENTENCES = new Map((L.sentences || []).map(([text, parts]) => [text, parts]));
  const FRAGS = new Set((L.sentences || []).flatMap(([, parts]) => Object.keys(parts)));

  const UNIT = {
    s: '秒', sec: '秒', second: '秒', m: '分', min: '分钟', minute: '分钟',
    h: '小时', hour: '小时', d: '天', day: '天', w: '周', week: '周',
    mo: '个月', month: '个月', y: '年', year: '年',
  };
  const TOKEN = /(\d+)\s*(months?|mo|weeks?|w|days?|d|hours?|h|minutes?|mins?|m|seconds?|secs?|s|years?|y)\b/g;
  // "4m 12s" -> "4分12秒", "7m" -> "7分钟", "6 days, 22 hours" -> "6天22小时";
  // null when the text is anything other than a duration.
  function duration(text) {
    const parts = [...text.matchAll(TOKEN)];
    if (!parts.length || text.replace(TOKEN, '').replace(/,|\band\b/g, '').trim()) return null;
    if (parts.length === 1 && parts[0][2] === 'm') return parts[0][1] + '分钟';
    return parts.map((p) => p[1] + (UNIT[p[2]] || UNIT[p[2].replace(/s$/, '')])).join('');
  }
  // A dictionary value is a string, or { '*': default, '<selector>': value }
  // for words whose meaning depends on where they appear.
  function lookup(text, el) {
    if (!has.call(DICT, text)) return null;
    const v = DICT[text];
    if (typeof v === 'string') return v;
    for (const sel in v) if (sel !== '*' && el && el.closest(sel)) return v[sel];
    return v['*'] ?? null;
  }
  // $1 = group as-is, $D1 = group as a duration, $T1 = group through the
  // dictionary. If a $D/$T group can't be converted the whole rule is skipped,
  // so "Delete {name}" never becomes half-Chinese for a user-chosen name.
  const CJK_LATIN = /([㐀-鿿])([A-Za-z])|([A-Za-z])([㐀-鿿])/g;
  function applyRule(rule, m, el) {
    let failed = false;
    let composed = false;
    const out = rule.to.replace(/\$([DT]?)(\d)/g, (_, kind, i) => {
      const g = m[+i] ?? '';
      if (kind === 'T') {
        composed = true;
        const v = lookup(g, el) ?? lookup(g.charAt(0).toUpperCase() + g.slice(1), el);
        if (v == null) failed = true;
        return v ?? g;
      }
      if (kind !== 'D') return g;
      const v = duration(g);
      if (v == null) failed = true;
      return v ?? g;
    });
    if (failed) return null;
    // "删除" + "MCP 服务器" -> "删除 MCP 服务器" (space between CJK and Latin)
    return composed ? out.replace(CJK_LATIN, (_, a, b, c, d) => (a ? a + ' ' + b : c + ' ' + d)) : out;
  }
  function originalText(el) {
    let s = '';
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const rec = texts.get(w.currentNode);
      s += rec && w.currentNode.nodeValue === rec.t ? rec.o : w.currentNode.nodeValue;
    }
    return s.replace(/\s+/g, ' ').trim();
  }
  function fromSentence(text, el) {
    if (!FRAGS.has(text)) return null;
    for (let e = el, i = 0; e && i < 3; e = e.parentElement, i++) {
      const parts = SENTENCES.get(originalText(e));
      if (parts && has.call(parts, text)) return parts[text];
    }
    return null;
  }
  function convert(text, zone, el) {
    if (zone === 2) {
      const s = el && fromSentence(text, el);
      if (s != null) return s;
    }
    if (zone === 2) {
      const d = lookup(text, el);
      if (d != null) return d;
    }
    for (const rule of zone === 2 ? RULES.concat(TIME) : TIME) {
      const m = text.match(rule.re);
      if (m) return applyRule(rule, m, el);
    }
    return null;
  }

  // 0 = skip, 1 = names (times only), 2 = full UI translation.
  // Controls nested inside a names container (a row's Pin / Archive / More
  // buttons) are UI, so they get full translation; the container itself
  // (e.g. the project header, which is a button) stays protected.
  const CONTROLS = 'button,[role="button"],[role="menuitem"]';
  function zoneOf(el) {
    if (!el) return 0;
    const hard = el.closest(HARD);
    if (hard) {
      // a code block's header buttons ("Copy code") are UI too
      const ctl = el.closest(CONTROLS);
      return ctl && hard.contains(ctl) ? 2 : 0;
    }
    const content = el.closest(CONTENT);
    if (content) {
      const ctl = el.closest(CONTROLS);
      return ctl && content.contains(ctl) ? 2 : 0;
    }
    const names = el.closest(NAMES);
    if (!names) return 2;
    const ctl = el.closest(CONTROLS);
    return ctl && ctl !== names && names.contains(ctl) ? 2 : 1;
  }

  const texts = new Map(); // Text node -> { o: original, t: translated }
  const attrs = new Map(); // Element -> { [attr]: { o, t } }

  function doText(node) {
    const cur = node.nodeValue;
    const rec = texts.get(node);
    if (rec && cur === rec.t) return; // our own write
    const trimmed = cur.trim();
    if (!trimmed || trimmed.length > 300 || !/[A-Za-z]/.test(trimmed)) {
      if (rec) texts.delete(node);
      return;
    }
    const out = convert(trimmed, zoneOf(node.parentElement), node.parentElement);
    if (out == null || out === trimmed) {
      if (rec) texts.delete(node);
      return;
    }
    const next = cur.replace(trimmed, () => out);
    texts.set(node, { o: cur, t: next });
    node.nodeValue = next;
  }

  function doAttrs(el, only) {
    let zone = -1;
    for (const name of only ? [only] : ATTRS) {
      const cur = el.getAttribute(name);
      if (cur == null) continue;
      const recs = attrs.get(el);
      const rec = recs && recs[name];
      if (rec && cur === rec.t) continue;
      if (zone < 0) zone = zoneOf(el);
      const trimmed = cur.trim();
      const out = zone && trimmed ? convert(trimmed, zone, el) : null;
      if (out == null || out === trimmed) {
        if (rec) delete recs[name];
        continue;
      }
      const next = cur.replace(trimmed, () => out);
      (recs || attrs.set(el, {}).get(el))[name] = { o: cur, t: next };
      el.setAttribute(name, next);
    }
  }

  // Content subtrees are not descended into (streaming replies stay cheap);
  // only the controls inside them are visited.
  function walkControlsIn(el) {
    for (const ctl of el.querySelectorAll(CONTROLS)) walk(ctl);
  }
  function walk(root) {
    if (root.nodeType === 3) return doText(root);
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    if (root.nodeType === 1) {
      const fenced = root.closest(HARD) || root.closest(CONTENT);
      if (fenced && !(root.closest(CONTROLS) && fenced.contains(root.closest(CONTROLS)))) {
        return walkControlsIn(root);
      }
      doAttrs(root);
    }
    const contents = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        if (n.nodeType !== 1) return NodeFilter.FILTER_ACCEPT;
        if (n.matches(HARD) || n.matches(CONTENT)) {
          contents.push(n);
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.nodeType === 3) doText(n);
      else doAttrs(n);
    }
    contents.forEach(walkControlsIn);
  }

  function prune() {
    for (const n of texts.keys()) if (!n.isConnected) texts.delete(n);
    for (const el of attrs.keys()) if (!el.isConnected) attrs.delete(el);
  }

  let sincePrune = 0;
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') doText(r.target);
      else if (r.type === 'attributes') doAttrs(r.target, r.attributeName);
      else for (const n of r.addedNodes) walk(n);
    }
    if (++sincePrune > 500) {
      sincePrune = 0;
      prune();
    }
  });
  // Observing the Document (not <html>) also works at document start, before
  // <html> exists — that is when the watcher's reload hook runs this.
  observer.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRS,
  });
  walk(document);

  function revert() {
    observer.disconnect();
    for (const [n, r] of texts) if (n.nodeValue === r.t) n.nodeValue = r.o;
    for (const [el, recs] of attrs) {
      for (const name in recs) if (el.getAttribute(name) === recs[name].t) el.setAttribute(name, recs[name].o);
    }
    texts.clear();
    attrs.clear();
    if (window.__agI18n === api) delete window.__agI18n;
  }

  // Debug helper: visible UI strings that are still English.
  function missing() {
    const seen = new Set();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const n = w.currentNode;
      const t = n.nodeValue.trim();
      if (!/[A-Za-z]{2}/.test(t) || texts.has(n)) continue;
      if (zoneOf(n.parentElement) !== 2 || !n.parentElement.getClientRects().length) continue;
      seen.add(t);
    }
    for (const el of document.querySelectorAll('[aria-label],[placeholder],[title]')) {
      for (const a of ['aria-label', 'placeholder', 'title']) {
        const v = el.getAttribute(a);
        if (v && /[A-Za-z]{2}/.test(v) && !(attrs.get(el) || {})[a] && zoneOf(el) === 2) seen.add('@' + a + ': ' + v);
      }
    }
    return [...seen];
  }

  const api = {
    locale: L.locale,
    revert,
    missing,
    stats: () => ({ texts: texts.size, attrs: attrs.size }),
    t: (text) => convert(text, 2, document.body), // debug: translate a string
  };
  window.__agI18n = api;
}

// Page-side cleanup, used by remove.js. Also clears the earlier Gemini
// prototype's observer if it is still attached to a long-lived window.
const REVERT_EXPRESSION = `
  if (window.__agI18n) window.__agI18n.revert();
  if (window.__agLangRow) window.__agLangRow.destroy();
  if (window.__ag_i18n_observer) { try { window.__ag_i18n_observer.disconnect(); } catch (e) {} }
  delete window.__ag_i18n_observer;
  delete window.__ag_i18n_installed;
`;

module.exports = {
  CONFIG_FILE,
  LOCALE_BINDING,
  SETTING_BINDING,
  setSetting,
  readConfig,
  localeFile,
  listLocales,
  setLocale,
  buildI18nScript,
  REVERT_EXPRESSION,
};
