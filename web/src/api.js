// 轻量 API 客户端 + 偏好存储 + Toast
const TOKEN_KEY = 'qw_token';

export function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
export function setToken(t) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }

export async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(path, { ...options, headers });
  let data = null;
  try { data = await resp.json(); } catch { /* 非 JSON */ }
  if (!resp.ok) {
    const err = new Error((data && data.error) || `请求失败（${resp.status}）`);
    err.status = resp.status;
    throw err;
  }
  return data;
}

// SSE 流式追问（POST + ReadableStream，EventSource 不支持 POST，这里手动解析）
export async function streamChat(payload, onDelta, onDone, onError) {
  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify(payload),
    });
    if (!resp.ok || !resp.body) throw new Error('无法开启对话');
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim());
            if (ev.error) throw new Error(ev.error);
            if (ev.content) onDelta(ev.content);
            if (ev.done) { onDone(); return; }
          } catch (e) {
            if (e.message && !e.message.startsWith('无法')) throw e;
          }
        }
      }
    }
    onDone();
  } catch (e) {
    onError(e);
  }
}

// 资料问答流：首帧是引用来源，后续帧是回答正文
export async function streamMaterialChat(materialId, payload, onSources, onDelta, onDone, onError) {
  try {
    const resp = await fetch(`/api/materials/${materialId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify(payload),
    });
    if (!resp.ok || !resp.body) throw new Error('无法开启资料问答');
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim());
            if (ev.error) throw new Error(ev.error);
            if (ev.sources) onSources(ev.sources);
            if (ev.content) onDelta(ev.content);
            if (ev.done) { onDone(); return; }
          } catch (e) {
            if (e.message && !e.message.startsWith('无法')) throw e;
          }
        }
      }
    }
    onDone();
  } catch (e) { onError(e); }
}

// 偏好（localStorage，首帧由 index.html 内联脚本写入防闪烁）
export const prefs = {
  get fontScale() { return localStorage.getItem('qw_font_scale') || '3'; },
  set fontScale(v) { localStorage.setItem('qw_font_scale', v); document.documentElement.style.setProperty('--font-scale', v); },
  get motion() { return localStorage.getItem('qw_motion') || '2'; },
  set motion(v) {
    localStorage.setItem('qw_motion', v);
    document.documentElement.setAttribute('data-motion', v === '1' ? 'full' : 'lite');
  },
};

// Toast
let toastTimer = null;
export function toast(msg, kind = '') {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 260);
  }, 2200);
}

export function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = (now - d) / 86400000;
  if (diff < 1) return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (diff < 2) return '昨天';
  if (diff < 7) return `${Math.floor(diff)} 天前`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
