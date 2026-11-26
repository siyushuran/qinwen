// 轻问练 · 后端服务（零依赖 Node + 内置 node:sqlite）
// 架构对齐方案：单后端服务同进程托管前端静态文件 + API 路由 + SSE 流式 + 模型抽象层
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
  created_at TEXT
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
`);

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

async function llmChat(messages, opts = {}) {
  const c = llmConfig();
  if (!modelAvailable()) throw new Error('模型未配置：请在设置页填写 Base URL、API Key 与模型名');
  const model = (opts.model === 'fast' && c.fast_model) ? c.fast_model : c.chat_model;
  const body = {
    model,
    messages,
    temperature: opts.temperature ?? 0.7,
    stream: opts.stream ?? false,
  };
  if (opts.json) body.response_format = { type: 'json_object' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const resp = await fetch(`${c.base_url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.api_key}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      throw new Error(`模型服务返回 ${resp.status}：${text.slice(0, 200)}`);
    }
    if (opts.stream) return resp.body; // ReadableStream，交给 SSE 转发
    const data = await resp.json();
    return data.choices?.[0]?.message?.content ?? '';
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

function promptMakeQuestion(nodeName, level, difficulty, interests) {
  const scene = interests ? `，尽量融入这些兴趣场景：${interests}` : '';
  return `你是一位出题老师。请围绕知识点「${nodeName}」（认知层级 ${level}，难度档 ${difficulty}/5）出一道题${scene}。
输出严格 JSON（不要 markdown）：
{"type":"single","stem":"题干","options":["选项A","选项B","选项C","选项D"],"answer":"A","explanation":"解析，简洁讲清为什么"}
type 只在 "single"（单选）和 "judge"（判断）中选；judge 时 options 为 ["正确","错误"]，answer 为 "正确" 或 "错误"。题干自然、生活化、无应试感。`;
}

function promptExplain(question, userAnswer, isCorrect) {
  return `你是一位耐心的陪练老师。用户作答了下面这道题，判定结果：${isCorrect ? '答对' : '答错'}。
题目：${question.stem}
选项：${(question.options || []).join(' / ')}
正确答案：${question.answer}
用户作答：${userAnswer}
请输出严格 JSON（不要 markdown）：
{"judged":"对/错","explanation":"讲解：先点明对错，再讲清知识点本身，语气像朋友聊天，不要应试腔","followups":["建议的追问方向1","建议的追问方向2"]}`;
}

function promptChat(question, history) {
  const ctx = history.slice(-8).map(h => `${h.role === 'user' ? '用户' : '老师'}：${h.content}`).join('\n');
  return `你是陪练老师「小问」。用户正在练习这道题：
题干：${question.stem}
选项：${(question.options || []).join(' / ')}
正确答案：${question.answer}
讲解：${question.explanation}
历史对话：
${ctx}
请回答用户的追问。要求：苏格拉底式引导，不直接甩答案，先从用户思路出发，逐步给线索；语气亲切自然，篇幅控制在 150 字以内。直接输出回复内容，不要 JSON。`;
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
  return { ...q, options };
}

// ---------- 鉴权（单用户） ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(pw, salt, 64).toString('hex');
  const a = Buffer.from(calc, 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function makeToken() {
  const token = crypto.randomBytes(24).toString('hex');
  setSetting('token', token);
  return token;
}
function authed(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return token && token === getSetting('token');
}

// ---------- 工具 ----------
function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function now() { return new Date().toISOString(); }
async function readBody(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) break; }
  try { return raw ? JSON.parse(raw) : {}; } catch { return null; }
}

// ---------- API 路由 ----------
const routes = {};

// 健康检查
routes['GET /api/health'] = (req, res) => json(res, 200, { ok: true, model_configured: modelAvailable(), time: now() });

