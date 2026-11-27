// 跨领域出题回归测试：桥接提示词、缓存隔离、关联节点不记账、伪跨领域拦截。
// 运行：node server/cross-domain-test.mjs
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
  let badBridge = false;
  const mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const prompt = body.messages?.[0]?.content || '';
      prompts.push(prompt);
      const reply = obj => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }));
      };
      if (prompt.includes('知识体系拆解教练')) {
        if (prompt.includes('投资领域')) return reply({ facets: [{ name: '收益', points: [{ name: '复利效应', cognitive_level: 2 }] }] });
        if (prompt.includes('物理领域')) return reply({ facets: [{ name: '力学', points: [{ name: '杠杆原理', cognitive_level: 2 }] }] });
        return reply({ facets: [{ name: '通用', points: [{ name: '通用概念', cognitive_level: 1 }] }] });
      }
      if (prompt.includes('擅长「知识迁移」的出题老师')) {
        if (badBridge) {
          return reply({ type: 'single', stem: '下面哪一项是正确说法？', options: ['甲', '乙', '丙'],
            answer: '甲', explanation: '因为如此', bridge: '两件事有共同结构', bridge_type: 'analogy' });
        }
        return reply({ type: 'single', stem: '把杠杆原理放进投资决策，哪一项最能说明两者的共同结构？',
          options: ['杠杆的支点像复利的时间', '无关选项一', '无关选项二'], answer: 'A',
          explanation: '杠杆原理与复利效应都靠一个关键点放大结果，只懂其中一个无法判断。',
          bridge: '杠杆的支点与复利的时间都是放大结果的支点', bridge_type: 'analogy' });
      }
      return reply({ type: 'single', stem: '普通题：哪一项正确？', options: ['正确项', '干扰项一', '干扰项二'],
        answer: 'A', explanation: '因为如此这般' });
    });
  });
  const mockPort = await freePort();
  await new Promise(r => mock.listen(mockPort, '127.0.0.1', r));

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingwen-cross-'));
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
    if (!r.ok) Object.assign(data, { __status: r.status });
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
    const da = await post('/api/domains', { name: '投资领域', level: '零基础' });
    const dbm = await post('/api/domains', { name: '物理领域', level: '零基础' });
    await post(`/api/domains/${da.id}/build`, {});
    await post(`/api/domains/${dbm.id}/build`, {});
    const detA = await call(`/api/domains/${da.id}`);
    const detB = await call(`/api/domains/${dbm.id}`);
    const a = detA.nodes.find(n => n.parent_id);
    const b = detB.nodes.find(n => n.parent_id);
    assert(a?.name === '复利效应' && b?.name === '杠杆原理', '两个领域各自生成知识点');
    assert(a.domain_id !== b.domain_id, '知识点确实跨领域');

    const cands = await call(`/api/nodes/candidates?exclude_id=${a.id}`);
    assert(cands.nodes.some(n => n.id === b.id && n.domain_name === '物理领域'), '候选清单带领域名');
    assert(!cands.nodes.some(n => n.id === a.id), '候选清单排除主知识点');

    const cross = await post('/api/questions', {
      node_id: a.id, difficulty: 3, related_node_ids: [b.id], bridge_type: 'analogy',
      force_new: true, regenerate: true,
    });
    assert(cross.__status === undefined, `跨领域出题成功：${JSON.stringify(cross)}`);
    assert(cross.cached === false, '首次跨领域出题调用模型');
    assert(JSON.stringify(cross.question.related_node_ids) === JSON.stringify([b.id]), '题目带着关联节点');
    assert(cross.question.bridge_type === 'analogy' && cross.question.bridge.length > 4, '桥接方式与桥接点已落库');
    const cp = prompts.find(p => p.includes('擅长「知识迁移」的出题老师'));
    assert(cp && cp.includes('【3档·应用】'), '跨领域提示词带难度档要求');
    assert(cp.includes('杠杆原理') && cp.includes('结构类比'), '跨领域提示词带关联节点与桥接类型');

    const crossAgain = await post('/api/questions', {
      node_id: a.id, difficulty: 3, related_node_ids: [b.id], bridge_type: 'analogy',
    });
    assert(crossAgain.cached === true && crossAgain.question.id === cross.question.id, '同组合缓存复用');

    const plain = await post('/api/questions', { node_id: a.id, difficulty: 3 });
    assert(plain.question.id !== cross.question.id && JSON.stringify(plain.question.related_node_ids) === '[]', '普通题与跨领域题缓存隔离');
    const otherBridge = await post('/api/questions', {
      node_id: a.id, difficulty: 3, related_node_ids: [b.id], bridge_type: 'contrast',
    });
    assert(otherBridge.cached === false, '换桥接方式重新出题');

    const ans = await post('/api/attempts', { question_id: cross.question.id, answer: 'A', duration_ms: 5000 });
    assert(ans.ok, '跨领域题可正常作答');
    const advA = await call(`/api/difficulty/advice?node_id=${a.id}`);
    const advB = await call(`/api/difficulty/advice?node_id=${b.id}`);
    assert(advA.samples >= 1, '作答记到主知识点');
    assert(advB.node_samples === 0, '关联知识点自身没有作答记录（samples 可能来自领域累计）');

    badBridge = true;
    const fake = await post('/api/questions', {
      node_id: a.id, difficulty: 4, related_node_ids: [b.id], bridge_type: 'analogy',
      force_new: true, regenerate: true,
    });
    assert(fake.__status === 502, `伪跨领域题被拒绝：${JSON.stringify(fake)}`);
    badBridge = false;

    const invalid = await post('/api/questions', { node_id: a.id, difficulty: 2, related_node_ids: [999999] });
    assert(invalid.__status === 400, '不存在的关联知识点被拒绝');
    const same = await post('/api/questions', { node_id: a.id, difficulty: 2, related_node_ids: [a.id] });
    assert(same.__status === 400, '关联节点不能等于主节点');

    console.log('CROSS-DOMAIN OK: 桥接提示词、缓存隔离、记账边界与伪跨领域拦截均生效');
  } finally {
    child.kill('SIGTERM');
    mock.close();
    await Promise.race([new Promise(r => child.once('exit', r)), wait(3000)]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

run().catch(e => { console.error(e.message); process.exitCode = 1; });
