import React, { useEffect, useState } from 'react';
import { api, fmtTime, toast } from '../api.js';
import { navigate } from '../App.jsx';

export default function Home() {
  const [domains, setDomains] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const data = await api('/api/domains');
      setDomains(data.domains);
    } catch (e) { toast(e.message, 'err'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const remove = async (id, name) => {
    if (!confirm(`确定删除领域「${name}」？该领域的全部练习数据将一并清除，不可恢复。`)) return;
    try {
      await api(`/api/domains/${id}`, { method: 'DELETE' });
      toast('已删除', 'ok');
      load();
    } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <>
      <div className="card enter pulse-ring" style={{ background: 'var(--grad)', border: 'none', color: '#fff' }}>
        <div className="row between">
          <div>
            <h2 style={{ color: '#fff' }}>今日练什么</h2>
            <p className="small" style={{ color: 'rgba(255,255,255,.85)' }}>点开一个领域，或新建一个想学的领域</p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm" style={{ background: 'rgba(255,255,255,.2)', color: '#fff', border: 'none' }}
              onClick={() => navigate('/materials')}>📄 导入资料</button>
            <button className="btn" style={{ background: 'rgba(255,255,255,.2)', color: '#fff', border: 'none', backdropFilter: 'blur(4px)' }}
              onClick={() => navigate('/domains/new')}>＋ 新领域</button>
          </div>
        </div>
      </div>

      <div className="card enter-d1">
        <h2>📘 我的领域</h2>
        {loading ? (
          <p className="muted center" style={{ padding: 20 }}>正在整理<span className="dots"></span></p>
        ) : domains.length === 0 ? (
          <div className="empty">
            <span className="emoji">🌱</span>
            <p>还没有领域，先建第一个吧</p>
            <button className="btn primary" onClick={() => navigate('/domains/new')}>创建第一个领域</button>
          </div>
        ) : (
          <ul style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {domains.map((d, i) => (
              <li key={d.id} className="map-node wave-item" style={{ animationDelay: `${i * 0.06}s`, cursor: 'pointer' }}
                onClick={() => navigate(`/learn/${d.id}`)}>
                <div className="ring" style={{ ['--p']: Math.round(d.overall_mastery * 100) }}>
                  <b>{Math.round(d.overall_mastery * 100)}%</b>
                </div>
                <div className="grow">
                  <div className="row" style={{ gap: 8 }}>
                    <strong>{d.name}</strong>
                    {d.due_count > 0 && <span className="chip on" style={{ padding: '2px 10px', fontSize: '.75em' }}>待复习 {d.due_count}</span>}
                  </div>
                  <div className="muted small">{fmtTime(d.created_at)}创建 · 点击开始练习</div>
                </div>
                <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); navigate(`/map/${d.id}`); }}>地图</button>
                <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); remove(d.id, d.name); }}>删除</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {domains.some(d => d.due_count > 0) && (
        <div className="card enter-d2" style={{ cursor: 'pointer' }} onClick={() => navigate('/review')}>
          <div className="row between">
            <div>
              <strong>🔁 有 {domains.reduce((s, d) => s + d.due_count, 0)} 个知识点到期了</strong>
              <div className="muted small">复习是巩固的关键，趁热打铁</div>
            </div>
            <span className="btn sm">去复习</span>
          </div>
        </div>
      )}
    </>
  );
}