// 鉴权
routes['POST /api/auth/setup'] = async (req, res) => {
  const b = await readBody(req);
  const pw = String(b.password || '');
  if (pw.length < 4) return json(res, 400, { error: '密码至少 4 位' });
  if (getSetting('password_hash')) return json(res, 409, { error: '密码已设置，请直接登录' });
  setSetting('password_hash', hashPassword(pw));
  const token = makeToken();
  json(res, 200, { ok: true, token });
};
routes['POST /api/auth/login'] = async (req, res) => {
  const b = await readBody(req);
  const pw = String(b.password || '');
  const stored = getSetting('password_hash');
  if (!stored) return json(res, 400, { error: '尚未设置密码，请先创建' });
  if (!verifyPassword(pw, stored)) return json(res, 401, { error: '密码错误' });
  const token = makeToken();
  json(res, 200, { ok: true, token });
};
routes['POST /api/auth/logout'] = async (req, res) => {
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
      chat_model: c.chat_model,
      fast_model: c.fast_model,
      configured: modelAvailable(),
    },
  });
};
routes['POST /api/settings'] = async (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const b = await readBody(req);
  for (const k of ['nickname', 'interests', 'font_scale', 'motion', 'voice_pref', 'llm_base_url', 'llm_api_key', 'llm_chat_model', 'llm_fast_model']) {
    if (k in b) setSetting(k, b[k]);
  }
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
  const name = String(b.name || '').trim();
  if (!name) return json(res, 400, { error: '领域名称不能为空' });
  const r = db.prepare('INSERT INTO domain (name, source, status, created_at) VALUES (?, ?, ?, ?)').run(name, 'manual', 'ready', now());
  json(res, 200, { ok: true, id: r.lastInsertRowid });
};
routes['DELETE /api/domains/:id'] = (req, res, m) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const id = Number(m.id);
  db.prepare('DELETE FROM chat_turn WHERE question_id IN (SELECT id FROM question WHERE node_id IN (SELECT id FROM node WHERE domain_id = ?))').run(id);
  db.prepare('DELETE FROM mistake WHERE node_id IN (SELECT id FROM node WHERE domain_id = ?)').run(id);
  db.prepare('DELETE FROM attempt WHERE node_id IN (SELECT id FROM node WHERE domain_id = ?)').run(id);
  db.prepare('DELETE FROM question WHERE node_id IN (SELECT id FROM node WHERE domain_id = ?)').run(id);
  db.prepare('DELETE FROM review_slot WHERE node_id IN (SELECT id FROM node WHERE domain_id = ?)').run(id);
  db.prepare('DELETE FROM node WHERE domain_id = ?').run(id);
  db.prepare('DELETE FROM domain WHERE id = ?').run(id);
  json(res, 200, { ok: true });
};
routes['GET /api/domains/:id'] = (req, res, m) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const id = Number(m.id);
  const d = db.prepare('SELECT * FROM domain WHERE id = ?').get(id);
  if (!d) return json(res, 404, { error: '领域不存在' });
  const nodes = db.prepare('SELECT * FROM node WHERE domain_id = ? ORDER BY parent_id NULLS FIRST, id').all(id);
  json(res, 200, { domain: d, nodes });
};

// 拆知识清单（M1 核心，构建过程由前端逐段渲染）
routes['POST /api/domains/:id/build'] = async (req, res, m) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const domainId = Number(m.id);
  const b = await readBody(req);
  const levelDesc = String(b.level || '');
  if (!modelAvailable()) return json(res, 500, { error: '模型未配置：请先在设置页填写模型配置' });
  try {
    const content = await llmChat([{ role: 'user', content: promptBuildList(b.domain_name || '', levelDesc) }], { json: true });
    const data = JSON.parse(content);
    db.prepare('DELETE FROM node WHERE domain_id = ?').run(domainId);
    let pid = null;
    for (const facet of (data.facets || [])) {
      const fr = db.prepare('INSERT INTO node (domain_id, parent_id, name, cognitive_level, created_at) VALUES (?, NULL, ?, 2, ?)').run(domainId, facet.name, now());
      pid = fr.lastInsertRowid;
      for (const point of (facet.points || [])) {
        db.prepare('INSERT INTO node (domain_id, parent_id, name, cognitive_level, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(domainId, pid, point.name, Math.min(4, Math.max(1, Number(point.cognitive_level) || 1)), now());
      }
    }
    db.prepare('UPDATE domain SET status = ? WHERE id = ?').run('ready', domainId);
    const nodes = db.prepare('SELECT * FROM node WHERE domain_id = ? ORDER BY parent_id NULLS FIRST, id').all(domainId);
    json(res, 200, { ok: true, facets: data.facets, nodes });
  } catch (e) {
    json(res, 500, { error: `拆解失败：${e.message}` });
  }
};

