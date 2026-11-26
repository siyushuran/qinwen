// 端到端冒烟测试：模拟 OpenAI 兼容模型 + 真实后端，验证主要用户流程与关键边界。
// 运行：node server/smoke-test.mjs
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

async function startMockModel() {
  const chunks = ['先说', '思路', '再看', '线索'];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const prompt = body.messages?.[0]?.content || '';
      const reply = (obj) => {
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
          options: ['正确项', '干扰项一', '干扰项二', '干扰项三'], answer: 'A', explanation: '因为如此这般' });
      }
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // 故意把第一帧拆成两段发送，验证服务端 SSE 帧缓冲不会丢字
        const frame = (c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`;
        const first = frame(chunks[0]);
        res.write(first.slice(0, 12));
        setTimeout(() => {
          res.write(first.slice(12));
          for (const c of chunks.slice(1)) res.write(frame(c));
          res.end(`data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\ndata: [DONE]\n\n`);
        }, 10);
        return;
      }
      return reply({ judged: '错', explanation: '这是讲解内容', followups: ['能举个例子吗？'] });
    });
  });
  const port = await freePort();
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, port };
}

async function waitHealth(base) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) return r.json();
    } catch { /* 尚未就绪 */ }
    await wait(100);
  }
  throw new Error('后端未能启动');
}

async function run() {
  assert(fs.existsSync(SERVER), '服务端文件存在');
  assert(fs.existsSync(path.join(WEB_DIR, 'index.html')), '前端构建产物存在');
  const mock = await startMockModel();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingwen-smoke-'));
  const apiPort = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(apiPort), DATA_DIR: dataDir, WEB_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', c => logs += c);
  child.stderr.on('data', c => logs += c);
  const base = `http://127.0.0.1:${apiPort}`;
  let token = '';

  const call = async (p, opts = {}) => {
    const r = await fetch(base + p, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
    });
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) throw new Error(`${opts.method || 'GET'} ${p} -> ${r.status}: ${JSON.stringify(data)}`);
    return { data, headers: r.headers };
  };
  const post = (p, body) => call(p, { method: 'POST', body: JSON.stringify(body) });

  try {
    const health = await waitHealth(base);
    assert(health.ok && health.model_configured === false, '初始健康检查');

    const status = (await call('/api/auth/status')).data;
    assert(status.configured === false, '首次访问未设置密码');

    token = (await post('/api/auth/setup', { password: 'test1234' })).data.token;
    assert(token && token.length > 20, '初始化密码返回令牌');

    await post('/api/settings', {
      llm_base_url: `http://127.0.0.1:${mock.port}/v1`,
      llm_api_key: 'sk-smoke-test', llm_chat_model: 'mock-chat', llm_fast_model: '',
    });
    // 关键回归：重新打开设置页后空输入框不应清空已保存的密钥/地址
    await post('/api/settings', { llm_base_url: '', llm_api_key: '', llm_chat_model: '' });
    const settings = (await call('/api/settings')).data;
    assert(settings.model.configured && settings.model.base_url_set && settings.model.api_key_set, '空值不覆盖模型配置');

    const domain = (await post('/api/domains', { name: '冒烟测试领域', level: '学过一点' })).data;
    assert(domain.id > 0, '创建领域');

    const built = (await post(`/api/domains/${domain.id}/build`, {})).data;
    assert(built.nodes.length >= 3, 'AI 拆解知识清单');
    const detail = (await call(`/api/domains/${domain.id}`)).data;
    assert(detail.domain.level === '学过一点', '起始基础已持久化并用于拆解');
    const point = detail.nodes.find(n => n.parent_id);
    assert(point, '存在知识点');

    const q = (await post('/api/questions', { node_id: point.id, difficulty: 2 })).data.question;
    assert(Array.isArray(q.options) && q.options.length === 4, '题目选项为数组');
    assert(!('answer' in q) && !('explanation' in q), '下发题目不含答案与解析');
    const byId = (await call(`/api/questions/${q.id}`)).data.question;
    assert(byId.domain_id === domain.id && !('answer' in byId), '按 ID 取题只返回公开字段');

    const wrong = q.options[1];
    const attempt = (await post('/api/attempts', { question_id: q.id, answer: wrong, duration_ms: 3000 })).data;
    assert(!attempt.is_correct && attempt.correct_index === 0, '判错并定位正确选项：' + JSON.stringify(attempt));
    assert(attempt.attempt_id > 0, '返回作答记录 ID 供错因补记');

    await post(`/api/attempts/${attempt.attempt_id}/error-tags`, { error_tags: ['概念不清', '审题偏差', '非法标签'] });
    const mistakes = (await call('/api/mistakes')).data.mistakes;
    const item = Object.values(mistakes).flat().find(x => x.question_id === q.id);
    assert(item && item.error_tags.length === 2 && item.error_tags.includes('概念不清'), '错因标签落库并在错题本可见');
    assert(item.domain_id === domain.id && item.node_id === point.id, '错题本含直达所需 ID');

    const report = (await call(`/api/report?days=7&tz=480`)).data;
    assert(report.tz === 480 && report.total >= 1 && report.byDay.length >= 1, '报告按本地时区聚合');

    const chatResp = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ question_id: q.id, content: '能提示一下吗？', history: [] }),
    });
    assert(chatResp.ok, 'SSE 追问可建立');
    const streamText = await chatResp.text();
    assert(['先说', '思路', '再看', '线索'].every(x => streamText.includes(x)), '跨分片 SSE 内容无丢失');
    assert(streamText.includes('"done":true'), 'SSE 正常结束');

    const exported = await call('/api/export');
    assert((exported.headers.get('content-type') || '').includes('octet-stream'), '导出为二进制备份');
    assert(!exported.data.includes('sk-smoke-test'), '备份不含模型密钥');

    await post('/api/auth/logout', {});
    const afterLogout = (await call('/api/auth/status')).data;
    assert(afterLogout.authed === false, '退出登录撤销令牌');

    console.log('SMOKE OK: 核心流程与边界检查通过');
  } finally {
    if (token) { try { await post('/api/auth/logout', {}); } catch { /* 已退出 */ } }
    child.kill('SIGTERM');
    await Promise.race([new Promise(r => child.once('exit', r)), wait(3000)]);
    mock.server.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
    if (child.exitCode === null) child.kill('SIGKILL');
    if (logs.includes('未捕获请求错误')) console.error('服务端异常日志：\n' + logs);
  }
}

run().catch(e => { console.error(e.stack || e); process.exit(1); });
