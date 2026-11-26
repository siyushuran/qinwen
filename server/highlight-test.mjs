// 划线功能端到端测试：真实后端 + 临时库
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(__dirname, 'server.mjs');
const WEB_DIR = path.join(ROOT, 'web', 'dist');
const assert = (c, m) => { if (!c) throw new Error('断言失败：' + m); };
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = ms => new Promise(r => setTimeout(r, ms));

const port = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-hl-test-'));
const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, WEB_DIR }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
const base = `http://127.0.0.1:${port}`;
async function call(p, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const resp = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, data, headers: resp.headers };
}
try {
  let up = false;
  for (let i = 0; i < 60; i++) { try { if ((await call('/api/health')).status === 200) { up = true; break; } } catch {} await wait(100); }
  assert(up, '服务未启动');
  const setup = await call('/api/auth/setup', { method: 'POST', body: { password: 'hltest1234' } });
  const token = setup.data.token;
  assert(token, '无 token');

  // 未登录应 401
  assert((await call('/api/highlights')).status === 401, '未登录应拒绝');

  // 建一个领域+节点+题目作为来源
  const d = await call('/api/domains', { method: 'POST', token, body: { name: '测试领域', level: '没学过' } });
  const domainId = d.data.id;
  const n = await call('/api/nodes', { method: 'POST', token, body: { domain_id: domainId, name: '测试知识点' } });
  const nodeId = n.data.id;
  const db = new (await import('node:sqlite')).DatabaseSync(path.join(dataDir, 'qingwen.db'));
  db.prepare('INSERT INTO question (node_id,type,difficulty,stem,options,answer,explanation,source_url,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(nodeId, 'single', 1, '这是一道关于逆向思维的题？', JSON.stringify(['甲', '乙']), '甲', '解析文字', 'https://mungermodels.com/models/inversion', new Date().toISOString());
  const qid = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  db.close();

  // 新增划线（带来源）
  const add = await call('/api/highlights', { method: 'POST', token, body: {
    text: '反过来想，总是反过来想', source: 'explanation', question_id: qid, node_id: nodeId, domain_id: domainId, note: '很受用',
  } });
  assert(add.status === 200, '新增失败 ' + JSON.stringify(add.data));
  assert(add.data.highlight.source_url === 'https://mungermodels.com/models/inversion', '来源 URL 未从题目反查');
  assert(add.data.highlight.node_id === nodeId && add.data.highlight.domain_id === domainId, '来源节点/领域错误');
  const id = add.data.highlight.id;

  // 过短文本应拒绝
  assert((await call('/api/highlights', { method: 'POST', token, body: { text: '好' } })).status === 400, '过短文本应拒绝');

  // 列表 + 搜索
  const list = await call('/api/highlights', { token });
  assert(list.data.total === 1 && list.data.items[0].text.includes('反过来想'), '列表不符');
  assert((await call('/api/highlights?q=' + encodeURIComponent('受用'), { token })).data.total === 1, '备注搜索失败');
  assert((await call('/api/highlights?q=' + encodeURIComponent('不存在'), { token })).data.total === 0, '无结果搜索失败');
  assert((await call(`/api/highlights?domain_id=${domainId}`, { token })).data.total === 1, '领域过滤失败');

  // 更新备注
  const patch = await call(`/api/highlights/${id}`, { method: 'PATCH', token, body: { note: '新备注' } });
  assert(patch.data.highlight.note === '新备注', '备注更新失败');
  assert((await call(`/api/highlights/${id}`, { method: 'PATCH', token, body: { note: 'x' } })).status === 200, 'PATCH 幂等');

  // 导出 Markdown
  const exp = await call('/api/highlights/export', { token });
  assert(exp.status === 200 && exp.data.includes('反过来想') && exp.data.includes('mungermodels.com'), '导出不符');

  // 删除
  assert((await call(`/api/highlights/${id}`, { method: 'DELETE', token })).status === 200, '删除失败');
  assert((await call('/api/highlights', { token })).data.total === 0, '删除后应为空');

  console.log('HIGHLIGHT TEST OK ✅');
} catch (e) {
  console.error('测试失败', e.stack, '\n日志:', log.slice(-800));
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
