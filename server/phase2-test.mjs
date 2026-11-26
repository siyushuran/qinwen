// Phase 2 端到端测试：排序题、记忆宫殿卡、多文档交叉核验、图片资料接入。
// 运行：node server/phase2-test.mjs
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
let mockMaterialId = 0;

const mockPort = await freePort();
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const first = body.messages?.[0]?.content;
    const prompt = typeof first === 'string' ? first : JSON.stringify(first || '');
    const reply = obj => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }));
    };
    if (prompt.includes('多来源交叉核验')) return reply({ summary: '文章称黎曼猜想已被攻克。',
      items: [
        { material_id: mockMaterialId, idx: 2, relation: 'support', quote: '黎曼猜想已被攻克', note: '提出了该主张' },
        { material_id: 99999, idx: 0, relation: 'support', quote: '伪造的引用', note: '应被丢弃' },
      ] });
    if (prompt.includes('记忆宫殿')) return reply({ room: '图书馆的借阅台', hook: '书桌上摆着三色积木',
      cue: '从轮廓到机制的第二步是什么？', answer: '先用动画立轮廓，再用交互摸机制[0]', chunk_index: 0 });
    if (prompt.includes('出一道排序题')) return reply({ type: 'order', stem: '请排列学习步骤',
      options: ['第三步 串因果', '第一步 立轮廓', '第二步 摸机制'],
      answer: ['第一步 立轮廓', '第二步 摸机制', '第三步 串因果'], explanation: '依据[0] 从轮廓到机制再到因果' });
    if (prompt.includes('请仔细观察这张图片')) return reply({ title: '学习步骤流程图', description: '图中是三步学习流程。',
      elements: ['动画', '交互', '流程图'], texts: ['25%', '50%', '75%'],
      flow: ['看动画', '玩小游戏', '画流程图'], uncertain: ['底部小字看不清'] });
    if (prompt.includes('ASD-STE100')) return reply({ one_line: '文章介绍五步学习法', points: ['先看动画'], timeline: ['第一步 — 动画'] });
    if (prompt.includes('知识体系拆解教练')) return reply({ facets: [{ name: '学习方法', points: [
      { name: '动画立轮廓', cognitive_level: 1 }, { name: '交互摸机制', cognitive_level: 2 },
      { name: '流程图串因果', cognitive_level: 3 },
    ] }] });
    if (prompt.includes('出题老师')) return reply({ type: 'single', stem: '根据文章，第一步先做什么？',
      options: ['看动画', '背公式'], answer: '看动画', explanation: '依据[0]', chunk_index: 0 });
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '先看动画' } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    return reply({ judged: '对', explanation: '讲解', followups: ['再问一个'] });
  });
});
await new Promise(r => mock.listen(mockPort, '127.0.0.1', r));

