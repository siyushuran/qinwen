// 轻问练 · 后端服务（零依赖 Node + 内置 node:sqlite）
// 架构对齐方案：单后端服务同进程托管前端静态文件 + API 路由 + SSE 流式 + 模型抽象层
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const WEB_DIR = process.env.WEB_DIR || path.join(__dirname, '..', 'web', 'dist');

fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'qingwen.db');
const db = new DatabaseSync(DB_PATH);

// ---------- 数据库初始化（方案第 6 节） ----------
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS setting (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS domain (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  source TEXT DEFAULT 'manual',
  status TEXT DEFAULT 'draft',
  overall_mastery REAL DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS node (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INT NOT NULL,
  parent_id INT,
  name TEXT,
  cognitive_level INT DEFAULT 1,
  mastery REAL DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS question (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INT NOT NULL,
  type TEXT,
  difficulty INT DEFAULT 1,
  stem TEXT,
  options TEXT,
  answer TEXT,
  explanation TEXT,
  model TEXT,
  prompt_ver TEXT,
  created_at TEXT,
  related_node_ids TEXT DEFAULT '[]',
  bridge_type TEXT DEFAULT '',
  bridge TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS attempt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INT NOT NULL,
  node_id INT,
  answer_given TEXT,
  is_correct INT,
  duration_ms INT DEFAULT 0,
  error_tags TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS review_slot (
  node_id INT PRIMARY KEY,
  due_at TEXT,
  interval_days INT DEFAULT 1,
  ease REAL DEFAULT 2.5
);
CREATE TABLE IF NOT EXISTS mistake (
  node_id INT NOT NULL,
  question_id INT,
  status TEXT DEFAULT 'active',
  resolved_at TEXT,
  PRIMARY KEY (node_id, question_id)
);
CREATE TABLE IF NOT EXISTS chat_turn (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INT,
  role TEXT,
  content TEXT,
  ts TEXT
);
-- 做题进度：按领域记住当前知识点/题目/难度，支持随时进出接着练
CREATE TABLE IF NOT EXISTS progress (
  domain_id INT PRIMARY KEY,
  node_id INT NOT NULL,
  question_id INT,
  difficulty INT DEFAULT 1,
  answered INT DEFAULT 0,
  updated_at TEXT
);
-- 划线收藏：用户在题干/讲解/追问中划下的有价值句子，可追溯到来源题目
CREATE TABLE IF NOT EXISTS highlight (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  source TEXT DEFAULT 'explanation',
  question_id INT,
  node_id INT,
  domain_id INT,
  question_stem TEXT DEFAULT '',
  source_url TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_highlight_created ON highlight(created_at);
CREATE INDEX IF NOT EXISTS idx_highlight_domain ON highlight(domain_id);
-- 资料（方案 M4）：网页/文章快照 + 结构化切块，支撑摘要、接地问答与资料出题
CREATE TABLE IF NOT EXISTS material (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INT,
  title TEXT NOT NULL,
  source_url TEXT DEFAULT '',
  source_type TEXT DEFAULT 'article',
  content_hash TEXT DEFAULT '',
  claim_policy TEXT DEFAULT 'article_claim',
  summary TEXT DEFAULT '',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS material_chunk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INT NOT NULL,
  idx INT NOT NULL,
  heading TEXT DEFAULT '',
  content TEXT NOT NULL,
  tags TEXT DEFAULT '[]',
  claim_status TEXT DEFAULT 'article_claim',
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunk_material ON material_chunk(material_id, idx);
-- 记忆宫殿复习卡：一个知识点一张，缓存生成结果，避免每次复习都调模型
CREATE TABLE IF NOT EXISTS memory_card (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INT NOT NULL UNIQUE,
  material_id INT,
  room TEXT NOT NULL,
  hook TEXT DEFAULT '',
  cue TEXT NOT NULL,
  answer TEXT NOT NULL,
  source_chunk_ids TEXT DEFAULT '[]',
  created_at TEXT
);
`);

// 旧库平滑升级：新增列不能影响已有数据
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
ensureColumn('domain', 'level', "TEXT DEFAULT '没学过'");
ensureColumn('mistake', 'error_tags', "TEXT DEFAULT '[]'");
// 外部题库（munger-kb）导入：source_key 用于幂等识别，source_url 保留来源可追溯
ensureColumn('domain', 'source_key', "TEXT DEFAULT ''");
ensureColumn('node', 'source_key', "TEXT DEFAULT ''");
ensureColumn('question', 'source_key', "TEXT DEFAULT ''");
ensureColumn('question', 'source_url', "TEXT DEFAULT ''");
ensureColumn('question', 'source_type', "TEXT DEFAULT ''");
ensureColumn('question', 'material_id', 'INT');
ensureColumn('question', 'chunk_id', 'INT');
// 跨领域题：关联节点只参与题干与解析，掌握度/错题/复习仍只记主节点
ensureColumn('question', 'related_node_ids', "TEXT DEFAULT '[]'");
ensureColumn('question', 'bridge_type', "TEXT DEFAULT ''");
ensureColumn('question', 'bridge', "TEXT DEFAULT ''");
ensureColumn('chat_turn', 'material_id', 'INT');
ensureColumn('chat_turn', 'source_chunk_ids', "TEXT DEFAULT '[]'");
ensureColumn('highlight', 'material_id', 'INT');
ensureColumn('highlight', 'chunk_id', 'INT');

// ---------- 偏好与配置 ----------
function getSetting(key, fallback = null) {
  const r = db.prepare('SELECT value FROM setting WHERE key = ?').get(key);
  return r ? r.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

const DEFAULT_SETTINGS = {
  nickname: '小问',
  interests: '',
  font_scale: '3',
  motion: '2',
  voice_pref: 'cloud',
  llm_base_url: '',
  llm_api_key: '',
  llm_chat_model: '',
  llm_fast_model: '',
  prompt_ver: 'v1',
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (getSetting(k) === null) setSetting(k, v);

// ---------- 模型抽象层（方案 7.2，OpenAI Chat Completions 兼容） ----------
function llmConfig() {
  return {
    base_url: (getSetting('llm_base_url') || '').replace(/\/+$/, ''),
    api_key: getSetting('llm_api_key') || '',
    chat_model: getSetting('llm_chat_model') || '',
    fast_model: getSetting('llm_fast_model') || '',
  };
}
function modelAvailable() {
  const c = llmConfig();
  return Boolean(c.base_url && c.chat_model);
}

// ---------- 出站地址校验：防止 SSRF 与 API Key 外带 ----------
function isLoopbackIp(ip) {
  return ip === '::1' || /^127\./.test(ip) || ip === '0:0:0:0:0:0:0:1';
}
function isPrivateIp(ip) {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (/^10\./.test(v4) || /^192\.168\./.test(v4) || /^172\.(1[6-9]|2\d|3[01])\./.test(v4)) return true;
  if (/^169\.254\./.test(v4) || /^100\.(6[4-9]|[7-9]\d|1\d\d)\./.test(v4) || /^0\./.test(v4)) return true;
  if (/^fe[89ab]/i.test(ip) || /^f[cd]/i.test(ip) || ip === '::') return true;
  return false;
}
// 原则：密钥只发给可验证的公网 HTTPS 端点；本地 Ollama 等回环 HTTP 例外，禁止跳转到内网。
async function checkBaseUrl(raw) {
  if (!raw) return '';
  if (typeof raw !== 'string' || raw.length > 300) fail(400, 'Base URL 不合法');
  let u;
  try { u = new URL(raw); } catch { fail(400, 'Base URL 不合法'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') fail(400, '仅支持 http/https 地址');
  if (u.username || u.password || u.hash) fail(400, 'Base URL 不合法');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  if (net.isIP(host)) addrs = [host];
  else {
    try { addrs = (await dns.lookup(host, { all: true })).map(x => x.address); }
    catch { fail(400, 'Base URL 域名无法解析'); }
    if (!addrs.length) fail(400, 'Base URL 域名无法解析');
  }
  for (const addr of addrs) {
    const loop = isLoopbackIp(addr) || isLoopbackIp(addr.startsWith('::ffff:') ? addr.slice(7) : addr);
    if (isPrivateIp(addr) && !loop) fail(400, '不允许指向内网或云元数据地址');
    if (u.protocol === 'http:' && !loop) fail(400, '明文 HTTP 仅允许本机地址');
  }
  return u.toString().replace(/\/+$/, '');
}
// 历史脏配置在调用时再校验一次，错误文案保持通用
async function assertModelEndpoint(raw) {
  try { await checkBaseUrl(raw); } catch { throw new Error('模型地址不安全，请在设置页检查 Base URL'); }
}

// 模型并发闸门：避免高频调用打满上游和本机资源
let modelActive = 0;
const modelWaiters = [];
async function withModelSlot(fn) {
  while (modelActive >= 2) await new Promise(resolve => modelWaiters.push(resolve));
  modelActive++;
  try { return await fn(); } finally {
    modelActive--;
    const next = modelWaiters.shift();
    if (next) next();
  }
}

async function llmChat(messages, opts = {}) {
  const c = llmConfig();
  if (!modelAvailable()) throw new Error('模型未配置：请在设置页填写 Base URL、API Key 与模型名');
  await assertModelEndpoint(c.base_url);
  const model = (opts.model === 'fast' && c.fast_model) ? c.fast_model : c.chat_model;
  const body = {
    model,
    messages,
    temperature: opts.temperature ?? 0.7,
    stream: opts.stream ?? false,
  };
  if (opts.json) body.response_format = { type: 'json_object' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.stream ? 60000 : 30000);
  const signals = opts.signal ? [ctrl.signal, opts.signal] : [ctrl.signal];
  const signal = AbortSignal.any ? AbortSignal.any(signals) : ctrl.signal;
  try {
    return await withModelSlot(async () => {
      const resp = await fetch(`${c.base_url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.api_key}` },
        body: JSON.stringify(body),
        signal,
        redirect: 'error',
      });
      // 上游响应体可能含密钥/内网信息，不回显给客户端
      if (!resp.ok || !resp.body) throw new Error(`模型服务返回 ${resp.status}`);
      if (opts.stream) return resp.body;
      const data = await resp.json();
      return data.choices?.[0]?.message?.content ?? '';
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 三条核心 Prompt（方案 7.2，带版本号） ----------
const PROMPT_VER = getSetting('prompt_ver') || 'v1';

function promptBuildList(domainName, levelDesc) {
  return `你是一位知识体系拆解教练。用户想学习「${domainName}」，当前基础：${levelDesc || '未特别说明'}。
请把该领域拆成知识清单，输出严格 JSON（不要 markdown）：
{"facets":[{"name":"知识面名称","points":[{"name":"知识点名称","cognitive_level":1到4的整数（1=识记 2=理解 3=应用 4=综合分析）}]}]}
要求：3~5 个知识面，每个知识面 3~6 个知识点，知识点要具体、可出题、贴合兴趣学习场景。`;
}

// 难度阶梯：把「1~5 档」翻译成模型可执行的差异维度，不能只写一个数字
function difficultySpec(d) {
  const specs = {
    1: '【1档·识记】直接考定义、事实或术语对应；题干把关键条件说清楚，选项彼此差异明显，不需要推理，辨认即可选出。',
    2: '【2档·理解】考概念辨析与解释；题干换一种说法或给一个简短情境，选项中要有 1~2 个相似但含义不同的干扰项，真懂才能区分。',
    3: '【3档·应用】考迁移使用；题干给一个具体场景或案例，需要把知识点用起来（判断、计算、选择方案、预测结果），干扰项贴近常见误区。',
    4: '【4档·分析】考多步推理与边界；题干含复合条件或需要拆解因果/结构，选项含强干扰项（似是而非、只对一半），必须排除与权衡。',
    5: '【5档·综合】考跨域迁移与反例；题干给新颖或相反情境，需综合多个条件、识别隐含前提或反例，选项差异细微，必须深入推敲。',
  };
  return specs[d] || specs[1];
}

function promptMakeQuestion(nodeName, level, difficulty, interests, avoidStems = []) {
  const scene = interests ? `，尽量融入这些兴趣场景：${interests}` : '';
  const avoid = avoidStems.length
    ? `\n避免与这些已出过的题目重复（换角度、换情境、换问法）：\n${avoidStems.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
    : '';
  return `你是一位出题老师。请围绕知识点「${nodeName}」（认知层级 ${level}）出一道题${scene}。${avoid}
难度要求：${difficultySpec(difficulty)}
必须严格按该档位出题：不同档位在情境复杂度、推理步数与干扰项强度上要有明显差别，不得只是把题干换个说法。认知层级是知识点本身的属性，难度档由上面的要求决定。
输出严格 JSON（不要 markdown）：
{"type":"single","stem":"题干","options":["选项A","选项B","选项C","选项D"],"answer":"A","explanation":"解析，简洁讲清为什么"}
type 只在 "single"（单选）和 "judge"（判断）中选；judge 时 options 为 ["正确","错误"]，answer 为 "正确" 或 "错误"。题干自然、生活化、无应试感。`;
}

// 跨领域出题的桥接类型：把「结合两个知识点」翻译成四种可验证的迁移关系，
// 而不是让模型自由发挥成"先讲A再讲B"的两张皮。
const BRIDGE_TYPES = {
  auto: '从下面四种里选最自然的一种',
  analogy: '结构类比：两件事表面无关，但内部结构/约束同构，用熟悉的结构看懂陌生的结构',
  transfer: '方法迁移：把一个领域的解题方法、判断框架搬到另一个领域使用',
  contrast: '边界对照：两个知识点容易混淆，题眼是划清各自适用边界，判断何时用哪个',
  counterexample: '反例检验：用另一个领域的情况推翻"看起来对"的推断，识别隐含前提',
};
function bridgeTypeOf(v) {
  return Object.prototype.hasOwnProperty.call(BRIDGE_TYPES, v) ? v : 'auto';
}

function promptBridgeQuestion(primary, related, level, difficulty, interests, bridgeType, avoidStems = []) {
  const relDesc = related.map((n, i) =>
    `${i + 1}. 「${n.name}」${n.domain_name ? `（领域：${n.domain_name}）` : ''}（认知层级 ${n.cognitive_level || 1}）`).join('\n');
  const scene = interests ? `，尽量融入这些兴趣场景：${interests}` : '';
  const avoid = avoidStems.length
    ? `\n避免与这些已出过的题重复（换角度、换情境、换问法）：\n${avoidStems.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
    : '';
  return `你是一位擅长「知识迁移」的出题老师。请出一道真正把两个知识点焊在一起的题${scene}。${avoid}

【主知识点（考查目标）】「${primary.name}」（认知层级 ${level}）
【关联知识点（考场/工具）】
${relDesc}
【桥接方式】${BRIDGE_TYPES[bridgeType]}
难度要求：${difficultySpec(difficulty)}

硬性要求：
- 关联知识点必须参与解题：它是情境、工具、类比对象或反例来源，不能只是并列出现；只靠主知识点或只靠关联知识点都应该答不对。
- 题干里要写出能让学习者认出这两个知识点的线索，不得凭空编造具体数据、出处或实验结论。
- 解析必须点明「桥」是什么：两者共享的结构或可迁移的方法，以及为什么不能只靠其中一个知识点作答。
- 不同档位在情境复杂度、推理步数与干扰项强度上要有明显差别。

输出严格 JSON（不要 markdown）：
{"type":"single","stem":"题干","options":["选项A","选项B","选项C","选项D"],"answer":"A","explanation":"简洁解析，点明桥接关系","bridge":"一句话说清两个知识点的桥接点","bridge_type":"${bridgeType}"}
type 只在 "single"（单选）和 "judge"（判断）中选；judge 时 options 为 ["正确","错误"]，answer 为 "正确" 或 "错误"。题干自然、生活化、无应试感。`;
}

function promptExplain(question, userAnswer, isCorrect) {
  return `你是一位耐心的陪练老师。用户作答了下面这道题，判定结果：${isCorrect ? '答对' : '答错'}。
题目：${question.stem}
选项：${(question.options || []).join(' / ')}
 正确答案：${question.type === 'order' ? parseOrderAnswer(question.answer).join(' → ') : question.answer}
 用户作答：${question.type === 'order' ? parseOrderAnswer(userAnswer).join(' → ') : userAnswer}
请输出严格 JSON（不要 markdown）：
{"judged":"对/错","explanation":"讲解：先点明对错，再讲清知识点本身，语气像朋友聊天，不要应试腔","followups":["建议的追问方向1","建议的追问方向2"]}`;
}

function promptChat(question, history, nickname = '小问') {
  const ctx = history.slice(-8).map(h => `${h.role === 'user' ? '用户' : '老师'}：${h.content}`).join('\n');
  return `你是陪练老师「${nickname || '小问'}」。用户正在练习这道题：
题干：${question.stem}
选项：${(question.options || []).join(' / ')}
 正确答案：${question.type === 'order' ? parseOrderAnswer(question.answer).join(' → ') : question.answer}
 讲解：${question.explanation}
历史对话：
${ctx}
请回答用户的追问。要求：苏格拉底式引导，不直接甩答案，先从用户思路出发，逐步给线索；语气亲切自然，篇幅控制在 150 字以内。直接输出回复内容，不要 JSON。`;
}

// ---------- 资料处理：结构化切块 + 轻量关键词召回（零额外依赖） ----------
function contentHash(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex').slice(0, 32);
}
function splitMaterial(content) {
  const src = String(content || '').replace(/\r\n/g, '\n').trim();
  if (!src) fail(400, '资料内容为空');
  const sections = [];
  let heading = '', buf = [];
  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) sections.push({ heading, body });
    buf = [];
  };
  for (const line of src.split('\n')) {
    const m = line.match(/^\s{0,3}(#{1,4})\s+(.+?)\s*$/);
    if (m) { flush(); heading = m[2].slice(0, 120); }
    else buf.push(line);
  }
  flush();
  if (!sections.length) sections.push({ heading: '正文', body: src });
  const MAX = 1200;
  const out = [];
  for (const sec of sections) {
    const paras = sec.body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    let cur = '';
    const push = () => { if (cur.trim()) out.push({ heading: sec.heading || '正文', content: cur.trim() }); };
    for (const para of paras) {
      let piece = para;
      while (piece.length > MAX) {
        if (cur) { push(); cur = ''; }
        let cut = piece.lastIndexOf('。', MAX);
        if (cut < MAX * 0.5) cut = MAX;
        out.push({ heading: sec.heading || '正文', content: piece.slice(0, cut + 1) });
        piece = piece.slice(cut + 1);
      }
      if (!cur) cur = piece;
      else if (cur.length + piece.length + 2 <= MAX) cur += '\n\n' + piece;
      else { push(); cur = piece; }
    }
    push();
  }
  return out.map((c, i) => ({ idx: i, heading: c.heading, content: c.content }));
}
function queryTokens(q) {
  const s = String(q || '').toLowerCase();
  const out = new Set();
  for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) out.add(m[0]);
  const cjk = (s.match(/[\u4e00-\u9fa5]+/g) || []).join('');
  for (let i = 0; i < cjk.length - 1; i++) out.add(cjk.slice(i, i + 2));
  for (const ch of cjk) out.add(ch);
  return [...out].slice(0, 80);
}
// 中文双字 + 英文词的外观匹配：单篇文章场景下足够，且不需要 embedding 服务
function retrieveChunks(chunks, query, limit = 6) {
  const toks = queryTokens(query);
  if (!toks.length) return chunks.slice(0, limit);
  const scored = chunks.map(c => {
    const body = (c.heading + ' ' + c.content).toLowerCase();
    let score = 0;
    for (const t of toks) if (body.includes(t)) score += t.length > 1 ? 2 : 1;
    return { c, score };
  }).sort((a, b) => b.score - a.score);
  const picked = scored.filter(x => x.score > 0).slice(0, limit).map(x => x.c);
  return picked.length ? picked : chunks.slice(0, limit);
}

// ---------- 资料专用 Prompt（v1，全部带引用约束） ----------
function promptMaterialSummarize(title, chunks) {
  const src = chunks.map(c => `[${c.idx}] ${c.heading}\n${c.content}`).join('\n\n');
  return `你是一位学习教练。下面是一篇公众号文章的原文片段。请严格按 ASD-STE100 简化技术规范写摘要：每句简短直白、去掉花哨比喻、每段不超过 4~6 句、面向聪明的中学生。
输出严格 JSON（不要 markdown）：
{"one_line":"一句话说清文章讲了什么","points":["5~8条要点，每条不超过40字"],"timeline":["3~8条关键时间节点或步骤，格式：阶段 — 事件"]}
要求：只使用资料中的信息；涉及未经核实的主张必须写"文章称"；资料没有的内容不要补充。

文章标题：${title}
资料片段：
${src.slice(0, 24000)}`;
}
function promptMaterialList(title, chunks, levelDesc) {
  const outline = chunks.map(c => `[${c.idx}] ${c.heading}`).join('\n');
  const src = chunks.slice(0, 12).map(c => `[${c.idx}] ${c.heading}\n${c.content.slice(0, 900)}`).join('\n\n');
  return `你是一位知识体系拆解教练。请只根据下面的资料，把「${title}」拆成知识清单，用户基础：${levelDesc || '未特别说明'}。
输出严格 JSON（不要 markdown）：
{"facets":[{"name":"知识面名称","points":[{"name":"具体、可出题的知识点","cognitive_level":1到4整数}]}]}
要求：3~5 个知识面，每个 3~6 个知识点；覆盖文章的学习方法与核心概念；不要引入资料之外的知识；对文章中的争议主张在知识点名后加「（文章称）」。

资料大纲：
${outline}
资料正文：
${src.slice(0, 20000)}`;
}
function promptMaterialQuestion(nodeName, level, difficulty, chunks, interests) {
  const picked = chunks.slice(0, 6).map(c => `[${c.idx}] ${c.heading}\n${c.content.slice(0, 900)}`).join('\n\n');
  return `你是一位出题老师。请只根据资料，围绕知识点「${nodeName}」（认知层级 ${level}）出一道题${interests ? `，尽量融入：${interests}` : ''}。
难度要求：${difficultySpec(difficulty)}
严格按该档位出题，不同档位在情境复杂度、推理步数与干扰项强度上要有明显差别。
输出严格 JSON（不要 markdown）：
{"type":"single","stem":"题干","options":["选项A","选项B","选项C","选项D"],"answer":"选项原文","explanation":"解析，必须引用资料编号如[2]，简洁","chunk_index":资料编号整数}
type 只能 single 或 judge；judge 时 options 为 ["正确","错误"]，answer 为 "正确" 或 "错误"；answer 必须是某个选项原文；题干自然、无应试感；涉及争议主张必须写"根据文章"。

资料片段：
${picked.slice(0, 14000)}`;
}
function promptMaterialQA(title, chunks, question, history, nickname) {
  const src = chunks.map(c => `[${c.idx}]（${c.heading}；状态：${c.claim_status === 'article_claim' ? '文章声称，未经独立核实' : '资料原文'}）\n${c.content}`).join('\n\n');
  const ctx = history.slice(-6).map(h => `${h.role === 'user' ? '用户' : '老师'}：${h.content}`).join('\n');
  return `你是陪练老师「${nickname || '小问'}」。用户正在阅读文章「${title}」，请只根据下面的资料片段回答问题，并用 [编号] 标出依据。
规则：
- 资料有答案：先一句话给结论，再用 2~4 句展开，最后列出依据编号；语气像朋友聊天。
- 资料没答案：明确说"这篇文章里没提到"，不要编造，可建议补充资料。
- 标注为"文章声称，未经独立核实"的内容，回答时必须带"文章称"或"据文章说"，不要当成公认事实。
- 篇幅 250 字以内，直接输出回复内容，不要 JSON。

历史对话：
${ctx}

用户问题：${question}

资料片段：
${src.slice(0, 22000)}`;
}

// 排序题：顺序是要考的关系知识，answer 与 options 必须同源，options 故意打乱
function promptMakeOrderQuestion(nodeName, level, difficulty, interests, chunks = []) {
  const src = chunks.slice(0, 5).map(c => `[${c.idx}] ${c.heading}\n${c.content.slice(0, 700)}`).join('\n\n');
  return `你是一位出题老师。请围绕知识点「${nodeName}」（认知层级 ${level}）出一道排序题${interests ? `，尽量融入：${interests}` : ''}${src ? '，且只依据下面的资料片段' : ''}。
难度要求：${difficultySpec(difficulty)}
严格按该档位决定步骤数量、因果链长度与干扰强度：低档步骤少且顺序直白，高档步骤多、有分支或需要先判断再排序。
输出严格 JSON（不要 markdown）：
{"type":"order","stem":"请把下列步骤按正确顺序排列","options":["乱序步骤C","乱序步骤A","乱序步骤B"],"answer":["正确步骤A","正确步骤B","正确步骤C"],"explanation":"解析，${src ? '必须引用资料编号如[2]，' : ''}简洁"}
要求：3~6 个步骤；answer 是正确顺序的选项原文数组；options 与 answer 必须是同一组步骤但顺序打乱；每一步 5~80 字；不得有重复步骤；涉及争议主张必须写"根据文章"。
${src ? `\n资料片段：\n${src.slice(0, 10000)}` : ''}`;
}

// 记忆宫殿卡：位置 + 意象 + 主动检索，不直接给答案的线索卡
function promptMemoryCard(nodeName, chunks) {
  const src = chunks.slice(0, 4).map(c => `[${c.idx}] ${c.heading}\n${c.content.slice(0, 700)}`).join('\n\n');
  return `你在帮学习者制作一张「记忆宫殿」复习卡。知识点：「${nodeName}」。
输出严格 JSON（不要 markdown）：
{"room":"一间具体的位置，例如'图书馆的借阅台'","hook":"把知识点绑到房间里某个物件的荒诞但好记的意象，30字以内","cue":"只给线索的自测问题，不直接说答案，40字以内","answer":"一句话说清这个知识点${src ? '，并引用资料编号如[2]' : ''}","chunk_index":资料编号整数}
要求：房间与意象必须具体、可想象；cue 要能在不看 answer 时唤起回忆；只使用资料信息，资料未写就不要编造。
${src ? `\n资料片段：\n${src.slice(0, 9000)}` : '\n（无资料片段：只能基于知识点名称生成通用线索，answer 中不得伪装成原文依据）'}`;
}

// 交叉核验：只认给出的片段编号与逐字原文，杜绝模型凭空"确认"
function promptCrossVerify(claim, evidence) {
  return `你在做多来源交叉核验。待核验主张：「${claim}」。
下面是若干资料片段，每段标注了资料 id、片段编号、章节与事实口径。请只依据这些片段判断该主张在各来源中是"支持 support"、"矛盾 contradict"还是"无关 unrelated"。
输出严格 JSON（不要 markdown）：
{"summary":"2~4 句总结：哪些来源支持、哪些矛盾、哪些没提到；争议内容必须带'文章称'","items":[{"material_id":1,"idx":2,"relation":"support","quote":"从该片段逐字摘录的原文短语，不超过80字","note":"一句话说明它如何支持或矛盾，40字以内"}]}
硬性规则：
- material_id 与 idx 必须是下面给出的真实编号，不得虚构；
- quote 必须是该片段中逐字出现的原文，不得改写；
- 每条 item 只写一个来源的一个片段，最多 8 条；
- 没有任何相关片段时 items 返回空数组，summary 明确写"资料未覆盖"；
- 口径为"文章声称，未经核实"的片段，note 必须以"文章称，"开头。

资料片段：
${evidence.slice(0, 22000)}`;
}

// 图片转文字：只描述看到的，看不清的进 uncertain，不靠常识补全
function promptImageDescribe(hint) {
  return `请仔细观察这张图片，把它转成可检索、可复习的文字资料。只描述你确实看到的内容；看不清的写进 uncertain，不要补全常识。
输出严格 JSON（不要 markdown）：
{"title":"给这张图起的简短标题","description":"3~5 句说清图片整体在讲什么","elements":["关键元素及其关系"],"texts":["图中可辨认的文字，逐字抄录"],"flow":["若为流程/步骤图，按图中顺序写出步骤"],"uncertain":["模糊、看不清或无法判断的部分"]}
${hint ? `\n用户补充的上下文：${hint}` : ''}`;
}

// ---------- 题目出参规范化 ----------
// options 在库中以 JSON 字符串存储，出参统一解析为数组，避免前端拿到字符串
function normalizeQuestion(q) {
  if (!q) return q;
  let options = q.options;
  if (typeof options === 'string') {
    try { options = JSON.parse(options); } catch { options = []; }
  }
  if (!Array.isArray(options)) options = [];
  let related = q.related_node_ids;
  if (typeof related === 'string') {
    try { related = JSON.parse(related); } catch { related = []; }
  }
  if (!Array.isArray(related)) related = [];
  return { ...q, options, related_node_ids: related.filter(n => Number.isInteger(n) && n > 0) };
}
// 校验跨领域题是否真的提到关联知识点：模型可能只写"结合两者"却没有桥，
// 这类题退化成普通题，必须挡在落库之前。中文双字词/英文词命中任一即可。
function mentionsNode(body, name) {
  const s = String(body || '').toLowerCase();
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  if (s.includes(n)) return true;
  return queryTokens(n).some(t => t.length >= 2 && s.includes(t));
}
// 排序题答案统一为「选项原文数组」：库中存 JSON 字符串，用户提交也是 JSON 字符串
function parseOrderAnswer(raw) {
  if (Array.isArray(raw)) return raw.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean);
  if (typeof raw !== 'string') return [];
  try {
    const p = JSON.parse(raw);
    if (Array.isArray(p)) return p.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean);
  } catch { /* 兼容非 JSON 提交，判错即可 */ }
  return [];
}
function orderResult(given, correct) {
  if (!given.length || given.length !== correct.length) return { correct: false, firstWrong: 0 };
  for (let i = 0; i < correct.length; i++) if (given[i] !== correct[i]) return { correct: false, firstWrong: i };
  return { correct: true, firstWrong: -1 };
}
function parseTags(raw) {
  try {
    const a = JSON.parse(raw || '[]');
    return Array.isArray(a) ? a.filter(t => typeof t === 'string') : [];
  } catch { return []; }
}
const ERROR_TAGS = ['概念不清', '计算失误', '审题偏差', '纯手滑'];
function cleanTags(value) {
  return (Array.isArray(value) ? value : [])
    .filter(t => typeof t === 'string' && ERROR_TAGS.includes(t)).slice(0, 3);
}

// 记录当前领域的做题进度（每次出题都更新，重新进入时接着练）
function saveProgress(domainId, nodeId, questionId, difficulty) {
  db.prepare(`INSERT INTO progress (domain_id, node_id, question_id, difficulty, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(domain_id) DO UPDATE SET node_id = excluded.node_id, question_id = excluded.question_id,
      difficulty = excluded.difficulty, answered = 0, updated_at = excluded.updated_at`)
    .run(domainId, nodeId, questionId, difficulty, now());
}

// 下发给客户端的题目不带答案/解析，避免提交前从数据里看到对错
function publicQuestion(q) {
  if (!q) return q;
  const { answer, explanation, ...rest } = normalizeQuestion(q);
  return rest;
}

// ---------- 鉴权（单用户） ----------
// 原则：不阻塞事件循环；比较凭据不泄露时间差；错误不区分账号状态。
const scryptAsync = promisify(crypto.scrypt);
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scryptAsync(pw, salt, 64)).toString('hex');
  return `${salt}:${hash}`;
}
async function verifyPassword(pw, stored) {
  // 无密码哈希时也做等价运算，避免响应时间差被用于探测初始化状态
  const [salt, hash] = (stored || `${DUMMY_SALT}:${'0'.repeat(128)}`).split(':');
  const calc = (await scryptAsync(pw, salt || DUMMY_SALT, 64)).toString('hex');
  const a = Buffer.from(calc, 'hex'), b = Buffer.from(hash || '', 'hex');
  return Boolean(stored) && a.length === b.length && crypto.timingSafeEqual(a, b);
}
function makeToken() {
  const token = crypto.randomBytes(24).toString('hex');
  setSetting('token', token);
  return token;
}
function authed(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const expected = getSetting('token') || '';
  if (!token || !expected) return false;
  const a = Buffer.from(token), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- 工具：边界校验与限流 ----------
class HttpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new HttpError(code, message); }
function intIn(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}
function text(value, max, fallback = '') {
  return typeof value === 'string' ? value.slice(0, max) : fallback;
}
function json(res, code, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function now() { return new Date().toISOString(); }

// 滑动窗口限流：按「分组 + 连接来源 IP」计数，匿名接口和模型接口都需要
const rateBuckets = new Map();
function allow(req, group, max, windowMs) {
  const key = `${group}:${req.socket.remoteAddress || 'unknown'}`;
  const t = Date.now();
  const hits = (rateBuckets.get(key) || []).filter(x => x > t - windowMs);
  if (hits.length >= max) { rateBuckets.set(key, hits); return false; }
  hits.push(t);
  rateBuckets.set(key, hits);
  if (rateBuckets.size > 2000) {
    for (const [k, v] of rateBuckets) if (!v.length || v[v.length - 1] < t - windowMs) rateBuckets.delete(k);
  }
  return true;
}
function limitOrThrow(req, group, max, windowMs) {
  if (!allow(req, group, max, windowMs)) fail(429, '请求过于频繁，请稍后再试');
}
async function readBody(req, limit = 1e6) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) fail(413, '请求内容过大');
  }
  if (!raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail(400, '请求格式错误'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, '请求格式错误');
  return parsed;
}
// 多步写库必须原子提交，避免 await 交错导致半截状态或丢失更新
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
    throw e;
  }
}
function purgeNodes(domainId) {
  db.prepare('DELETE FROM chat_turn WHERE question_id IN (SELECT id FROM question WHERE node_id IN (SELECT id FROM node WHERE domain_id = ?))').run(domainId);
  db.prepare('DELETE FROM mistake WHERE node_id IN (SELECT id FROM node WHERE domain_id = ?)').run(domainId);
  db.prepare('DELETE FROM attempt WHERE node_id IN (SELECT id FROM node WHERE domain_id = ?)').run(domainId);
  db.prepare('DELETE FROM question WHERE node_id IN (SELECT id FROM node WHERE domain_id = ?)').run(domainId);
  db.prepare('DELETE FROM review_slot WHERE node_id IN (SELECT id FROM node WHERE domain_id = ?)').run(domainId);
  db.prepare('DELETE FROM memory_card WHERE node_id IN (SELECT id FROM node WHERE domain_id = ?)').run(domainId);
  db.prepare('DELETE FROM progress WHERE domain_id = ?').run(domainId);
  db.prepare('DELETE FROM node WHERE domain_id = ?').run(domainId);
}
// ---------- 外部题库导入（munger-kb → domain/node/question） ----------
// 幂等：以 source_key 判定已存在对象；只增量补缺，绝不删除用户已有作答/进度。
const BANK_DOMAIN_KEY = 'munger-kb://domain/munger-models';
const BANK_PREFIX = 'munger-kb://';
// 题库导入通用化：缺省仍是 munger-kb，外部资料可传 domain_name / source_key_prefix / domain_source。
// source_key 必须唯一且幂等，前缀决定后续增量导入落到同一个领域。
function importQuestionBank(items, opts = {}) {
  if (!Array.isArray(items) || items.length === 0) fail(400, '题库为空');
  const max = 5000;
  if (items.length > max) fail(400, `单次最多导入 ${max} 题`);
  const prefix = typeof opts.source_key_prefix === 'string' && opts.source_key_prefix.trim()
    ? opts.source_key_prefix.trim().slice(0, 120) : BANK_PREFIX;
  const domainKey = typeof opts.domain_key === 'string' && opts.domain_key.trim()
    ? opts.domain_key.trim().slice(0, 200) : BANK_DOMAIN_KEY;
  const domainName = typeof opts.domain_name === 'string' && opts.domain_name.trim()
    ? opts.domain_name.trim().slice(0, 120) : '芒格思维模型';
  const domainSource = typeof opts.domain_source === 'string' && opts.domain_source.trim()
    ? opts.domain_source.trim().slice(0, 40) : 'munger-kb';
  const stats = { received: items.length, domains_created: 0, nodes_created: 0, nodes_reused: 0, questions_created: 0, questions_skipped: 0, invalid: 0 };

  transaction(() => {
    let domain = db.prepare('SELECT * FROM domain WHERE source_key = ?').get(domainKey);
    if (!domain) {
      const r = db.prepare('INSERT INTO domain (name, source, status, level, created_at, source_key) VALUES (?, ?, ?, ?, ?, ?)')
        .run(domainName, domainSource, 'ready', '能上手用', now(), domainKey);
      domain = { id: r.lastInsertRowid };
      stats.domains_created = 1;
    }
    const domainId = domain.id;
    const facetCache = new Map();
    const nodeCache = new Map();

    // 现有题按 source_key 建集合，避免重复插入
    const existingQ = new Set(db.prepare('SELECT source_key FROM question WHERE source_key LIKE ?').all(`${prefix}%`).map(r => r.source_key));

    for (const raw of items) {
      if (!raw || typeof raw !== 'object') { stats.invalid++; continue; }
      const bankId = typeof raw.bank_id === 'string' ? raw.bank_id.slice(0, 120) : '';
      const domainName = typeof raw.domain_name === 'string' ? raw.domain_name.trim().slice(0, 120) : '';
      const nodeName = typeof raw.node_name === 'string' ? raw.node_name.trim().slice(0, 120) : '';
      const stem = typeof raw.stem === 'string' ? raw.stem.trim().slice(0, 1000) : '';
      const answer = typeof raw.answer === 'string' ? raw.answer.trim().slice(0, 300) : '';
      let options = raw.options;
      if (typeof options === 'string') { try { options = JSON.parse(options); } catch { options = []; } }
      options = Array.isArray(options) ? options.filter(x => typeof x === 'string').slice(0, 6) : [];
      if (!bankId || !nodeName || !stem || !answer || options.length < 2 || !options.includes(answer)) { stats.invalid++; continue; }

      // 学科知识点（facet）：按 domain_name 建
      const facetKey = `${prefix}facet/${domainName}`;
      let facetId = facetCache.get(facetKey);
      if (facetId === undefined) {
        const found = db.prepare('SELECT id FROM node WHERE domain_id = ? AND source_key = ?').get(domainId, facetKey);
        if (found) {
          facetId = found.id;
          stats.nodes_reused++;
        } else {
          const r = db.prepare("INSERT INTO node (domain_id, parent_id, name, cognitive_level, mastery, status, created_at, source_key) VALUES (?, NULL, ?, 2, 0, 'active', ?, ?)")
            .run(domainId, domainName || '未分类', now(), facetKey);
          facetId = r.lastInsertRowid;
          stats.nodes_created++;
        }
        facetCache.set(facetKey, facetId);
      }

      // 模型知识点：挂在学科下；同名模型跨题型复用同一节点
      const stableNodeKey = `${prefix}model/${nodeName}`;
      let nodeId = nodeCache.get(stableNodeKey);
      if (nodeId === undefined) {
        const found = db.prepare('SELECT id FROM node WHERE domain_id = ? AND source_key = ?').get(domainId, stableNodeKey);
        if (found) {
          nodeId = found.id;
          stats.nodes_reused++;
        } else {
          const r = db.prepare("INSERT INTO node (domain_id, parent_id, name, cognitive_level, mastery, status, created_at, source_key) VALUES (?, ?, ?, 1, 0, 'active', ?, ?)")
            .run(domainId, facetId, nodeName, now(), stableNodeKey);
          nodeId = r.lastInsertRowid;
          stats.nodes_created++;
        }
        nodeCache.set(stableNodeKey, nodeId);
      }

      const qKey = `${prefix}q/${bankId}`;
      if (existingQ.has(qKey)) { stats.questions_skipped++; continue; }
      const type = raw.type === 'judge' ? 'judge' : 'single';
      const difficulty = intIn(raw.difficulty, 1, 5, 1);
      const explanation = typeof raw.explanation === 'string' ? raw.explanation.slice(0, 4000) : '';
      const sourceUrl = typeof raw.source_url === 'string' ? raw.source_url.slice(0, 500) : '';
      const sourceType = typeof raw.source_type === 'string' ? raw.source_type.slice(0, 40) : '';
      db.prepare('INSERT INTO question (node_id, type, difficulty, stem, options, answer, explanation, model, prompt_ver, created_at, source_key, source_url, source_type, material_id, chunk_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(nodeId, type, difficulty, stem, JSON.stringify(options), answer, explanation,
          typeof raw.model === 'string' ? raw.model.slice(0, 80) : (opts.model || 'munger-kb'),
          typeof raw.prompt_ver === 'string' ? raw.prompt_ver.slice(0, 40) : (opts.prompt_ver || 'bank-v1'),
          now(), qKey, sourceUrl, sourceType || opts.source_type || 'munger-kb',
          intIn(raw.material_id, 1, 2147483647, null), intIn(raw.chunk_id, 1, 2147483647, null));
      existingQ.add(qKey);
      stats.questions_created++;
    }
  });
  return stats;
}

function questionBankStats(prefix = BANK_PREFIX, domainKey = BANK_DOMAIN_KEY) {
  const q = db.prepare('SELECT COUNT(*) AS n FROM question WHERE source_key LIKE ?').get(`${prefix}%`).n;
  const nodes = db.prepare('SELECT COUNT(*) AS n FROM node WHERE source_key LIKE ?').get(`${prefix}model/%`).n;
  const facets = db.prepare('SELECT COUNT(*) AS n FROM node WHERE source_key LIKE ?').get(`${prefix}facet/%`).n;
  const domain = db.prepare('SELECT id, name FROM domain WHERE source_key = ?').get(domainKey) || null;
  const byType = db.prepare('SELECT source_type, COUNT(*) AS n FROM question WHERE source_key LIKE ? GROUP BY source_type').all(`${prefix}%`);
  return { domain, facets, nodes, questions: q, by_type: byType };
}

// 同一知识点的出题串行化：防止并发请求同时判定缓存未命中，生成重复题
const nodeLocks = new Map();
async function withNodeLock(nodeId, fn) {
  const prev = nodeLocks.get(nodeId) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  nodeLocks.set(nodeId, current);
  await prev;
  try { return await fn(); }
  finally { release(); if (nodeLocks.get(nodeId) === current) nodeLocks.delete(nodeId); }
}

// ---------- API 路由 ----------
const routes = {};

// 健康检查
routes['GET /api/health'] = (req, res) => json(res, 200, { ok: true, model_configured: modelAvailable(), time: now() });

// 鉴权
routes['POST /api/auth/setup'] = async (req, res) => {
  limitOrThrow(req, 'setup', 5, 10 * 60 * 1000);
  const b = await readBody(req);
  const pw = typeof b.password === 'string' ? b.password : '';
  if (pw.length < 4 || pw.length > 128) return json(res, 400, { error: '密码需 4~128 位' });
  if (getSetting('password_hash')) return json(res, 409, { error: '密码已设置，请直接登录' });
  setSetting('password_hash', await hashPassword(pw));
  const token = makeToken();
  json(res, 200, { ok: true, token });
};
routes['POST /api/auth/login'] = async (req, res) => {
  limitOrThrow(req, 'login', 8, 10 * 60 * 1000);
  const b = await readBody(req);
  const pw = typeof b.password === 'string' ? b.password.slice(0, 128) : '';
  const stored = getSetting('password_hash');
  if (!stored) return json(res, 400, { error: '尚未设置密码，请先创建' });
  if (!await verifyPassword(pw, stored)) return json(res, 401, { error: '密码错误' });
  const token = makeToken();
  json(res, 200, { ok: true, token });
};
routes['POST /api/auth/logout'] = async (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  setSetting('token', '');
  json(res, 200, { ok: true });
};
routes['GET /api/auth/status'] = (req, res) => json(res, 200, { authed: authed(req), configured: Boolean(getSetting('password_hash')) });

// 设置
routes['GET /api/settings'] = (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const c = llmConfig();
  json(res, 200, {
    nickname: getSetting('nickname'),
    interests: getSetting('interests'),
    font_scale: getSetting('font_scale'),
    motion: getSetting('motion'),
    voice_pref: getSetting('voice_pref'),
    model: {
      base_url: c.base_url ? '已配置' : '',
      base_url_set: Boolean(c.base_url),
      api_key_set: Boolean(c.api_key),
      chat_model: c.chat_model,
      fast_model: c.fast_model,
      configured: modelAvailable(),
    },
  });
};
routes['POST /api/settings'] = async (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const b = await readBody(req);
  const patch = {};
  if ('nickname' in b) patch.nickname = text(b.nickname, 24);
  if ('interests' in b) patch.interests = text(b.interests, 500);
  if ('font_scale' in b) {
    const v = String(b.font_scale);
    if (!['1', '2', '3', '4', '5'].includes(v)) fail(400, '字号不合法');
    patch.font_scale = v;
  }
  if ('motion' in b) {
    const v = String(b.motion);
    if (!['1', '2'].includes(v)) fail(400, '动效档位不合法');
    patch.motion = v;
  }
  if ('voice_pref' in b) patch.voice_pref = text(b.voice_pref, 20, 'cloud');
  // 空输入框表示「保持原值」，避免重新打开设置页后误清空密钥/地址；
  // 需要彻底清除时传 clear_llm: true。
  if (b.clear_llm === true) {
    Object.assign(patch, { llm_base_url: '', llm_api_key: '', llm_chat_model: '', llm_fast_model: '' });
  } else {
    if ('llm_base_url' in b) {
      const v = String(b.llm_base_url || '').trim();
      if (v) patch.llm_base_url = await checkBaseUrl(v);
    }
    if ('llm_api_key' in b) {
      const v = text(b.llm_api_key, 500).trim();
      if (v) patch.llm_api_key = v;
    }
    if ('llm_chat_model' in b) {
      const v = text(b.llm_chat_model, 100).trim();
      if (v) patch.llm_chat_model = v;
    }
    if ('llm_fast_model' in b) patch.llm_fast_model = text(b.llm_fast_model, 100).trim();
  }
  for (const [k, v] of Object.entries(patch)) setSetting(k, v);
  json(res, 200, { ok: true });
};

// 领域
routes['GET /api/domains'] = (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const rows = db.prepare('SELECT * FROM domain ORDER BY id DESC').all();
  const out = rows.map(d => {
    const due = db.prepare('SELECT COUNT(*) AS n FROM review_slot WHERE due_at <= ? AND node_id IN (SELECT id FROM node WHERE domain_id = ?)').get(now(), d.id);
    return { ...d, due_count: due.n };
  });
  json(res, 200, { domains: out });
};
routes['POST /api/domains'] = async (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const b = await readBody(req);
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 120) : '';
  if (!name) return json(res, 400, { error: '领域名称不能为空' });
  const allowedLevels = ['没学过', '学过一点', '能上手用'];
  const level = allowedLevels.includes(b.level) ? b.level : '没学过';
  const r = db.prepare('INSERT INTO domain (name, source, status, level, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, 'manual', 'ready', level, now());
  json(res, 200, { ok: true, id: r.lastInsertRowid });
};
routes['DELETE /api/domains/:id'] = (req, res, m) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const id = intIn(m.id, 1, 2147483647, 0);
  transaction(() => {
    purgeNodes(id);
    db.prepare('DELETE FROM domain WHERE id = ?').run(id);
  });
  json(res, 200, { ok: true });
};
routes['GET /api/domains/:id'] = (req, res, m) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const id = Number(m.id);
  const d = db.prepare('SELECT * FROM domain WHERE id = ?').get(id);
  if (!d) return json(res, 404, { error: '领域不存在' });
  const nodes = db.prepare('SELECT * FROM node WHERE domain_id = ? ORDER BY parent_id NULLS FIRST, id').all(id);
  const progress = db.prepare('SELECT node_id, question_id, difficulty, answered, updated_at FROM progress WHERE domain_id = ?').get(id) || null;
  json(res, 200, { domain: d, nodes, progress });
};

// 拆知识清单（M1 核心，构建过程由前端逐段渲染）
routes['POST /api/domains/:id/build'] = async (req, res, m) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  limitOrThrow(req, 'build', 5, 60 * 1000);
  const domainId = intIn(m.id, 1, 2147483647, 0);
  const d = db.prepare('SELECT * FROM domain WHERE id = ?').get(domainId);
  if (!d) return json(res, 404, { error: '领域不存在' });
  const b = await readBody(req);
  // 前端传值优先；旧调用未传时回退到创建领域时选择的起始基础
  const levelDesc = text(b.level, 200) || d.level || '';
  if (!modelAvailable()) return json(res, 500, { error: '模型未配置：请先在设置页填写模型配置' });
  let data;
  try {
    const content = await llmChat([{ role: 'user', content: promptBuildList(d.name, levelDesc) }], { json: true });
    data = JSON.parse(content);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return json(res, 502, { error: '拆解失败：模型输出不可用，请重试' });
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.facets)) return json(res, 502, { error: '拆解失败：模型输出格式异常' });
  // 模型输出不可信：限制数量与字段类型，清洗后再落库
  const cleaned = [];
  for (const f of data.facets.slice(0, 8)) {
    if (!f || typeof f !== 'object') continue;
    const name = typeof f.name === 'string' ? f.name.trim().slice(0, 80) : '';
    const points = (Array.isArray(f.points) ? f.points : []).slice(0, 12).map(p => ({
      name: typeof p?.name === 'string' ? p.name.trim().slice(0, 80) : '',
      cognitive_level: intIn(p?.cognitive_level, 1, 4, 1),
    })).filter(p => p.name);
    if (name && points.length) cleaned.push({ name, points });
  }
  if (!cleaned.length) return json(res, 502, { error: '拆解失败：模型输出的知识清单为空' });
  const nodes = transaction(() => {
    purgeNodes(domainId);
    for (const facet of cleaned) {
      const fr = db.prepare('INSERT INTO node (domain_id, parent_id, name, cognitive_level, created_at) VALUES (?, NULL, ?, 2, ?)').run(domainId, facet.name, now());
      for (const point of facet.points) {
        db.prepare('INSERT INTO node (domain_id, parent_id, name, cognitive_level, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(domainId, fr.lastInsertRowid, point.name, point.cognitive_level, now());
      }
    }
    db.prepare("UPDATE domain SET status = 'ready' WHERE id = ?").run(domainId);
    return db.prepare('SELECT * FROM node WHERE domain_id = ? ORDER BY parent_id NULLS FIRST, id').all(domainId);
  });
  json(res, 200, { ok: true, facets: cleaned, nodes });
};

// 跨领域出题候选：全领域 active 节点，带领域名与所属知识面，前端按领域分组选择
routes['GET /api/nodes/candidates'] = (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const params = new URL(req.url, 'http://localhost').searchParams;
  const excludeId = intIn(params.get('exclude_id'), 1, 2147483647, 0);
  const kw = text(params.get('q'), 40).toLowerCase();
  const rows = db.prepare(`SELECT n.id, n.name, n.domain_id, n.parent_id, n.cognitive_level, n.mastery,
      d.name AS domain_name, p.name AS parent_name
    FROM node n JOIN domain d ON d.id = n.domain_id LEFT JOIN node p ON p.id = n.parent_id
    WHERE n.status = 'active' AND (? = 0 OR n.id <> ?) ORDER BY d.id, n.id`).all(excludeId, excludeId);
  const filtered = kw ? rows.filter(r => `${r.name} ${r.domain_name} ${r.parent_name || ''}`.toLowerCase().includes(kw)) : rows;
  json(res, 200, { nodes: filtered.slice(0, 200) });
};

// 节点维护
routes['POST /api/nodes'] = async (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const b = await readBody(req);
  const domainId = intIn(b.domain_id, 1, 2147483647, 0);
  if (!db.prepare('SELECT 1 FROM domain WHERE id = ?').get(domainId)) fail(404, '领域不存在');
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 120) : '';
  if (!name) fail(400, '知识点名称不能为空');
  let parentId = null;
  if (b.parent_id !== null && b.parent_id !== undefined && b.parent_id !== '') {
    parentId = intIn(b.parent_id, 1, 2147483647, 0);
    if (!db.prepare('SELECT 1 FROM node WHERE id = ? AND domain_id = ?').get(parentId, domainId)) fail(400, '父知识点不存在');
  }
  const r = db.prepare('INSERT INTO node (domain_id, parent_id, name, cognitive_level, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(domainId, parentId, name, intIn(b.level, 1, 4, 1), now());
  json(res, 200, { ok: true, id: r.lastInsertRowid });
};
routes['DELETE /api/nodes/:id'] = (req, res, m) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const id = intIn(m.id, 1, 2147483647, 0);
  // 删除父节点时一并处理所有后代，避免孤儿节点与悬挂引用
  const ids = db.prepare(`WITH RECURSIVE sub(id) AS (
    SELECT ? UNION ALL SELECT n.id FROM node n JOIN sub ON n.parent_id = sub.id
  ) SELECT id FROM sub`).all(id).map(r => r.id);
  const ph = ids.map(() => '?').join(',');
  transaction(() => {
    db.prepare(`DELETE FROM chat_turn WHERE question_id IN (SELECT id FROM question WHERE node_id IN (${ph}))`).run(...ids);
    db.prepare(`DELETE FROM mistake WHERE node_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM attempt WHERE node_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM question WHERE node_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM review_slot WHERE node_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM progress WHERE node_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM node WHERE id IN (${ph})`).run(...ids);
  });
  json(res, 200, { ok: true });
};

// 外部题库管理：需鉴权；导入幂等，仅补缺不破坏已有数据
routes['GET /api/bank/stats'] = (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const params = new URL(req.url, 'http://localhost').searchParams;
  const prefix = text(params.get('prefix'), 120) || BANK_PREFIX;
  const domainKey = text(params.get('domain_key'), 200) || BANK_DOMAIN_KEY;
  json(res, 200, questionBankStats(prefix, domainKey));
};
routes['POST /api/bank/import'] = async (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  limitOrThrow(req, 'bank-import', 10, 60 * 1000);
  const b = await readBody(req, 8e6); // 题库文件较大，放宽到 8MB
  const items = Array.isArray(b.questions) ? b.questions : [];
  const opts = {
    domain_name: b.domain_name, domain_key: b.domain_key, domain_source: b.domain_source,
    source_key_prefix: b.source_key_prefix, source_type: b.source_type, model: b.model, prompt_ver: b.prompt_ver,
  };
  const stats = importQuestionBank(items, opts);
  const prefix = text(b.source_key_prefix, 120) || BANK_PREFIX;
  const domainKey = text(b.domain_key, 200) || BANK_DOMAIN_KEY;
  json(res, 200, { ok: true, stats, bank: questionBankStats(prefix, domainKey) });
};

// 按 ID 取单题（公开字段）：供地图/复习/错题本直达指定题目或知识点
routes['GET /api/questions/:id'] = (req, res, m) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const q = normalizeQuestion(db.prepare(`SELECT q.*, n.domain_id FROM question q
    JOIN node n ON n.id = q.node_id WHERE q.id = ?`).get(intIn(m.id, 1, 2147483647, 0)));
  if (!q) return json(res, 404, { error: '题目不存在' });
  json(res, 200, { question: publicQuestion(q) });
};

// 出题（默认落库缓存复用；force_new 时跳过已见过的题，保证「下一题」是新题）
// 自适应难度建议：只看这个知识点最近的真实作答，不引入新表。
// 前 3 题用于定档；之后连对升档、连错降档，否则按近 10 题正确率微调。
routes['GET /api/difficulty/advice'] = (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const nodeId = intIn(new URL(req.url, 'http://localhost').searchParams.get('node_id'), 1, 2147483647, 0);
  if (!nodeId) return json(res, 400, { error: '缺少 node_id' });
  if (!db.prepare('SELECT 1 FROM node WHERE id = ?').get(nodeId)) return json(res, 404, { error: '知识点不存在' });
  const rows = db.prepare(`
    SELECT a.is_correct, a.created_at, q.difficulty
    FROM attempt a JOIN question q ON q.id = a.question_id
    WHERE a.node_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 30`).all(nodeId);
  const byDifficulty = {};
  for (const r of rows) {
    const d = intIn(r.difficulty, 1, 5, 1);
    const s = byDifficulty[d] || (byDifficulty[d] = { n: 0, ok: 0 });
    s.n++; s.ok += r.is_correct ? 1 : 0;
  }
  let recommended = 2, reason = '', phase = 'calibrating';
  if (rows.length === 0) {
    reason = '还没有作答记录，先用基础档试水';
  } else if (rows.length < 3) {
    reason = `已答 ${rows.length} 题，答满 3 题后开始自动定档`;
  } else {
    phase = 'adaptive';
    const lastDiff = intIn(rows[0].difficulty, 1, 5, 2);
    const lastCorrect = rows[0].is_correct === 1;
    let streak = 0;
    // 连对/连错必须在同一难度档内累计，跨档不接续
    for (const r of rows) {
      if (intIn(r.difficulty, 1, 5, 0) === lastDiff && (r.is_correct === 1) === lastCorrect) streak++;
      else break;
    }
    if (streak >= 2) {
      recommended = Math.max(1, Math.min(5, lastDiff + (lastCorrect ? 1 : -1)));
      reason = `同档连续 ${streak} 题${lastCorrect ? '答对' : '答错'}，${lastCorrect ? '升' : '降'}到 ${recommended} 档`;
    } else {
      const recent = rows.slice(0, 10);
      const rate = recent.filter(r => r.is_correct === 1).length / recent.length;
      const pct = Math.round(rate * 100);
      if (rate >= 0.85 && lastDiff < 5) { recommended = lastDiff + 1; reason = `近 ${recent.length} 题正确率 ${pct}%，升到 ${recommended} 档`; }
      else if (rate <= 0.4 && lastDiff > 1) { recommended = lastDiff - 1; reason = `近 ${recent.length} 题正确率 ${pct}%，降到 ${recommended} 档巩固`; }
      else { recommended = lastDiff; reason = `近 ${recent.length} 题正确率 ${pct}%，保持 ${recommended} 档`; }
    }
  }
  json(res, 200, {
    ok: true, node_id: nodeId, recommended, reason, phase, samples: rows.length,
    by_difficulty: [1, 2, 3, 4, 5].map(d => ({ difficulty: d, ...(byDifficulty[d] || { n: 0, ok: 0 }) })),
  });
};

routes['POST /api/questions'] = async (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const b = await readBody(req);
  const node = db.prepare('SELECT * FROM node WHERE id = ?').get(intIn(b.node_id, 1, 2147483647, 0));
  if (!node) return json(res, 404, { error: '知识点不存在' });
  const difficulty = intIn(b.difficulty, 1, 5, 1);
  const forceNew = b.force_new === true || b.force_new === 'true';
  // 手动切难度时跳过旧缓存，确保按新难度标准重新出题
  const regenerate = b.regenerate === true || b.regenerate === 'true';
  // 跨领域：关联节点只进入题干与解析；掌握度、错题、复习只记主节点，保证可归因
  const rawRelated = Array.isArray(b.related_node_ids) ? b.related_node_ids : [];
  const relatedIds = [...new Set(rawRelated.map(v => intIn(v, 1, 2147483647, 0)).filter(id => id > 0 && id !== node.id))]
    .slice(0, 3).sort((x, y) => x - y);
  let relatedNodes = [];
  if (relatedIds.length) {
    const ph = relatedIds.map(() => '?').join(',');
    relatedNodes = db.prepare(`SELECT n.id, n.name, n.domain_id, n.cognitive_level, d.name AS domain_name
      FROM node n JOIN domain d ON d.id = n.domain_id
      WHERE n.id IN (${ph}) AND n.status = 'active'`).all(...relatedIds)
      .sort((x, y) => relatedIds.indexOf(x.id) - relatedIds.indexOf(y.id));
    if (relatedNodes.length !== relatedIds.length) return json(res, 400, { error: '关联知识点不可用' });
  } else if (rawRelated.length) {
    return json(res, 400, { error: '关联知识点不可用（不能与主知识点相同）' });
  }
  const bridgeType = relatedNodes.length ? bridgeTypeOf(b.bridge_type) : '';
  if (b.type === 'order' && relatedNodes.length) return json(res, 400, { error: '排序题暂不支持跨领域组题' });
  const relKey = JSON.stringify(relatedIds);
  limitOrThrow(req, forceNew || regenerate ? 'question-new' : 'question', forceNew || regenerate ? 12 : 40, 60 * 1000);
  const excludeIds = (Array.isArray(b.exclude_ids) ? b.exclude_ids : [])
    .map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 20);
  await withNodeLock(node.id, async () => {
    const wantOrder = b.type === 'order';
    // 普通出题沿用缓存；「下一题」优先复用库中还没见过的题，避免重复调用模型
    // 排序题、跨领域组合各自隔离缓存，避免点了「跨领域」却拿到普通题
    const cached = db.prepare(`SELECT * FROM question WHERE node_id = ? AND difficulty = ?
      AND COALESCE(related_node_ids, '[]') = ? AND COALESCE(bridge_type, '') = ? ORDER BY id`)
      .all(node.id, difficulty, relKey, bridgeType)
      .find(q => (wantOrder ? q.type === 'order' : q.type !== 'order') && !excludeIds.includes(q.id));
    if (cached && !regenerate && (!forceNew || excludeIds.length > 0)) {
      transaction(() => saveProgress(node.domain_id, node.id, cached.id, difficulty));
      return json(res, 200, { question: publicQuestion(cached), cached: true });
    }
    if (!modelAvailable()) return json(res, 500, { error: '模型未配置：请先在设置页填写模型配置' });
    const count = db.prepare('SELECT COUNT(*) AS n FROM question WHERE node_id = ?').get(node.id).n;
    if (count >= 200) return json(res, 409, { error: '该知识点题目已达上限' });
    let row;
    try {
      const placeholders = excludeIds.map(() => '?').join(',');
      const avoidStems = placeholders
        ? db.prepare(`SELECT stem FROM question WHERE id IN (${placeholders})`).all(...excludeIds).map(r => r.stem).filter(Boolean).slice(0, 8)
        : [];
      const interests = getSetting('interests') || '';
      const prompt = relatedNodes.length
        ? promptBridgeQuestion({ name: node.name }, relatedNodes, node.cognitive_level, difficulty, interests, bridgeType, avoidStems)
        : wantOrder
          ? promptMakeOrderQuestion(node.name, node.cognitive_level, difficulty, interests)
          : promptMakeQuestion(node.name, node.cognitive_level, difficulty, interests, avoidStems);
      const content = await llmChat([{ role: 'user', content: prompt }], { json: true });
      const q = JSON.parse(content);
      // 模型输出不可信：结构、数量、长度都要校验后再落库
      if (!q || typeof q !== 'object' || typeof q.stem !== 'string' || !q.stem.trim()) throw new Error('invalid question');
      // 跨领域题必须说出「桥」是什么，且题干/解析/桥接说明里要真的出现关联知识点
      const bridge = typeof q.bridge === 'string' ? q.bridge.trim().slice(0, 300) : '';
      if (relatedNodes.length) {
        if (bridge.length < 4) throw new Error('missing bridge');
        const body = `${q.stem}\n${typeof q.explanation === 'string' ? q.explanation : ''}\n${bridge}`;
        for (const rn of relatedNodes) if (!mentionsNode(body, rn.name)) throw new Error('bridge not grounded');
      }
      let type, options, answer;
      if (wantOrder) {
        if (q.type !== 'order') throw new Error('not an order question');
        options = (Array.isArray(q.options) ? q.options : []).filter(o => typeof o === 'string' && o.trim()).map(o => o.trim().slice(0, 120)).slice(0, 6);
        const steps = parseOrderAnswer(q.answer).slice(0, 6);
        if (options.length < 3 || steps.length !== options.length) throw new Error('invalid order steps');
        if (new Set(options).size !== options.length || steps.some(s => !options.includes(s))) throw new Error('order mismatch');
        type = 'order'; answer = JSON.stringify(steps);
      } else {
        type = q.type === 'judge' ? 'judge' : 'single';
        const rawOptions = (Array.isArray(q.options) ? q.options : [])
          .filter(o => typeof o === 'string' && o.trim()).slice(0, 6)
          .map(o => o.trim().slice(0, 300));
        options = type === 'judge' ? ['正确', '错误'] : [...new Set(rawOptions)];
        answer = typeof q.answer === 'string' ? q.answer.trim().slice(0, 300) : '';
        if (options.length < 2 || !answer) throw new Error('invalid options or answer');
        if (type === 'judge' && !['正确', '错误', 'A', 'B'].includes(answer)) throw new Error('invalid judge answer');
        // 答案必须能定位到某个选项，否则这道题永远判错；这类脏数据宁可不落库
        if (answerIndex(answer, options, true) < 0) throw new Error('answer not in options');
      }
      row = transaction(() => {
        const ver = relatedNodes.length ? `${PROMPT_VER}-bridge-${bridgeType}` : wantOrder ? PROMPT_VER + '-order' : PROMPT_VER;
        const r = db.prepare(`INSERT INTO question (node_id, type, difficulty, stem, options, answer, explanation,
          model, prompt_ver, created_at, related_node_ids, bridge_type, bridge)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(node.id, type, difficulty, q.stem.slice(0, 1000), JSON.stringify(options), answer,
            typeof q.explanation === 'string' ? q.explanation.slice(0, 4000) : '', llmConfig().chat_model, ver, now(),
            relKey, bridgeType, bridge);
        const inserted = db.prepare('SELECT * FROM question WHERE id = ?').get(r.lastInsertRowid);
        saveProgress(node.domain_id, node.id, inserted.id, difficulty);
        return inserted;
      });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      return json(res, 502, { error: relatedNodes.length
        ? '跨领域出题失败：题目没有形成真正的知识桥接，请重试'
        : '出题失败：模型输出不可用，请重试' });
    }
    return json(res, 200, { question: publicQuestion(row), cached: false });
  });
};

// ---------- 答案定位：兼容「字母」「选项原文」「数字序号」三种存储/提交形式 ----------
// preferLetter=true 用于题库答案（模型输出约定为字母），false 用于用户提交（前端传选项原文）。
// 这样即使某个选项文本恰好是 "B"，也不会把字母答案和选项原文混为一谈。
function answerIndex(answer, options, preferLetter = true) {
  const raw = String(answer ?? '').trim();
  const opts = Array.isArray(options) ? options : [];
  if (!raw || !opts.length) return -1;
  const exact = opts.findIndex(o => String(o).trim() === raw);
  if (!preferLetter && exact >= 0) return exact;
  const allSingleLetters = opts.every(o => /^[A-Za-z]$/.test(String(o).trim()));
  if (!allSingleLetters && /^[A-Za-z]$/.test(raw)) {
    const i = raw.toUpperCase().charCodeAt(0) - 65;
    if (i >= 0 && i < opts.length) return i;
  }
  if (exact >= 0) return exact;
  const loose = opts.findIndex(o => String(o).trim().toUpperCase() === raw.toUpperCase());
  if (loose >= 0) return loose;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n >= 1 && n <= opts.length) return n - 1;
  }
  return -1;
}

