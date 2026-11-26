import React, { useEffect, useState } from 'react';
import { api, toast } from '../api.js';
import { navigate } from '../App.jsx';

const TAGS = ['全部', '概念不清', '计算失误', '审题偏差', '纯手滑'];

export default function Mistakes() {
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(true);
  const [tagFilter, setTagFilter] = useState('全部');

  const load = async () => {
    try {
      const res = await api('/api/mistakes');
      setData(res.mistakes);
    } catch (e) { toast(e.message, 'err'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const entries = Object.entries(data)
    .map(([name, qs]) => [name, qs.filter(q => tagFilter === '全部' || (q.error_tags || []).includes(tagFilter))])
    .filter(([, qs]) => qs.length > 0);

  return (
    <>
      <div className="card enter">
        <h2>📝 错题本</h2>
        <div className="chips mb12">
          {TAGS.map(t => (
            <button key={t} className={`chip ${tagFilter === t ? 'on' : ''}`} onClick={() => setTagFilter(t)}>{t}</button>
          ))}
        </div>
        {loading ? (
          <p className="muted">正在整理错题<span className="dots"></span></p>
        ) : entries.length === 0 ? (
          <div className="empty">
            <span className="emoji">✨</span>
            <p>{tagFilter === '全部' ? '错题本是空的' : `没有「${tagFilter}」类错题`}</p>
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
                        <div className="grow">
                          <div className="small">{q.stem}</div>
                          {(q.error_tags || []).length > 0 && (
                            <div className="muted small">错因：{q.error_tags.join(' · ')}</div>
                          )}
                        </div>
                        <button className="btn sm" onClick={() => navigate(`/learn/${q.domain_id}?node=${q.node_id}&q=${q.question_id}`)}>
                          重练这题
                        </button>
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
