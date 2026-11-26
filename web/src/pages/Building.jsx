import React, { useEffect, useState } from 'react';
import { api, toast } from '../api.js';
import { navigate } from '../App.jsx';

const STEPS = [
  { key: 'read', label: '正在读懂你的领域' },
  { key: 'split', label: '正在拆分知识面' },
  { key: 'points', label: '正在整理知识点' },
  { key: 'done', label: '清单已就绪' },
];

export default function Building({ domainId }) {
  const [phase, setPhase] = useState('loading'); // loading | building | ready | error
  const [domain, setDomain] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [stepIdx, setStepIdx] = useState(0);
  const [newPoint, setNewPoint] = useState({});
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await api(`/api/domains/${domainId}`);
        if (!alive) return;
        setDomain(data.domain);
        if (data.nodes.length > 0) {
          setNodes(data.nodes);
          setPhase('ready');
        } else {
          setPhase('building');
          // 拟人化构建过程：逐步推进进度
          const timers = [400, 1300, 2200];
          timers.forEach((t, i) => setTimeout(() => alive && setStepIdx(i + 1), t));
          try {
            const res = await api(`/api/domains/${domainId}/build`, {
              method: 'POST',
              body: JSON.stringify({ domain_name: data.domain.name, level: data.domain.level || '' }),
            });
            if (!alive) return;
            setNodes(res.nodes);
            setStepIdx(STEPS.length);
            setPhase('ready');
          } catch (e) {
            if (!alive) return;
            setPhase('error');
            toast(e.message, 'err');
          }
        }
      } catch (e) {
        if (alive) { setPhase('error'); toast(e.message, 'err'); }
      }
    })();
    return () => { alive = false; };
  }, [domainId, retry]);

  // 同路由重试必须真的重新执行构建，单纯 navigate 到当前 hash 不会触发刷新
  const retryBuild = () => { setPhase('building'); setStepIdx(0); setRetry(n => n + 1); };

  const facets = nodes.filter(n => !n.parent_id);
  const addPoint = async (facetId) => {
    const name = (newPoint[facetId] || '').trim();
    if (!name) return toast('输入知识点名称', 'err');
    try {
      await api('/api/nodes', { method: 'POST', body: JSON.stringify({ domain_id: Number(domainId), parent_id: facetId, name }) });
      setNewPoint({ ...newPoint, [facetId]: '' });
      const data = await api(`/api/domains/${domainId}`);
      setNodes(data.nodes);
      toast('已添加', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  const removeNode = async (id) => {
    if (!confirm('删除该节点？相关练习记录也会清除。')) return;
    try {
      await api(`/api/nodes/${id}`, { method: 'DELETE' });
      const data = await api(`/api/domains/${domainId}`);
      setNodes(data.nodes);
      toast('已删除', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  if (phase === 'loading' || phase === 'building') {
    return (
      <div className="card enter pulse-ring">
        <h2>🧱 构建知识清单</h2>
        <p className="sub mb12">正在为「{domain?.name || '你的领域'}」搭建学习地图</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '6px 2px' }}>
          {STEPS.map((s, i) => (
            <div key={s.key} className="row"
              style={{ opacity: stepIdx >= i + 1 ? 1 : .35, transition: 'opacity .3s' }}>
              <span key={`step-${i}-${stepIdx >= i + 1 ? 'done' : 'todo'}`} style={{
                width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                display: 'grid', placeItems: 'center', fontSize: '.8em',
                background: stepIdx >= i + 1 ? 'var(--grad)' : 'var(--line)',
                color: stepIdx >= i + 1 ? '#fff' : 'var(--ink-mute)',
                transition: 'background .3s var(--ease-soft), color .3s var(--ease-soft)',
                animation: stepIdx >= i + 1 ? 'badgePop .38s var(--ease-out-back) both' : 'none',
              }}>{stepIdx >= i + 1 ? '✓' : i + 1}</span>
              <span style={{ fontWeight: stepIdx >= i + 1 ? 600 : 400 }}>{s.label}</span>
              {stepIdx === i + 1 && phase === 'building' && i < STEPS.length - 1 && (
                <span className="muted small">…前半程屏幕不动是在构思，不是卡住</span>
              )}
            </div>
          ))}
        </div>
        <p className="muted small center mt12">首次构建需要模型生成，请稍候</p>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="card enter">
        <div className="empty">
          <span className="emoji">🛠️</span>
          <p>清单构建失败了</p>
          <p className="muted small">请到「设置」页检查模型配置（Base URL / API Key / 模型名）后重试</p>
          <div className="row">
            <button className="btn" onClick={() => navigate('/settings')}>去设置</button>
            <button className="btn primary" onClick={retryBuild}>重试</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="card enter">
        <h2>✅ 知识清单确认</h2>
        <p className="sub mb12">「{domain.name}」拆出了 {facets.length} 个知识面。可以增删，确认后开始练习</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {facets.map((f, i) => {
            const points = nodes.filter(n => n.parent_id === f.id);
            return (
              <div key={f.id} className="wave-item" style={{ animationDelay: `${i * 0.07}s` }}>
                <div className="row between mb8">
                  <strong style={{ fontSize: '1.05em' }}>🧩 {f.name}</strong>
                  <button className="btn ghost sm" onClick={() => removeNode(f.id)}>删除</button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 10, borderLeft: '2px solid var(--grad-soft)' }}>
                  {points.map(p => (
                    <div key={p.id} className="row" style={{ gap: 8 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--primary)', flexShrink: 0 }} />
                      <span className="grow">{p.name}</span>
                      <span className="muted small">层级 {p.cognitive_level}</span>
                      <button className="btn ghost sm" style={{ color: 'var(--ink-mute)', fontSize: '1em' }} onClick={() => removeNode(p.id)}>✕</button>
                    </div>
                  ))}
                  <div className="row mt8">
                    <input className="input" style={{ padding: '8px 12px', fontSize: '.9em' }}
                      placeholder="＋ 添加知识点" value={newPoint[f.id] || ''}
                      onChange={e => setNewPoint({ ...newPoint, [f.id]: e.target.value })}
                      onKeyDown={e => { if (e.key === 'Enter') addPoint(f.id); }} />
                    <button className="btn sm" onClick={() => addPoint(f.id)}>添加</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <button className="btn primary block enter-d1" onClick={() => navigate(`/learn/${domainId}`)}>
        清单确认，开始练习 →
      </button>
      <button className="btn block enter-d2" onClick={() => navigate('/')}>返回领域列表</button>
    </>
  );
}