// 作答判定 + 掌握度 + 错题 + 复习调度
routes['POST /api/attempts'] = async (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  limitOrThrow(req, 'attempt', 60, 60 * 1000);
  const b = await readBody(req);
  const q = normalizeQuestion(db.prepare('SELECT * FROM question WHERE id = ?').get(intIn(b.question_id, 1, 2147483647, 0)));
  if (!q) return json(res, 404, { error: '题目不存在' });
  const isOrder = q.type === 'order';
  const answerGiven = text(b.answer, isOrder ? 4000 : 500);
  const durationMs = intIn(b.duration_ms, 0, 86400000, 0);
  const orderInfo = isOrder ? orderResult(parseOrderAnswer(answerGiven), parseOrderAnswer(q.answer)) : null;
  const isCorrect = isOrder ? (orderInfo.correct ? 1 : 0)
    : (answerIndex(answerGiven, q.options, false) === answerIndex(q.answer, q.options, true) ? 1 : 0);
  const errorTags = cleanTags(b.error_tags);

  // 讲解先生成（含 await），写库阶段不留跨 await 的读-改-写窗口
  let explanation = '', followups = [];
  if (modelAvailable()) {
    try {
      const content = await llmChat([{ role: 'user', content: promptExplain(q, answerGiven, isCorrect) }], { json: true });
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.explanation === 'string') explanation = parsed.explanation.slice(0, 4000);
        if (Array.isArray(parsed.followups)) followups = parsed.followups.filter(x => typeof x === 'string').slice(0, 3).map(x => x.slice(0, 200));
      }
    } catch { /* 兜底 */ }
  }
  if (!explanation) {
    explanation = isCorrect
      ? `答对了。「${q.stem}」的关键就是${q.explanation || '注意题目的核心判断点'}。继续保持这个状态，可以试试更快的档位。`
      : `这题答错了，别灰心。「${q.stem}」的关键是${q.explanation || '需要再理一理题目的核心逻辑'}，建议把错因记下来，稍后复习时再过一遍。`;
    followups = ['能再举一个类似的例子吗？', '这个点在实际中怎么用？'];
  }

  // 所有状态变更原子完成；掌握度/复习间隔在事务内重新读取，避免并发提交丢失更新
  const state = transaction(() => {
    const attempt = db.prepare('INSERT INTO attempt (question_id, node_id, answer_given, is_correct, duration_ms, error_tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(q.id, q.node_id, answerGiven, isCorrect, durationMs, JSON.stringify(errorTags), now());
    const attemptNode = db.prepare('SELECT domain_id FROM node WHERE id = ?').get(q.node_id);
    if (attemptNode) db.prepare('UPDATE progress SET answered = 1 WHERE domain_id = ? AND question_id = ?').run(attemptNode.domain_id, q.id);

    // 错题本：答错入队，答对后自动移出
    if (!isCorrect) {
      db.prepare('INSERT OR REPLACE INTO mistake (node_id, question_id, status, resolved_at, error_tags) VALUES (?, ?, ?, NULL, ?)')
        .run(q.node_id, q.id, 'active', JSON.stringify(errorTags));
    } else {
      db.prepare("UPDATE mistake SET status = 'resolved', resolved_at = ? WHERE node_id = ? AND question_id = ? AND status = 'active'").run(now(), q.node_id, q.id);
    }

    const node = db.prepare('SELECT mastery, domain_id FROM node WHERE id = ?').get(q.node_id);
    const speedBonus = isCorrect && durationMs > 0 && durationMs < 15000 ? 0.15 : 0;
    const m = Math.max(0, Math.min(1, (node?.mastery || 0) + (isCorrect ? 0.2 + speedBonus : -0.25)));
    db.prepare('UPDATE node SET mastery = ? WHERE id = ?').run(m, q.node_id);

    // 间隔复习调度（简化 SRS：答对延长间隔，答错明天再练）
    const slot = db.prepare('SELECT * FROM review_slot WHERE node_id = ?').get(q.node_id);
    let interval, ease = slot ? slot.ease : 2.5;
    if (isCorrect) {
      interval = slot ? Math.round(slot.interval_days * ease) : 1;
      ease = Math.min(3.2, ease + 0.15);
    } else {
      interval = 1;
      ease = Math.max(1.3, ease - 0.2);
    }
    db.prepare('INSERT INTO review_slot (node_id, due_at, interval_days, ease) VALUES (?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET due_at = excluded.due_at, interval_days = excluded.interval_days, ease = excluded.ease')
      .run(q.node_id, new Date(Date.now() + interval * 86400000).toISOString(), interval, ease);

    if (node) {
      const avg = db.prepare('SELECT AVG(mastery) AS m FROM node WHERE domain_id = ?').get(node.domain_id);
      db.prepare('UPDATE domain SET overall_mastery = ? WHERE id = ?').run(avg?.m || 0, node.domain_id);
    }
    return { mastery: m, attemptId: attempt.lastInsertRowid };
  });

  // 只有在提交作答后，才告诉前端正确选项在哪
  const correctIndex = isOrder ? -1 : answerIndex(q.answer, q.options, true);
  json(res, 200, {
    ok: true, attempt_id: state.attemptId, is_correct: isCorrect,
    correct_index: correctIndex,
    ...(isOrder ? { correct_order: parseOrderAnswer(q.answer), first_wrong: orderInfo.firstWrong } : {}),
    explanation, followups, mastery: state.mastery,
  });
};

