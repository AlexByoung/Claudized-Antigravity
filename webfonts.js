// LXGW WenKai as a web font, so it never depends on Windows' font list.
//
// Antigravity (Chromium) only sees system fonts that existed when it started,
// and Windows does not reliably load per-user fonts at sign-in: after a
// restart all Chinese could fall back to Microsoft YaHei. Instead, theme.css
// gets @font-face rules for the installed font files: `local()` first (no
// cost when Windows did load the font), else a same-origin URL
// (/__ag_fonts/<file>) that the watcher answers over CDP (Fetch domain) with
// the file's bytes. Nothing is copied or installed.

const fs = require('fs');
const path = require('path');

const URL_PREFIX = '/__ag_fonts/';
const DIRS = [
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'),
];
// file name -> face; only these files are ever served
const FACES = [
  { re: /^LXGWWenKai-Regular\.ttf$/i, family: 'LXGW WenKai', weight: 400, local: ['LXGW WenKai Regular', 'LXGWWenKai-Regular'] },
  { re: /^LXGWWenKai-Medium\.ttf$/i, family: 'LXGW WenKai', weight: 500, local: ['LXGW WenKai Medium', 'LXGWWenKai-Medium'] },
  { re: /^LXGWWenKaiMono-Regular\.ttf$/i, family: 'LXGW WenKai Mono', weight: 400, local: ['LXGW WenKai Mono Regular', 'LXGWWenKaiMono-Regular'] },
  { re: /^LXGWWenKaiMono-Medium\.ttf$/i, family: 'LXGW WenKai Mono', weight: 500, local: ['LXGW WenKai Mono Medium', 'LXGWWenKaiMono-Medium'] },
];

// [{ family, weight, local, file, name }] for the font files found
function findFaces() {
  const found = new Map();
  for (const dir of DIRS) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const face = FACES.find((f) => f.re.test(name));
      if (face && !found.has(name.toLowerCase())) found.set(name.toLowerCase(), { ...face, file: path.join(dir, name), name });
    }
  }
  return [...found.values()];
}

function fontFaceCss(faces = findFaces()) {
  return faces
    .map((f) => {
      const src = f.local.map((n) => `local(${JSON.stringify(n)})`).concat(`url(${JSON.stringify(URL_PREFIX + f.name)}) format("truetype")`);
      return `@font-face { font-family: ${JSON.stringify(f.family)}; font-weight: ${f.weight}; font-style: normal; font-display: swap; src: ${src.join(', ')}; }`;
    })
    .join('\n');
}

// Serve /__ag_fonts/<file> on a CDP page session. Call once per session.
async function serveFonts(session, log) {
  session.on('Fetch.requestPaused', ({ requestId, request }) => {
    const name = decodeURIComponent(new URL(request.url).pathname.slice(URL_PREFIX.length));
    const face = findFaces().find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (!face) {
      session.send('Fetch.failRequest', { requestId, errorReason: 'FileNotFound' }).catch(() => {});
      return;
    }
    fs.readFile(face.file, (err, data) => {
      if (err) {
        session.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
        return;
      }
      session
        .send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'font/ttf' },
            { name: 'Cache-Control', value: 'max-age=31536000, immutable' },
            { name: 'Access-Control-Allow-Origin', value: '*' },
          ],
          body: data.toString('base64'),
        })
        .then(() => log && log(`[字体] 已提供网页字体: ${face.name}`))
        .catch((e) => log && log(`[!] 网页字体发送失败: ${face.name} — ${e.message}`));
    });
  });
  await session.send('Fetch.enable', { patterns: [{ urlPattern: `*${URL_PREFIX}*`, requestStage: 'Request' }] });
}

module.exports = { fontFaceCss, serveFonts, findFaces };
