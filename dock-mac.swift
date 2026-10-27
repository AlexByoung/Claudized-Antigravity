// macOS counterpart of dock.ps1: shows Gemini next to or inside Antigravity.
// Started by gemini-dock.js (watch mode), which compiles it on first use
// (swiftc, from the Xcode Command Line Tools) into .build/gemini-dock.
//
// Gemini runs in a WebKit view inside this helper, with its own persistent
// website data store, so the Google sign-in stays here and nowhere else.
//
// Layouts
//   float  (default)  a small floating panel along Antigravity's right edge.
//                     Hovering its top edge shows a slim bar (drag to move,
//                     "-" hides, "x" closes); any edge resizes it.
//   docked            fills Antigravity's content area below its title bar
//                     and follows the window as it moves or resizes.
// Both stay above Antigravity while Antigravity (or Gemini) is the active
// app, and drop to a normal window when you switch to another app.
//
// stdin commands, one per line (same as dock.ps1, plus "frame"):
//   frame x y w h ih dpr  Antigravity's window: screen points (top-left origin),
//                         inner height and device pixel ratio
//   show [topPx]          show Gemini; topPx = Antigravity title bar height (physical px)
//   hide                  hide it (the page keeps running: login, drafts stay)
//   toggle                small window: show it, or hide it if it is active
//   top <px>              title bar height changed
//   cut x y w h [r]       docked: cut a (rounded) hole for a menu Antigravity
//                         opens over Gemini (physical px); "cut" alone closes it
//   layout float|docked
//   hotkey <mods> <vk>    global shortcut (mods: Alt 1, Ctrl 2, Shift 4, Cmd 8;
//                         vk: Windows virtual-key code); 0 0 = off
//   quit                  close Gemini and exit
// stdout events: ready | shown | hidden | closed | error <msg>
//   | colors #LEFT #RIGHT <split> (Gemini's sidebar / header colors along its top row)
//   | hotkey-ok | hotkey-fail | hotkey-off | hotkey-pressed (docked layout)
// stdin EOF, or the watcher process (-ParentPid) gone: exit.
import AppKit
import Carbon.HIToolbox
import WebKit

// ── Arguments ─────────────────────────────────────────────────────────────
var url = "https://gemini.google.com/app"
var parentPid: pid_t = 0
do {
  let a = CommandLine.arguments
  var i = 1
  while i < a.count {
    if a[i] == "-Url", i + 1 < a.count { url = a[i + 1]; i += 1 }
    else if a[i] == "-ParentPid", i + 1 < a.count { parentPid = pid_t(a[i + 1]) ?? 0; i += 1 }
    i += 1
  }
}

// stdout may be a broken pipe once the watcher is gone; never let that kill us.
signal(SIGPIPE, SIG_IGN)
func emit(_ s: String) {
  FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
}

let ANTIGRAVITY_ID = "com.google.antigravity"
// One fixed store: Gemini's cookies and storage, separate from Safari and Antigravity.
let STORE_ID = UUID(uuidString: "6A1D3C52-0B7E-4F57-9C5E-41A6E0C2A9B1")!
// Google refuses sign-in in "embedded" browsers; present as Safari.
let SAFARI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15"

// ── Views ─────────────────────────────────────────────────────────────────
final class GeminiPanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
}

// Small-window chrome: a slim bar over the page's top edge, shown on hover.
final class HoverBar: NSView {
  var onHide: () -> Void = {}
  var onClose: () -> Void = {}
  private var tracking: NSTrackingArea?
  private let hideBtn = NSButton(title: "—", target: nil, action: nil)
  private let closeBtn = NSButton(title: "✕", target: nil, action: nil)
  var color = NSColor(srgbRed: 0.97, green: 0.98, blue: 0.99, alpha: 1) {
    didSet { layer?.backgroundColor = color.cgColor; tint() }
  }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.backgroundColor = color.cgColor
    alphaValue = 0
    for (b, sel) in [(hideBtn, #selector(hideTap)), (closeBtn, #selector(closeTap))] {
      b.isBordered = false
      b.target = self
      b.action = sel
      b.font = .systemFont(ofSize: 12, weight: .semibold)
      addSubview(b)
    }
    tint()
  }
  required init?(coder: NSCoder) { fatalError() }

