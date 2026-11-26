import React, { useState } from 'react';
import { api, toast } from '../api.js';
import { navigate } from '../App.jsx';

const LEVELS = [
  { v: '没学过', d: '完全没接触过，从零开始' },
  { v: '学过一点', d: '知道些概念，还不扎实' },
  { v: '能上手用', d: '基本能用，想更系统' },
];

export default function DomainNew() {
  const [name, setName] = useState('');
  const [level, setLevel] = useState('没学过');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return toast('先告诉它想学什么', 'err');
    setLoading(true);
    try {
      const data = await api('/api/domains', { method: 'POST', body: JSON.stringify({ name: trimmed, level }) });
      toast('领域已创建，开始拆解清单', 'ok');
      navigate(`/building/${data.id}`);
    } catch (err) {
      toast(err.message, 'err');
      setLoading(false);
    }
  };

  return (
    <>
      <div className="card enter">
        <h2>✏️ 创建领域</h2>
        <p className="sub mb12">用一句话描述你想学的东西，越具体越好</p>
        <form onSubmit={submit}>
          <div className="field">
            <label>想学什么？</label>
            <input className="input" value={name} onChange={e => setName(e.target.value)}
              placeholder="例如：民谣吉他入门、咖啡冲煮、宋代历史、日常英语口语" maxLength={40} autoFocus />
          </div>
          <div className="field">
            <label>目前的基础</label>
            <div className="chips">
              {LEVELS.map(l => (
                <button type="button" key={l.v} className={`chip ${level === l.v ? 'on' : ''}`}
                  onClick={() => setLevel(l.v)}>{l.v}</button>
              ))}
            </div>
            <p className="muted small mt8">{LEVELS.find(l => l.v === level)?.d}</p>
          </div>
          <button className="btn primary block" disabled={loading}>
            {loading ? <>准备中<span className="dots"></span></> : '开始拆解知识清单'}
          </button>
        </form>
      </div>
      <p className="muted small center">提示：领域创建后，AI 会把它拆成「知识面 → 知识点」两层清单</p>
    </>
  );
}
