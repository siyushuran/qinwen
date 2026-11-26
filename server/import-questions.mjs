// 题库导入客户端：把 munger-kb 生成的 question_bank.jsonl 推送到网站 API
// 用法:
//   node import-questions.mjs <jsonl路径> [--url http://127.0.0.1:3000] [--token <token>] [--batch 200]
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) {
  console.error('用法: node import-questions.mjs <jsonl路径> [--url ...] [--token ...] [--batch 200]');
  process.exit(2);
}
function opt(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
}
const baseUrl = (opt('url', process.env.QW_URL || 'http://127.0.0.1:3000')).replace(/\/+$/, '');
const token = opt('token', process.env.QW_TOKEN || '');
const batchSize = Math.max(10, Math.min(1000, Number(opt('batch', '200')) || 200));

if (!token) {
  console.error('缺少 token：请通过 --token 或环境变量 QW_TOKEN 提供网站登录 token');
  process.exit(2);
}

const raw = fs.readFileSync(file, 'utf8').trim();
if (!raw) { console.error('题库文件为空'); process.exit(2); }
const questions = raw.split(/\r?\n/).map(line => {
  try { return JSON.parse(line); } catch { throw new Error(`JSONL 解析失败: ${line.slice(0, 80)}`); }
});

async function post(path, body) {
  const resp = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  if (!resp.ok) throw new Error(`${path} HTTP ${resp.status}: ${JSON.stringify(data)}`);
  return data;
}

let created = 0, skipped = 0, invalid = 0;
const total = Math.ceil(questions.length / batchSize);
for (let i = 0; i < questions.length; i += batchSize) {
  const batch = questions.slice(i, i + batchSize);
  const r = await post('/api/bank/import', { questions: batch });
  created += r.stats.questions_created;
  skipped += r.stats.questions_skipped;
  invalid += r.stats.invalid;
  console.log(`[${Math.floor(i / batchSize) + 1}/${total}] 新建 ${r.stats.questions_created}，跳过 ${r.stats.questions_skipped}，无效 ${r.stats.invalid}`);
}
const resp = await fetch(baseUrl + '/api/bank/stats', { headers: { Authorization: `Bearer ${token}` } });
const stats = await resp.json();
console.log('导入完成:', JSON.stringify({ created, skipped, invalid, bank: stats }, null, 2));