  private func tint() {
    let c = color.usingColorSpace(.sRGB) ?? color
    let dark = 0.2126 * c.redComponent + 0.7152 * c.greenComponent + 0.0722 * c.blueComponent < 0.5
    for b in [hideBtn, closeBtn] { b.contentTintColor = dark ? .init(white: 0.9, alpha: 1) : .init(white: 0.15, alpha: 1) }
  }
  override func layout() {
    super.layout()
    closeBtn.frame = NSRect(x: bounds.width - 30, y: 0, width: 28, height: bounds.height)
    hideBtn.frame = NSRect(x: bounds.width - 58, y: 0, width: 28, height: bounds.height)
  }
  override func updateTrackingAreas() {
    if let t = tracking { removeTrackingArea(t) }
    tracking = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways], owner: self)
    addTrackingArea(tracking!)
  }
  override func mouseEntered(with event: NSEvent) { animator().alphaValue = 1 }
  override func mouseExited(with event: NSEvent) { animator().alphaValue = 0 }
  override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
  // the bar is invisible until hovered, but must still take the hover
  override func hitTest(_ point: NSPoint) -> NSView? {
    frame.contains(point) ? (super.hitTest(point) ?? self) : nil
  }
  @objc func hideTap() { onHide() }
  @objc func closeTap() { onClose() }
}

// ── Dock ──────────────────────────────────────────────────────────────────
final class Dock: NSObject, WKNavigationDelegate, WKUIDelegate {
  var layout = "float"
  var shown = false
  var topPx = 80
  var frame: (x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat, ih: CGFloat, dpr: CGFloat)?
  var hole: (rect: NSRect, r: CGFloat)?
  var window: GeminiPanel?
  var web: WKWebView?
  var bar: HoverBar?
  var lastColors: String?
  var hotKeyRef: EventHotKeyRef?

