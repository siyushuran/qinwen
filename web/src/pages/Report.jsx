import React, { useEffect, useState } from 'react';
import { api, toast } from '../api.js';

export default function Report() {
  const [data, setData] = useState(null);

  useEffect(() => {
    // getTimezoneOffset 与本地偏移符号相反，取负后传给后端按本地日聚合
    const tz = -new Date().getTimezoneOffset();
    api(`/api/report?days=30&tz=${tz}`).then(setData).catch(e => toast(e.message, 'err'));
  }, []);

  if (!data) return <div className="card enter"><p className="muted center" style={{ padding: 30 }}>正在汇总数据<span className="dots"></span></p></div>;

  // 真实作答日历：无作答的日子不画点
  const days = data.byDay;
  const maxDay = Math.max(1, ...days.map(d => d.n));
  const today = new Date();
  const monthDays = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(today.getTime() - (29 - i) * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const hit = days.find(x => x.d === key);
    return { d, key, n: hit?.n || 0, ok: hit?.ok || 0 };
  });

  return (
    <>
      <div className="card enter">
        <h2>📈 学习报告</h2>
        <p className="sub mb12">近 {data.days} 天真实作答数据，没有作答的日子不会画点</p>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div className="stat" style={{ flex: 1, minWidth: 90 }}>
            <div className="num">{data.total}</div><div className="label">总作答</div>
          </div>
          <div className="stat" style={{ flex: 1, minWidth: 90 }}>
            <div className="num">{data.accuracy}%</div><div className="label">正确率</div>
          </div>
          <div className="stat" style={{ flex: 1, minWidth: 90 }}>
            <div className="num">{data.days}</div><div className="label">统计天数</div>
          </div>
        </div>
      </div>

      <div className="card enter-d1">
        <h2>📅 近 30 天</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 6 }}>
          {monthDays.map((d, i) => (
            <div key={i} className="center" title={`${d.key}：${d.n} 题，对 ${d.ok}`}>
              <div style={{
                width: '100%', aspectRatio: '1', borderRadius: 6,
                background: d.n === 0 ? 'var(--surface-2)' : d.ok / d.n >= 0.5 ? 'var(--primary)' : 'var(--err)',
                opacity: d.n === 0 ? .5 : .95,
                animation: `waveIn .3s var(--ease-out-back) ${i * 0.02}s both`,
              }} />
              <div className="muted small" style={{ fontSize: '.65em' }}>{d.d.getDate()}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card enter-d2">
        <h2>📊 各领域掌握度</h2>
        {data.domains.length === 0 ? (
          <p className="muted">还没有练习数据</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {data.domains.map((d, i) => (
              <div key={d.name} className="wave-item" style={{ animationDelay: `${i * 0.06}s` }}>
                <div className="row mb8">
                  <strong>{d.name}</strong>
                  <span className="muted small">{Math.round(d.overall_mastery * 100)}%</span>
                </div>
                <div style={{ height: 10, borderRadius: 999, background: 'var(--surface-2)', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', width: `${d.overall_mastery * 100}%`, borderRadius: 999, background: 'var(--grad)',
                    transition: 'width .5s var(--ease-soft)',
                  }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