// 节点维护
routes['POST /api/nodes'] = async (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const b = await readBody(req);
  const r = db.prepare('INSERT INTO node (domain_id, parent_id, name, cognitive_level, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(Number(b.domain_id), b.parent_id ? Number(b.parent_id) : null, String(b.name || ''), Number(b.level) || 1, now());
  json(res, 200, { ok: true, id: r.lastInsertRowid });
};
routes['DELETE /api/nodes/:id'] = (req, res, m) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const id = Number(m.id);
  db.prepare('DELETE FROM chat_turn WHERE question_id IN (SELECT id FROM question WHERE node_id = ?)').run(id);
  db.prepare('DELETE FROM mistake WHERE node_id = ?').run(id);
  db.prepare('DELETE FROM attempt WHERE node_id = ?').run(id);
  db.prepare('DELETE FROM question WHERE node_id = ?').run(id);
  db.prepare('DELETE FROM review_slot WHERE node_id = ?').run(id);
  db.prepare('DELETE FROM node WHERE id = ?').run(id);
  json(res, 200, { ok: true });
};

// 出题（落库缓存，同节点同难度复用）
routes['POST /api/questions'] = async (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const b = await readBody(req);
  const node = db.prepare('SELECT * FROM node WHERE id = ?').get(Number(b.node_id));
  if (!node) return json(res, 404, { error: '知识点不存在' });
  const difficulty = Math.min(5, Math.max(1, Number(b.difficulty) || 1));
  const cached = db.prepare('SELECT * FROM question WHERE node_id = ? AND difficulty = ? LIMIT 1').get(node.id, difficulty);
  if (cached) return json(res, 200, { question: normalizeQuestion(cached), cached: true });
  if (!modelAvailable()) return json(res, 500, { error: '模型未配置：请先在设置页填写模型配置' });
  try {
    const content = await llmChat([{ role: 'user', content: promptMakeQuestion(node.name, node.cognitive_level, difficulty, getSetting('interests') || '') }], { json: true });
    const q = JSON.parse(content);
    const r = db.prepare('INSERT INTO question (node_id, type, difficulty, stem, options, answer, explanation, model, prompt_ver, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(node.id, q.type || 'single', difficulty, q.stem || '', JSON.stringify(q.options || []), q.answer || '', q.explanation || '', llmConfig().chat_model, PROMPT_VER, now());
    json(res, 200, { question: normalizeQuestion(db.prepare('SELECT * FROM question WHERE id = ?').get(r.lastInsertRowid)), cached: false });
  } catch (e) {
    json(res, 500, { error: `出题失败：${e.message}` });
  }
};

// ---------- 答案归一化：兼容「字母」「选项原文」「数字序号」三种存储/提交形式 ----------
function normalizeAnswerKey(answer, options) {
  const a = String(answer ?? '').trim().toUpperCase();
  if (!a) return '';
  // 原文形式：在选项列表中找到对应项，转成字母
  const idx = (options || []).findIndex(o => String(o).trim().toUpperCase() === a);
  if (idx >= 0) return String.fromCharCode(65 + idx);
  // 已是字母形式
  if (/^[A-Z]$/.test(a)) return a;
  // 数字序号（1 起）
  if (/^\d+$/.test(a)) return String.fromCharCode(65 + Math.min(25, Number(a) - 1));
  return a;
}

// 作答判定 + 掌握度 + 错题 + 复习调度
routes['POST /api/attempts'] = async (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const b = await readBody(req);
  const q = normalizeQuestion(db.prepare('SELECT * FROM question WHERE id = ?').get(Number(b.question_id)));
  if (!q) return json(res, 404, { error: '题目不存在' });
  const answerGiven = String(b.answer ?? '');
  const isCorrect = normalizeAnswerKey(answerGiven, q.options) === normalizeAnswerKey(q.answer, q.options) ? 1 : 0;
  const errorTags = Array.isArray(b.error_tags) ? b.error_tags.slice(0, 3) : [];
  db.prepare('INSERT INTO attempt (question_id, node_id, answer_given, is_correct, duration_ms, error_tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(q.id, q.node_id, answerGiven, isCorrect, Number(b.duration_ms) || 0, JSON.stringify(errorTags), now());

  // 讲解（模型可用时生成，失败则用规则兜底文案）
  let judged = null, explanation = '', followups = [];
  if (modelAvailable()) {
    try {
      const content = await llmChat([{ role: 'user', content: promptExplain(q, answerGiven, isCorrect) }], { json: true });
      const parsed = JSON.parse(content);
      judged = parsed.judged; explanation = parsed.explanation; followups = parsed.followups || [];
    } catch { /* 兜底 */ }
  }
  if (!explanation) {
    explanation = isCorrect
      ? `答对了。「${q.stem}」的关键就是${q.explanation || '注意题目的核心判断点'}。继续保持这个状态，可以试试更快的档位。`
      : `这题答错了，别灰心。「${q.stem}」的关键是${q.explanation || '需要再理一理题目的核心逻辑'}，建议把错因记下来，稍后复习时再过一遍。`;
    followups = ['能再举一个类似的例子吗？', '这个点在实际中怎么用？'];
  }

  // 掌握度更新（答对抬升、答错回落；答对且快加更多）
  const node = db.prepare('SELECT * FROM node WHERE id = ?').get(q.node_id);
  const speedBonus = isCorrect && Number(b.duration_ms) > 0 && Number(b.duration_ms) < 15000 ? 0.15 : 0;
  let mastery = Math.min(1, (node.mastery || 0) + (isCorrect ? 0.2 + speedBonus : -0.25));
  mastery = Math.max(0, mastery);
  db.prepare('UPDATE node SET mastery = ? WHERE id = ?').run(mastery, q.node_id);

  // 错题本（答错入队，答稳自动移出由复习处理）
  if (!isCorrect) {
    db.prepare('INSERT OR REPLACE INTO mistake (node_id, question_id, status) VALUES (?, ?, ?)').run(q.node_id, q.id, 'active');
  }

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
  const due = new Date(Date.now() + interval * 86400000);
  db.prepare('INSERT INTO review_slot (node_id, due_at, interval_days, ease) VALUES (?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET due_at = excluded.due_at, interval_days = excluded.interval_days, ease = excluded.ease')
    .run(q.node_id, due.toISOString(), interval, ease);

  // 领域总掌握度
  const avg = db.prepare('SELECT AVG(mastery) AS m FROM node WHERE domain_id = ?').get(node.domain_id);
  db.prepare('UPDATE domain SET overall_mastery = ? WHERE id = ?').run(avg?.m || 0, node.domain_id);

  json(res, 200, { ok: true, is_correct: isCorrect, explanation, followups, mastery });
};

// 复习队列（到期知识点）
routes['GET /api/review'] = (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const rows = db.prepare(`
    SELECT n.*, r.due_at, r.interval_days FROM review_slot r
    JOIN node n ON n.id = r.node_id
    WHERE r.due_at <= ? AND n.status = 'active' ORDER BY r.due_at LIMIT 50`).all(now());
  json(res, 200, { due: rows });
};

// 错题本（按知识点/错因聚类展示，答稳自动移出）
routes['GET /api/mistakes'] = (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const rows = db.prepare(`
    SELECT m.*, n.name AS node_name, q.stem, q.type FROM mistake m
    JOIN node n ON n.id = m.node_id
    JOIN question q ON q.id = m.question_id
    WHERE m.status = 'active' ORDER BY m.node_id`).all();
  const byNode = {};
  for (const r of rows) {
    (byNode[r.node_name] ||= []).push({ question_id: r.question_id, stem: r.stem, type: r.type });
  }
  json(res, 200, { mistakes: byNode });
};

// 做题统计：每日 / 每月 / 每年 + 连续打卡 + 作答时长（真实作答数据）
routes['GET /api/stats'] = (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const today = new Date();

  // 累计总览
  const all = db.prepare('SELECT COUNT(*) AS n, SUM(is_correct) AS ok, SUM(duration_ms) AS dur FROM attempt').get();

  // 每日：近 30 天逐日
  const since30 = new Date(today.getTime() - 29 * 86400000).toISOString();
  const byDay = db.prepare(`
    SELECT substr(created_at,1,10) AS d, COUNT(*) AS n, SUM(is_correct) AS ok, SUM(duration_ms) AS dur
    FROM attempt WHERE created_at >= ? GROUP BY d ORDER BY d`).all(since30);

  // 每月：近 12 个月（零作答月份由前端补齐）
  const since12m = new Date(today.getFullYear(), today.getMonth() - 11, 1).toISOString();
  const byMonth = db.prepare(`
    SELECT substr(created_at,1,7) AS m, COUNT(*) AS n, SUM(is_correct) AS ok, SUM(duration_ms) AS dur
    FROM attempt WHERE created_at >= ? GROUP BY m ORDER BY m`).all(since12m);

  // 每年：全部有记录的年份
  const byYear = db.prepare(`
    SELECT substr(created_at,1,4) AS y, COUNT(*) AS n, SUM(is_correct) AS ok, SUM(duration_ms) AS dur
    FROM attempt GROUP BY y ORDER BY y`).all();

  // 打卡天数与连续打卡（从最近一次有作答的日子往前连续推）
  const activeDays = db.prepare('SELECT DISTINCT substr(created_at,1,10) AS d FROM attempt ORDER BY d DESC').all();
  let streak = 0;
  if (activeDays.length) {
    const set = new Set(activeDays.map(r => r.d));
    const cursor = new Date(activeDays[0].d);
    while (set.has(cursor.toISOString().slice(0, 10))) {
      streak += 1;
      cursor.setTime(cursor.getTime() - 86400000);
    }
  }

  const domains = db.prepare('SELECT name, overall_mastery FROM domain ORDER BY id DESC').all();
  json(res, 200, {
    total: all.n || 0,
    correct: all.ok || 0,
    accuracy: all.n ? Math.round((all.ok / all.n) * 100) : 0,
    totalMs: all.dur || 0,
    daysActive: activeDays.length,
    streak,
    byDay, byMonth, byYear, domains,
  });
};

// 追问对话（SSE 流式）
routes['POST /api/chat'] = async (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  const b = await readBody(req);
  const q = normalizeQuestion(db.prepare('SELECT * FROM question WHERE id = ?').get(Number(b.question_id)));
  if (!q) return json(res, 404, { error: '题目不存在' });
  const history = Array.isArray(b.history) ? b.history : [];
  db.prepare('INSERT INTO chat_turn (question_id, role, content, ts) VALUES (?, ?, ?, ?)').run(q.id, 'user', String(b.content || ''), now());

  if (!modelAvailable()) {
    json(res, 500, { error: '模型未配置：请先在设置页填写模型配置' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${JSON.stringify({ role: 'assistant', content: '' })}\n\n`);
  try {
    const stream = await llmChat([{ role: 'user', content: promptChat(q, history) }], { stream: true });
    let full = '';
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split('\n')) {
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
    }
    db.prepare('INSERT INTO chat_turn (question_id, role, content, ts) VALUES (?, ?, ?, ?)').run(q.id, 'assistant', full, now());
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
};

// 数据导出（备份 SQLite）
routes['GET /api/export'] = (req, res) => {
  if (!authed(req)) return json(res, 401, { error: '未登录' });
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="qingwen-backup-${Date.now()}.db"`,
  });
  fs.createReadStream(DB_PATH).pipe(res);
};

// ---------- 请求分发 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // 静态文件 + SPA 回退
  if (!pathname.startsWith('/api/')) {
    let file = path.join(WEB_DIR, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIR, 'index.html');
    if (fs.existsSync(file)) {
      const ext = path.extname(file).toLowerCase();
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
      const stat = fs.statSync(file);
      res.writeHead(200, {
        'Content-Type': types[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
        'Content-Length': stat.size,
      });
      fs.createReadStream(file).pipe(res);
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
      try { await handler(req, res, params); } catch (e) { json(res, 500, { error: e.message || '服务器内部错误' }); }
      return;
    }
  }
  json(res, 404, { error: '接口不存在' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[qingwen] 服务已启动 http://0.0.0.0:${PORT}`);
  console.log(`[qingwen] 数据库 ${DB_PATH}`);
  console.log(`[qingwen] 前端目录 ${WEB_DIR}`);
});
