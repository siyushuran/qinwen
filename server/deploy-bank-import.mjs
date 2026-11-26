// 容器内执行：从共享 DB 读取登录 token，调用本机 API 导入题库，避免暴露密码。
// 由临时容器挂载 /vol2/1000/DOCKER/qingwen-practice/server 到 /appdir 后运行。
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DB = process.env.DB_PATH || '/appdir/data/qingwen.db';
const API = process.env.API_BASE || 'http://127.0.0.1:3000';
const BANK = process.env.BANK_FILE || '/appdir/question_bank.jsonl';

const db = new DatabaseSync(DB, { readOnly: true });
const token = db.prepare("SELECT value FROM setting WHERE key = 'token'").get()?.value || '';
db.close();
if (!token) { console.error('DB 中无 token'); process.exit(2); }

const questions = fs.readFileSync(BANK, 'utf8').trim().split(/\r?\n/).map(l => JSON.parse(l));
async function post(path, body) {
  const resp = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  if (!resp.ok) throw new Error(`${path} HTTP ${resp.status}: ${JSON.stringify(data)}`);
  return data;
}
async function get(path) {
  const resp = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  return resp.json();
}

let created = 0, skipped = 0, invalid = 0;
const B = 200;
for (let i = 0; i < questions.length; i += B) {
  const r = await post('/api/bank/import', { questions: questions.slice(i, i + B) });
  created += r.stats.questions_created;
  skipped += r.stats.questions_skipped;
  invalid += r.stats.invalid;
  console.log(`[${Math.floor(i / B) + 1}/${Math.ceil(questions.length / B)}] 新建 ${r.stats.questions_created}，跳过 ${r.stats.questions_skipped}`);
}
const stats = await get('/api/bank/stats');
console.log('FINAL', JSON.stringify({ created, skipped, invalid, bank: stats }));
