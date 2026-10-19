# Claudized Antigravity

给 Google Antigravity（Windows 版）的非侵入式界面补丁：**Claude Code 风格的明暗主题**、**完整简体中文界面**，以及**和 Antigravity 并行使用的 Gemini 窗口**。

补丁通过 Antigravity 自带的 Chrome DevTools Protocol（CDP）端口在运行时注入，**不修改任何安装文件**，Antigravity 升级不会被破坏，随时可以一键撤销。

> 非官方项目，与 Google、Anthropic 无关。配色参考 Claude Code 的公开界面风格。

[English summary](#english)

## 功能

**主题**
- 浅色（象牙白）/ 深色（炭灰）两套配色，跟随 Antigravity 自身的明暗切换，过渡平滑
- 覆盖聊天区、侧栏、卡片、代码高亮（Prism）以及内嵌的 VS Code 编辑器、Diff、终端和菜单
- 阅读区使用衬线字体，中文回退到霞鹜文楷；思考链的行距更紧凑
- 隐藏标题栏右侧的 File / View / Window 菜单

**简体中文**
- 约 1,550 条词条，外加模板规则（如「思考中 3 秒」「复制项目名称」），按语境区分同词异义（如订阅里的 Plan →「套餐」，Agent 里的 Plan →「计划」）
- 只翻译界面控件，不碰对话内容、代码和输入框；翻译可逆，切回英文即时还原
- 设置 → 常规 → **语言** 可切换「简体中文 / English」
- **中文对话标题**：Antigravity 生成标题的提示词写死在语言服务里（"3-5 words, title-cased"），中文对话也常常得到英文标题。新对话的第一条消息是中文而标题是英文时，补丁让你当前选择的模型把这个英文标题翻译成中文（约 10–25 秒），失败时退回用第一句。只处理开启后新建的对话，每个对话只改一次，手动改过的标题不会被覆盖。可在设置 → 常规 → 语言中关闭
- **隐藏插件项目**：带后台小程序（sidecar）的插件会自带一个空项目，例如 Science 插件的 `science/biomolecular_structure_viewer`。删除后插件重启又会重新登记，所以删不掉。补丁从 `~/.gemini/config/config.json` 的 `sidecars` 读出这些项目，在侧栏、设置和项目选择器里隐藏，不影响插件本身

**Gemini 窗口**（需要 Microsoft Edge）
- 使用独立的 Edge 配置目录登录 Google，登录状态持久保存，不影响你自己的 Edge
- 两种打开方式，在设置 → 常规 → **Gemini** 中选择：
  - **小窗**（默认）：左上角 Gemini 按钮或全局快捷键（默认 `Ctrl+Alt+G`，可自定义）打开浮动小窗。隐藏了 Edge 顶栏；鼠标移到小窗顶边出现拖动条和「— / ×」，右下角可拖动缩放
  - **全屏切换**：鼠标悬停左上角，在下拉菜单里切换 Antigravity / Gemini。Gemini 铺满 Antigravity 内容区，标题栏颜色同步 Gemini（包括展开侧栏时的双色标题栏）
- Antigravity 退出时 Gemini 窗口自动隐藏
- 开机或重启后第一次打开 Gemini 时，页面可能抢在 Google 续期登录凭证之前加载而显示未登录；补丁会在 Edge 启动约 6 秒后自动刷新一次（仅当 Gemini 是当前窗口时），无需重新登录

**其他**
- 「版本」与「检查更新」移到 设置 → 应用 的版本卡片里
- 守护模式：Antigravity 重启、刷新、开新窗口后自动重新注入；修改 `theme.css` / `config.json` / 语言文件后热更新

## 环境要求

- Windows 10 / 11
- [Node.js](https://nodejs.org/) 22 或更高（使用内置的 `fetch` 与 `WebSocket`，无需 `npm install`）
- Google Antigravity。它默认开启 CDP 端口（`%APPDATA%\Antigravity\DevToolsActivePort`），无需额外启动参数
- Microsoft Edge：仅 Gemini 窗口需要
- 可选字体：[霞鹜文楷 LXGW WenKai](https://github.com/lxgw/LxgwWenKai)（Regular + Medium）。安装后需**完全退出** Antigravity（托盘里也要退出）再打开才会生效。未安装时回退到微软雅黑

## 安装

```bat
git clone https://github.com/AlexByoung/Claudized-Antigravity.git %USERPROFILE%\.antigravity-patch
cd %USERPROFILE%\.antigravity-patch
copy config.example.json config.json
```

然后任选一种运行方式：

| 文件 | 作用 |
| --- | --- |
| `watch.bat` | 后台启动守护进程（推荐）。日志在 `watch.log` |
| `autostart-on.bat` | 开机自动启动守护进程（在「启动」文件夹建快捷方式） |
| `autostart-off.bat` | 取消开机启动 |
| `inject.bat` | 单次注入（窗口刷新后失效，调试用） |
| `remove.bat` | 停止守护进程、关闭 Gemini 窗口、撤销所有注入 |

也可以用 `npm run watch` / `npm run inject` / `npm run remove`。

第一次打开 Gemini 时，在弹出的 Edge 窗口里登录 Google 账号即可。Google 不允许在内嵌浏览器里登录，所以这里用的是真正的 Edge 窗口。

## 配置

`config.json` 不纳入版本控制。缺省时全部使用默认值，大部分选项也能在 Antigravity 设置页里直接修改：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `translate` | `true` | 是否翻译界面 |
| `locale` | `"zh-CN"` | 语言文件 `locale.<locale>.js` |
| `chineseTitles` | `true` | 新对话首条消息为中文时，把英文标题翻译成中文 |
| `hidePluginProjects` | `true` | 隐藏插件 sidecar 自带的空项目 |
| `geminiMode` | `true` | 设为 `false` 关闭 Gemini 功能 |
| `geminiLayout` | `"float"` | `float` 小窗 / `docked` 全屏切换 |
| `geminiHotkey` | `"Ctrl+Alt+G"` | 小窗快捷键；空字符串表示不注册 |
| `geminiUrl` | `"https://gemini.google.com/app"` | Gemini 打开的地址 |
| `geminiEngine` | `"edge"` | 保持 `edge`。`webview` 是实验选项，Google 会拒绝在其中登录 |

Gemini 的 Edge 配置目录：`%LOCALAPPDATA%\AntigravityPatch\EdgeGemini`。删除它即可清除登录状态。

## 文件结构

| 文件 | 说明 |
| --- | --- |
| `inject.js` | 入口：单次注入 / 守护模式，处理页面回调、热更新 |
| `cdp.js` | CDP 连接、注入表达式、撤销表达式 |
| `theme.css` | 主题（1 浅色 · 2 深色 · 3 组件 · 4 代码高亮 · 5 VS Code · 6 字体 · 7 标题栏） |
| `i18n.js` | 翻译引擎、设置页「语言」「Gemini」「检查更新」行 |
| `locale.zh-CN.js` | 简体中文词库 |
| `modes.js` | 左上角 Gemini 按钮 / 切换下拉菜单 |
| `titles.js` | 中文对话标题 |
| `projects.js` | 隐藏插件 sidecar 项目 |
| `gemini-dock.js` + `dock.ps1` | Edge 窗口的启动、停靠、小窗外框和全局快捷键（Win32） |
| `remove.js` | 撤销 |

### 添加语言

复制 `locale.zh-CN.js` 为 `locale.<代码>.js`，修改 `label` 和词条，它会自动出现在设置页的语言列表中。

## 安全说明

- 注入只在本机回环地址（`127.0.0.1`）上的 CDP 端口进行
- 补丁不会把非法值写进 Antigravity 的 `localStorage`；所有注入都是幂等的，可以完整撤销
- 设置页只能写入白名单内的键值（语言、中文标题开关、Gemini 打开方式、快捷键）
- 中文标题功能只在 `localStorage` 的独立键 `agPatch.titles` 中记录处理过的对话，撤销时一并清除
- 翻译标题用的是一次性的智能体运行：模型只看到英文标题，看不到你的消息；使用只读规划模式、关闭命令自动执行；出现任何工具调用立即中止；运行结束后删除，全程不在侧栏显示

## 已知限制

- 中文标题是对 Antigravity 英文标题的翻译，每个新对话会多一次简短的模型调用，消耗少量额度
- 仅支持 Windows
- Antigravity 更新改动界面结构后，个别样式或词条可能失效，需要跟进更新
- 全屏切换模式在浅色主题下测试较少，欢迎反馈

## 致谢

本项目受 X（Twitter）上 [@Arcadia_Bao](https://x.com/Arcadia_Bao) 分享的作品启发，并在其基础上修改扩展而来。感谢原作者。

## 许可

[MIT](LICENSE)。霞鹜文楷字体不随本仓库分发，它使用 SIL Open Font License 1.1。

---

<a id="english"></a>
## English

A runtime patch for Google Antigravity on Windows. It injects over Antigravity's built-in CDP port and never touches the installation.

- **Theme:** Claude Code-style light (ivory) and dark (charcoal) palettes. They cover chat, sidebar, code highlighting and the embedded VS Code views.
- **Simplified Chinese UI:** about 1,550 strings plus template and context rules. Only controls are translated, never chat content or code. Switch languages in Settings → General → Language.
- **Chinese conversation titles:** Antigravity often titles Chinese conversations in English. The patch has the selected model translate that title in a short read-only throwaway run, which sees only the title. If the run fails, it falls back to the first sentence. It runs once per new conversation and never overrides a title you set.
- **Plugin sidecar projects hidden:** plugins with a sidecar come with an empty project that re-registers itself after deletion. These projects are hidden from the sidebar, Settings and project pickers.
- **Gemini window (needs Microsoft Edge):** a real Edge window with its own profile, so Google sign-in works. There are two layouts:
  - *Float* (default): a floating window opened by the top-left button or `Ctrl+Alt+G`. Hover its top edge to move, hide or close it; drag the bottom-right corner to resize.
  - *Docked*: a hover menu switches the whole content area between Antigravity and Gemini. The title bar takes Gemini's colours.

Requirements: Windows 10/11, Node.js ≥ 22, and Antigravity. Microsoft Edge is needed for Gemini. LXGW WenKai is optional.

Install: clone into `%USERPROFILE%\.antigravity-patch`, copy `config.example.json` to `config.json`, then run `watch.bat`. Run `autostart-on.bat` to start the watcher at login. `remove.bat` reverts everything.

Inspired by and built upon the work shared by [@Arcadia_Bao](https://x.com/Arcadia_Bao) on X. Thanks to the original author.

Not affiliated with Google or Anthropic. MIT licensed.
