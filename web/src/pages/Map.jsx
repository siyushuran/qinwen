import React, { useEffect, useState } from 'react';
import { api, toast } from '../api.js';
import { navigate } from '../App.jsx';

function masteryColor(m) {
  if (m >= 0.8) return '#10b981';
  if (m >= 0.5) return '#6366f1';
  if (m >= 0.25) return '#f59e0b';
  return '#f43f5e';
}

export default function MapPage({ domainId }) {
  const [domain, setDomain] = useState(null);
  const [nodes, setNodes] = useState([]);

  useEffect(() => {
    api(`/api/domains/${domainId}`).then(d => { setDomain(d.domain); setNodes(d.nodes); })
      .catch(e => toast(e.message, 'err'));
  }, [domainId]);

  const facets = nodes.filter(n => !n.parent_id);

  return (
    <>
      <div className="card enter tight">
        <div className="row between">
          <div className="row" style={{ gap: 8 }}>
            <button className="btn ghost sm" onClick={() => navigate('/')}>← 领域</button>
            <strong>{domain?.name || '知识地图'}</strong>
          </div>
          <span className="muted small">总掌握度 {Math.round((domain?.overall_mastery || 0) * 100)}%</span>
        </div>
      </div>

      <div className="card enter-d1">
        <h2>🗺️ 知识地图</h2>
        <p className="sub mb12">颜色代表掌握度：绿=稳了 · 紫=渐入佳境 · 橙=刚起步 · 红=待攻坚。点节点直接出题</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {facets.map((f, i) => {
            const points = nodes.filter(n => n.parent_id === f.id);
            const avg = points.length ? points.reduce((s, p) => s + (p.mastery || 0), 0) / points.length : 0;
            return (
              <div key={f.id} className="wave-item" style={{ animationDelay: `${i * 0.06}s` }}>
                <div className="row mb8">
                  <span style={{ width: 12, height: 12, borderRadius: 4, background: masteryColor(avg), flexShrink: 0 }} />
                  <strong style={{ fontSize: '1.05em' }}>🧩 {f.name}</strong>
                  <span className="muted small">{Math.round(avg * 100)}%</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, paddingLeft: 20 }}>
                  {points.map(p => (
                    <button key={p.id} className="chip" style={{ borderColor: masteryColor(p.mastery) }}
                      onClick={() => navigate(`/learn/${domainId}`)}>
                      {p.name} · {Math.round(p.mastery * 100)}%
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <button className="btn primary block enter-d2" onClick={() => navigate(`/learn/${domainId}`)}>开始练习 →</button>
    </>
  );
}
