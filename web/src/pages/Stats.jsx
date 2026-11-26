import React, { useEffect, useState } from 'react';
import { api, toast } from '../api.js';
import { navigate } from '../App.jsx';

// 热力图分档：按当日题数映射 5 级色块（0 空档 + 4 级浓度，GitHub 贡献墙常用做法）
const HEAT = [
  'var(--surface-2)',
  'color-mix(in srgb, var(--primary) 30%, var(--surface-2))',
  'color-mix(in srgb, var(--primary) 55%, var(--surface-2))',
  'color-mix(in srgb, var(--primary) 78%, var(--surface-2))',
  'var(--primary)',
];
function heatLevel(n, max) {
  if (n <= 0) return 0;
  if (max <= 0) return 1;
  const t = n / max;
  if (t >= 0.8) return 4;
  if (t >= 0.55) return 3;
  if (t >= 0.3) return 2;
  return 1;
}

const pad = (x) => String(x).padStart(2, '0');
const fmtKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export default function Stats() {
  const [data, setData] = useState(null);
  const [detailLimit, setDetailLimit] = useState(14);

  useEffect(() => {
    // getTimezoneOffset 与本地偏移符号相反，取负后传给后端按本地日聚合
    const tz = -new Date().getTimezoneOffset();
    api(`/api/stats?tz=${tz}`).then(setData).catch(e => toast(e.message, 'err'));
  }, []);

  if (!data) return <div className="card enter"><p className="muted center" style={{ padding: 30 }}>正在汇总数据<span className="dots"></span></p></div>;

  const { by_day: days, by_month: months, by_year: years } = data;

  // ---------- 每日热力图：近 90 天，按周分列（周一开头，对齐 GitHub 贡献墙布局） ----------
  const today = new Date();
  const heatMax = Math.max(1, ...days.map(d => d.n));
  const heat = [];
  let cursor = new Date(today.getTime() - 89 * 86400000);
  cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7)); // 回退到本周周一
  while (cursor <= today) {
    const key = fmtKey(cursor);
    const hit = days.find(x => x.d === key);
    heat.push({ key, n: hit?.n || 0, ok: hit?.ok || 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  // ---------- 每月柱状图：近 12 个月 ----------
  const monthMax = Math.max(1, ...months.map(m => m.n));
  const monthCells = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth() - (11 - i), 1);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    const hit = months.find(m => m.m === key);
    return { key, label: `${d.getMonth() + 1}月`, n: hit?.n || 0, ok: hit?.ok || 0 };
  });

  return (
    <>
      <div className="card enter">
        <h2>📊 做题统计</h2>
        <p className="sub mb12">
          从 {data.first_day || '—'} 开始的累计数据，按本地日期统计
        </p>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div className="stat" style={{ flex: 1, minWidth: 80 }}>
            <div className="num">{data.total}</div><div className="label">总做题</div>
          </div>
          <div className="stat" style={{ flex: 1, minWidth: 80 }}>
            <div className="num">{data.accuracy}%</div><div className="label">正确率</div>
          </div>
          <div className="stat" style={{ flex: 1, minWidth: 80 }}>
            <div className="num">{data.streak}<span className="small" style={{ fontSize: '.55em' }}> 天</span></div>
            <div className="label">连续打卡</div>
          </div>
          <div className="stat" style={{ flex: 1, minWidth: 80 }}>
            <div className="num">{data.best_streak}<span className="small" style={{ fontSize: '.55em' }}> 天</span></div>
            <div className="label">最长连击</div>
          </div>
          <div className="stat" style={{ flex: 1, minWidth: 80 }}>
            <div className="num">{data.active_days}</div><div className="label">有做题的天数</div>
          </div>
        </div>
      </div>

      <div className="card enter-d1">
        <h2>🔥 每日热力图（近 90 天）</h2>
        <p className="sub mb12">颜色越深当天做题越多，悬停可看当日明细</p>
        <div style={{
          display: 'grid', gridTemplateRows: 'repeat(7, 1fr)',
          gridAutoFlow: 'column', gridAutoColumns: '15px', gap: 4, overflowX: 'auto',
        }}>
          {heat.map(h => (
            <div key={h.key} className="center" title={`${h.key}：${h.n} 题，对 ${h.ok}`} style={{ animation: `waveIn .3s var(--ease-out-back) both` }}>
              <div style={{
                width: '100%', aspectRatio: '1', borderRadius: 4,
                background: HEAT[heatLevel(h.n, heatMax)],
                opacity: h.n === 0 ? .35 : .95,
              }} />
            </div>
          ))}
        </div>
        <div className="row mt12" style={{ gap: 12, fontSize: '.75em' }}>
          <span className="muted">少</span>
          {HEAT.map((c, i) => (
            <span key={i} style={{ width: 12, height: 12, borderRadius: 4, background: c, opacity: i === 0 ? .35 : .95, display: 'inline-block' }} />
          ))}
          <span className="muted">多</span>
        </div>
      </div>

      <div className="card enter-d2">
        <h2>📋 每日明细</h2>
        <p className="sub mb12">按本地日期倒序列出每一天的做题量、答对数与正确率</p>
        {days.length === 0 ? (
          <p className="muted">还没有做题记录</p>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[...days].reverse().slice(0, detailLimit).map((d, i) => {
                const [, m, dd] = d.d.split('-');
                const week = ['日', '一', '二', '三', '四', '五', '六'][new Date(Number(d.d.slice(0, 4)), Number(m) - 1, Number(dd)).getDay()];
                const rate = d.n ? Math.round((d.ok / d.n) * 100) : 0;
                return (
                  <div key={d.d} className="wave-item" style={{
                    animationDelay: `${Math.min(i, 12) * 0.03}s`,
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--surface-2)',
                  }}>
                    <div style={{ width: 62, flexShrink: 0 }}>
                      <strong style={{ fontSize: '.95em' }}>{Number(m)}/{Number(dd)}</strong>
                      <div className="muted small" style={{ fontSize: '.7em' }}>周{week}</div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: '1.05em' }}>{d.n} <span className="muted small" style={{ fontWeight: 400 }}>题</span></div>
                      <div style={{ height: 5, borderRadius: 999, background: 'var(--line)', marginTop: 5, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${rate}%`, background: rate >= 60 ? 'var(--grad)' : 'var(--err)', borderRadius: 999 }} />
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div className="small" style={{ color: rate >= 60 ? 'var(--ok)' : 'var(--err)', fontWeight: 600 }}>{rate}%</div>
                      <div className="muted small" style={{ fontSize: '.7em' }}>对 {d.ok}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            {days.length > detailLimit && (
              <button className="btn sm block mt12" onClick={() => setDetailLimit(v => v + 30)}>
                显示更多（还有 {days.length - detailLimit} 天）
              </button>
            )}
          </>
        )}
      </div>

      <div className="card enter-d2">
        <h2>🎯 最该补的知识点</h2>
        <p className="sub mb12">按累计正确率排序（至少 2 次作答），点条目直接去练</p>
        {(data.weak_nodes || []).length === 0 ? (
          <p className="muted">还没有足够数据，答满 2 题后开始生成</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.weak_nodes.map((w, i) => (
              <div key={w.node_id} className="wave-item" role="button" tabIndex={0}
                style={{
                  animationDelay: `${i * 0.04}s`, cursor: 'pointer',
                  padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--surface-2)',
                }}
                onClick={() => navigate(`/learn/${w.domain_id}?node=${w.node_id}`)}
                onKeyDown={e => { if (e.key === 'Enter') navigate(`/learn/${w.domain_id}?node=${w.node_id}`); }}>
                <div className="row between" style={{ gap: 8 }}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <strong>{w.node_name}</strong>
                    <div className="muted small">{w.domain_name} · {w.attempts} 题 · 近 7 天错 {w.recent_wrong} 次</div>
                  </div>
                  <span className="small" style={{ color: w.rate >= 60 ? 'var(--ok)' : 'var(--err)', fontWeight: 700 }}>{w.rate}%</span>
                </div>
                <div style={{ height: 5, borderRadius: 999, background: 'var(--line)', marginTop: 6, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${w.rate}%`, background: w.rate >= 60 ? 'var(--grad)' : 'var(--err)' }} />
                </div>
                {w.top_tags.length > 0 && (
                  <div className="chips mt8">
                    {w.top_tags.map(t => <span key={t.tag} className="chip">{t.tag} ×{t.count}</span>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card enter-d2">
        <h2>📈 每月做题量（近 12 个月）</h2>
        {monthCells.every(m => m.n === 0) ? (
          <p className="muted">近 12 个月还没有做题记录</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 8, alignItems: 'end', height: 150 }}>
            {monthCells.map((m, i) => (
              <div key={m.key} className="center" title={`${m.key}：${m.n} 题，对 ${m.ok}`}
                style={{ animation: `waveIn .3s var(--ease-out-back) ${i * 0.03}s both` }}>
                <div style={{
                  width: '70%', maxWidth: 26, minHeight: 3, borderRadius: 5,
                  height: `${Math.max(4, (m.n / monthMax) * 100)}%`,
                  background: m.ok / Math.max(1, m.n) >= 0.5 ? 'var(--grad)' : 'var(--err)',
                  transition: 'height .5s var(--ease-soft)',
                }} />
                <div className="muted small" style={{ marginTop: 6, fontSize: '.7em' }}>{m.label}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card enter-d2">
        <h2>🗓 每年汇总</h2>
        {years.length === 0 ? (
          <p className="muted">还没有做题数据</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[...years].reverse().map((y, i) => (
              <div key={y.y} className="wave-item" style={{ animationDelay: `${i * 0.05}s` }}>
                <div className="row mb8">
                  <strong>{y.y} 年</strong>
                  <span className="muted small">
                    {y.n} 题 · 正确率 {y.n ? Math.round((y.ok / y.n) * 100) : 0}%
                  </span>
                </div>
                <div style={{ height: 10, borderRadius: 999, background: 'var(--surface-2)', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', width: `${monthMax && y.n ? Math.min(100, (y.n / Math.max(1, ...years.map(t => t.n))) * 100) : 0}%`,
                    borderRadius: 999, background: 'var(--grad)',
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
