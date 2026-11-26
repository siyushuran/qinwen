// 把一篇整理好的 Markdown 资料导入「轻问练」：入库 → 摘要 → 按资料拆清单 → 生成题目。
// 用法：QW_TOKEN='<网站token>' node server/seed-article.mjs <站点URL> <资料.md> [领域名]
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [urlArg, fileArg, domainName] = process.argv.slice(2);
let token = process.env.QW_TOKEN || '';
// 也可从本地数据库副本读取 token（配合 NAS 文件下载使用），避免在终端/聊天里暴露令牌
if (!token && process.env.QW_DB) {
  const db = new DatabaseSync(process.env.QW_DB, { readOnly: true });
  try { token = db.prepare("SELECT value FROM setting WHERE key = 'token'").get()?.value || ''; }
  finally { db.close(); }
}
const base = (urlArg || '').replace(/\/+$/, '');
if (!base || !fileArg || !token) {
  console.error('用法：QW_TOKEN=<token> 或 QW_DB=<数据库副本路径> node server/seed-article.mjs <站点URL> <资料.md> [领域名]');
  process.exit(2);
}
const content = fs.readFileSync(fileArg, 'utf8').trim();
const title = (domainName || content.match(/^#\s+(.+)$/m)?.[1] || '未命名资料').trim().slice(0, 120);
const sourceUrl = content.match(/原文[：:]\s*(https?:\/\/\S+)/)?.[1] || '';

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

const health = await fetch(base + '/api/health').then(r => r.json());
if (!health.model_configured) throw new Error('目标站点模型未配置，请先在设置页填写模型信息');

const created = await call('/api/materials', {
  title, source_url: sourceUrl, content, source_type: 'article', claim_policy: 'article_claim',
});
const id = created.material.id;
console.log(`资料：${created.reused ? '复用已有' : '新建'} #${id}，标题「${created.material.title}」，${created.material.chunk_count} 块`);

const sum = await call(`/api/materials/${id}/summary`, {});
console.log(`摘要：${sum.summary.one_line || '(空)'}；要点 ${sum.summary.points.length} 条，时间线 ${sum.summary.timeline.length} 条`);

const built = await call(`/api/materials/${id}/build`, { domain_name: title, level: '没学过' });
console.log(`清单：领域 #${built.domain_id}，${built.nodes.length} 个知识点`);

const questions = await call(`/api/materials/${id}/questions`, { count: 12, difficulty: 1 });
console.log(`题目：成功 ${questions.created}，失败 ${questions.failed}`);
console.log(`SEED_OK material_id=${id} domain_id=${built.domain_id}`);

// 可选：把非敏感结果写到静态目录，便于在容器外验证（不含 token / 密钥）
if (process.env.SEED_RESULT_FILE) {
  fs.writeFileSync(process.env.SEED_RESULT_FILE, JSON.stringify({
    ok: true, material_id: id, domain_id: built.domain_id, chunks: created.material.chunk_count,
    summary_points: sum.summary.points.length, nodes: built.nodes.length,
    questions: questions.created, failed: questions.failed, time: new Date().toISOString(),
  }, null, 2));
}
