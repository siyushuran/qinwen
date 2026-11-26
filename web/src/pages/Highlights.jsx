import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtTime, toast } from '../api.js';
import { navigate } from '../App.jsx';

export default function Highlights() {
  const [items, setItems] = useState([]);
  const [domains, setDomains] = useState([]);
  const [q, setQ] = useState('');
  const [domainId, setDomainId] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [noteDraft, setNoteDraft] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '500' });
      if (q.trim()) params.set('q', q.trim());
      if (domainId) params.set('domain_id', domainId);
      const [hl, dm] = await Promise.all([api(`/api/highlights?${params}`), api('/api/domains')]);
      setItems(hl.items);
      setDomains(dm.domains);
    } catch (e) {
      toast(e.message || '加载失败', 'err');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [domainId]);
  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [q]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const h of items) {
      const key = h.domain_id || 0;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(h);
    }
    return [...map.entries()];
  }, [items]);

  const remove = async (id) => {
    if (!window.confirm('删除这条划线？')) return;
    try {
      await api(`/api/highlights/${id}`, { method: 'DELETE' });
      setItems(items.filter(x => x.id !== id));
      toast('已删除', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  const saveNote = async (id) => {
    try {
      const r = await api(`/api/highlights/${id}`, { method: 'PATCH', body: JSON.stringify({ note: noteDraft }) });
      setItems(items.map(x => x.id === id ? r.highlight : x));
      setEditing(null);
      toast('备注已保存', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <>
      <div className="card enter tight">
        <div className="row between">
          <div>
            <h1 className="h-lg mb8">✍️ 划线收藏</h1>
            <p className="sub">在题干、讲解、追问中选中文字即可划线，把有价值的句子收在这里</p>
          </div>
          <a className="btn sm" href="/api/highlights/export" download="highlights.md">⬇️ 导出</a>
        </div>
      </div>

      <div className="card enter-d1">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input className="input" style={{ flex: 1, minWidth: 160 }} value={q}
            placeholder="搜索划线内容、备注、题干…" onChange={e => setQ(e.target.value)} />
          <select className="input" style={{ width: 'auto' }} value={domainId} onChange={e => setDomainId(e.target.value)}>
            <option value="">全部领域</option>
            {domains.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <p className="muted small mt8">共 {items.length} 条划线</p>
      </div>

      {loading ? (
        <div className="card"><p className="muted center" style={{ padding: 30 }}>加载中<span className="dots"></span></p></div>
      ) : items.length === 0 ? (
        <div className="card center" style={{ padding: 40 }}>
          <div style={{ fontSize: '2.4em', marginBottom: 12 }}>✍️</div>
          <p className="muted">还没有划线。去答题时选中一段有价值的文字试试。</p>
          <button className="btn primary mt12" onClick={() => navigate('/')}>去练习</button>
        </div>
      ) : grouped.map(([did, list]) => {
        const d = domains.find(x => x.id === did);
        return (
          <div key={did} className="card enter">
            <div className="row between mb12">
              <strong>{d?.name || '未分类'} <span className="muted small">· {list.length} 条</span></strong>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {list.map(h => (
                <div key={h.id} className="hl-item">
                  <div className="hl-text">{h.text}</div>
                  <div className="row between mt8" style={{ gap: 8, alignItems: 'center' }}>
                    <div className="muted small" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <span>{fmtTime(h.created_at)}</span>
                      {h.node_name && (
                        <button className="linklike" onClick={() => navigate(`/learn/${h.domain_id}?node=${h.node_id}&q=${h.question_id || ''}`)}>
                          📍 {h.node_name}
                        </button>
                      )}
                      {h.source_url && <a className="linklike" href={h.source_url} target="_blank" rel="noreferrer">🔗 原文</a>}
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn ghost sm" onClick={() => { setEditing(h.id); setNoteDraft(h.note || ''); }}>备注</button>
                      <button className="btn danger sm" onClick={() => remove(h.id)}>删除</button>
                    </div>
                  </div>
                  {editing === h.id ? (
                    <div className="row mt8" style={{ gap: 8 }}>
                      <input className="input" style={{ flex: 1 }} value={noteDraft} placeholder="写下你的想法…"
                        onChange={e => setNoteDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveNote(h.id); }} />
                      <button className="btn sm" onClick={() => saveNote(h.id)}>保存</button>
                      <button className="btn ghost sm" onClick={() => setEditing(null)}>取消</button>
                    </div>
                  ) : h.note ? (
                    <div className="hl-note mt8">📝 {h.note}</div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}
