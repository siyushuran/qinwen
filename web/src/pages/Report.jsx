import React, { useEffect, useState } from 'react';
import { api, toast } from '../api.js';

const RANGES = [
  { key: 'day', label: '每日', ico: '📅' },
  { key: 'month', label: '每月', ico: '📊' },
  { key: 'year', label: '每年', ico: '📆' },
];

// 作答量热力分档（GitHub 贡献图思路：颜色越深题越多）
function heat(n, max) {
  if (!n) return 'var(--surface-2)';
  const t = max > 0 ? n / max : 0;
  if (t > 0.75) return 'var(--primary)';
  if (t > 0.5) return 'rgba(99,102,241,.72)';
  if (t > 0.25) return 'rgba(99,102,241,.5)';
  return 'rgba(99,102,241,.26)';
}

function fmtDuration(ms) {
  const m = Math.round((ms || 0) / 60000);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
}

// 周期切换（胶囊分段控件，风格与应用一致）
function RangeSwitch({ value, onChange }) {
  return (
    <div style={{
      display: 'inline-flex', gap: 2, padding: 3, borderRadius: 999,
      background: 'var(--surface-2)',
    }}>
      {RANGES.map(r => (
        <button
          key={r.key}
          onClick={() => onChange(r.key)}
          style={{
            border: 'none', cursor: 'pointer', padding: '6px 18px', borderRadius: 999, fontSize: '.95em',
            background: value === r.key ? 'var(--grad)' : 'transparent',
            color: value === r.key ? '#fff' : 'var(--ink-soft)',
            boxShadow: value === r.key ? 'var(--shadow-pop)' : 'none',
            transition: 'all .2s var(--ease-out-back)',
          }}
        >
          <span>{r.ico}</span>{r.label}
        </button>
      ))}
    </div>
  );
}