  // Cocoa screen coordinates (bottom-left origin) from top-left ones.
  func cocoa(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> NSRect {
    let primary = NSScreen.screens.first?.frame.height ?? 0
    return NSRect(x: x, y: primary - y - h, width: w, height: h)
  }

  // Antigravity's content area below its title bar (docked).
  func dockedRect() -> NSRect? {
    guard let f = frame else { return nil }
    let chrome = max(0, f.h - f.ih) // native title bar, if any
    let top = chrome + CGFloat(topPx) / max(1, f.dpr)
    return cocoa(f.x, f.y + top, f.w, max(200, f.h - top))
  }

  // About 440x720 along Antigravity's right edge, below its title bar;
  // centered on the main screen when Antigravity's window is unknown.
  func floatRect() -> NSRect {
    let w: CGFloat = 440
    var h: CGFloat = 720
    if let f = frame {
      let top = max(0, f.h - f.ih) + CGFloat(topPx) / max(1, f.dpr)
      h = min(h, max(360, f.h - top - 40))
      return cocoa(f.x + f.w - w - 24, f.y + top + 16, w, h)
    }
    let s = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    return NSRect(x: s.midX - w / 2, y: s.midY - h / 2, width: w, height: h)
  }

  func makeWindow() {
    let config = WKWebViewConfiguration()
    if #available(macOS 14.0, *) {
      config.websiteDataStore = WKWebsiteDataStore(forIdentifier: STORE_ID)
    } else {
      config.websiteDataStore = .default()
    }
    config.preferences.javaScriptCanOpenWindowsAutomatically = true
    let web = WKWebView(frame: .zero, configuration: config)
    web.customUserAgent = SAFARI_UA
    web.navigationDelegate = self
    web.uiDelegate = self
    web.allowsBackForwardNavigationGestures = true
    web.load(URLRequest(url: URL(string: url)!))

    let w = GeminiPanel(contentRect: floatRect(), styleMask: [], backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false
    w.hidesOnDeactivate = false
    w.collectionBehavior = [.fullScreenAuxiliary, .moveToActiveSpace]
    w.title = "Gemini"
    let root = NSView()
    root.wantsLayer = true
    web.autoresizingMask = [.width, .height]
    root.addSubview(web)
    let bar = HoverBar(frame: .zero)
    bar.onHide = { [weak self] in self?.hide() }
    bar.onClose = { [weak self] in self?.hide(); emit("closed") }
    root.addSubview(bar)
    w.contentView = root
    self.window = w
    self.web = web
    self.bar = bar
    style()
  }

  // Window style for the current layout.
  func style() {
    guard let w = window, let root = w.contentView, let web = web, let bar = bar else { return }
    if layout == "float" {
      w.styleMask = [.titled, .resizable, .fullSizeContentView]
      w.titlebarAppearsTransparent = true
      w.titleVisibility = .hidden
      for b in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { w.standardWindowButton(b)?.isHidden = true }
      w.isOpaque = true
      w.hasShadow = true
      w.minSize = NSSize(width: 320, height: 360)
      w.setFrameAutosaveName("AGGeminiFloat")
      bar.isHidden = false
    } else {
      w.setFrameAutosaveName("")
      w.styleMask = [.borderless]
      w.isOpaque = false
      w.backgroundColor = .clear
      w.hasShadow = false
      bar.isHidden = true
    }
    web.frame = root.bounds
    bar.frame = NSRect(x: 0, y: root.bounds.height - 24, width: root.bounds.width, height: 24)
    bar.autoresizingMask = [.width, .minYMargin]
    applyHole()
  }

  func place() {
    guard let w = window else { return }
    if layout == "docked" {
      if let r = dockedRect(), w.frame != r { w.setFrame(r, display: true) }
    } else if !w.setFrameUsingName("AGGeminiFloat") {
      w.setFrame(floatRect(), display: true)
    }
  }

  // Above Antigravity only while Antigravity or this helper is active.
  func updateLevel() {
    guard let w = window else { return }
    let front = NSWorkspace.shared.frontmostApplication
    let ours = front?.bundleIdentifier == ANTIGRAVITY_ID || front?.processIdentifier == getpid()
    w.level = ours ? .floating : .normal
  }

  func show() {
    if window == nil { makeWindow() }
    guard let w = window else { return }
    place()
    updateLevel()
    w.orderFrontRegardless()
    if layout == "float" {
      NSApp.activate(ignoringOtherApps: true)
      w.makeKey()
    }
    shown = true
    emit("shown")
    sampleColors()
  }

  func hide() {
    guard shown, let w = window else { return }
    w.orderOut(nil)
    shown = false
    emit("hidden")
    if layout == "docked" { activateAntigravity() }
  }

  func activateAntigravity() {
    NSRunningApplication.runningApplications(withBundleIdentifier: ANTIGRAVITY_ID).first?.activate()
  }

  func toggle() {
    if let w = window, shown, w.isVisible, NSApp.isActive, w.isKeyWindow { hide() } else { show() }
  }

  // docked: a hole the menu shows through (clicks there reach Antigravity)
  func applyHole() {
    guard let root = window?.contentView, let layer = root.layer else { return }
    guard layout == "docked", let h = hole, let f = frame else { layer.mask = nil; return }
    let d = max(1, f.dpr)
    let b = root.bounds
    // menu rect is in Antigravity client px; the docked view starts topPx below its top
    let r = NSRect(x: h.rect.minX / d, y: b.height - (h.rect.minY - CGFloat(topPx)) / d - h.rect.height / d,
                   width: h.rect.width / d, height: h.rect.height / d)
    let path = CGMutablePath()
    path.addRect(b)
    path.addRoundedRect(in: r, cornerWidth: h.r / d, cornerHeight: h.r / d)
    let mask = CAShapeLayer()
    mask.path = path
    mask.fillRule = .evenOdd
    layer.mask = mask
    window?.ignoresMouseEvents = false
  }

  // Gemini's colors along its top row: left (over its sidebar, when open),
  // right (header), and where the left color ends, in physical px.
  func sampleColors() {
    guard shown, let web = web, web.bounds.width > 40 else { return }
    let cfg = WKSnapshotConfiguration()
    cfg.rect = NSRect(x: 0, y: 0, width: web.bounds.width, height: 4)
    web.takeSnapshot(with: cfg) { [weak self] img, _ in
      guard let self = self, let img = img, let tiff = img.tiffRepresentation,
            let rep = NSBitmapImageRep(data: tiff), rep.pixelsWide > 8 else { return }
      let y = rep.pixelsHigh / 2
      func hex(_ x: Int) -> String {
        guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { return "#FFFFFF" }
        return String(format: "#%02X%02X%02X", Int(c.redComponent * 255), Int(c.greenComponent * 255), Int(c.blueComponent * 255))
      }
      let left = hex(4), right = hex(rep.pixelsWide - 4)
      // a frame captured before the page painted comes back transparent (black)
      if left == "#000000" && right == "#000000" { return }
      var split = 0
      if left != right {
        for x in stride(from: 4, to: rep.pixelsWide - 4, by: 2) where hex(x) != left { split = x; break }
        // snapshot pixels -> physical px
        split = Int(CGFloat(split) * (self.frame?.dpr ?? 2) * web.bounds.width / CGFloat(rep.pixelsWide))
      }
      let line = "colors \(left) \(right) \(split)"
      if line != self.lastColors {
        self.lastColors = line
        emit(line)
      }
      if let c = NSColor(hexString: right) { self.bar?.color = c }
    }
  }

  // ── Global shortcut (Carbon: needs no Accessibility permission) ─────────
  func setHotkey(mods: UInt32, vk: UInt32) {
    if let r = hotKeyRef { UnregisterEventHotKey(r); hotKeyRef = nil }
    guard mods != 0, vk != 0, let code = macKeyCode(vk) else { emit("hotkey-off"); return }
    var m: UInt32 = 0
    if mods & 1 != 0 { m |= UInt32(optionKey) }
    if mods & 2 != 0 { m |= UInt32(controlKey) }
    if mods & 4 != 0 { m |= UInt32(shiftKey) }
    if mods & 8 != 0 { m |= UInt32(cmdKey) }
    var ref: EventHotKeyRef?
    let id = EventHotKeyID(signature: OSType(0x4147_4D49), id: 1) // 'AGMI'
    let ok = RegisterEventHotKey(code, m, id, GetApplicationEventTarget(), 0, &ref) == noErr
    hotKeyRef = ref
    emit(ok ? "hotkey-ok" : "hotkey-fail") // fails when another program owns it
  }

  func hotkeyPressed() {
    if layout == "float" { toggle() } else { emit("hotkey-pressed") }
  }

  // ── WebKit ────────────────────────────────────────────────────────────
  // Popups (Google sign-in, links): Google pages load here, anything else
  // opens in the default browser.
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let u = action.request.url {
      if isGoogle(u) { webView.load(action.request) } else { NSWorkspace.shared.open(u) }
    }
    return nil
  }
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if action.targetFrame?.isMainFrame == true, action.navigationType == .linkActivated,
       let u = action.request.url, !isGoogle(u) {
      NSWorkspace.shared.open(u)
      return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.sampleColors() }
  }
  func isGoogle(_ u: URL) -> Bool {
    guard let h = u.host?.lowercased() else { return true }
    return ["google.com", "gstatic.com", "googleusercontent.com", "youtube.com", "google.co"].contains { h == $0 || h.hasSuffix("." + $0) }
      || h.contains(".google.")
  }

  // ── Commands ──────────────────────────────────────────────────────────
  func handle(_ line: String) {
    let a = line.split(separator: " ").map(String.init)
    guard let verb = a.first else { return }
    let n = a.dropFirst().compactMap { Double($0) }.map { CGFloat($0) }
    switch verb {
    case "frame":
      if n.count == 6 {
        frame = (n[0], n[1], n[2], n[3], n[4], n[5])
        if shown && layout == "docked" { place(); applyHole() }
      }
    case "show":
      if let v = n.first, v > 0 { topPx = Int(v) }
      show()
    case "hide": hide()
    case "toggle": toggle()
    case "top":
      if let v = n.first, v > 0 { topPx = Int(v) }
      if shown && layout == "docked" { place() }
    case "cut":
      hole = n.count >= 4 ? (NSRect(x: n[0], y: n[1], width: n[2], height: n[3]), n.count >= 5 ? n[4] : 0) : nil
      applyHole()
    case "layout":
      let next = a.count > 1 ? a[1] : ""
      if (next == "float" || next == "docked") && next != layout {
        if shown { hide() } // a visible window must not change shape unasked
        layout = next
        hole = nil
        style()
      }
    case "hotkey":
      let m = a.count == 3 ? UInt32(a[1]) ?? 0 : 0
      let k = a.count == 3 ? UInt32(a[2]) ?? 0 : 0
      setHotkey(mods: m, vk: k)
    case "quit":
      window?.orderOut(nil)
      exit(0)
    default: break
    }
  }
}

