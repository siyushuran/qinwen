import React, { useEffect, useState } from 'react';
import { api, toast } from '../api.js';
import { navigate } from '../App.jsx';

export default function Review() {
  const [due, setDue] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const data = await api('/api/review');
      setDue(data.due);
    } catch (e) { toast(e.message, 'err'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  return (
    <>
      <div className="card enter pulse-ring">
        <h2>🔁 今日复习</h2>
        {loading ? (
          <p className="muted">正在查看到期清单<span className="dots"></span></p>
        ) : due.length === 0 ? (
          <div className="empty">
            <span className="emoji">🍃</span>
            <p>今天没有到期的复习点</p>
            <p className="muted small">去练几个新点，或做一轮练习攒点复习</p>
          </div>
        ) : (
          <>
            <p className="sub mb12">{due.length} 个知识点到期，练一轮就把它们巩固掉</p>
            <ul style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {due.map((n, i) => (
                <li key={n.id} className="map-node wave-item" style={{ animationDelay: `${i * 0.06}s`, cursor: 'pointer' }}
                  onClick={() => navigate(`/learn/${n.domain_id}?node=${n.id}`)}>
                  <span style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />
                  <div className="grow">
                    <strong>{n.name}</strong>
                    <div className="muted small">到期 · 当前掌握 {Math.round(n.mastery * 100)}%</div>
                  </div>
                  <span className="btn sm primary">去练习</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="card enter-d1">
        <div className="row between">
          <div>
            <strong>💡 复习是怎么安排的</strong>
            <p className="muted small mt8">答对 → 间隔自动拉长（明天→数天后）；答错 → 明天重新练。掌握度按认知点单独记录，随时进出。</p>
          </div>
        </div>
      </div>
    </>
  );
}
