import React, { useEffect, useState } from 'react';
import { api, toast } from '../api.js';
import { navigate } from '../App.jsx';

export default function Mistakes() {
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const res = await api('/api/mistakes');
      setData(res.mistakes);
    } catch (e) { toast(e.message, 'err'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const entries = Object.entries(data);

  return (
    <>
      <div className="card enter">
        <h2>📝 错题本</h2>
        {loading ? (
          <p className="muted">正在整理错题<span className="dots"></span></p>
        ) : entries.length === 0 ? (
          <div className="empty">
            <span className="emoji">✨</span>
            <p>错题本是空的</p>
            <p className="muted small">答错的题会自动进来，答稳后自动移出——它不是只增不减的账本</p>
          </div>
        ) : (
          <>
            <p className="sub mb12">按知识点聚类。点「去练习」答稳这道题后，它会从清单里消失</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {entries.map(([nodeName, qs], i) => (
                <div key={nodeName} className="wave-item" style={{ animationDelay: `${i * 0.06}s` }}>
                  <div className="row between mb8">
                    <strong>🎯 {nodeName}</strong>
                    <span className="muted small">{qs.length} 题待巩固</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {qs.map(q => (
                      <div key={q.question_id} className="map-node">
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--err)', flexShrink: 0 }} />
                        <span className="grow small">{q.stem}</span>
                        <span className="btn sm" onClick={() => navigate('/review')}>去练习</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