// 作答后补记错因：结果先出、错因后选，保存后同步更新错题本用于按错因聚类
routes['POST /api/attempts/:id/error-tags'] = async (req, res, m) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const id = intIn(m.id, 1, 2147483647, 0);
  const b = await readBody(req);
  const tags = cleanTags(b.error_tags);
  const attempt = db.prepare('SELECT question_id, node_id FROM attempt WHERE id = ?').get(id);
  if (!attempt) return json(res, 404, { error: '作答记录不存在' });
  transaction(() => {
    db.prepare('UPDATE attempt SET error_tags = ? WHERE id = ?').run(JSON.stringify(tags), id);
    db.prepare("UPDATE mistake SET error_tags = ? WHERE node_id = ? AND question_id = ? AND status = 'active'")
      .run(JSON.stringify(tags), attempt.node_id, attempt.question_id);
  });
  json(res, 200, { ok: true, error_tags: tags });
};

// 复习队列（到期知识点）：先按薄弱度与逾期天数排优先级，而不是只按到期时间。
// 近 7 天正确率越低、答错越多、逾期越久越靠前；没有近期数据的节点按"未知"居中。
routes['GET /api/review'] = (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const rows = db.prepare(`
    WITH recent AS (
      SELECT q.node_id AS node_id, COUNT(*) AS n, SUM(a.is_correct) AS ok,
             SUM(CASE WHEN a.is_correct = 0 THEN 1 ELSE 0 END) AS wrong
      FROM attempt a JOIN question q ON q.id = a.question_id
      WHERE a.created_at >= ? GROUP BY q.node_id
    )
    SELECT nd.*, r.due_at, r.interval_days,
           COALESCE(recent.n, 0) AS recent_n,
           COALESCE(recent.ok, 0) AS recent_ok,
           COALESCE(recent.wrong, 0) AS recent_wrong
    FROM review_slot r
    JOIN node nd ON nd.id = r.node_id
    LEFT JOIN recent ON recent.node_id = nd.id
    WHERE r.due_at <= ? AND nd.status = 'active'`).all(since, now());
  const stamp = Date.now();
  for (const r of rows) {
    const acc = r.recent_n ? r.recent_ok / r.recent_n : null;
    r.recent_rate = acc === null ? null : Math.round(acc * 100);
    r.weakness = acc === null ? 0.5 : Math.round((1 - acc) * 100) / 100;
    const overdue = Math.max(0, (stamp - new Date(r.due_at).getTime()) / 86400000);
    r.priority = Math.round((overdue * 0.6 + r.weakness * 4 + Math.min(r.recent_wrong, 5) * 0.3) * 100) / 100;
  }
  rows.sort((a, b) => b.priority - a.priority || String(a.due_at).localeCompare(String(b.due_at)));
  json(res, 200, { due: rows.slice(0, 50) });
};

