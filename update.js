// Update check for the patch itself (Settings > Application > 补丁).
//
// A git clone is compared with its upstream (origin/main by default): `check`
// fetches and counts the commits it is behind; `apply` fast-forwards
// (git pull --ff-only, never a merge or a reset) and restarts the watcher so
// the new code runs. A folder that is not a git clone (e.g. a downloaded zip)
// is compared with the latest GitHub release and only links to it.

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const UPDATE_BINDING = '__agPatchUpdate';
const DIR = __dirname;
const pkg = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
})();
const VERSION = pkg.version || '0.0.0';
// owner/name on GitHub, from package.json "repository" or the origin remote
const DEFAULT_REPO = 'AlexByoung/Claudized-Antigravity';

function git(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: DIR, windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').pop()));
      else resolve(stdout.trim());
    });
  });
}

async function isGitClone() {
  if (!fs.existsSync(path.join(DIR, '.git'))) return false;
  try {
    return (await git(['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

async function repoSlug() {
  const fromPkg = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && pkg.repository.url;
  const url = fromPkg || (await git(['remote', 'get-url', 'origin']).catch(() => ''));
  const m = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url || '');
  return m ? m[1] : DEFAULT_REPO;
}

class PatchUpdater {
  constructor({ log, onStatus }) {
    this.log = log;
    this.onStatus = onStatus;
    this.status = { state: 'idle', version: VERSION };
    this.busy = false;
  }

  set(next) {
    this.status = { version: VERSION, ...next };
    this.onStatus(this.status);
  }

  async check() {
    if (this.busy) return;
    this.busy = true;
    this.set({ state: 'checking' });
    try {
      if (await isGitClone()) {
        const head = await git(['rev-parse', '--short', 'HEAD']);
        const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => 'origin/main');
        const [remote, branch] = [upstream.split('/')[0], upstream.split('/').slice(1).join('/')];
        await git(['fetch', '--quiet', remote, branch]);
        const behind = Number(await git(['rev-list', '--count', `HEAD..${upstream}`])) || 0;
        const ahead = Number(await git(['rev-list', '--count', `${upstream}..HEAD`])) || 0;
        const latest = behind ? await git(['log', '-1', '--format=%s', upstream]) : '';
        this.set({ state: behind ? 'available' : 'latest', git: true, head, behind, ahead, latest });
        this.log(`[更新] 检查完成: ${behind ? `落后 ${behind} 个提交` : '已是最新'}${ahead ? `，本地领先 ${ahead} 个提交` : ''}`);
      } else {
        const slug = await repoSlug();
        const res = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
          headers: { 'User-Agent': 'claudized-antigravity', Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`GitHub ${res.status}`);
        const rel = await res.json();
        const tag = String(rel.tag_name || '').replace(/^v/, '');
        const newer = tag && tag.localeCompare(VERSION, undefined, { numeric: true }) > 0;
        this.set({ state: newer ? 'available' : 'latest', git: false, latest: tag, url: rel.html_url });
      }
    } catch (err) {
      this.set({ state: 'error', message: err.message.slice(0, 160) });
      this.log(`[!] 检查补丁更新失败: ${err.message}`);
    } finally {
      this.busy = false;
    }
  }

  // Fast-forward to upstream, then restart the watcher on the new code.
  async apply() {
    if (this.busy || this.status.state !== 'available' || !this.status.git) return;
    this.busy = true;
    this.set({ ...this.status, state: 'updating' });
    try {
      await git(['pull', '--ff-only', '--quiet']);
      const head = await git(['rev-parse', '--short', 'HEAD']);
      this.log(`[更新] 已更新到 ${head}，正在重启守护进程`);
      this.set({ state: 'restarting', git: true, head });
      // start the new watcher once this one has exited and released its lock
      if (process.platform === 'darwin') {
        spawn('/bin/sh', ['-c', 'sleep 2; exec ./watch.sh'], { cwd: DIR, detached: true, stdio: 'ignore' }).unref();
      } else {
        const vbs = path.join(DIR, 'watch-hidden.vbs');
        // (ping as the delay: `timeout` refuses to run without a console)
        spawn('cmd.exe', ['/d', '/s', '/c', `"ping -n 3 127.0.0.1 >nul & start "" wscript.exe "${vbs}""`], {
          cwd: DIR,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          windowsVerbatimArguments: true,
        }).unref();
      }
      setTimeout(() => process.exit(0), 500);
    } catch (err) {
      this.set({ ...this.status, state: 'error', message: err.message.slice(0, 160) });
      this.log(`[!] 补丁更新失败: ${err.message}`);
    } finally {
      this.busy = false;
    }
  }

  handle(payload) {
    let action;
    try {
      action = JSON.parse(payload).action;
    } catch {
      return;
    }
    if (action === 'check') this.check();
    else if (action === 'apply') this.apply();
    else if (action === 'status') this.onStatus(this.status);
  }
}

module.exports = { UPDATE_BINDING, PatchUpdater, VERSION };
