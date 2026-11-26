import React, { useEffect, useRef, useState } from 'react';
import { api, streamMaterialChat, toast } from '../api.js';
import { navigate } from '../App.jsx';
import Highlightable from '../components/Highlightable.jsx';

export default function MaterialDetail({ materialId }) {
  const [material, setMaterial] = useState(null);
  const [chunks, setChunks] = useState([]);
  const [summary, setSummary] = useState(null);
  const [highlights, setHighlights] = useState([]);
  const [chat, setChat] = useState([]);
  const [sources, setSources] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [busy, setBusy] = useState('');
  const [count, setCount] = useState(6);
  const chatEnd = useRef(null);

  const loadHighlights = async () => {
    try {
      const r = await api('/api/highlights?limit=500');
      setHighlights(r.items || []);
    } catch { /* 划线失败不影响阅读 */ }
  };
  const load = async () => {
    try {
      const r = await api(`/api/materials/${materialId}`);
      setMaterial(r.material);
      setChunks(r.chunks || []);
      if (r.material.summary) {
        try { setSummary(JSON.parse(r.material.summary)); } catch { /* 摘要格式异常则重新生成 */ }
      }
    } catch (e) { toast(e.message, 'err'); }
  };
  useEffect(() => { load(); loadHighlights(); }, [materialId]);
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [chat]);

  const hlFor = (source, text, chunkId) => highlights.filter(h =>
    h.material_id === Number(materialId) && h.chunk_id === chunkId && h.source === source && text && h.text && text.includes(h.text));
  const meta = (source, chunkId) => ({ source, material_id: Number(materialId), chunk_id: chunkId || null, domain_id: material?.domain_id || null });
  const onHlAdded = item => setHighlights(prev => [item, ...prev]);

  const genSummary = async () => {
    setBusy('summary');
    try {
      const r = await api(`/api/materials/${materialId}/summary`, { method: 'POST' });
      setSummary(r.summary);
      toast(r.cached ? '已有摘要' : '摘要已生成', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(''); }
  };
  const build = async () => {
    setBusy('build');
    try {
      const r = await api(`/api/materials/${materialId}/build`, { method: 'POST', body: JSON.stringify({ domain_name: material.title, level: '没学过' }) });
      toast('知识清单已生成', 'ok');
      navigate(`/building/${r.domain_id}`);
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(''); }
  };
  const genQuestions = async () => {
    setBusy('questions');
    try {
      const r = await api(`/api/materials/${materialId}/questions`, { method: 'POST', body: JSON.stringify({ count: Number(count), difficulty: 1 }) });
      toast(`已生成 ${r.created} 道题${r.failed ? `，${r.failed} 道失败` : ''}`, r.created ? 'ok' : 'err');
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(''); }
  };
  const send = async () => {
    const q = input.trim();
    if (!q || streaming) return;
    const next = [...chat, { role: 'user', content: q }];
    setChat(next); setInput(''); setStreaming(true); setSources([]);
    let acc = '';
    await streamMaterialChat(materialId, { content: q, history: chat },
      list => setSources(list),
      delta => { acc += delta; setChat([...next, { role: 'assistant', content: acc }]); },
      () => setStreaming(false),
      e => { setStreaming(false); toast(`问答失败：${e.message}`, 'err'); });
  };

  if (!material) return <div className="card enter"><p className="muted center" style={{ padding: 30 }}>正在载入资料<span className="dots"></span></p></div>;

  return (
    <>
      <div className="card enter tight">
        <div className="row between">
          <div className="row" style={{ gap: 8 }}>
            <button className="btn ghost sm" onClick={() => navigate('/materials')}>← 资料</button>
            <strong>{material.title}</strong>
          </div>
          {material.domain_id && <button className="btn ghost sm" onClick={() => navigate(`/learn/${material.domain_id}`)}>去练习</button>}
        </div>
        {material.source_url && <div className="muted small mt8" style={{ wordBreak: 'break-all' }}>原文：{material.source_url}</div>}
      </div>

      <div className="card enter-d1">
        <div className="row between">
          <h2>⚡ 一键学习</h2>
          <span className="muted small">{chunks.length} 块 · {material.claim_policy === 'article_claim' ? '文章声称口径' : '资料口径'}</span>
        </div>
        <div className="row mt12" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={genSummary} disabled={!!busy}>{busy === 'summary' ? '生成中…' : '生成摘要'}</button>
          <button className="btn sm" onClick={build} disabled={!!busy}>{busy === 'build' ? '拆解中…' : '按资料拆清单'}</button>
          <span className="row" style={{ gap: 6 }}>
            <input className="input" style={{ width: 70, padding: '8px' }} type="number" min={1} max={20} value={count}
              onChange={e => setCount(e.target.value)} />
            <button className="btn sm" onClick={genQuestions} disabled={!!busy || !material.domain_id}>
              {busy === 'questions' ? '出题中…' : '生成题目'}
            </button>
          </span>
        </div>
        {!material.domain_id && <p className="muted small mt8">先「按资料拆清单」创建领域，才能生成题目。</p>}
      </div>

      {summary && (
        <div className="card enter">
          <h2>📌 极简速查</h2>
          <p style={{ lineHeight: 1.7 }}>{summary.one_line}</p>
          {summary.points?.length > 0 && (
            <>
              <p className="small" style={{ fontWeight: 600 }}>要点</p>
              <ul>{summary.points.map((p, i) => <li key={i} className="small" style={{ lineHeight: 1.7 }}>{p}</li>)}</ul>
            </>
          )}
          {summary.timeline?.length > 0 && (
            <>
              <p className="small mt12" style={{ fontWeight: 600 }}>时间线 / 步骤</p>
              <ul>{summary.timeline.map((t, i) => <li key={i} className="small" style={{ lineHeight: 1.7 }}>{t}</li>)}</ul>
            </>
          )}
          <p className="muted small">摘要由模型生成，争议内容按「文章称」处理，请对照原文。</p>
        </div>
      )}

      <div className="card enter">
        <h2>💬 问这篇资料</h2>
        {sources.length > 0 && (
          <div className="chips mb8">
            {sources.map(s => (
              <span key={s.id} className="chip" title={s.heading}>
                [{s.idx}] {s.heading.slice(0, 14)}{s.claim_status === 'article_claim' ? ' · 文章称' : ''}
              </span>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto', padding: 2 }}>
          {chat.length === 0 && <p className="muted small">试试问：「第一步到底在解决什么问题？」</p>}
          {chat.map((c, i) => c.role === 'assistant' ? (
            <Highlightable key={i} text={c.content} highlights={hlFor('chat', c.content, sources[0]?.id)}
              meta={meta('chat', sources[0]?.id)} onAdded={onHlAdded} className={`chat-line ${c.role}`} />
          ) : <div key={i} className={`chat-line ${c.role}`}>{c.content}</div>)}
          {streaming && <div className="chat-line assistant">{input || '正在翻资料'}<span className="dots"></span></div>}
          <div ref={chatEnd} />
        </div>
        <div className="row mt12" style={{ gap: 8 }}>
          <input className="input" style={{ flex: 1 }} value={input} onChange={e => setInput(e.target.value)}
            placeholder="针对这篇资料问点什么…" onKeyDown={e => { if (e.key === 'Enter') send(); }} disabled={streaming} />
          <button className="btn primary" onClick={send} disabled={streaming || !input.trim()}>发送</button>
        </div>
      </div>

      <div className="card enter-d2">
        <h2>📖 原文片段</h2>
        {chunks.map(c => (
          <details key={c.id} className="wave-item" style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
            <summary style={{ cursor: 'pointer' }}>
              <span className="muted small">[{c.idx}]</span> <strong>{c.heading}</strong>
              <span className="muted small"> · {c.content.length} 字{c.claim_status === 'article_claim' ? ' · 文章声称' : ''}</span>
            </summary>
            <Highlightable text={c.content} highlights={hlFor('chunk', c.content, c.id)}
              meta={meta('chunk', c.id)} onAdded={onHlAdded}
              style={{ marginTop: 10, whiteSpace: 'pre-wrap', lineHeight: 1.75, fontSize: '.94em' }} />
          </details>
        ))}
      </div>
    </>
  );
}
