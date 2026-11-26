// 资料接入端到端测试：模拟模型 + 真实后端 + 临时数据库，验证资料入库/切块/摘要/清单/出题/问答/划线/通用题库导入。
// 运行：node server/material-test.mjs
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(__dirname, 'server.mjs');
const WEB_DIR = path.join(ROOT, 'web', 'dist');
const assert = (cond, msg) => { if (!cond) throw new Error('断言失败：' + msg); };
const freePort = () => new Promise(resolve => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const wait = ms => new Promise(r => setTimeout(r, ms));

const mockPort = await freePort();
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const prompt = body.messages?.[0]?.content || '';
    const reply = obj => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }));
    };
    if (prompt.includes('ASD-STE100')) return reply({ one_line: '文章介绍五步学习法', points: ['先看动画', '再做交互'], timeline: ['第一步 — 动画'] });
    if (prompt.includes('知识体系拆解教练')) return reply({ facets: [{ name: '学习方法', points: [
      { name: '动画立轮廓', cognitive_level: 1 }, { name: '交互摸机制', cognitive_level: 2 },
    ] }] });
    if (prompt.includes('出题老师')) return reply({ type: 'single', stem: '根据文章，第一步先做什么？',
      options: ['看动画', '背公式', '写代码'], answer: '看动画', explanation: '依据[0]', chunk_index: 0 });
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frame = c => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`;
      res.write(frame('文章称')); res.write(frame('先看动画'));
      res.end('data: [DONE]\n\n');
      return;
    }
    return reply({ judged: '对', explanation: '讲解', followups: ['再问一个'] });
  });
});
await new Promise(r => mock.listen(mockPort, '127.0.0.1', r));

const port = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-material-test-'));
const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, WEB_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', d => log += d.toString());
child.stderr.on('data', d => log += d.toString());
const base = `http://127.0.0.1:${port}`;
async function call(p, { method = 'GET', token, body, raw = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const resp = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (raw) return { status: resp.status, text: await resp.text() };
  const t = await resp.text();
  let data; try { data = JSON.parse(t); } catch { data = t; }
  return { status: resp.status, data };
}

try {
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await call('/api/health')).status === 200) { up = true; break; } } catch {}
    await wait(100);
  }
  assert(up, `服务未启动：${log.slice(-600)}`);

  await call('/api/auth/setup', { method: 'POST', body: { password: 'test-password' } });
  const login = await call('/api/auth/login', { method: 'POST', body: { password: 'test-password' } });
  assert(login.status === 200, '登录失败');
  const token = login.data.token;
  await call('/api/settings', { method: 'POST', token, body: {
    llm_base_url: `http://127.0.0.1:${mockPort}/v1`, llm_api_key: 'test', llm_chat_model: 'mock-chat', llm_fast_model: 'mock-fast',
  } });

  const md = `# 五步学习法\n\n先做 2 分钟动画，把轮廓立住。\n\n## 第一步 理解度 25%\n\n文章称质数只能被 1 和自己整除。\n\n## 第二步 理解度 50%\n\n复平面横轴是实部，纵轴是虚部。\n\n## 争议\n\n文章称黎曼猜想已被攻克，这一点未经独立核实。`;
  const created = await call('/api/materials', { method: 'POST', token, body: {
    title: '测试文章', source_url: 'https://example.com/article', content: md,
  } });
  assert(created.status === 200 && created.data.ok, '资料入库失败：' + JSON.stringify(created.data));
  const materialId = created.data.material.id;
  assert(created.data.material.chunk_count >= 4, '切块数量异常');

  const again = await call('/api/materials', { method: 'POST', token, body: { title: '测试文章', content: md } });
  assert(again.data.reused === true, '重复资料未幂等');

  const detail = await call(`/api/materials/${materialId}`, { token });
  assert(detail.data.chunks.length >= 4, '块详情为空');

  const sum = await call(`/api/materials/${materialId}/summary`, { method: 'POST', token });
  assert(sum.status === 200 && sum.data.summary.points.length === 2, '摘要失败：' + JSON.stringify(sum.data));

  const built = await call(`/api/materials/${materialId}/build`, { method: 'POST', token, body: { domain_name: '测试领域' } });
  assert(built.status === 200 && built.data.nodes.length === 3, '清单生成失败：' + JSON.stringify(built.data));
  const domainId = built.data.domain_id;

  const qs = await call(`/api/materials/${materialId}/questions`, { method: 'POST', token, body: { count: 3, difficulty: 2 } });
  assert(qs.status === 200 && qs.data.created === 3, '出题失败：' + JSON.stringify(qs.data));

  const ask = await call('/api/questions', { method: 'POST', token, body: { node_id: built.data.nodes[2].id, difficulty: 2 } });
  assert(ask.status === 200 && ask.data.question.id, '取题失败：' + JSON.stringify(ask.data));
  const ans = await call('/api/attempts', { method: 'POST', token, body: { question_id: ask.data.question.id, answer: '看动画' } });
  assert(ans.status === 200 && ans.data.is_correct === 1, '判分失败：' + JSON.stringify(ans.data));

  const chat = await call(`/api/materials/${materialId}/chat`, { method: 'POST', token, body: { content: '第一步做什么？', history: [] }, raw: true });
  assert(chat.status === 200 && chat.text.includes('sources') && chat.text.includes('先看动画'), '资料问答失败：' + chat.text.slice(0, 300));

  const hl = await call('/api/highlights', { method: 'POST', token, body: { text: '先看动画，把轮廓立住', material_id: materialId, source: 'chat' } });
  assert(hl.status === 200 && hl.data.highlight.source_url === 'https://example.com/article', '划线来源 URL 未回填');

  const bank = await call('/api/bank/import', { method: 'POST', token, body: {
    domain_name: '文章领域', domain_key: 'article://material/test-domain', source_key_prefix: 'article://test/',
    questions: [{ bank_id: 'q1', domain_name: '文章领域', node_name: '概念一', type: 'judge',
      stem: '这是一道判断题', options: ['正确', '错误'], answer: '正确', explanation: '依据[0]', source_type: 'article' }],
  } });
  assert(bank.status === 200 && bank.data.bank.domain.name === '文章领域' && bank.data.bank.questions === 1, '通用题库导入失败：' + JSON.stringify(bank.data));
  const stats = await call('/api/bank/stats?prefix=article%3A%2F%2Ftest%2F&domain_key=article%3A%2F%2Fmaterial%2Ftest-domain', { token });
  assert(stats.data.questions === 1, '题库统计前缀未生效');

  const del = await call(`/api/materials/${materialId}`, { method: 'DELETE', token });
  assert(del.status === 200, '资料删除失败');
  console.log('MATERIAL OK: 资料入库/切块/摘要/清单/出题/问答/划线/通用导入全部通过');
} finally {
  child.kill('SIGTERM');
  await new Promise(r => child.once('exit', r));
  mock.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 文件句柄释放延迟，临时目录可留待系统清理 */ }
}