// Windows virtual-key code (what gemini-dock.js sends) -> macOS key code.
func macKeyCode(_ vk: UInt32) -> UInt32? {
  let letters: [Int] = [kVK_ANSI_A, kVK_ANSI_B, kVK_ANSI_C, kVK_ANSI_D, kVK_ANSI_E, kVK_ANSI_F, kVK_ANSI_G, kVK_ANSI_H,
                        kVK_ANSI_I, kVK_ANSI_J, kVK_ANSI_K, kVK_ANSI_L, kVK_ANSI_M, kVK_ANSI_N, kVK_ANSI_O, kVK_ANSI_P,
                        kVK_ANSI_Q, kVK_ANSI_R, kVK_ANSI_S, kVK_ANSI_T, kVK_ANSI_U, kVK_ANSI_V, kVK_ANSI_W, kVK_ANSI_X,
                        kVK_ANSI_Y, kVK_ANSI_Z]
  let digits: [Int] = [kVK_ANSI_0, kVK_ANSI_1, kVK_ANSI_2, kVK_ANSI_3, kVK_ANSI_4, kVK_ANSI_5, kVK_ANSI_6, kVK_ANSI_7,
                       kVK_ANSI_8, kVK_ANSI_9]
  let fkeys: [Int] = [kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10, kVK_F11, kVK_F12,
                      kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20]
  switch vk {
  case 0x41...0x5A: return UInt32(letters[Int(vk - 0x41)])
  case 0x30...0x39: return UInt32(digits[Int(vk - 0x30)])
  case 0x70...0x83: return UInt32(fkeys[Int(vk - 0x70)])
  case 0x20: return UInt32(kVK_Space)
  case 0xC0: return UInt32(kVK_ANSI_Grave)
  case 0x0D: return UInt32(kVK_Return)
  case 0x09: return UInt32(kVK_Tab)
  case 0xBF: return UInt32(kVK_ANSI_Slash)
  case 0xBA: return UInt32(kVK_ANSI_Semicolon)
  case 0xBC: return UInt32(kVK_ANSI_Comma)
  case 0xBE: return UInt32(kVK_ANSI_Period)
  default: return nil
  }
}