// 错题本（按知识点/错因聚类展示，答稳自动移出）
routes['GET /api/mistakes'] = (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const rows = db.prepare(`
    SELECT m.*, n.name AS node_name, n.domain_id, q.stem, q.type FROM mistake m
    JOIN node n ON n.id = m.node_id
    JOIN question q ON q.id = m.question_id
    WHERE m.status = 'active' ORDER BY m.node_id`).all();
  const byNode = {};
  for (const r of rows) {
    (byNode[r.node_name] ||= []).push({
      question_id: r.question_id, node_id: r.node_id, domain_id: r.domain_id,
      stem: r.stem, type: r.type, error_tags: parseTags(r.error_tags),
    });
  }
  json(res, 200, { mistakes: byNode });
};

// 学习报告（真实作答数据）
routes['GET /api/report'] = (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const params = new URL(req.url, 'http://localhost').searchParams;
  const days = intIn(params.get('days'), 1, 90, 30);
  // 客户端传本地时区偏移（分钟）：UTC+8 传 480，保证日历格子与用户看到的日期一致
  const tz = intIn(params.get('tz'), -720, 840, 0);
  const dayExpr = `strftime('%Y-%m-%d', created_at, '${tz >= 0 ? '+' : ''}${tz} minutes')`;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const total = db.prepare('SELECT COUNT(*) AS n, SUM(is_correct) AS ok FROM attempt WHERE created_at >= ?').get(since);
  const byDay = db.prepare(`SELECT ${dayExpr} AS d, COUNT(*) AS n, SUM(is_correct) AS ok FROM attempt WHERE created_at >= ? GROUP BY d ORDER BY d`).all(since);
  const domains = db.prepare('SELECT name, overall_mastery FROM domain ORDER BY id DESC').all();
  json(res, 200, {
    days, tz,
    total: total.n || 0,
    correct: total.ok || 0,
    accuracy: total.n ? Math.round((total.ok / total.n) * 100) : 0,
    byDay, domains,
  });
};

