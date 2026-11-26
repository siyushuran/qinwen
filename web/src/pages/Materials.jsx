import React, { useEffect, useState } from 'react';
import { api, fmtTime, toast } from '../api.js';
import { navigate } from '../App.jsx';

export default function Materials() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [content, setContent] = useState('');
  const [policy, setPolicy] = useState('article_claim');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await api('/api/materials');
      setItems(r.materials || []);
    } catch (e) { toast(e.message, 'err'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim() || !content.trim()) return toast('请填写标题并粘贴正文', 'err');
    setBusy(true);
    try {
      const r = await api('/api/materials', {
        method: 'POST',
        body: JSON.stringify({ title: title.trim(), source_url: sourceUrl.trim(), content, claim_policy: policy, source_type: 'article' }),
      });
      toast(r.reused ? '这份资料已经导入过，已为你打开' : '资料已入库并完成切块', 'ok');
      navigate(`/material/${r.material.id}`);
    } catch (err) { toast(err.message, 'err'); }
    finally { setBusy(false); }
  };

  const remove = async (id, name) => {
    if (!confirm(`删除资料「${name}」？切块和摘要会一并删除，已生成的题目和练习记录会保留。`)) return;
    try {
      await api(`/api/materials/${id}`, { method: 'DELETE' });
      toast('已删除', 'ok');
      load();
    } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <>
      <div className="card enter">
        <h2>📄 资料库</h2>
        <p className="sub mb12">粘贴文章正文或 Markdown，系统按小标题切块，供摘要、问答和出题使用</p>
        <form onSubmit={submit}>
          <div className="field">
            <label>资料标题</label>
            <input className="input" value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：五步学会陌生领域" maxLength={120} />
          </div>
          <div className="field">
            <label>原文链接（可选，划线导出会带上）</label>
            <input className="input" value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} placeholder="https://mp.weixin.qq.com/s/..." />
          </div>
          <div className="field">
            <label>事实口径</label>
            <select className="input" value={policy} onChange={e => setPolicy(e.target.value)}>
              <option value="article_claim">文章声称（回答时标注"文章称"，推荐）</option>
              <option value="verified">已核实资料</option>
              <option value="mixed">混合，按段落判断</option>
            </select>
          </div>
          <div className="field">
            <label>正文 / Markdown</label>
            <textarea className="input" rows={7} value={content} onChange={e => setContent(e.target.value)}
              placeholder={'# 标题\n\n正文段落……\n\n## 小标题\n\n文章称……'} />
          </div>
          <button className="btn primary block" disabled={busy}>{busy ? '正在切块入库…' : '导入资料'}</button>
        </form>
      </div>

      <div className="card enter-d1">
        <h2>已导入</h2>
        {loading ? <p className="muted center" style={{ padding: 20 }}>正在读取<span className="dots"></span></p>
          : items.length === 0 ? <p className="muted center" style={{ padding: 20 }}>还没有资料，先在上面贴一篇</p>
          : (
            <ul style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {items.map(it => (
                <li key={it.id} className="map-node" style={{ cursor: 'pointer' }} onClick={() => navigate(`/material/${it.id}`)}>
                  <div className="grow">
                    <div className="row" style={{ gap: 8 }}>
                      <strong>{it.title}</strong>
                      <span className="chip" style={{ padding: '2px 8px', fontSize: '.75em' }}>{it.chunk_count} 块</span>
                    </div>
                    <div className="muted small">{fmtTime(it.created_at)} · {it.domain_name || '未关联领域'}</div>
                  </div>
                  <button className="btn ghost sm" onClick={e => { e.stopPropagation(); remove(it.id, it.title); }}>删除</button>
                </li>
              ))}
            </ul>
          )}
      </div>
    </>
  );
}
