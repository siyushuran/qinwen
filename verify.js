const http = require('http');
const fs = require('fs');
const path = require('path');

const target = process.argv[2] || '172.17.0.2:3000';
const webDir = process.argv[3] || path.join(__dirname, 'web', 'dist');
const outFile = process.argv[4] || '/out/result.json';

function fetchPath(p) {
  return new Promise((resolve) => {
    http.get('http://' + target + p, (r) => {
      let d = '';
      r.on('data', (c) => d += c);
      r.on('end', () => resolve({ status: r.statusCode, len: d.length, head: d.slice(0, 80) }));
    }).on('error', (e) => resolve({ status: 0, body: 'ERR:' + e.message }));
  });
}

(async () => {
  // 从构建产物中读取实际资源名，避免每次构建后脚本失效
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  const jsPath = (html.match(/src="\.\/(assets\/[^"]+\.js)"/) || [])[1];
  const cssPath = (html.match(/href="\.\/(assets\/[^"]+\.css)"/) || [])[1];
  if (!jsPath || !cssPath) throw new Error('无法从 dist/index.html 解析前端资源');

  const health = await fetchPath('/api/health');
  const index = await fetchPath('/');
  const js = await fetchPath('/' + jsPath);
  const css = await fetchPath('/' + cssPath);
  const manifest = await fetchPath('/manifest.webmanifest');
  const icon = await fetchPath('/icon.svg');
  const result = { health, index, js, css, manifest, icon };

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  const ok = Object.values(result).every(x => x.status === 200);
  console.log(JSON.stringify(result, null, 2));
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