// 做题统计：每日/每月/每年聚合 + 连续打卡（热力图/打卡墙通用做法）
routes['GET /api/stats'] = (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const params = new URL(req.url, 'http://localhost').searchParams;
  // 客户端传本地时区偏移（分钟）：UTC+8 传 480，保证日历与用户看到的日期一致
  const tz = intIn(params.get('tz'), -720, 840, 0);
  const tzMod = `${tz >= 0 ? '+' : ''}${tz} minutes`;
  const dayExpr = `strftime('%Y-%m-%d', created_at, '${tzMod}')`;
  const monthExpr = `strftime('%Y-%m', created_at, '${tzMod}')`;
  const yearExpr = `strftime('%Y', created_at, '${tzMod}')`;

  const byDay = db.prepare(`SELECT ${dayExpr} AS d, COUNT(*) AS n, SUM(is_correct) AS ok FROM attempt GROUP BY d ORDER BY d`).all();
  const byMonth = db.prepare(`SELECT ${monthExpr} AS m, COUNT(*) AS n, SUM(is_correct) AS ok FROM attempt GROUP BY m ORDER BY m`).all();
  const byYear = db.prepare(`SELECT ${yearExpr} AS y, COUNT(*) AS n, SUM(is_correct) AS ok FROM attempt GROUP BY y ORDER BY y`).all();
  const total = db.prepare('SELECT COUNT(*) AS n, SUM(is_correct) AS ok FROM attempt').get();

  // 连续打卡：今天还没做题时从昨天回推，避免早上刚打开就判定断签
  const daySet = new Set(byDay.map(r => r.d));
  const dayKey = (d) => d.toISOString().slice(0, 10);
  let streak = 0;
  let cursor = new Date(Date.now() + tz * 60000);
  if (!daySet.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (daySet.has(dayKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  // 最长连续段：遍历有序日期，间隔 1 天则续段
  let run = 0, bestStreak = 0, prevKey = null;
  for (const r of byDay) {
    if (prevKey) {
      const gap = (new Date(`${r.d}T00:00:00`) - new Date(`${prevKey}T00:00:00`)) / 86400000;
      run = gap === 1 ? run + 1 : 1;
    } else {
      run = 1;
    }
    if (run > bestStreak) bestStreak = run;
    prevKey = r.d;
  }

  // 薄弱知识点排行：至少 2 次作答才入榜，正确率低的排前面；附带错因与近 7 天错题数
  const weakRows = db.prepare(`
    SELECT nd.id AS node_id, nd.name AS node_name, dm.id AS domain_id, dm.name AS domain_name,
           COUNT(*) AS attempts, SUM(a.is_correct) AS correct
    FROM attempt a
    JOIN question q ON q.id = a.question_id
    JOIN node nd ON nd.id = q.node_id
    JOIN domain dm ON dm.id = nd.domain_id
    GROUP BY nd.id
    HAVING COUNT(*) >= 2
    ORDER BY (1 - SUM(a.is_correct) * 1.0 / COUNT(*)) DESC, COUNT(*) DESC, nd.id
    LIMIT 8`).all();
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const weakNodes = weakRows.map(r => {
    const tagRows = db.prepare(`SELECT a.error_tags FROM attempt a JOIN question q ON q.id = a.question_id
      WHERE q.node_id = ? AND a.error_tags IS NOT NULL AND a.error_tags <> '' AND a.error_tags <> '[]'`).all(r.node_id);
    const counts = {};
    for (const t of tagRows) for (const tag of parseTags(t.error_tags)) counts[tag] = (counts[tag] || 0) + 1;
    const recentWrong = db.prepare(`SELECT COUNT(*) AS n FROM attempt a JOIN question q ON q.id = a.question_id
      WHERE q.node_id = ? AND a.is_correct = 0 AND a.created_at >= ?`).get(r.node_id, since).n;
    return {
      ...r,
      rate: Math.round((r.correct / r.attempts) * 100),
      recent_wrong: recentWrong,
      top_tags: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([tag, count]) => ({ tag, count })),
    };
  });

  json(res, 200, {
    ok: true, tz,
    total: total.n || 0,
    correct: total.ok || 0,
    accuracy: total.n ? Math.round((total.ok / total.n) * 100) : 0,
    active_days: byDay.length,
    streak,
    best_streak: bestStreak,
    first_day: byDay[0]?.d || null,
    by_day: byDay,
    by_month: byMonth,
    by_year: byYear,
    weak_nodes: weakNodes,
  });
};

// 划线收藏：只存用户划下的原文片段，来源题目/领域用于回溯；导入题自动带原始网页链接
routes['GET /api/highlights'] = (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const params = new URL(req.url, 'http://localhost').searchParams;
  const q = (params.get('q') || '').trim().slice(0, 120);
  const dRaw = Number(params.get('domain_id'));
  const domainId = Number.isInteger(dRaw) && dRaw > 0 ? dRaw : 0;
  const lRaw = Number(params.get('limit'));
  const limit = Number.isInteger(lRaw) && lRaw > 0 ? Math.min(500, lRaw) : 200;
  const oRaw = Number(params.get('offset'));
  const offset = Number.isInteger(oRaw) && oRaw >= 0 ? Math.min(100000, oRaw) : 0;
  let sql = 'SELECT h.*, d.name AS domain_name, n.name AS node_name FROM highlight h LEFT JOIN domain d ON d.id = h.domain_id LEFT JOIN node n ON n.id = h.node_id WHERE 1=1';
  const args = [];
  if (q) { sql += ' AND (h.text LIKE ? OR h.note LIKE ? OR h.question_stem LIKE ?)'; const like = `%${q}%`; args.push(like, like, like); }
  if (domainId) { sql += ' AND h.domain_id = ?'; args.push(domainId); }
  sql += ' ORDER BY h.created_at DESC LIMIT ? OFFSET ?'; args.push(limit, offset);
  const items = db.prepare(sql).all(...args);
  const countSql = 'SELECT COUNT(*) AS n FROM highlight h WHERE 1=1' + (q ? ' AND (h.text LIKE ? OR h.note LIKE ? OR h.question_stem LIKE ?)' : '') + (domainId ? ' AND h.domain_id = ?' : '');
  const total = db.prepare(countSql).get(...(q ? [...Array(3).fill(`%${q}%`)] : []), ...(domainId ? [domainId] : [])).n;
  json(res, 200, { items, total, count: items.length });
};

routes['POST /api/highlights'] = async (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  limitOrThrow(req, 'highlight-write', 60, 60 * 1000);
  const b = await readBody(req);
  const text = typeof b.text === 'string' ? b.text.trim().slice(0, 2000) : '';
  if (!text || text.length < 2) return json(res, 400, { error: '划线内容不能为空或过短' });
  const source = ['stem', 'explanation', 'chat', 'option'].includes(b.source) ? b.source : 'explanation';
  const questionId = intIn(b.question_id, 1, 2147483647, 0) || null;
  const nodeId = intIn(b.node_id, 1, 2147483647, 0) || null;
  const domainId = intIn(b.domain_id, 1, 2147483647, 0) || null;
  // 从数据库反查题目信息，避免客户端伪造来源
  let stem = '', sourceUrl = '', realNodeId = nodeId, realDomainId = domainId;
  const materialId = intIn(b.material_id, 1, 2147483647, null);
  const chunkId = intIn(b.chunk_id, 1, 2147483647, null);
  if (questionId) {
    const row = db.prepare(`SELECT q.stem, q.source_url, q.node_id, n.domain_id FROM question q
      JOIN node n ON n.id = q.node_id WHERE q.id = ?`).get(questionId);
    if (row) { stem = row.stem || ''; sourceUrl = row.source_url || ''; realNodeId = row.node_id; realDomainId = row.domain_id; }
  }
  if (materialId && !sourceUrl) {
    const row = db.prepare('SELECT source_url, domain_id FROM material WHERE id = ?').get(materialId);
    if (row) { sourceUrl = row.source_url || ''; realDomainId = row.domain_id || realDomainId; }
  }
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 1000) : '';
  const r = db.prepare(`INSERT INTO highlight (text, source, question_id, node_id, domain_id, question_stem, source_url, note, created_at, material_id, chunk_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(text, source, questionId, realNodeId, realDomainId, stem, sourceUrl, note, now(), materialId, chunkId);
  const item = db.prepare('SELECT h.*, d.name AS domain_name, n.name AS node_name FROM highlight h LEFT JOIN domain d ON d.id=h.domain_id LEFT JOIN node n ON n.id=h.node_id WHERE h.id=?').get(r.lastInsertRowid);
  json(res, 200, { ok: true, highlight: item });
};

routes['PATCH /api/highlights/:id'] = async (req, res, m) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const id = intIn(m.id, 1, 2147483647, 0);
  if (!db.prepare('SELECT 1 FROM highlight WHERE id = ?').get(id)) return json(res, 404, { error: '划线不存在' });
  const b = await readBody(req);
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 1000) : null;
  if (note !== null) db.prepare('UPDATE highlight SET note = ? WHERE id = ?').run(note, id);
  const item = db.prepare('SELECT h.*, d.name AS domain_name, n.name AS node_name FROM highlight h LEFT JOIN domain d ON d.id=h.domain_id LEFT JOIN node n ON n.id=h.node_id WHERE h.id=?').get(id);
  json(res, 200, { ok: true, highlight: item });
};

routes['DELETE /api/highlights/:id'] = (req, res, m) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const id = intIn(m.id, 1, 2147483647, 0);
  db.prepare('DELETE FROM highlight WHERE id = ?').run(id);
  json(res, 200, { ok: true });
};

routes['GET /api/highlights/export'] = (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const items = db.prepare(`SELECT h.*, d.name AS domain_name, n.name AS node_name FROM highlight h
    LEFT JOIN domain d ON d.id=h.domain_id LEFT JOIN node n ON n.id=h.node_id ORDER BY h.created_at DESC`).all();
  const lines = [`# 划线收藏（${items.length} 条）`, ''];
  let lastDomain = '';
  for (const h of items) {
    if (h.domain_name !== lastDomain) { lines.push(`## ${h.domain_name || '未分类'}`, ''); lastDomain = h.domain_name; }
    lines.push(`> ${h.text.replace(/\n/g, '\n> ')}`);
    if (h.note) lines.push('', `备注：${h.note}`);
    const src = [h.node_name ? `知识点：${h.node_name}` : '', h.source_url ? `原文：${h.source_url}` : ''].filter(Boolean).join(' · ');
    if (src) lines.push('', `— ${src}`);
    lines.push('');
  }
  res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="highlights.md"' });
  res.end(lines.join('\n'));
};

// ---------- 资料（M4）：快照 → 切块 → 摘要 / 清单 / 出题 / 接地问答 ----------
function loadMaterial(id) {
  const m = db.prepare('SELECT * FROM material WHERE id = ?').get(intIn(id, 1, 2147483647, 0));
  if (!m) fail(404, '资料不存在');
  const chunks = db.prepare('SELECT * FROM material_chunk WHERE material_id = ? ORDER BY idx').all(m.id)
    .map(c => ({ ...c, tags: parseTags(c.tags) }));
  return { m, chunks };
}
function storeChunks(materialId, chunks, claimPolicy) {
  const insert = db.prepare('INSERT INTO material_chunk (material_id, idx, heading, content, tags, claim_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const c of chunks) insert.run(materialId, c.idx, c.heading, c.content, '[]', claimPolicy, now());
}
function materialPublic(m) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM material_chunk WHERE material_id = ?').get(m.id).n;
  const domain = m.domain_id ? db.prepare('SELECT name FROM domain WHERE id = ?').get(m.domain_id) : null;
  return { ...m, chunk_count: count, domain_name: domain?.name || '' };
}
let materialChatStreams = 0;

routes['GET /api/materials'] = (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const rows = db.prepare('SELECT * FROM material ORDER BY id DESC').all().map(materialPublic);
  json(res, 200, { materials: rows });
};
// 所有资料入口共用同一条落库链路：哈希幂等 → 切块 → 事务写入
function createMaterial({ title, source = '', content, domainId = null, claimPolicy = 'article_claim', sourceType = 'article' }) {
  const hash = contentHash(content);
  const dup = db.prepare('SELECT * FROM material WHERE content_hash = ? ORDER BY id LIMIT 1').get(hash);
  if (dup) return { material: materialPublic(dup), reused: true };
  const chunks = splitMaterial(content);
  if (!chunks.length) fail(400, '资料切块为空');
  const id = transaction(() => {
    const r = db.prepare('INSERT INTO material (domain_id, title, source_url, source_type, content_hash, claim_policy, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(domainId, title, source, ['article', 'note', 'doc', 'image'].includes(sourceType) ? sourceType : 'article', hash, claimPolicy, '', now());
    storeChunks(Number(r.lastInsertRowid), chunks, claimPolicy);
    return Number(r.lastInsertRowid);
  });
  return { material: materialPublic(db.prepare('SELECT * FROM material WHERE id = ?').get(id)), reused: false };
}
routes['POST /api/materials'] = async (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  limitOrThrow(req, 'material-create', 10, 60 * 1000);
  const b = await readBody(req, 2e6);
  const title = text(b.title, 120).trim();
  const source = text(b.source_url, 500).trim();
  const content = typeof b.content === 'string' ? b.content.trim().slice(0, 1000000) : '';
  const domainId = intIn(b.domain_id, 1, 2147483647, null);
  const claimPolicy = ['article_claim', 'verified', 'mixed'].includes(b.claim_policy) ? b.claim_policy : 'article_claim';
  if (!title) return json(res, 400, { error: '资料标题不能为空' });
  if (!content) return json(res, 400, { error: '资料内容不能为空' });
  if (domainId && !db.prepare('SELECT 1 FROM domain WHERE id = ?').get(domainId)) return json(res, 404, { error: '领域不存在' });
  const created = createMaterial({ title, source, content, domainId, claimPolicy, sourceType: b.source_type });
  json(res, 200, { ok: true, ...created });
};
// 图片资料：视觉模型输出结构化描述 → 同一条资料流水线。看不清的部分保留在 uncertain，不编造。
routes['POST /api/materials/image'] = async (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  limitOrThrow(req, 'material-image', 10, 60 * 1000);
  const b = await readBody(req, 6e6);
  const dataUri = typeof b.image === 'string' ? b.image : '';
  const match = dataUri.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return json(res, 400, { error: '仅支持 PNG / JPEG / WebP / GIF 的 data URL 图片' });
  if (match[2].length > 5e6) return json(res, 413, { error: '图片过大，请使用 3MB 以内的图片' });
  if (!modelAvailable()) return json(res, 500, { error: '模型未配置：请先在设置页填写模型配置' });
  let data;
  try {
    const content = await llmChat([{ role: 'user', content: [
      { type: 'text', text: promptImageDescribe(text(b.hint, 400)) },
      { type: 'image_url', image_url: { url: dataUri } },
    ] }], { json: true, model: 'fast' });
    data = JSON.parse(content);
  } catch {
    return json(res, 502, { error: '图片描述失败：当前模型可能不支持视觉输入，或输出不可用' });
  }
  if (!data || typeof data !== 'object' || typeof data.description !== 'string' || !data.description.trim()) {
    return json(res, 502, { error: '图片描述失败：模型输出为空或格式异常' });
  }
  const list = key => (Array.isArray(data[key]) ? data[key] : []).filter(x => typeof x === 'string' && x.trim()).slice(0, 20).map(x => x.slice(0, 300));
  const lines = [`# ${(typeof data.title === 'string' && data.title.trim() ? data.title.trim() : '图片资料').slice(0, 120)}`, '', '> 由视觉模型转写，需与原图核对；未经独立核实。', '', '## 画面概述', data.description.slice(0, 2000), ''];
  const section = (name, key, ordered) => {
    const items = list(key);
    if (!items.length) return;
    lines.push(`## ${name}`, '');
    items.forEach((x, i) => lines.push(ordered ? `${i + 1}. ${x}` : `- ${x}`));
    lines.push('');
  };
  section('关键元素', 'elements', false);
  section('图中文字', 'texts', false);
  section('流程 / 步骤', 'flow', true);
  section('不确定 / 未识别', 'uncertain', false);
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const uploadDir = path.join(DATA_DIR, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const file = `${contentHash(match[2])}.${ext}`;
  fs.writeFileSync(path.join(uploadDir, file), Buffer.from(match[2], 'base64'));
  const imageUrl = `/uploads/${file}`;
  const title = text(b.title, 120).trim() || (typeof data.title === 'string' ? data.title.trim().slice(0, 120) : '') || '图片资料';
  const created = createMaterial({ title, source: imageUrl, content: lines.join('\n').trim(),
    domainId: intIn(b.domain_id, 1, 2147483647, null), claimPolicy: 'article_claim', sourceType: 'image' });
  json(res, 200, { ok: true, ...created, image_url: imageUrl, uncertain: list('uncertain') });
};
routes['GET /api/materials/:id'] = (req, res, m) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const { m: material, chunks } = loadMaterial(m.id);
  json(res, 200, { material: materialPublic(material), chunks });
};
routes['DELETE /api/materials/:id'] = (req, res, m) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const { m: material } = loadMaterial(m.id);
  transaction(() => {
    // 题目保留来源链接，只解除与资料的关联，避免影响已有作答/错题
    db.prepare('UPDATE question SET material_id = NULL, chunk_id = NULL WHERE material_id = ?').run(material.id);
    db.prepare('UPDATE chat_turn SET material_id = NULL WHERE material_id = ?').run(material.id);
    db.prepare('UPDATE highlight SET material_id = NULL, chunk_id = NULL WHERE material_id = ?').run(material.id);
    db.prepare('DELETE FROM memory_card WHERE material_id = ?').run(material.id);
    db.prepare('DELETE FROM material_chunk WHERE material_id = ?').run(material.id);
    db.prepare('DELETE FROM material WHERE id = ?').run(material.id);
  });
  json(res, 200, { ok: true });
};
routes['POST /api/materials/:id/summary'] = async (req, res, m) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  limitOrThrow(req, 'material-summary', 10, 60 * 1000);
  const { m: material, chunks } = loadMaterial(m.id);
  if (material.summary) return json(res, 200, { summary: JSON.parse(material.summary), cached: true });
  if (!modelAvailable()) return json(res, 500, { error: '模型未配置：请先在设置页填写模型配置' });
  let summary;
  try {
    const content = await llmChat([{ role: 'user', content: promptMaterialSummarize(material.title, chunks) }], { json: true, model: 'fast' });
    const d = JSON.parse(content);
    summary = {
      one_line: typeof d.one_line === 'string' ? d.one_line.slice(0, 300) : '',
      points: (Array.isArray(d.points) ? d.points : []).filter(x => typeof x === 'string').slice(0, 10).map(x => x.slice(0, 120)),
      timeline: (Array.isArray(d.timeline) ? d.timeline : []).filter(x => typeof x === 'string').slice(0, 10).map(x => x.slice(0, 160)),
    };
    if (!summary.one_line && !summary.points.length) throw new Error('empty summary');
  } catch {
    return json(res, 502, { error: '摘要生成失败：模型输出不可用，请重试' });
  }
  db.prepare('UPDATE material SET summary = ? WHERE id = ?').run(JSON.stringify(summary), material.id);
  json(res, 200, { summary, cached: false });
};
routes['POST /api/materials/:id/build'] = async (req, res, m) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  limitOrThrow(req, 'build', 5, 60 * 1000);
  const { m: material, chunks } = loadMaterial(m.id);
  const b = await readBody(req);
  if (!modelAvailable()) return json(res, 500, { error: '模型未配置：请先在设置页填写模型配置' });
  const levelDesc = text(b.level, 200) || '没学过';
  let data;
  try {
    data = JSON.parse(await llmChat([{ role: 'user', content: promptMaterialList(material.title, chunks, levelDesc) }], { json: true }));
  } catch {
    return json(res, 502, { error: '拆解失败：模型输出不可用，请重试' });
  }
  if (!data || !Array.isArray(data.facets)) return json(res, 502, { error: '拆解失败：模型输出格式异常' });
  const cleaned = [];
  for (const f of data.facets.slice(0, 8)) {
    const name = typeof f?.name === 'string' ? f.name.trim().slice(0, 80) : '';
    const points = (Array.isArray(f?.points) ? f.points : []).slice(0, 12).map(p => ({
      name: typeof p?.name === 'string' ? p.name.trim().slice(0, 80) : '',
      cognitive_level: intIn(p?.cognitive_level, 1, 4, 1),
    })).filter(p => p.name);
    if (name && points.length) cleaned.push({ name, points });
  }
  if (!cleaned.length) return json(res, 502, { error: '拆解失败：知识清单为空' });
  let domainId = intIn(b.domain_id, 1, 2147483647, null) || material.domain_id;
  if (!domainId) {
    const domainName = text(b.domain_name, 120) || material.title;
    const key = `article://material/${material.id}`;
    const r = db.prepare('INSERT INTO domain (name, source, status, level, created_at, source_key) VALUES (?, ?, ?, ?, ?, ?)')
      .run(domainName, 'material', 'ready', levelDesc, now(), key);
    domainId = Number(r.lastInsertRowid);
  }
  const nodes = transaction(() => {
    const old = db.prepare('SELECT id FROM node WHERE domain_id = ?').all(domainId).map(r => r.id);
    const ph = old.map(() => '?').join(',');
    if (ph) {
      db.prepare(`DELETE FROM chat_turn WHERE question_id IN (SELECT id FROM question WHERE node_id IN (${ph}))`).run(...old);
      db.prepare(`DELETE FROM mistake WHERE node_id IN (${ph})`).run(...old);
      db.prepare(`DELETE FROM attempt WHERE node_id IN (${ph})`).run(...old);
      db.prepare(`DELETE FROM question WHERE node_id IN (${ph})`).run(...old);
      db.prepare(`DELETE FROM review_slot WHERE node_id IN (${ph})`).run(...old);
      db.prepare(`DELETE FROM memory_card WHERE node_id IN (${ph})`).run(...old);
      db.prepare(`DELETE FROM progress WHERE node_id IN (${ph})`).run(...old);
      db.prepare(`DELETE FROM node WHERE id IN (${ph})`).run(...old);
    }
    for (const facet of cleaned) {
      const fr = db.prepare('INSERT INTO node (domain_id, parent_id, name, cognitive_level, created_at) VALUES (?, NULL, ?, 2, ?)')
        .run(domainId, facet.name, now());
      for (const point of facet.points) {
        db.prepare('INSERT INTO node (domain_id, parent_id, name, cognitive_level, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(domainId, fr.lastInsertRowid, point.name, point.cognitive_level, now());
      }
    }
    db.prepare('UPDATE material SET domain_id = ? WHERE id = ?').run(domainId, material.id);
    return db.prepare('SELECT * FROM node WHERE domain_id = ? ORDER BY parent_id NULLS FIRST, id').all(domainId);
  });
  json(res, 200, { ok: true, domain_id: domainId, facets: cleaned, nodes });
};
routes['POST /api/materials/:id/questions'] = async (req, res, m) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  limitOrThrow(req, 'material-question', 10, 60 * 1000);
  const { m: material, chunks } = loadMaterial(m.id);
  const b = await readBody(req);
  const count = intIn(b.count, 1, 20, 5);
  const difficulty = intIn(b.difficulty, 1, 5, 1);
  if (!material.domain_id) return json(res, 400, { error: '请先把资料关联到领域或先拆解知识清单' });
  let nodes = db.prepare('SELECT * FROM node WHERE domain_id = ?').all(material.domain_id);
  if (b.node_id) {
    const one = nodes.find(n => n.id === intIn(b.node_id, 1, 2147483647, 0));
    if (!one) return json(res, 404, { error: '知识点不存在' });
    nodes = [one];
  } else nodes = nodes.filter(n => n.parent_id !== null);
  if (!nodes.length) return json(res, 400, { error: '领域还没有知识点，请先拆解清单' });
  if (!modelAvailable()) return json(res, 500, { error: '模型未配置：请先在设置页填写模型配置' });
  const interests = getSetting('interests') || '';
  const created = [], failed = [];
  for (let i = 0; i < count; i++) {
    const node = nodes[i % nodes.length];
    const picked = retrieveChunks(chunks, node.name, 6);
    try {
      const wantOrder = b.type === 'order';
      const prompt = wantOrder
        ? promptMakeOrderQuestion(node.name, node.cognitive_level, difficulty, interests, picked)
        : promptMaterialQuestion(node.name, node.cognitive_level, difficulty, picked, interests);
      const content = await llmChat([{ role: 'user', content: prompt }], { json: true });
      const q = JSON.parse(content);
      if (!q || typeof q.stem !== 'string' || !q.stem.trim()) throw new Error('invalid stem');
      let type, options, answer;
      if (wantOrder) {
        if (q.type !== 'order') throw new Error('not an order question');
        options = (Array.isArray(q.options) ? q.options : []).filter(o => typeof o === 'string' && o.trim()).map(o => o.trim().slice(0, 120)).slice(0, 6);
        const steps = parseOrderAnswer(q.answer).slice(0, 6);
        if (options.length < 3 || steps.length !== options.length) throw new Error('invalid order steps');
        if (new Set(options).size !== options.length || steps.some(s => !options.includes(s))) throw new Error('order mismatch');
        type = 'order'; answer = JSON.stringify(steps);
      } else {
        type = q.type === 'judge' ? 'judge' : 'single';
        const rawOptions = (Array.isArray(q.options) ? q.options : []).filter(o => typeof o === 'string' && o.trim()).slice(0, 6).map(o => o.trim().slice(0, 300));
        options = type === 'judge' ? ['正确', '错误'] : [...new Set(rawOptions)];
        answer = typeof q.answer === 'string' ? q.answer.trim().slice(0, 300) : '';
        if (options.length < 2 || !answer || answerIndex(answer, options, true) < 0) throw new Error('invalid answer');
      }
      const idx = intIn(q.chunk_index, 0, 10000, picked[0]?.idx ?? 0);
      const chunk = chunks.find(c => c.idx === idx) || picked[0];
      const row = transaction(() => {
        const r = db.prepare('INSERT INTO question (node_id, type, difficulty, stem, options, answer, explanation, model, prompt_ver, created_at, source_key, source_url, source_type, material_id, chunk_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(node.id, type, difficulty, q.stem.slice(0, 1000), JSON.stringify(options), answer,
            typeof q.explanation === 'string' ? q.explanation.slice(0, 4000) : '', llmConfig().chat_model, PROMPT_VER + (wantOrder ? '-order' : '-material-v1'), now(),
            `article://material/${material.id}/q/${crypto.randomBytes(8).toString('hex')}`, material.source_url || '', 'material', material.id, chunk?.id || null);
        return Number(r.lastInsertRowid);
      });
      created.push({ id: row, node_id: node.id, chunk_idx: chunk?.idx ?? null });
    } catch { failed.push({ node_id: node.id }); }
  }
  json(res, 200, { ok: true, created: created.length, failed: failed.length, questions: created });
};
// 多文档交叉核验：每篇资料先按主张召回片段，模型判断后逐条回溯真实原文
routes['POST /api/materials/verify'] = async (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  limitOrThrow(req, 'verify', 10, 60 * 1000);
  const b = await readBody(req);
  const claim = text(b.claim, 500).trim();
  if (!claim) return json(res, 400, { error: '请填写要核验的主张' });
  let materials = db.prepare('SELECT id, title, source_url FROM material ORDER BY id').all();
  if (Array.isArray(b.material_ids) && b.material_ids.length) {
    const ids = b.material_ids.map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 8);
    materials = materials.filter(m => ids.includes(m.id));
  } else materials = materials.slice(0, 8);
  if (!materials.length) return json(res, 400, { error: '没有可核验的资料' });
  if (!modelAvailable()) return json(res, 500, { error: '模型未配置：请先在设置页填写模型配置' });
  const sources = [], blocks = [];
  for (const material of materials) {
    const chunks = db.prepare('SELECT * FROM material_chunk WHERE material_id = ? ORDER BY idx').all(material.id);
    for (const c of retrieveChunks(chunks, claim, 3)) {
      sources.push({ material_id: material.id, idx: c.idx, heading: c.heading, content: c.content,
        claim_status: c.claim_status, source_url: material.source_url });
      blocks.push(`资料 id=${material.id} 标题「${material.title}」片段编号=${c.idx} 章节「${c.heading}」口径=${c.claim_status === 'article_claim' ? '文章声称，未经核实' : '资料原文'}\n${c.content.slice(0, 700)}`);
    }
  }
  if (!sources.length) return json(res, 200, { claim, summary: '资料里没有可用片段，无法核验。', items: [], covered: false });
  let parsed;
  try {
    parsed = JSON.parse(await llmChat([{ role: 'user', content: promptCrossVerify(claim, blocks.join('\n\n---\n\n')) }], { json: true, model: 'fast' }));
  } catch { return json(res, 502, { error: '核验失败：模型输出不可用，请重试' }); }
  const items = [];
  for (const it of (Array.isArray(parsed?.items) ? parsed.items : []).slice(0, 8)) {
    const mid = Number(it?.material_id), idx = Number(it?.idx);
    const src = sources.find(s => s.material_id === mid && s.idx === idx);
    if (!src) continue;
    const quote = text(it.quote, 80).trim();
    if (!quote || !src.content.includes(quote)) continue; // 引用必须逐字命中，杜绝模型伪造证据
    const relation = ['support', 'contradict', 'unrelated'].includes(it.relation) ? it.relation : 'unrelated';
    let note = text(it.note, 120).trim();
    if (src.claim_status === 'article_claim' && !note.startsWith('文章称')) note = `文章称，${note}`;
    items.push({ material_id: mid, idx, heading: src.heading, relation, quote, note, source_url: src.source_url });
  }
  json(res, 200, { claim, summary: text(parsed?.summary, 800) || '未给出总结。', items,
    covered: items.length > 0, sources_checked: sources.length });
};