extension NSColor {
  convenience init?(hexString s: String) {
    guard s.hasPrefix("#"), s.count == 7, let v = Int(s.dropFirst(), radix: 16) else { return nil }
    self.init(srgbRed: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
let app = NSApplication.shared
app.setActivationPolicy(.accessory) // no Dock icon, no menu bar
let dock = Dock()

var hotkeySpec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
  DispatchQueue.main.async { dock.hotkeyPressed() }
  return noErr
}, 1, &hotkeySpec, nil, nil)

for name in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.didDeactivateApplicationNotification] {
  NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { _ in dock.updateLevel() }
}
// Antigravity quit: hide Gemini (it comes back on the next show)
NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { n in
  let a = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
  if a?.bundleIdentifier == ANTIGRAVITY_ID, dock.shown { dock.hide(); emit("closed") }
}
Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { _ in dock.sampleColors() }

// stdin on a background thread; EOF (watcher gone) ends the helper.
Thread.detachNewThread {
  while let line = readLine() {
    let l = line.trimmingCharacters(in: .whitespaces)
    if !l.isEmpty { DispatchQueue.main.async { dock.handle(l) } }
  }
  DispatchQueue.main.async { exit(0) }
}
var parentWatch: DispatchSourceProcess?
if parentPid > 0 {
  parentWatch = DispatchSource.makeProcessSource(identifier: parentPid, eventMask: .exit, queue: .main)
  parentWatch?.setEventHandler { exit(0) }
  parentWatch?.resume()
  if kill(parentPid, 0) != 0 { exit(0) }
}

emit("ready")
app.run()
