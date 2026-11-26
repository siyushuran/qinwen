const http = require('http');
const fs = require('fs');
const target = process.argv[2] || '172.17.0.2:3000';

function fetchPath(path) {
  return new Promise((resolve) => {
    http.get('http://' + target + path, (r) => {
      let d = '';
      r.on('data', (c) => d += c);
      r.on('end', () => resolve({ status: r.statusCode, len: d.length, head: d.slice(0, 80) }));
    }).on('error', (e) => resolve({ status: 0, body: 'ERR:' + e.message }));
  });
}

(async () => {
  const health = await fetchPath('/api/health');
  const index = await fetchPath('/');
  const js = await fetchPath('/assets/index-aotSL_Ih.js');
  const css = await fetchPath('/assets/style-dfH99KOb.css');
  const manifest = await fetchPath('/manifest.webmanifest');
  const icon = await fetchPath('/icon.svg');
  const result = { health, index, js, css, manifest, icon };
  fs.writeFileSync('/out/result.json', JSON.stringify(result, null, 2));
  const ok = [health, index, js, css, manifest, icon].every(x => x.status === 200);
  process.exit(ok ? 0 : 1);
})();