// 记忆宫殿复习卡：位置线索 → 自测线索 → 揭示答案 → 自评驱动既有 SRS
routes['GET /api/memory-cards'] = (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const rows = db.prepare(`SELECT c.*, n.name AS node_name, n.domain_id, d.name AS domain_name,
    r.due_at FROM memory_card c JOIN node n ON n.id = c.node_id
    LEFT JOIN domain d ON d.id = n.domain_id LEFT JOIN review_slot r ON r.node_id = c.node_id
    ORDER BY (r.due_at IS NULL), r.due_at, c.id LIMIT 100`).all();
  json(res, 200, { cards: rows.map(c => {
    let ids = []; try { ids = JSON.parse(c.source_chunk_ids || '[]').map(Number); } catch { /* 兼容旧数据 */ }
    return { ...c, source_chunk_ids: ids };
  }) });
};
routes['POST /api/memory-cards/generate'] = async (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  limitOrThrow(req, 'memory-generate', 10, 60 * 1000);
  const b = await readBody(req);
  const nodeId = intIn(b.node_id, 1, 2147483647, 0);
  const materialId = intIn(b.material_id, 1, 2147483647, 0);
  const count = intIn(b.count, 1, 20, 5);
  let nodes = [];
  if (nodeId) {
    const one = db.prepare('SELECT * FROM node WHERE id = ?').get(nodeId);
    if (!one) return json(res, 404, { error: '知识点不存在' });
    nodes = [one];
  } else if (materialId) {
    const m = db.prepare('SELECT * FROM material WHERE id = ?').get(materialId);
    if (!m) return json(res, 404, { error: '资料不存在' });
    nodes = db.prepare('SELECT * FROM node WHERE domain_id = ? AND parent_id IS NOT NULL ORDER BY id LIMIT ?').all(m.domain_id, count);
  } else {
    nodes = db.prepare(`SELECT n.* FROM review_slot r JOIN node n ON n.id = r.node_id
      WHERE r.due_at <= ? AND n.status = 'active' ORDER BY r.due_at LIMIT ?`).all(now(), count);
  }
  if (!nodes.length) return json(res, 200, { ok: true, generated: 0, message: '当前没有待做卡片的知识点' });
  if (!modelAvailable()) return json(res, 500, { error: '模型未配置：请先在设置页填写模型配置' });
  let generated = 0, reused = 0;
  for (const node of nodes) {
    if (db.prepare('SELECT 1 FROM memory_card WHERE node_id = ?').get(node.id)) { reused++; continue; }
    const material = db.prepare('SELECT * FROM material WHERE domain_id = ? ORDER BY id LIMIT 1').get(node.domain_id);
    const chunks = material ? db.prepare('SELECT * FROM material_chunk WHERE material_id = ? ORDER BY idx').all(material.id) : [];
    const picked = chunks.length ? retrieveChunks(chunks, node.name, 4) : [];
    try {
      const d = JSON.parse(await llmChat([{ role: 'user', content: promptMemoryCard(node.name, picked) }], { json: true, model: 'fast' }));
      const room = text(d.room, 80).trim(), hook = text(d.hook, 120).trim(), cue = text(d.cue, 160).trim();
      let answer = text(d.answer, 400).trim();
      if (!room || !cue || !answer) continue;
      const idx = intIn(d.chunk_index, 0, 10000, picked[0]?.idx ?? 0);
      const chunk = picked.find(c => c.idx === idx) || picked[0];
      if (chunk && !answer.includes(`[${idx}]`)) answer += `（依据：[${idx}]）`;
      const r = db.prepare('INSERT OR IGNORE INTO memory_card (node_id, material_id, room, hook, cue, answer, source_chunk_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(node.id, material?.id || null, room, hook, cue, answer, JSON.stringify(chunk ? [chunk.id] : []), now());
      generated += r.changes;
    } catch { /* 单张失败不影响其他卡片 */ }
  }
  json(res, 200, { ok: true, generated, reused });
};
routes['POST /api/memory-cards/:id/review'] = async (req, res, m) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const id = intIn(m.id, 1, 2147483647, 0);
  const card = db.prepare('SELECT * FROM memory_card WHERE id = ?').get(id);
  if (!card) return json(res, 404, { error: '卡片不存在' });
  const b = await readBody(req);
  const remembered = b.remembered === true || b.remembered === 'true';
  const slot = db.prepare('SELECT * FROM review_slot WHERE node_id = ?').get(card.node_id);
  let ease = slot ? slot.ease : 2.5;
  const interval = remembered ? (slot ? Math.max(1, Math.round(slot.interval_days * ease)) : 2) : 1;
  ease = remembered ? Math.min(3.2, ease + 0.15) : Math.max(1.3, ease - 0.2);
  const due = new Date(Date.now() + interval * 86400000).toISOString();
  const node = db.prepare('SELECT mastery FROM node WHERE id = ?').get(card.node_id);
  const mastery = Math.max(0, Math.min(1, (node?.mastery || 0) + (remembered ? 0.1 : -0.1)));
  transaction(() => {
    db.prepare('INSERT INTO review_slot (node_id, due_at, interval_days, ease) VALUES (?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET due_at = excluded.due_at, interval_days = excluded.interval_days, ease = excluded.ease')
      .run(card.node_id, due, interval, ease);
    db.prepare('UPDATE node SET mastery = ? WHERE id = ?').run(mastery, card.node_id);
  });
  json(res, 200, { ok: true, remembered, next_due: due, interval_days: interval, mastery });
};

