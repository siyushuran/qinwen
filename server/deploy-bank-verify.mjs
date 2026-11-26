// 容器内只读验证题库导入结果
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/appdir/data/qingwen.db', { readOnly: true });
const q = sql => db.prepare(sql).get();
const all = sql => db.prepare(sql).all();
const out = {
  domain: q("SELECT id,name,source_key FROM domain WHERE source_key='munger-kb://domain/munger-models'") || null,
  facets: q("SELECT COUNT(*) n FROM node WHERE source_key LIKE 'munger-kb://facet/%'").n,
  model_nodes: q("SELECT COUNT(*) n FROM node WHERE source_key LIKE 'munger-kb://model/%'").n,
  questions: q("SELECT COUNT(*) n FROM question WHERE source_key LIKE 'munger-kb://q/%'").n,
  by_type: all("SELECT source_type, COUNT(*) n FROM question WHERE source_key LIKE 'munger-kb://q/%' GROUP BY source_type"),
  by_difficulty: all("SELECT difficulty, COUNT(*) n FROM question WHERE source_key LIKE 'munger-kb://q/%' GROUP BY difficulty"),
  with_source: q("SELECT COUNT(*) n FROM question WHERE source_key LIKE 'munger-kb://q/%' AND source_url LIKE 'https://mungermodels.com/%'").n,
  sample: q("SELECT stem,type,difficulty,options,answer,source_url FROM question WHERE source_key LIKE 'munger-kb://q/%' LIMIT 1"),
};
import fs from 'node:fs'; fs.writeFileSync('/appdir/bank-verify-result.json', JSON.stringify(out, null, 2)); try { fs.writeFileSync('/appweb/bank-verify-result.json', JSON.stringify(out, null, 2)); } catch(e) { console.error('web write:', e.message); } console.log(JSON.stringify(out, null, 2));
db.close();
