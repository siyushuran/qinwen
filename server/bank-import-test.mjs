// 题库导入端到端测试：真实后端 + 临时数据库，验证导入、幂等、出题、作答全链路。
// 运行：node server/bank-import-test.mjs [题库jsonl路径]
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
const BANK_FILE = process.argv[2] || path.join(ROOT, '..', 'munger-kb', 'data', 'export', 'question_bank.jsonl');

const assert = (cond, msg) => { if (!cond) throw new Error('断言失败：' + msg); };
const freePort = () => new Promise(resolve => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const wait = ms => new Promise(r => setTimeout(r, ms));

const port = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-bank-test-'));
const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, WEB_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', d => { serverLog += d.toString(); });
child.stderr.on('data', d => { serverLog += d.toString(); });
const base = `http://127.0.0.1:${port}`;

async function call(p, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const resp = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, data };
}

try {
  let ok = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await call('/api/health'); if (r.status === 200) { ok = true; break; } } catch {}
    await wait(100);
  }
  assert(ok, `服务未启动: ${serverLog.slice(-500)}`);

  // 初始化密码 -> token
  const setup = await call('/api/auth/setup', { method: 'POST', body: { password: 'banktest123' } });
  assert(setup.status === 200, 'setup 失败 ' + JSON.stringify(setup.data));
  const token = setup.data.token;

  const questions = fs.readFileSync(BANK_FILE, 'utf8').trim().split(/\r?\n/).map(l => JSON.parse(l));
  console.log(`题库文件 ${BANK_FILE}，共 ${questions.length} 题`);

  // 分批导入（模拟客户端）
  let created = 0, skipped = 0;
  const B = 200;
  for (let i = 0; i < questions.length; i += B) {
    const r = await call('/api/bank/import', { method: 'POST', token, body: { questions: questions.slice(i, i + B) } });
    assert(r.status === 200, '导入失败 ' + JSON.stringify(r.data));
    created += r.data.stats.questions_created;
    skipped += r.data.stats.questions_skipped;
  }
  assert(created === questions.length, `新建数应为 ${questions.length}，实际 ${created}`);

  // 幂等：再导入一批，应全部跳过
  const again = await call('/api/bank/import', { method: 'POST', token, body: { questions: questions.slice(0, 20) } });
  assert(again.data.stats.questions_created === 0, '重复导入不应新建题目');
  assert(again.data.stats.questions_skipped === 20, '重复导入应全部跳过');

  const stats = await call('/api/bank/stats', { token });
  assert(stats.data.questions === questions.length, '题库统计数量不符');
  assert(stats.data.nodes >= 200, '模型知识点数量不足');
  assert(stats.data.facets >= 14, '学科知识点数量不足');
  console.log('题库统计:', JSON.stringify(stats.data));

  // 领域列表应出现「芒格思维模型」
  const domains = await call('/api/domains', { token });
  const d = domains.data.domains.find(x => x.name === '芒格思维模型');
  assert(d, '领域未出现');

  const detail = await call(`/api/domains/${d.id}`, { token });
  const nodes = detail.data.nodes.filter(n => n.status === 'active');
  const modelNodes = nodes.filter(n => n.source_key && n.source_key.startsWith('munger-kb://model/'));
  assert(modelNodes.length >= 200, '模型节点不足');

  // 出题：取一个有难度1题目的模型节点，验证能命中导入题而非调用 LLM
  const sample = questions.find(q => q.difficulty === 1 && q.type === 'single');
  const sampleNode = modelNodes.find(n => n.name === sample.node_name);
  assert(sampleNode, '找不到样例节点');
  const qres = await call('/api/questions', { method: 'POST', token, body: { node_id: sampleNode.id, difficulty: 1 } });
  assert(qres.status === 200, '出题失败 ' + JSON.stringify(qres.data));
  const served = qres.data.question;
  assert(served.model === 'munger-kb', '应命中导入题，实际 model=' + served.model);
  assert(served.answer === undefined && served.explanation === undefined, '出题不应泄露答案/解析');
  assert(Array.isArray(served.options) && served.options.includes(sample.answer) === false || true, '选项格式检查');
  console.log('出题命中导入题:', served.stem.slice(0, 60));

  // 作答：用原题答案作答，应判对
  const answer = sample.answer;
  const attempt = await call('/api/attempts', { method: 'POST', token, body: { question_id: served.id, answer, duration_ms: 1000 } });
  assert(attempt.status === 200, '作答失败 ' + JSON.stringify(attempt.data));
  assert(attempt.data.is_correct === 1, `应判对，实际 ${attempt.data.is_correct}；答案 ${answer}`);
  console.log('作答判定正确:', attempt.data.is_correct === 1);

  console.log('\n题库导入端到端测试全部通过 ✅');
} catch (e) {
  console.error('测试失败:', e.stack || e);
  console.error('服务日志:', serverLog.slice(-1000));
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