routes['POST /api/materials/:id/chat'] = async (req, res, m) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  limitOrThrow(req, 'material-chat', 20, 60 * 1000);
  if (materialChatStreams >= 2) fail(429, '同时进行的对话过多，请稍后再试');
  const { m: material, chunks } = loadMaterial(m.id);
  const b = await readBody(req);
  const content = text(b.content, 2000);
  if (!content.trim()) fail(400, '问题不能为空');
  const history = (Array.isArray(b.history) ? b.history : []).slice(-6).map(h => ({
    role: h && h.role === 'user' ? 'user' : 'assistant', content: text(h && h.content, 1000),
  })).filter(h => h.content);
  const picked = retrieveChunks(chunks, content, 6);
  const sourceIds = picked.map(c => c.id);
  db.prepare('INSERT INTO chat_turn (question_id, material_id, role, content, ts, source_chunk_ids) VALUES (NULL, ?, ?, ?, ?, ?)')
    .run(material.id, 'user', content, now(), JSON.stringify(sourceIds));
  if (!modelAvailable()) return json(res, 500, { error: '模型未配置：请先在设置页填写模型配置' });
  const abort = new AbortController();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${JSON.stringify({ sources: picked.map(c => ({ id: c.id, idx: c.idx, heading: c.heading, claim_status: c.claim_status })) })}\n\n`);
  materialChatStreams++;
  let reader = null, aborted = false, full = '';
  res.on('close', () => {
    if (aborted) return;
    aborted = true; abort.abort();
    try { reader?.cancel?.(); } catch { /* 客户端断开 */ }
  });
  try {
    const stream = await llmChat([{ role: 'user', content: promptMaterialQA(material.title, picked, content, history, getSetting('nickname') || '小问') }], { stream: true, signal: abort.signal });
    reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const emit = (frame) => {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const delta = JSON.parse(payload).choices?.[0]?.delta?.content || '';
          if (delta) { full += delta; res.write(`data: ${JSON.stringify({ role: 'assistant', content: delta })}\n\n`); }
        } catch { /* 忽略不完整分片 */ }
      }
    };
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) { const frame = buf.slice(0, sep); buf = buf.slice(sep + 2); emit(frame); }
    }
    buf += decoder.decode();
    if (!aborted && buf.trim()) emit(buf);
    if (!aborted) {
      db.prepare('INSERT INTO chat_turn (question_id, material_id, role, content, ts, source_chunk_ids) VALUES (NULL, ?, ?, ?, ?, ?)')
        .run(material.id, 'assistant', full, now(), JSON.stringify(sourceIds));
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }
  } catch {
    if (!aborted && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: '回答生成失败，请稍后重试' })}\n\n`);
      res.end();
    }
  } finally { materialChatStreams--; }
};

