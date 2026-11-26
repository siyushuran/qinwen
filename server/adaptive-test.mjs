// 自适应闭环回归测试：难度建议（定档/升降档）+ 薄弱知识点排行 + 复习优先级排序。
// 运行：node server/adaptive-test.mjs
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

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
      if (prompt.includes('知识体系拆解教练')) {
        return reply({ facets: [{ name: '基础概念', points: [
          { name: '概念甲', cognitive_level: 1 }, { name: '概念乙', cognitive_level: 2 },
        ] }] });
      }
      if (prompt.includes('出题老师')) {
        return reply({ type: 'single', stem: '下面哪一个是正确选项？',
          options: ['正确项', '干扰项一', '干扰项二'], answer: 'A', explanation: '因为如此这般' });
      }
      return reply({ explanation: '讲解内容', followups: [] });
    });
  });
  const mockPort = await freePort();
  await new Promise(r => mock.listen(mockPort, '127.0.0.1', r));

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingwen-adaptive-'));
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
    const domain = await post('/api/domains', { name: '自适应测试领域', level: '零基础' });
    await post(`/api/domains/${domain.id}/build`, {});
    const detail = await call(`/api/domains/${domain.id}`);
    const points = detail.nodes.filter(n => n.parent_id);
    assert(points.length >= 2, '至少两个知识点');
    const [strong, weak] = points;

    // --- 1. 难度建议：无记录时定为基础档 ---
    const init = await call(`/api/difficulty/advice?node_id=${strong.id}`);
    assert(init.recommended === 2 && init.phase === 'calibrating' && init.samples === 0, '无记录时先用基础档定档');

    // --- 2. 连对 3 题升档、连错 3 题降档 ---
    for (let i = 0; i < 3; i++) {
      const q = await post('/api/questions', { node_id: strong.id, difficulty: 2 });
      await post('/api/attempts', { question_id: q.question.id, answer: '正确项', duration_ms: 5000 });
    }
    const up = await call(`/api/difficulty/advice?node_id=${strong.id}`);
    assert(up.phase === 'adaptive' && up.recommended === 3, '同档连对 3 题升到 3 档');
    assert(up.reason.includes('升到 3 档'), '升档有可解释原因');

    let tagged = null;
    for (let i = 0; i < 3; i++) {
      const q = await post('/api/questions', { node_id: weak.id, difficulty: 2 });
      const a = await post('/api/attempts', { question_id: q.question.id, answer: '干扰项一', duration_ms: 5000 });
      tagged ||= a.attempt_id;
    }
    await post(`/api/attempts/${tagged}/error-tags`, { error_tags: ['概念不清'] });
    const down = await call(`/api/difficulty/advice?node_id=${weak.id}`);
    assert(down.recommended === 1, '同档连错 3 题降到 1 档');
    assert(down.reason.includes('降到 1 档'), '降档有可解释原因');
    assert(down.by_difficulty.find(x => x.difficulty === 2).n === 3, '按档位统计题数正确');

    // --- 3. 薄弱知识点排行：错的排前面，带错因与近 7 天错题数 ---
    const stats = await call('/api/stats?tz=480');
    assert(stats.weak_nodes.length >= 2, '统计返回薄弱知识点');
    assert(stats.weak_nodes[0].node_id === weak.id, '正确率低的知识点排最前');
    assert(stats.weak_nodes[0].rate === 0 && stats.weak_nodes[0].recent_wrong === 3, '薄弱点正确率与近期错题数正确');
    assert(stats.weak_nodes[0].top_tags.some(t => t.tag === '概念不清'), '薄弱点带错因标签');

    // --- 4. 复习排序：同样到期时，薄弱节点优先 ---
    const db = new DatabaseSync(path.join(dataDir, 'qingwen.db'));
    const past = new Date(Date.now() - 3600000).toISOString();
    db.prepare('UPDATE review_slot SET due_at = ?').run(past);
    db.close();
    const review = await call('/api/review');
    assert(review.due.length >= 2, '两个知识点到期');
    assert(review.due[0].id === weak.id, '薄弱知识点优先出现在复习队列');
    assert(review.due[0].weakness > review.due[1].weakness, '复习队列带薄弱度且排序正确');
    assert(review.due[0].recent_rate === 0 && review.due[0].recent_n === 3, '复习队列带近 7 天作答数据');

    console.log('ADAPTIVE OK: 难度建议、薄弱排行与复习优先级均生效');
  } finally {
    child.kill('SIGTERM');
    mock.close();
    await Promise.race([new Promise(r => child.once('exit', r)), wait(3000)]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

run().catch(e => { console.error(e.message); process.exitCode = 1; });
