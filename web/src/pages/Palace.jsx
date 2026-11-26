import React, { useEffect, useState } from 'react';
import { api, toast } from '../api.js';
import { navigate } from '../App.jsx';

export default function Palace() {
  const [cards, setCards] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [materialId, setMaterialId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [revealed, setRevealed] = useState({});

  const load = async () => {
    try {
      const [c, m] = await Promise.all([api('/api/memory-cards'), api('/api/materials')]);
      setCards(c.cards || []);
      setMaterials(m.materials || []);
    } catch (e) { toast(e.message, 'err'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const generate = async (payload, which) => {
    setBusy(which);
    try {
      const r = await api('/api/memory-cards/generate', { method: 'POST', body: JSON.stringify(payload) });
      toast(r.generated ? `已生成 ${r.generated} 张卡片` : (r.reused ? '已有卡片，未重复生成' : '暂无可生成卡片的知识点'), r.generated ? 'ok' : '');
      await load();
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(''); }
  };

  const review = async (card, remembered) => {
    try {
      const r = await api(`/api/memory-cards/${card.id}/review`, { method: 'POST', body: JSON.stringify({ remembered }) });
      toast(`${remembered ? '已记住' : '明天再练'} · 下次复习 ${r.interval_days} 天后`, 'ok');
      await load();
    } catch (e) { toast(e.message, 'err'); }
  };

  const isDue = c => !c.due_at || new Date(c.due_at) <= new Date();

  return (
    <>
      <div className="card enter">
        <div className="row between">
          <h2>🏛️ 记忆宫殿</h2>
          <button className="btn ghost sm" onClick={() => navigate('/review')}>← 复习</button>
        </div>
        <p className="sub mb12">一个知识点一间房：先看位置与线索自己回忆，再揭示答案并自评。自评会同步到间隔复习。</p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn sm" disabled={!!busy} onClick={() => generate({}, 'due')}>
            {busy === 'due' ? '生成中…' : '为到期知识点生成'}
          </button>
          <span className="row" style={{ gap: 6 }}>
            <select className="input" style={{ width: 'auto', maxWidth: 180 }} value={materialId} onChange={e => setMaterialId(e.target.value)}>
              <option value="">选择资料…</option>
              {materials.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}
            </select>
            <button className="btn sm" disabled={!!busy || !materialId} onClick={() => generate({ material_id: Number(materialId), count: 5 }, 'material')}>
              {busy === 'material' ? '生成中…' : '按资料生成'}
            </button>
          </span>
        </div>
      </div>

      {loading ? (
        <div className="card enter"><p className="muted center" style={{ padding: 24 }}>正在读取卡片<span className="dots"></span></p></div>
      ) : cards.length === 0 ? (
        <div className="card enter"><div className="empty"><span className="emoji">🏛️</span><p>还没有记忆卡片</p><p className="muted small">到复习页攒几个到期知识点，或从一篇资料生成</p></div></div>
      ) : cards.map((c, i) => (
        <div key={c.id} className="card room-card enter" style={{ animationDelay: `${Math.min(i, 8) * 0.05}s` }}>
          <div className="row between mb8">
            <div className="row" style={{ gap: 8 }}>
              <span className="chip">{c.room}</span>
              {isDue(c) ? <span className="chip on">待复习</span> : <span className="muted small">{new Date(c.due_at).toLocaleDateString()} 后到期</span>}
            </div>
            <button className="btn ghost sm" onClick={() => navigate(`/learn/${c.domain_id}?node=${c.node_id}`)}>去练习</button>
          </div>
          <p className="small muted">{c.domain_name || '领域'} · {c.node_name}</p>
          {c.hook && <p className="mt8" style={{ lineHeight: 1.7 }}>🪑 意象：{c.hook}</p>}
          <p style={{ lineHeight: 1.7 }}>🔎 自测：{c.cue}</p>
          {revealed[c.id] ? (
            <>
              <p className="answer-reveal enter" style={{ lineHeight: 1.7 }}>💡 {c.answer}</p>
              <div className="row mt12" style={{ gap: 8 }}>
                <button className="btn primary grow" onClick={() => review(c, true)}>记住了</button>
                <button className="btn grow" onClick={() => review(c, false)}>还没记住</button>
              </div>
            </>
          ) : (
            <button className="btn block mt12" onClick={() => setRevealed({ ...revealed, [c.id]: true })}>揭示答案</button>
          )}
        </div>
      ))}
    </>
  );
}
