// 难度行为回归测试：确认难度阶梯写进提示词，且手动切档会跳过旧缓存重新出题。
// 运行：node server/difficulty-test.mjs
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, 'server.mjs');
const WEB_DIR = path.resolve(__dirname, '..', 'web', 'dist');
const assert = (c, m) => { if (!c) throw new Error('断言失败：' + m); };
const freePort = () => new Promise(r => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
});
const wait = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  const prompts = [];
  const mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const prompt = body.messages?.[0]?.content || '';
      prompts.push(prompt);
      const reply = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }));
      };
      if (prompt.includes('知识体系拆解教练')) {
        return reply({ facets: [{ name: '基础概念', points: [{ name: '概念甲', cognitive_level: 1 }] }] });
      }
      return reply({ type: 'single', stem: '下面哪一个是正确选项？',
        options: ['正确项', '干扰项一', '干扰项二'], answer: 'A', explanation: '因为如此这般' });
    });
  });
  const mockPort = await freePort();
  await new Promise(r => mock.listen(mockPort, '127.0.0.1', r));

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingwen-difficulty-'));
  const apiPort = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(apiPort), DATA_DIR: dataDir, WEB_DIR },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${apiPort}`;
  let token = '';
  const call = async (p, opts = {}) => {
    const r = await fetch(base + p, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`${opts.method || 'GET'} ${p} -> ${r.status}: ${JSON.stringify(data)}`);
    return data;
  };
  const post = (p, body) => call(p, { method: 'POST', body: JSON.stringify(body) });

  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await call('/api/health')).ok) break; } catch {}
      await wait(100);
    }
    token = (await post('/api/auth/setup', { password: 'test1234' })).token;
    await post('/api/settings', {
      llm_base_url: `http://127.0.0.1:${mockPort}/v1`,
      llm_api_key: 'sk-test', llm_chat_model: 'mock-chat',
    });
    const domain = await post('/api/domains', { name: '难度测试领域', level: '零基础' });
    await post(`/api/domains/${domain.id}/build`, {});
    const detail = await call(`/api/domains/${domain.id}`);
    const point = detail.nodes.find(n => n.parent_id);
    assert(point, '存在知识点');

    const q1 = await post('/api/questions', { node_id: point.id, difficulty: 1 });
    assert(q1.cached === false, '难度1首次生成');
    const p1 = prompts.find(p => p.includes('【1档·识记】'));
    assert(p1 && p1.includes('严格按该档位出题'), '难度1提示词带识记档要求');

    const q1Again = await post('/api/questions', { node_id: point.id, difficulty: 1 });
    assert(q1Again.cached === true, '同难度无 regenerate 时复用缓存');

    const before = prompts.length;
    const q1Regen = await post('/api/questions', { node_id: point.id, difficulty: 1, regenerate: true });
    assert(q1Regen.cached === false, 'regenerate 跳过缓存重新生成');
    assert(prompts.length === before + 1, 'regenerate 触发了一次模型调用');

    const q2 = await post('/api/questions', { node_id: point.id, difficulty: 2, regenerate: true });
    assert(q2.cached === false, '难度2切档重新生成');
    const p2 = prompts.find(p => p.includes('【2档·理解】'));
    assert(p2 && p2.includes('严格按该档位出题'), '难度2提示词带理解档要求');
    assert(q2.question.difficulty === 2, '新题落库为难度2');

    console.log('DIFFICULTY OK: 难度阶梯与切档重新出题均生效');
  } finally {
    child.kill('SIGTERM');
    mock.close();
    await Promise.race([new Promise(r => child.once('exit', r)), wait(3000)]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

run().catch(e => { console.error(e.message); process.exitCode = 1; });
