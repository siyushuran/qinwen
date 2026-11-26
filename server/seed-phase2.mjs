// 在 NAS 内一次性生成 Phase 2 数据：从资料 #1 生成记忆卡与排序题。
// 用法：QW_DB=/app/server/data/qingwen.db node seed-phase2.mjs <站点URL>
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [urlArg] = process.argv.slice(2);
if (!urlArg) { console.error('用法：node seed-phase2.mjs <站点URL>'); process.exit(2); }
const db = new DatabaseSync(process.env.QW_DB || '/app/server/data/qingwen.db', { readOnly: true });
let token = '';
try { token = db.prepare("SELECT value FROM setting WHERE key = 'token'").get()?.value || ''; }
finally { db.close(); }
if (!token) { console.error('数据库里没有 token'); process.exit(2); }
const base = urlArg.replace(/\/+$/, '');

async function call(path, body) {
  const resp = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
  if (!resp.ok) throw new Error(`${path} 失败（${resp.status}）：${data.error || '未知错误'}`);
  return data;
}

const materials = await fetch(base + '/api/materials', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
const material = (materials.materials || []).find(m => m.title.includes('快速学习')) || materials.materials?.[0];
if (!material) throw new Error('线上没有资料，跳过 seed');

const cards = await call('/api/memory-cards/generate', { material_id: material.id, count: 5 });
let questions = { created: 0, failed: 0 };
if (material.domain_id) {
  questions = await call(`/api/materials/${material.id}/questions`, { count: 2, difficulty: 1, type: 'order' });
}
const listed = await fetch(base + '/api/memory-cards', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
const result = {
  ok: true, material_id: material.id, domain_id: material.domain_id,
  cards_generated: cards.generated, cards_reused: cards.reused,
  cards_total: (listed.cards || []).length,
  order_questions: questions.created, order_failed: questions.failed,
  time: new Date().toISOString(),
};
console.log(JSON.stringify(result, null, 2));
if (process.env.SEED_RESULT_FILE) fs.writeFileSync(process.env.SEED_RESULT_FILE, JSON.stringify(result, null, 2));
