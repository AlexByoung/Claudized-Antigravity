# Load the theme's fonts (LXGW WenKai etc.) into the current Windows session.
#
# Fonts installed "for this user only" live in %LOCALAPPDATA%\Microsoft\Windows\Fonts
# and are listed in HKCU, but Windows does not always load them at sign-in;
# Antigravity then falls back to Microsoft YaHei for all Chinese text. The
# watcher runs this at start (it autostarts at sign-in, normally before
# Antigravity), so the fonts are there when Antigravity builds its font list.
# Only font files whose name matches the patterns below are touched; nothing is
# installed, copied or written. Output: one line per font file loaded.
param([string[]]$Patterns = @('LXGW*', 'Sarasa*'))

Add-Type @'
using System; using System.Runtime.InteropServices;
public static class AgFonts {
  [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] public static extern int AddFontResourceW(string file);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
}
'@

$dir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Fonts'
if (-not (Test-Path $dir)) { return }
$loaded = 0
foreach ($p in $Patterns) {
  foreach ($f in Get-ChildItem $dir -Filter "$p" -File -ErrorAction SilentlyContinue) {
    if ($f.Extension -notin '.ttf', '.otf', '.ttc') { continue }
    if ([AgFonts]::AddFontResourceW($f.FullName) -gt 0) { $loaded++; "loaded $($f.Name)" }
  }
}
if ($loaded) {
  $r = [IntPtr]::Zero
  # WM_FONTCHANGE to all top-level windows (2 s timeout, skip hung ones)
  [AgFonts]::SendMessageTimeout([IntPtr]0xFFFF, 0x001D, [IntPtr]::Zero, [IntPtr]::Zero, 2, 2000, [ref]$r) | Out-Null
}