// 追问对话（SSE 流式）
let chatStreams = 0;
routes['POST /api/chat'] = async (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  limitOrThrow(req, 'chat', 20, 60 * 1000);
  if (chatStreams >= 2) fail(429, '同时进行的对话过多，请稍后再试');
  const b = await readBody(req);
  const q = normalizeQuestion(db.prepare('SELECT * FROM question WHERE id = ?').get(intIn(b.question_id, 1, 2147483647, 0)));
  if (!q) return json(res, 404, { error: '题目不存在' });
  const content = text(b.content, 2000);
  if (!content.trim()) fail(400, '追问内容不能为空');
  const history = (Array.isArray(b.history) ? b.history : []).slice(-8).map(h => ({
    role: h && h.role === 'user' ? 'user' : 'assistant',
    content: text(h && h.content, 1000),
  })).filter(h => h.content);
  db.prepare('INSERT INTO chat_turn (question_id, role, content, ts) VALUES (?, ?, ?, ?)').run(q.id, 'user', content, now());

  if (!modelAvailable()) return json(res, 500, { error: '模型未配置：请先在设置页填写模型配置' });
  const abort = new AbortController();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${JSON.stringify({ role: 'assistant', content: '' })}\n\n`);
  chatStreams++;
  let reader = null;
  let aborted = false;
  res.on('close', () => {
    if (aborted) return;
    aborted = true;
    abort.abort();
    try { reader?.cancel?.(); } catch { /* 客户端断开 */ }
  });
  try {
    const stream = await llmChat([{ role: 'user', content: promptChat(q, history, getSetting('nickname') || '小问') }], { stream: true, signal: abort.signal });
    let full = '';
    reader = stream.getReader();
    const decoder = new TextDecoder();
    let sseBuf = '';
    // 上游分片不保证按 SSE 帧边界到达，必须缓冲到 \n\n 再解析，否则会随机丢字
    const emitFrame = (frame) => {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const delta = JSON.parse(payload).choices?.[0]?.delta?.content || '';
          if (delta) {
            full += delta;
            res.write(`data: ${JSON.stringify({ role: 'assistant', content: delta })}\n\n`);
          }
        } catch { /* 忽略不完整分片 */ }
      }
    };
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = sseBuf.indexOf('\n\n')) >= 0) {
        const frame = sseBuf.slice(0, sep);
        sseBuf = sseBuf.slice(sep + 2);
        emitFrame(frame);
      }
    }
    sseBuf += decoder.decode();
    if (!aborted && sseBuf.trim()) emitFrame(sseBuf);
    if (!aborted) {
      db.prepare('INSERT INTO chat_turn (question_id, role, content, ts) VALUES (?, ?, ?, ?)').run(q.id, 'assistant', full, now());
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }
  } catch {
    // 上游错误不回显内部信息，客户端断开时也不再写入已关闭的响应
    if (!aborted && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: '对话生成失败，请稍后重试' })}\n\n`);
      res.end();
    }
  } finally {
    chatStreams--;
  }
};

// 数据导出：WAL 模式下直接读主库会得到空文件，必须用一致性快照；
// 同时剔除 token / 密码哈希 / 模型密钥，备份文件可安全留存。
routes['GET /api/export'] = async (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  limitOrThrow(req, 'export', 5, 60 * 1000);
  const snapshot = path.join(DATA_DIR, `export-${crypto.randomBytes(8).toString('hex')}.db`);
  try {
    db.exec(`VACUUM INTO '${snapshot}'`); // 路径由 hex 生成，无引号注入风险
    const copy = new DatabaseSync(snapshot);
    try {
      copy.exec("DELETE FROM setting WHERE key IN ('token', 'password_hash', 'llm_api_key')");
      // DELETE 只标记空闲页，密钥明文仍会留在文件里；VACUUM 重建页面才能彻底剔除
      copy.exec('VACUUM');
    }
    finally { copy.close(); }
    const stat = fs.statSync(snapshot);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="qingwen-backup-${now().slice(0, 10)}.db"`,
      'Content-Length': stat.size,
    });
    const stream = fs.createReadStream(snapshot);
    res.on('close', () => fs.rmSync(snapshot, { force: true }));
    await new Promise((resolve, reject) => {
      stream.on('error', reject);
      res.on('error', reject);
      res.on('finish', resolve);
      stream.pipe(res);
    });
  } catch (e) {
    fs.rmSync(snapshot, { force: true });
    if (e instanceof HttpError) throw e;
    if (!res.headersSent) json(res, 500, { error: '导出失败' });
    else res.destroy();
  }
};

// ---------- 请求分发 ----------
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // 图片资料原图：限制在 DATA_DIR/uploads 内，路径越界直接拒绝
  if (pathname.startsWith('/uploads/')) {
    const root = path.resolve(DATA_DIR, 'uploads');
    const file = path.resolve(root, `.${pathname.slice('/uploads'.length)}`);
    if (file === root || !file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return;
    }
    const ext = path.extname(file).toLowerCase();
    const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
    const stat = fs.statSync(file);
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400', 'Content-Length': stat.size });
    fs.createReadStream(file).pipe(res);
    return;
  }

  // 静态文件 + SPA 回退
  if (!pathname.startsWith('/api/')) {
    // 显式限制在前端目录内，避免编码路径或异常 pathname 逃出 WEB_DIR
    const webRoot = path.resolve(WEB_DIR);
    let file = path.resolve(webRoot, `.${pathname}`);
    if (file !== webRoot && !file.startsWith(webRoot + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403');
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(webRoot, 'index.html');
    if (fs.existsSync(file)) {
      const ext = path.extname(file).toLowerCase();
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
      const stat = fs.statSync(file);
      res.writeHead(200, {
        'Content-Type': types[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
        'Content-Length': stat.size,
      });
      const stream = fs.createReadStream(file);
      stream.on('error', () => { if (!res.headersSent) json(res, 500, { error: '读取文件失败' }); else res.destroy(); });
      stream.pipe(res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }

  // API 路由匹配（支持 :param）
  for (const [key, handler] of Object.entries(routes)) {
    const [method, pattern] = key.split(' ');
    if (method !== req.method) continue;
    const pm = pattern.replace(/:[^/]+/g, '([^/]+)');
    const m = pathname.match(new RegExp(`^${pm}$`));
    if (m) {
      const params = {};
      const names = [...pattern.matchAll(/:([^/]+)/g)].map(x => x[1]);
      names.forEach((n, i) => { params[n] = m[i + 1]; });
      try {
        await handler(req, res, params);
      } catch (e) {
        if (e instanceof HttpError) json(res, e.code, { error: e.message });
        else {
          console.error('[qingwen] 请求处理失败', req.method, pathname, e);
          if (!res.headersSent) json(res, 500, { error: '服务器内部错误' });
          else res.destroy();
        }
      }
      return;
    }
  }
  json(res, 404, { error: '接口不存在' });
}
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(e => {
    console.error('[qingwen] 未捕获请求错误', e);
    if (!res.headersSent) json(res, 500, { error: '服务器内部错误' });
    else res.destroy();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[qingwen] 服务已启动 http://0.0.0.0:${PORT}`);
  console.log(`[qingwen] 数据库 ${DB_PATH}`);
  console.log(`[qingwen] 前端目录 ${WEB_DIR}`);
});
