// 冒烟测试：node smoke-stats.mjs seed | node smoke-stats.mjs check
// seed：建临时库、灌模拟作答数据、把 token 写入 .tmp-smoke/token.txt
// check：启动服务后调用 /api/stats 断言统计结果
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const phase = process.argv[2];
const dir = path.join(process.cwd(), '.tmp-smoke');

if (phase === 'seed') {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'qingwen.db'));
  db.exec(`
  CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS domain (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, source TEXT DEFAULT 'manual', status TEXT DEFAULT 'draft', overall_mastery REAL DEFAULT 0, created_at TEXT);
  CREATE TABLE IF NOT EXISTS node (id INTEGER PRIMARY KEY AUTOINCREMENT, domain_id INT NOT NULL, parent_id INT, name TEXT, cognitive_level INT DEFAULT 1, mastery REAL DEFAULT 0, status TEXT DEFAULT 'active', created_at TEXT);
  CREATE TABLE IF NOT EXISTS question (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id INT NOT NULL, type TEXT, difficulty INT DEFAULT 1, stem TEXT, options TEXT, answer TEXT, explanation TEXT, model TEXT, prompt_ver TEXT, created_at TEXT);
  CREATE TABLE IF NOT EXISTS attempt (id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INT NOT NULL, node_id INT, answer_given TEXT, is_correct INT, duration_ms INT DEFAULT 0, error_tags TEXT, created_at TEXT);
  CREATE TABLE IF NOT EXISTS review_slot (node_id INT PRIMARY KEY, due_at TEXT, interval_days INT DEFAULT 1, ease REAL DEFAULT 2.5);
  CREATE TABLE IF NOT EXISTS mistake (node_id INT NOT NULL, question_id INT, status TEXT DEFAULT 'active', resolved_at TEXT, PRIMARY KEY (node_id, question_id));
  CREATE TABLE IF NOT EXISTS chat_turn (id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INT, role TEXT, content TEXT, ts TEXT);
  `);

  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT OR REPLACE INTO setting (key, value) VALUES (?, ?)').run('token', token);
  db.prepare('INSERT OR REPLACE INTO setting (key, value) VALUES (?, ?)').run('password_hash', 'x:x');
  db.prepare('INSERT OR REPLACE INTO domain (id, name, overall_mastery, status, created_at) VALUES (1, ?, 0.5, ?, ?)').run('测试领域', 'ready', new Date().toISOString());
  db.prepare('INSERT OR REPLACE INTO node (id, domain_id, name, mastery, created_at) VALUES (1, 1, ?, 0.5, ?)').run('测试知识点', new Date().toISOString());
  db.prepare('INSERT OR REPLACE INTO question (id, node_id, type, difficulty, stem, options, answer, explanation, created_at) VALUES (1, 1, ?, 1, ?, ?, ?, ?, ?)')
    .run('single', '测试题', JSON.stringify(['A', 'B']), 'A', '解析', new Date().toISOString());

  // 模拟作答：今天×3、昨天×2、3 天前×1、31 天前×2（跨月）、62 天前×1、去年×3
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const ins = db.prepare('INSERT INTO attempt (question_id, node_id, answer_given, is_correct, duration_ms, created_at) VALUES (1, 1, ?, ?, ?, ?)');
  ins.run('A', 1, 30000, day(0));
  ins.run('A', 1, 20000, day(0));
  ins.run('B', 0, 40000, day(0));
  ins.run('A', 1, 15000, day(1));
  ins.run('A', 1, 25000, day(1));
  ins.run('B', 0, 60000, day(3));
  ins.run('A', 1, 30000, day(31));
  ins.run('A', 1, 20000, day(31));
  ins.run('B', 0, 50000, day(62));
  ins.run('A', 1, 10000, '2025-12-15T10:00:00.000Z');
  ins.run('A', 1, 20000, '2025-12-16T10:00:00.000Z');
  ins.run('B', 0, 30000, '2025-12-16T11:00:00.000Z');
  db.close();

  fs.writeFileSync(path.join(dir, 'token.txt'), token, 'utf8');
  console.log('seed 完成：12 条模拟作答已写入 ' + path.join(dir, 'qingwen.db'));
  process.exit(0);
}

if (phase === 'check') {
  if (!fs.existsSync(path.join(dir, 'qingwen.db'))) {
    console.error('缺少种子库，请先运行 seed');
    process.exit(1);
  }
  const token = fs.readFileSync(path.join(dir, 'token.txt'), 'utf8').trim();
  const base = 'http://127.0.0.1:3999';
  const resp = await fetch(`${base}/api/stats`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await resp.json();
  console.log('HTTP', resp.status);
  console.log(JSON.stringify({
    total: data.total, correct: data.correct, accuracy: data.accuracy,
    totalMs: data.totalMs, daysActive: data.daysActive, streak: data.streak,
    byDayCount: data.byDay.length, byMonthCount: data.byMonth.length,
    byYearCount: data.byYear.length,
    byDay: data.byDay, byMonth: data.byMonth, byYear: data.byYear,
    domains: data.domains,
  }, null, 2));

  const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('PASS:', msg); };
  assert(resp.status === 200, '接口返回 200');
  assert(data.total === 12, `总题数=12（实际 ${data.total}）`);
  assert(data.correct === 8, `答对数=8（实际 ${data.correct}）`);
  assert(data.accuracy === 67, `正确率=67%（实际 ${data.accuracy}）`);
  assert(data.totalMs === 350000, `累计时长=350000ms（实际 ${data.totalMs}）`);
  assert(data.streak === 2, `连续打卡=2（11-24 空档，实际 ${data.streak}）`);
  assert(data.daysActive === 7, `打卡天数=7（实际 ${data.daysActive}）`);
  assert(data.byDay.length === 3, `逐日记录=3 天（实际 ${data.byDay.length}）`);
  assert(data.byMonth.length === 4, `逐月记录=4 个月（实际 ${data.byMonth.length}）`);
  assert(data.byYear.length === 2, `逐年记录=2 年（实际 ${data.byYear.length}）`);
  const curMonth = new Date().toISOString().slice(0, 7);
  const cur = data.byMonth.find(m => m.m === curMonth);
  assert(cur && cur.n === 6 && cur.ok === 4, `当月聚合正确（期望 n=6/ok=4，实际 ${cur?.n}/${cur?.ok}）`);
  assert(data.domains.length === 1 && data.domains[0].name === '测试领域', '领域掌握度返回正常');
  console.log('\n冒烟测试完成');
  process.exit(process.exitCode || 0);
}

console.error('用法：node smoke-stats.mjs seed | node smoke-stats.mjs check');
process.exit(1);