const port = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-phase2-test-'));
const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, WEB_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', d => log += d.toString());
child.stderr.on('data', d => log += d.toString());
const base = `http://127.0.0.1:${port}`;
async function call(p, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const resp = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
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
  const token = login.data.token;
  assert(token, '登录失败');
  await call('/api/settings', { method: 'POST', token, body: {
    llm_base_url: `http://127.0.0.1:${mockPort}/v1`, llm_api_key: 'test', llm_chat_model: 'mock-chat', llm_fast_model: 'mock-fast',
  } });

  const md = '# 五步学习法\n\n先做 2 分钟动画，把轮廓立住。\n\n## 第一步 理解度 25%\n\n文章称质数只能被 1 和自己整除。\n\n## 争议\n\n文章称黎曼猜想已被攻克，这一点未经独立核实。';
  const created = await call('/api/materials', { method: 'POST', token, body: { title: '测试文章', content: md } });
  assert(created.status === 200, '资料入库失败');
  mockMaterialId = created.data.material.id;
  const built = await call(`/api/materials/${mockMaterialId}/build`, { method: 'POST', token, body: { domain_name: '测试领域' } });
  const nodeId = built.data.nodes.find(n => n.parent_id !== null).id;

  // 排序题：生成 + 正确/错误判分，answer 不出题前泄露
  const orderQ = await call('/api/questions', { method: 'POST', token, body: { node_id: nodeId, type: 'order', difficulty: 1 } });
  assert(orderQ.status === 200 && orderQ.data.question.type === 'order', '排序题生成失败：' + JSON.stringify(orderQ.data));
  assert(!('answer' in orderQ.data.question), '排序题泄露答案');
  const oid = orderQ.data.question.id;
  const correct = ['第一步 立轮廓', '第二步 摸机制', '第三步 串因果'];
  const right = await call('/api/attempts', { method: 'POST', token, body: { question_id: oid, answer: JSON.stringify(correct) } });
  assert(right.data.is_correct === 1 && right.data.correct_order?.length === 3, '排序题正确判分失败：' + JSON.stringify(right.data));
  const wrong = await call('/api/attempts', { method: 'POST', token, body: { question_id: oid, answer: JSON.stringify([...correct].reverse()) } });
  assert(wrong.data.is_correct === 0 && wrong.data.first_wrong === 0, '排序题错误判分失败：' + JSON.stringify(wrong.data));
  const bankStats = await call('/api/bank/stats', { token });
  assert(bankStats.data.questions === 0, '排序题污染了芒格题库');

  // 记忆宫殿卡：生成 → 列表 → 自评驱动 SRS
  const gen = await call('/api/memory-cards/generate', { method: 'POST', token, body: { node_id: nodeId } });
  assert(gen.status === 200 && gen.data.generated === 1, '记忆卡生成失败：' + JSON.stringify(gen.data));
  const cards = await call('/api/memory-cards', { token });
  assert(cards.data.cards.length === 1 && cards.data.cards[0].cue, '记忆卡列表为空');
  const cardId = cards.data.cards[0].id;
  const again = await call('/api/memory-cards/generate', { method: 'POST', token, body: { node_id: nodeId } });
  assert(again.data.generated === 0 && again.data.reused === 1, '记忆卡未复用');
  const reviewed = await call(`/api/memory-cards/${cardId}/review`, { method: 'POST', token, body: { remembered: true } });
  assert(reviewed.data.ok && reviewed.data.interval_days >= 1, '记忆卡自评失败：' + JSON.stringify(reviewed.data));

  // 交叉核验：伪造引用必须被丢弃，文章声称必须带口径
  const verify = await call('/api/materials/verify', { method: 'POST', token, body: { claim: '黎曼猜想已被攻克' } });
  assert(verify.status === 200 && verify.data.items.length === 1, '交叉核验未过滤伪引用：' + JSON.stringify(verify.data));
  assert(verify.data.items[0].note.startsWith('文章称'), '交叉核验未标注文章口径');

  // 图片资料：视觉描述 → 资料切块 → 原图静态可访问
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const img = await call('/api/materials/image', { method: 'POST', token, body: { image: png, title: '流程图截图', hint: '学习步骤' } });
  assert(img.status === 200 && img.data.material.source_type === 'image', '图片资料入库失败：' + JSON.stringify(img.data));
  assert(img.data.image_url?.startsWith('/uploads/'), '图片原图地址缺失');
  const detail = await call(`/api/materials/${img.data.material.id}`, { token });
  assert(detail.data.chunks.some(c => c.content.includes('看动画')), '图片描述未切块入库');
  const imgResp = await fetch(base + img.data.image_url);
  assert(imgResp.status === 200 && (imgResp.headers.get('content-type') || '').includes('image/png'), '原图静态访问失败');

  console.log('PHASE2 OK: 排序题/记忆宫殿/交叉核验/图片资料全部通过');
} finally {
  child.kill('SIGTERM');
  await new Promise(r => child.once('exit', r));
  mock.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 文件句柄释放延迟 */ }
}
