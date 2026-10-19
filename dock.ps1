# Shows Gemini (a Microsoft Edge app window, dedicated profile) next to or
# inside Antigravity. Started by inject.js (watch mode).
#
# Layouts
#   float  (default)  a small floating window. Edge's own title bar is hidden;
#                     hovering its top edge shows a slim bar (drag to move,
#                     "-" hides, "x" closes), its bottom-right corner a resize grip.
#   docked            fills Antigravity's content area below its title bar.
# In both, the window is borderless and clipped with a window region, so only
# the page shows (Edge runs with --disable-direct-composition: otherwise the
# region would not clip its output). It is owned by Antigravity's window:
# stays above it, minimizes with it, no taskbar button.
#
# stdin commands, one per line:
#   show [topPx]          show Gemini; topPx = Antigravity title bar height (px)
#   hide                  hide it (it keeps running: login, drafts stay)
#   toggle                small window: show it, or hide it if it is active
#   top <px>              title bar height changed (display scale)
#   cut x y w h [r]       docked: cut a (rounded) hole for a menu Antigravity
#                         opens over Gemini; "cut" alone closes it
#   layout float|docked
#   hotkey <mods> <vk>    global shortcut (mods: Alt 1, Ctrl 2, Shift 4, Win 8); 0 0 = off
#   quit                  close the Gemini window and exit
# stdout events: ready | shown | hidden | closed | error <msg>
#   | colors #LEFT #RIGHT <split> (Gemini's sidebar / header colors along its top row)
#   | hotkey-ok | hotkey-fail | hotkey-off | hotkey-pressed (docked layout)
# stdin EOF, or the watcher process (-ParentPid) gone: hide Gemini and exit,
# so the window, its login and drafts survive and get reused.
# -Close: close an existing Gemini window gracefully and exit (remove.js).
param(
  [Parameter(Mandatory = $true)][string]$EdgePath,
  [Parameter(Mandatory = $true)][string]$ProfileDir,
  [Parameter(Mandatory = $true)][string]$Url,
  [int]$ParentPid = 0,
  [switch]$Close
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class GeminiDock {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int val, int size);
  [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("gdi32.dll")] static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h);
  [DllImport("gdi32.dll")] static extern int CombineRgn(IntPtr dst, IntPtr a, IntPtr b, int mode);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
  [DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw);
  [DllImport("user32.dll")] static extern int GetWindowRgnBox(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc, int x, int y);
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);

  struct RECT { public int L, T, R, B; }
  struct POINT { public int X, Y; }

  const int GWL_STYLE = -16, GWL_EXSTYLE = -20, GWLP_HWNDPARENT = -8;
  const long WS_CAPTION = 0x00C00000, WS_THICKFRAME = 0x00040000, WS_SYSMENU = 0x00080000,
             WS_MINIMIZEBOX = 0x00020000, WS_MAXIMIZEBOX = 0x00010000;
  const long WS_EX_APPWINDOW = 0x00040000, WS_EX_TOOLWINDOW = 0x00000080;
  const uint SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20, SWP_NOOWNERZORDER = 0x200;
  const int SW_HIDE = 0, SW_SHOW = 5, SW_RESTORE = 9;
  const uint WM_CLOSE = 0x10;
  const int WM_HOTKEY = 0x0312, HOTKEY_ID = 1;

  static readonly ConcurrentQueue<string> commands = new ConcurrentQueue<string>();
  static IntPtr gemini = IntPtr.Zero, owner = IntPtr.Zero;
  static string layout = "float";
  static string adoptedAs = null;   // layout the current window was styled for
  static bool shown = false;
  static int shownTicks = 0;        // ticks since the last show (page-content check)
  static bool nudged = false;       // one hide/show cycle already tried for this show
  static int topPx = 70;            // Antigravity's title bar height (physical px)
  // Where Edge's page content sits inside its window: top = Edge's own app
  // title bar, the others its (unpainted) borders. null = not measured yet.
  static RECT? insets = null;
  static RECT lastRect;             // visible page rect last applied (screen px)
  static bool regionDirty = false;
  static RECT? hole = null;         // docked: menu hole, Antigravity client px
  static int holeRadius = 0;
  static RECT floatV;               // float: visible page rect (screen px)
  static bool floatVSet = false;
  static string lastColors = null;
  static uint headerColor = 0xF9F8F8; // COLORREF, for the hover bar

  // stdout may be a broken pipe once the watcher is gone; never let that throw.
  static void Emit(string s) {
    try { Console.Out.WriteLine(s); Console.Out.Flush(); } catch { }
  }

  static string Text(IntPtr h, bool cls) {
    var sb = new StringBuilder(256);
    if (cls) GetClassName(h, sb, sb.Capacity); else GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }

  static double Scale(IntPtr h) {
    uint dpi = h != IntPtr.Zero ? GetDpiForWindow(h) : 0;
    return dpi > 0 ? dpi / 96.0 : 1.0;
  }

  // ── Finding windows ───────────────────────────────────────────────────
  // Largest titled Chromium top-level window among the given processes.
  static IntPtr FindWindow(HashSet<uint> pids, string titleContains, bool includeHidden) {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid) || Text(h, true) != "Chrome_WidgetWin_1") return true;
      string title = Text(h, false);
      if (title.Length == 0 || (titleContains != null && title.IndexOf(titleContains, StringComparison.OrdinalIgnoreCase) < 0)) return true;
      if (!includeHidden && !IsWindowVisible(h)) return true;
      RECT r; GetWindowRect(h, out r);
      long area = (long)(r.R - r.L) * (r.B - r.T);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  static HashSet<uint> Pids(string name, string cmdContains) {
    var set = new HashSet<uint>();
    string q = "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='" + name + "'";
    using (var s = new ManagementObjectSearcher(q))
      foreach (ManagementObject o in s.Get()) {
        string cmd = (o["CommandLine"] as string) ?? "";
        if (cmdContains == null || cmd.IndexOf(cmdContains, StringComparison.OrdinalIgnoreCase) >= 0)
          set.Add((uint)o["ProcessId"]);
      }
    return set;
  }

  // Antigravity's title is the conversation name: take its largest window.
  static IntPtr FindOwner() {
    var pids = new HashSet<uint>();
    foreach (var p in Process.GetProcessesByName("Antigravity")) pids.Add((uint)p.Id);
    return FindWindow(pids, null, false);
  }

  // Hidden windows count (a hidden Gemini must be reused, not relaunched);
  // prefer the one titled Gemini over other windows of the same profile.
  static IntPtr FindGemini(string profileDir) {
    var pids = Pids("msedge.exe", profileDir);
    IntPtr h = FindWindow(pids, "Gemini", true);
    return h != IntPtr.Zero ? h : FindWindow(pids, null, true);
  }

  // ── Placement ─────────────────────────────────────────────────────────
  // Small window: about 440x720 (scaled) along Antigravity's right edge,
  // below its title bar; centered on screen when Antigravity is not open.
  static RECT FloatRect() {
    RECT o = new RECT();
    bool hasOwner = owner != IntPtr.Zero && IsWindow(owner) && GetWindowRect(owner, out o);
    double s = hasOwner ? Math.Max(1.0, Scale(owner)) : Math.Max(1.0, GetSystemMetrics(0) / 1920.0);
    int w = (int)(440 * s), h = (int)(720 * s);
    if (hasOwner) {
      h = Math.Min(h, Math.Max((int)(360 * s), (o.B - o.T) - (int)(120 * s)));
      int x = o.R - w - (int)(24 * s), y = o.T + topPx + (int)(16 * s);
      return new RECT { L = x, T = y, R = x + w, B = y + h };
    }
    int sx = (GetSystemMetrics(0) - w) / 2, sy = (GetSystemMetrics(1) - h) / 2;
    return new RECT { L = sx, T = sy, R = sx + w, B = sy + h };
  }

  // The visible page rect: Antigravity's content area (docked) or floatV.
  static RECT Target() {
    if (layout == "float") return floatV;
    RECT c; GetClientRect(owner, out c);
    POINT p = new POINT(); ClientToScreen(owner, ref p);
    return new RECT { L = p.X, T = p.Y + topPx, R = p.X + c.R, B = p.Y + c.B };
  }

  // Launch straight into place: a window born off-screen is marked occluded
  // by Chromium, which then keeps the page hidden.
  static void Launch(string edge, string profileDir, string url) {
    if (layout == "float" && !floatVSet) { floatV = FloatRect(); floatVSet = true; }
    RECT t = Target();
    string pos = "--window-position=" + t.L + "," + t.T + " --window-size=" + Math.Max(400, t.R - t.L) + "," + Math.Max(300, t.B - t.T);
    string args = "--user-data-dir=\"" + profileDir + "\" --app=\"" + url + "\" --no-first-run --no-default-browser-check --disable-direct-composition " + pos;
    // ShellExecute: Edge must not inherit our stdout/stderr pipes.
    Process.Start(new ProcessStartInfo(edge, args) { UseShellExecute = true });
  }

  // Both layouts: borderless, owned by Antigravity, no taskbar button; the
  // window region (Sync) does the visible shape.
  static void Adopt(bool placeFloat) {
    long style = GetWindowLongPtr(gemini, GWL_STYLE).ToInt64();
    style &= ~(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
    SetWindowLongPtr(gemini, GWL_STYLE, new IntPtr(style));
    long ex = GetWindowLongPtr(gemini, GWL_EXSTYLE).ToInt64();
    ex = (ex & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW;
    SetWindowLongPtr(gemini, GWL_EXSTYLE, new IntPtr(ex));
    SetWindowLongPtr(gemini, GWLP_HWNDPARENT, owner); // IntPtr.Zero when Antigravity is closed
    int noRound = 1; DwmSetWindowAttribute(gemini, 33 /* DWMWA_WINDOW_CORNER_PREFERENCE */, ref noRound, 4);
    if (layout == "float" && (placeFloat || !floatVSet)) { floatV = FloatRect(); floatVSet = true; }
    if (layout == "docked") hole = null;
    lastRect = new RECT();
    insets = null;
    regionDirty = true;
    adoptedAs = layout;
    SetWindowPos(gemini, IntPtr.Zero, 0, 0, 0, 0, SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED | 0x1 | 0x2);
  }

  // Edge draws its app title bar and borders inside the window, so removing
  // the Windows frame does not remove them. Measure them from where the page
  // (the Chrome_RenderWidgetHostHWND child) sits inside the window.
  static RECT? MeasureInsets() {
    RECT w; GetWindowRect(gemini, out w);
    RECT? best = null; int bestArea = 0;
    EnumChildWindows(gemini, (h, l) => {
      if (Text(h, true) != "Chrome_RenderWidgetHostHWND" || !IsWindowVisible(h)) return true;
      RECT r; GetWindowRect(h, out r);
      int area = (r.R - r.L) * (r.B - r.T);
      if (area > bestArea) { bestArea = area; best = new RECT { L = r.L - w.L, T = r.T - w.T, R = w.R - r.R, B = w.B - r.B }; }
      return true;
    }, IntPtr.Zero);
    if (best.HasValue) {
      RECT i = best.Value;
      if (i.L < 0 || i.T < 0 || i.R < 0 || i.B < 0 || i.L > 100 || i.T > 200 || i.R > 100 || i.B > 100) return null;
    }
    return best;
  }

  // Place the window so its page lands exactly on Target(), enlarged by the
  // insets, and clip to the page (rounded in the small window). Chromium
  // resets regions on its own, so the region is re-checked every tick.
  static void Sync() {
    RECT t = Target();
    if (!insets.HasValue) {
      insets = MeasureInsets();
      if (insets.HasValue) lastRect = new RECT();
    }
    RECT n = insets ?? new RECT();
    int tw = Math.Max(0, t.R - t.L), th = Math.Max(0, t.B - t.T);
    int w = tw + n.L + n.R, h = th + n.T + n.B;
    if (t.L != lastRect.L || t.T != lastRect.T || t.R != lastRect.R || t.B != lastRect.B) {
      lastRect = t;
      regionDirty = true;
      SetWindowPos(gemini, IntPtr.Zero, t.L - n.L, t.T - n.T, w, h, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
    }
    if (!insets.HasValue) return;
    RECT box;
    int kind = GetWindowRgnBox(gemini, out box); // 0 = no region
    if (!regionDirty && kind != 0 && box.L == n.L && box.T == n.T && box.R == n.L + tw && box.B == n.T + th) return;
    regionDirty = false;
    IntPtr rgn;
    if (layout == "float") {
      int rad = (int)(10 * Scale(gemini)) * 2;
      rgn = CreateRoundRectRgn(n.L, n.T, n.L + tw + 1, n.T + th + 1, rad, rad);
    } else {
      rgn = CreateRectRgn(n.L, n.T, n.L + tw, n.T + th);
      if (hole.HasValue) {
        // Antigravity client px -> window px: x + insetL, y - titleBar + insetT
        RECT o = hole.Value;
        IntPtr cut = holeRadius > 0
          ? CreateRoundRectRgn(o.L + n.L, o.T - topPx + n.T, o.R + n.L + 1, o.B - topPx + n.T + 1, holeRadius * 2, holeRadius * 2)
          : CreateRectRgn(o.L + n.L, o.T - topPx + n.T, o.R + n.L, o.B - topPx + n.T);
        CombineRgn(rgn, rgn, cut, 4 /* RGN_DIFF */);
        DeleteObject(cut);
      }
    }
    SetWindowRgn(gemini, rgn, true); // the system owns the region afterwards
  }

  // ── Colors ────────────────────────────────────────────────────────────
  static string Hex(uint c) { return string.Format("#{0:X2}{1:X2}{2:X2}", c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF); }

  // Gemini's top row: left edge (its sidebar when open) and right edge (its
  // header). When they differ, binary-search where the sidebar ends.
  static void SampleColors() {
    if (hole.HasValue || !insets.HasValue || lastRect.R - lastRect.L < 40) return;
    IntPtr dc = GetDC(IntPtr.Zero);
    int y = lastRect.T + 3;
    uint left = GetPixel(dc, lastRect.L + 4, y), right = GetPixel(dc, lastRect.R - 8, y);
    int split = 0;
    if (left != right && left != 0xFFFFFFFF && right != 0xFFFFFFFF) {
      int lo = lastRect.L + 4, hi = lastRect.R - 8; // pixel(lo) == left, pixel(hi) != left
      while (hi - lo > 1) { int mid = (lo + hi) / 2; if (GetPixel(dc, mid, y) == left) lo = mid; else hi = mid; }
      split = hi - lastRect.L;
    }
    ReleaseDC(IntPtr.Zero, dc);
    if (left == 0xFFFFFFFF || right == 0xFFFFFFFF) return;
    headerColor = right;
    string s = "colors " + Hex(left) + " " + Hex(right) + " " + split;
    if (s == lastColors) return;
    lastColors = s;
    if (bar != null) bar.SetColors(right);
    if (grip != null) grip.SetColors(right);
    Emit(s);
  }

  // ── Small-window chrome: hover bar + resize grip ──────────────────────
  // Not activating, owned by the Gemini window (so they stay above it).
  public class Chrome : Form {
    readonly bool isGrip;
    int hover = 0, pressed = 0; // 1 = hide, 2 = close
    Color bg = Color.FromArgb(249, 248, 248), fg = Color.FromArgb(31, 31, 31);
    public float S = 1f;
    public Chrome(bool grip) {
      isGrip = grip;
      FormBorderStyle = FormBorderStyle.None;
      ShowInTaskbar = false;
      StartPosition = FormStartPosition.Manual;
      DoubleBuffered = true;
      BackColor = bg;
      if (grip) Cursor = Cursors.SizeNWSE;
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
      get { var cp = base.CreateParams; cp.ExStyle |= 0x80 /* TOOLWINDOW */ | 0x08000000 /* NOACTIVATE */; return cp; }
    }
    public void SetColors(uint colorref) {
      int r = (int)(colorref & 0xFF), g = (int)((colorref >> 8) & 0xFF), b = (int)((colorref >> 16) & 0xFF);
      bg = Color.FromArgb(r, g, b);
      bool dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
      fg = dark ? Color.FromArgb(227, 227, 227) : Color.FromArgb(31, 31, 31);
      BackColor = bg;
      Invalidate();
    }
    int BtnW { get { return (int)(42 * S); } }
    int Hit(int x) { if (isGrip) return 0; if (x >= Width - BtnW) return 2; if (x >= Width - 2 * BtnW) return 1; return 0; }
    protected override void OnPaint(PaintEventArgs e) {
      var g = e.Graphics;
      g.SmoothingMode = SmoothingMode.AntiAlias;
      g.Clear(bg);
      float lw = Math.Max(1f, 1.3f * S);
      if (isGrip) {
        using (var pen = new Pen(Color.FromArgb(150, fg), lw))
          for (int i = 1; i <= 3; i++) { float o = i * 4 * S; g.DrawLine(pen, Width - o, Height - 2 * S, Width - 2 * S, Height - o); }
        return;
      }
      using (var f = new Font("Segoe UI Semibold", 12f * S, FontStyle.Regular, GraphicsUnit.Pixel))
      using (var b = new SolidBrush(Color.FromArgb(200, fg)))
        g.DrawString("Gemini", f, b, 12 * S, (Height - f.GetHeight(g)) / 2);
      for (int i = 1; i <= 2; i++) {
        var r = new RectangleF(Width - (3 - i) * BtnW, 0, BtnW, Height);
        bool closeHot = i == 2 && hover == 2;
        if (hover == i)
          using (var hb = new SolidBrush(closeHot ? Color.FromArgb(196, 43, 28) : Color.FromArgb(30, fg))) g.FillRectangle(hb, r);
        float cx = r.X + r.Width / 2, cy = r.Y + r.Height / 2, k = 5 * S;
        using (var p = new Pen(closeHot ? Color.White : fg, lw)) {
          if (i == 1) g.DrawLine(p, cx - k, cy, cx + k, cy);
          else { g.DrawLine(p, cx - k, cy - k, cx + k, cy + k); g.DrawLine(p, cx - k, cy + k, cx + k, cy - k); }
        }
      }
    }
    protected override void OnMouseMove(MouseEventArgs e) {
      if (dragMode != 0) { DragTo(); return; }
      int h = Hit(e.X);
      if (h != hover) { hover = h; Invalidate(); }
    }
    protected override void OnMouseLeave(EventArgs e) { if (hover != 0) { hover = 0; Invalidate(); } }
    protected override void OnMouseDown(MouseEventArgs e) {
      if (e.Button != MouseButtons.Left) return;
      int h = Hit(e.X);
      if (h != 0) { pressed = h; return; }
      BeginDrag(isGrip ? 2 : 1);
    }
    protected override void OnMouseUp(MouseEventArgs e) {
      if (dragMode != 0) { dragMode = 0; return; }
      if (pressed != 0 && Hit(e.X) == pressed) ChromeAction(pressed);
      pressed = 0;
    }
  }

  static Chrome bar, grip;
  static int dragMode = 0;            // 0 none, 1 move, 2 resize
  static POINT dragStart;
  static RECT dragFrom;
  static DateTime barSeen = DateTime.MinValue, gripSeen = DateTime.MinValue;

  static void BeginDrag(int mode) {
    GetCursorPos(out dragStart);
    dragFrom = floatV;
    dragMode = mode;
  }

  static void DragTo() {
    POINT p; GetCursorPos(out p);
    int dx = p.X - dragStart.X, dy = p.Y - dragStart.Y;
    double s = Scale(gemini);
    if (dragMode == 1) {
      floatV = new RECT { L = dragFrom.L + dx, T = dragFrom.T + dy, R = dragFrom.R + dx, B = dragFrom.B + dy };
    } else {
      floatV = new RECT { L = dragFrom.L, T = dragFrom.T,
        R = Math.Max(dragFrom.L + (int)(320 * s), dragFrom.R + dx),
        B = Math.Max(dragFrom.T + (int)(360 * s), dragFrom.B + dy) };
    }
    Sync();
    PlaceChrome(true, true);
  }

  static void ChromeAction(int action) {
    HideChrome();
    if (action == 1) commands.Enqueue("hide");
    else if (gemini != IntPtr.Zero && IsWindow(gemini)) PostMessage(gemini, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
  }

  static Chrome MakeChrome(bool isGrip) {
    var c = new Chrome(isGrip);
    c.SetColors(headerColor);
    IntPtr h = c.Handle; // create the window now
    return c;
  }

  static Rectangle lastBarBounds;
  static IntPtr chromeOwner = IntPtr.Zero;

  static void PlaceChrome(bool showBar, bool showGrip) {
    double s = Scale(gemini);
    int barH = (int)(30 * s), gs = (int)(18 * s);
    RECT v = floatV;
    if (bar == null) bar = MakeChrome(false);
    if (grip == null) grip = MakeChrome(true);
    bar.S = grip.S = (float)s;
    if (chromeOwner != gemini) {
      foreach (var c in new[] { bar, grip }) SetWindowLongPtr(c.Handle, GWLP_HWNDPARENT, gemini);
      chromeOwner = gemini;
    }
    if (showBar) {
      var nb = new Rectangle(v.L, v.T, v.R - v.L, barH);
      if (nb != lastBarBounds) {
        bar.Bounds = nb;
        int rad = (int)(10 * s) * 2;
        IntPtr hr = CreateRoundRectRgn(0, 0, nb.Width + 1, barH + rad, rad, rad); // round top corners
        bar.Region = Region.FromHrgn(hr);
        DeleteObject(hr);
        lastBarBounds = nb;
      }
      if (!bar.Visible) bar.Show();
    } else if (bar.Visible) bar.Hide();
    if (showGrip) {
      grip.Bounds = new Rectangle(v.R - gs, v.B - gs, gs, gs);
      if (!grip.Visible) grip.Show();
    } else if (grip.Visible) grip.Hide();
  }

  static void HideChrome() {
    if (bar != null && bar.Visible) bar.Hide();
    if (grip != null && grip.Visible) grip.Hide();
  }

  // Reveal the bar when the pointer reaches the top edge of the small window,
  // the grip near its bottom-right corner; hide them shortly after it leaves.
  static void UpdateChrome() {
    if (dragMode != 0) return;
    if (layout != "float" || !shown || gemini == IntPtr.Zero || !IsWindowVisible(gemini) || IsIconic(gemini) || !insets.HasValue) {
      HideChrome();
      return;
    }
    double s = Scale(gemini);
    POINT p; GetCursorPos(out p);
    RECT v = floatV;
    bool inX = p.X >= v.L && p.X < v.R;
    bool overBar = bar != null && bar.Visible && bar.Bounds.Contains(p.X, p.Y);
    bool nearTop = (inX && p.Y >= v.T - (int)(2 * s) && p.Y < v.T + (int)(10 * s)) || overBar;
    bool overGrip = grip != null && grip.Visible && grip.Bounds.Contains(p.X, p.Y);
    bool nearCorner = (p.X >= v.R - (int)(26 * s) && p.X < v.R + (int)(2 * s) && p.Y >= v.B - (int)(26 * s) && p.Y < v.B + (int)(2 * s)) || overGrip;
    DateTime now = DateTime.Now;
    if (nearTop) barSeen = now;
    if (nearCorner) gripSeen = now;
    bool showBar = (now - barSeen).TotalMilliseconds < 450;
    bool showGrip = (now - gripSeen).TotalMilliseconds < 450;
    if (showBar || showGrip || (bar != null && bar.Visible) || (grip != null && grip.Visible)) PlaceChrome(showBar, showGrip);
  }

  // ── Hotkey ────────────────────────────────────────────────────────────
  // Registered on a message-only window, so WM_HOTKEY is dispatched by the
  // same message pump (Application.DoEvents) that drives the chrome.
  class HotkeySink : NativeWindow {
    public HotkeySink() { CreateHandle(new CreateParams { Parent = new IntPtr(-3) /* HWND_MESSAGE */ }); }
    protected override void WndProc(ref Message m) {
      if (m.Msg == WM_HOTKEY) {
        if (layout == "float") commands.Enqueue("toggle");
        else Emit("hotkey-pressed");
      }
      base.WndProc(ref m);
    }
  }
  static HotkeySink sink;

  static void SetHotkey(uint mods, uint vk) {
    if (sink == null) sink = new HotkeySink();
    UnregisterHotKey(sink.Handle, HOTKEY_ID);
    if (mods == 0 || vk == 0) { Emit("hotkey-off"); return; }
    bool ok = RegisterHotKey(sink.Handle, HOTKEY_ID, mods | 0x4000 /* MOD_NOREPEAT */, vk);
    Emit(ok ? "hotkey-ok" : "hotkey-fail"); // fails when another program owns it
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────
  static void Focus() {
    IntPtr fg = GetForegroundWindow();
    uint dummy;
    uint fgThread = GetWindowThreadProcessId(fg, out dummy);
    uint me = GetCurrentThreadId();
    AttachThreadInput(me, fgThread, true);
    SetForegroundWindow(gemini);
    AttachThreadInput(me, fgThread, false);
  }

  static bool Ensure(string edge, string profileDir, string url) {
    if (owner == IntPtr.Zero || !IsWindow(owner)) owner = FindOwner();
    // Docking needs Antigravity's window; the small window works without it.
    if (owner == IntPtr.Zero && layout == "docked") { Emit("error Antigravity window not found"); return false; }
    if (gemini == IntPtr.Zero || !IsWindow(gemini)) {
      gemini = FindGemini(profileDir);
      if (gemini == IntPtr.Zero) {
        Launch(edge, profileDir, url);
        for (int i = 0; i < 100 && gemini == IntPtr.Zero; i++) { Thread.Sleep(150); gemini = FindGemini(profileDir); }
        if (gemini == IntPtr.Zero) { Emit("error Edge window did not appear"); return false; }
      }
      if (IsIconic(gemini)) ShowWindow(gemini, SW_RESTORE);
      Adopt(false);
    } else if (adoptedAs != layout || GetWindowLongPtr(gemini, GWLP_HWNDPARENT) != owner) {
      Adopt(adoptedAs == "docked" && layout == "float"); // layout changed or Antigravity restarted
    }
    return true;
  }

  static void DoShow(string edge, string profileDir, string url) {
    if (!Ensure(edge, profileDir, url)) return;
    Sync();
    ShowWindow(gemini, SW_SHOW);
    Focus();
    shown = true;
    shownTicks = 0;
    nudged = false;
    lastColors = null;     // report the colors again for this show
    hole = null;           // a menu left open from before must not leave a hole
    regionDirty = true;
    Emit("shown");
  }

  static void DoHide(string profileDir) {
    if (gemini == IntPtr.Zero || !IsWindow(gemini)) gemini = FindGemini(profileDir);
    HideChrome();
    if (gemini != IntPtr.Zero && IsWindow(gemini)) ShowWindow(gemini, SW_HIDE);
    if (layout == "docked" && owner != IntPtr.Zero && IsWindow(owner)) SetForegroundWindow(owner);
    shown = false;
    Emit("hidden");
  }

  // Graceful close (WM_CLOSE) so Edge flushes the profile, e.g. a fresh login.
  public static void CloseExisting(string profileDir) {
    IntPtr h = FindGemini(profileDir);
    if (h != IntPtr.Zero) { PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); Emit("closed"); }
    else Emit("none");
  }

  static bool Alive(int pid) {
    try { return !Process.GetProcessById(pid).HasExited; } catch { return false; }
  }

  static void Detach() {
    if (sink != null) UnregisterHotKey(sink.Handle, HOTKEY_ID);
    HideChrome();
    if (gemini != IntPtr.Zero && IsWindow(gemini)) ShowWindow(gemini, SW_HIDE);
  }

  // parentPid: the watcher. stdin EOF is not reliably seen inside PowerShell
  // when it is killed, so the parent is also polled about once a second.
  public static void Run(string edge, string profileDir, string url, int parentPid) {
    SetProcessDpiAwarenessContext(new IntPtr(-4)); // per-monitor v2: physical pixels everywhere
    // A broken stdin pipe throws instead of returning null; any error counts
    // as end of input (an unhandled exception here would kill the process
    // before it could hide Gemini).
    var reader = new Thread(() => {
      try {
        string line;
        while ((line = Console.In.ReadLine()) != null) commands.Enqueue(line.Trim());
      } catch { }
      commands.Enqueue("detach");
    }) { IsBackground = true };
    reader.Start();
    Emit("ready");

    int tick = 0;
    while (true) {
      tick++;
      if (parentPid > 0 && tick % 25 == 0 && !Alive(parentPid)) { Detach(); return; }

      string cmd;
      while (commands.TryDequeue(out cmd)) {
        try {
          string[] a = cmd.Split(' ');
          string verb = a[0];
          int v;
          if (verb == "show") {
            if (a.Length > 1 && int.TryParse(a[1], out v) && v > 0) topPx = v;
            DoShow(edge, profileDir, url);
          } else if (verb == "hide") {
            DoHide(profileDir);
          } else if (verb == "toggle") {
            // the small window's shortcut: hide only when it is the active window
            bool active = shown && gemini != IntPtr.Zero && IsWindow(gemini) && IsWindowVisible(gemini)
                          && !IsIconic(gemini) && GetForegroundWindow() == gemini;
            if (active) DoHide(profileDir); else DoShow(edge, profileDir, url);
          } else if (verb == "top") {
            if (a.Length > 1 && int.TryParse(a[1], out v) && v > 0 && v != topPx) { topPx = v; lastRect = new RECT(); }
          } else if (verb == "cut") {
            int x, y, w, h, r = 0;
            if (a.Length >= 5 && int.TryParse(a[1], out x) && int.TryParse(a[2], out y) && int.TryParse(a[3], out w) && int.TryParse(a[4], out h)) {
              if (a.Length >= 6) int.TryParse(a[5], out r);
              hole = new RECT { L = x, T = y, R = x + w, B = y + h };
              holeRadius = r;
            } else hole = null;
            regionDirty = true;
            if (shown && layout == "docked" && gemini != IntPtr.Zero && IsWindow(gemini)) Sync();
          } else if (verb == "layout") {
            string next = a.Length > 1 ? a[1] : "";
            if ((next == "float" || next == "docked") && next != layout) {
              // hide first: a visible window must not change shape unasked
              if (shown && gemini != IntPtr.Zero && IsWindow(gemini)) DoHide(profileDir);
              layout = next;
              hole = null;
              if (gemini != IntPtr.Zero && IsWindow(gemini) && adoptedAs != null) {
                if (owner == IntPtr.Zero || !IsWindow(owner)) owner = FindOwner();
                if (layout == "float" || owner != IntPtr.Zero) Adopt(layout == "float");
              }
            }
          } else if (verb == "hotkey") {
            uint m = 0, k = 0;
            if (a.Length == 3) { uint.TryParse(a[1], out m); uint.TryParse(a[2], out k); }
            SetHotkey(m, k);
          } else if (verb == "detach") {
            Detach();
            return;
          } else if (verb == "quit") {
            if (gemini == IntPtr.Zero || !IsWindow(gemini)) gemini = FindGemini(profileDir);
            if (gemini != IntPtr.Zero) PostMessage(gemini, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            return;
          }
        } catch (Exception e) { Emit("error " + e.Message.Replace('\n', ' ')); }
      }

      try {
        if (shown) {
          if (gemini == IntPtr.Zero || !IsWindow(gemini)) {
            shown = false; gemini = IntPtr.Zero; HideChrome(); Emit("closed");
          } else if (layout == "docked" && (owner == IntPtr.Zero || !IsWindow(owner))) {
            ShowWindow(gemini, SW_HIDE); shown = false; owner = IntPtr.Zero; Emit("closed");
          } else if (layout == "float" || !IsIconic(owner)) {
            if (layout == "float" && owner != IntPtr.Zero && !IsWindow(owner)) owner = IntPtr.Zero;
            if (IsWindowVisible(gemini) && !IsIconic(gemini)) {
              Sync();
              if (tick % 15 == 0) SampleColors();
              // Chromium can still consider the window occluded and keep the
              // page hidden (no visible content child, so no insets): one
              // hide/show cycle makes it re-evaluate.
              if (!insets.HasValue && !nudged && ++shownTicks > 35) {
                nudged = true;
                ShowWindow(gemini, SW_HIDE);
                ShowWindow(gemini, SW_SHOW);
              }
            }
          }
        }
        UpdateChrome();
        Application.DoEvents(); // chrome input/paint and WM_HOTKEY
      } catch (Exception e) { Emit("error " + e.Message.Replace('\n', ' ')); }
      Thread.Sleep(dragMode != 0 ? 10 : 40);
    }
  }
}
'@ -ReferencedAssemblies System.Management, System.Windows.Forms, System.Drawing

if ($Close) { [GeminiDock]::CloseExisting($ProfileDir) } else { [GeminiDock]::Run($EdgePath, $ProfileDir, $Url, $ParentPid) }