// 柱状图（每月/每年题量）
function BarChart({ cells, max, labelOf }) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {cells.map((c, i) => {
        const h = max > 0 ? Math.max(c.n > 0 ? 8 : 2, (c.n / max) * 100) : 2;
        return (
          <div
            key={c.key ?? c.y}
            className="center"
            title={`${labelOf(c)}：${c.n} 题，对 ${c.ok}，${fmtDuration(c.dur)}`}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}
          >
            <span className="muted small" style={{ fontSize: '.7em', height: 14 }}>{c.n > 0 ? c.n : ''}</span>
            <div style={{ width: '100%', maxWidth: 26, height: 110, display: 'flex', alignItems: 'flex-end', margin: '4px 0' }}>
              <div style={{
                width: '100%', height: `${h}%`, borderRadius: '6px 6px 2px 2px',
                background: c.n > 0 ? 'var(--grad)' : 'var(--surface-2)',
                opacity: c.n > 0 ? .95 : .5,
                animation: `waveIn .3s var(--ease-out-back) ${i * 0.03}s both`,
              }} />
            </div>
            <span className="muted small" style={{ fontSize: '.65em' }}>{labelOf(c)}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function Report() {
  const [data, setData] = useState(null);
  const [range, setRange] = useState('day');

  useEffect(() => {
    api('/api/stats').then(setData).catch(e => toast(e.message, 'err'));
  }, []);

  if (!data) return <div className="card enter"><p className="muted center" style={{ padding: 30 }}>正在汇总数据<span className="dots"></span></p></div>;

  const today = new Date();
  const empty = data.total === 0;

  // 每日：近 30 天热力图（无作答的日子不画点）
  const dayMap = new Map(data.byDay.map(r => [r.d, r]));
  const dayCells = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(today.getTime() - (29 - i) * 86400000);
    const key = d.toISOString().slice(0, 10);
    const hit = dayMap.get(key);
    return { d, key, n: hit?.n || 0, ok: hit?.ok || 0, dur: hit?.dur || 0 };
  });
  const maxDay = Math.max(1, ...dayCells.map(c => c.n));

  // 每月：近 12 个月（零作答月份补齐，保持柱状图完整）
  const monthMap = new Map(data.byMonth.map(r => [r.m, r]));
  const monthCells = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth() - (11 - i), 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const hit = monthMap.get(key);
    return { key, label: `${d.getMonth() + 1}月`, n: hit?.n || 0, ok: hit?.ok || 0, dur: hit?.dur || 0 };
  });
  const maxMonth = Math.max(1, ...monthCells.map(c => c.n));

  // 每年：全部有记录的年份
  const yearMap = new Map(data.byYear.map(r => [r.y, r]));
  const yearCells = [...yearMap.entries()].sort().map(([y, r]) => ({ y, n: r.n, ok: r.ok, dur: r.dur }));
  const maxYear = Math.max(1, ...yearCells.map(c => c.n));

  // 当前周期汇总
  const rangeTotal = range === 'day' ? data.byDay.reduce((s, x) => s + x.n, 0)
    : range === 'month' ? data.byMonth.reduce((s, x) => s + x.n, 0) : data.total;
  const rangeOk = range === 'day' ? data.byDay.reduce((s, x) => s + x.ok, 0)
    : range === 'month' ? data.byMonth.reduce((s, x) => s + x.ok, 0) : data.correct;
  const rangeAcc = rangeTotal ? Math.round((rangeOk / rangeTotal) * 100) : 0;
  const scopeText = range === 'day' ? '近 30 天' : range === 'month' ? '近 12 个月' : '累计';

  return (
    <>
      <div className="card enter">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <h2 style={{ margin: 0 }}>📈 学习报告</h2>
          <RangeSwitch value={range} onChange={setRange} />
        </div>
        <p className="sub mb12">{scopeText}真实作答数据，没有作答的日子不会画点</p>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div className="stat" style={{ flex: 1, minWidth: 80 }}>
            <div className="num">{rangeTotal}</div><div className="label">{scopeText}作答</div>
          </div>
          <div className="stat" style={{ flex: 1, minWidth: 80 }}>
            <div className="num">{rangeAcc}%</div><div className="label">正确率</div>
          </div>
          <div className="stat" style={{ flex: 1, minWidth: 80 }}>
            <div className="num">🔥{data.streak}</div><div className="label">连续打卡</div>
          </div>
          <div className="stat" style={{ flex: 1, minWidth: 80 }}>
            <div className="num">{data.daysActive}</div><div className="label">累计天数</div>
          </div>
          <div className="stat" style={{ flex: 1, minWidth: 80 }}>
            <div className="num" style={{ fontSize: '1.25em' }}>{fmtDuration(data.totalMs)}</div><div className="label">累计时长</div>
          </div>
        </div>
      </div>

      <div className="card enter-d1">
        {range === 'day' ? (
          <>
            <h2>📅 每日热力（近 30 天）</h2>
            {empty ? <p className="muted center" style={{ padding: 20 }}>还没有练习数据，去做第一道题吧～</p> : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 6 }}>
                {dayCells.map((c, i) => (
                  <div key={i} className="center" title={`${c.key}：${c.n} 题 · 对 ${c.ok} · ${fmtDuration(c.dur)}`}>
                    <div style={{
                      width: '100%', aspectRatio: '1', borderRadius: 6,
                      background: heat(c.n, maxDay),
                      opacity: c.n === 0 ? .5 : .95,
                      animation: `waveIn .3s var(--ease-out-back) ${i * 0.02}s both`,
                    }} />
                    <div className="muted small" style={{ fontSize: '.65em' }}>{c.d.getDate()}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : range === 'month' ? (
          <>
            <h2>📊 每月题量（近 12 个月）</h2>
            {empty ? <p className="muted center" style={{ padding: 20 }}>还没有练习数据，去做第一道题吧～</p> : (
              <BarChart cells={monthCells} max={maxMonth} labelOf={c => c.label} />
            )}
          </>
        ) : (
          <>
            <h2>📆 每年题量</h2>
            {empty ? <p className="muted center" style={{ padding: 20 }}>还没有练习数据，去做第一道题吧～</p> : (
              <BarChart cells={yearCells} max={maxYear} labelOf={c => `${c.y}年`} />
            )}
          </>
        )}
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
