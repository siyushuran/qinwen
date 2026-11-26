import React, { useEffect, useState } from 'react';
import { api, prefs, toast, setToken } from '../api.js';
import { navigate } from '../App.jsx';

const FONT_LEVELS = [
  { v: '1', label: '小' },
  { v: '2', label: '较小' },
  { v: '3', label: '标准' },
  { v: '4', label: '较大' },
  { v: '5', label: '大' },
];
const MOTION_LEVELS = [
  { v: '1', label: '完整动效' },
  { v: '2', label: '精简动效' },
];

export default function Settings({ onLogout }) {
  const [nickname, setNickname] = useState('');
  const [interests, setInterests] = useState('');
  const [font, setFont] = useState(prefs.fontScale);
  const [motion, setMotion] = useState(prefs.motion);
  const [model, setModel] = useState({ base_url: '', api_key: '', chat_model: '', fast_model: '' });
  const [modelStatus, setModelStatus] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const s = await api('/api/settings');
      setNickname(s.nickname || '');
      setInterests(s.interests || '');
      setModelStatus(s.model);
    } catch (e) { toast(e.message, 'err'); }
  };
  useEffect(() => { load(); }, []);

  const save = async (patch) => {
    setSaving(true);
    try {
      await api('/api/settings', { method: 'POST', body: JSON.stringify(patch) });
      toast('已保存', 'ok');
      if (patch.model !== undefined || ['llm_base_url', 'llm_chat_model'].some(k => k in patch)) {
        const s = await api('/api/settings');
        setModelStatus(s.model);
      }
    } catch (e) { toast(e.message, 'err'); }
    finally { setSaving(false); }
  };

  return (
    <>
      <div className="card enter">
        <h2>🎨 显示</h2>
        <div className="field">
          <label>全局字号</label>
          <div className="chips">
            {FONT_LEVELS.map(l => (
              <button key={l.v} className={`chip ${font === l.v ? 'on' : ''}`}
                onClick={() => { setFont(l.v); prefs.fontScale = l.v; }}>{l.label}</button>
            ))}
          </div>
        </div>
        <div className="field">
          <label>动效档位</label>
          <div className="chips">
            {MOTION_LEVELS.map(l => (
              <button key={l.v} className={`chip ${motion === l.v ? 'on' : ''}`}
                onClick={() => { setMotion(l.v); prefs.motion = l.v; }}>{l.label}</button>
            ))}
          </div>
          <p className="muted small mt8">选择即时生效，无需保存</p>
        </div>
      </div>

      <div className="card enter-d1">
        <h2>🙋 陪练伙伴</h2>
        <div className="field">
          <label>助手昵称</label>
          <input className="input" value={nickname} onChange={e => setNickname(e.target.value)} maxLength={12} />
        </div>
        <div className="field">
          <label>兴趣场景（逗号分隔，出题时融入）</label>
          <textarea className="textarea" style={{ minHeight: 72 }} value={interests}
            onChange={e => setInterests(e.target.value)} placeholder="例如：露营，手冲咖啡，citywalk，老电影" />
        </div>
          <button className="btn primary" disabled={saving} onClick={() => save({ nickname, interests })}>
            {saving ? <>保存中<span className="dots"></span></> : '保存偏好'}
          </button>
      </div>

      <div className="card enter-d2">
        <h2>🤖 模型配置</h2>
        <p className="sub mb12">
          状态：
          {modelStatus?.configured ? (
            <span className="chip on" style={{ marginLeft: 6, padding: '2px 10px', fontSize: '.78em' }}>已配置 · {modelStatus.chat_model}</span>
          ) : (
            <span className="muted small">未配置，出题与拆解需要模型</span>
          )}
        </p>
        <div className="field">
          <label>Base URL（OpenAI 兼容）</label>
          <input className="input" value={model.base_url} onChange={e => setModel({ ...model, base_url: e.target.value })}
            placeholder="https://api.deepseek.com/v1" />
        </div>
        <div className="field">
          <label>API Key</label>
          <input className="input" type="password" value={model.api_key} onChange={e => setModel({ ...model, api_key: e.target.value })}
            placeholder="sk-…" />
        </div>
        <div className="field">
          <label>主力模型（拆清单 / 出题）</label>
          <input className="input" value={model.chat_model} onChange={e => setModel({ ...model, chat_model: e.target.value })}
            placeholder="deepseek-chat" />
        </div>
        <div className="field">
          <label>快速模型（判定 / 总结，可选）</label>
          <input className="input" value={model.fast_model} onChange={e => setModel({ ...model, fast_model: e.target.value })}
            placeholder="如 deepseek-reasoner 或留空复用主力模型" />
        </div>
        <button className="btn primary" disabled={saving} onClick={() => save({
          llm_base_url: model.base_url, llm_api_key: model.api_key,
          llm_chat_model: model.chat_model, llm_fast_model: model.fast_model,
        })}>{saving ? <>保存中<span className="dots"></span></> : '保存模型配置（重启生效）'}</button>
        <p className="muted small mt8">支持 DeepSeek / Kimi / GLM / 通义 / 本地 Ollama 等 OpenAI 兼容接口，换模型只改配置不改代码</p>
      </div>

      <div className="card enter-d3">
        <h2>💾 数据与账号</h2>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <a className="btn" href="/api/export" style={{ textDecoration: 'none' }} onClick={() => toast('已开始下载备份', 'ok')}>导出数据备份</a>
          <button className="btn" onClick={() => navigate('/')}>返回首页</button>
          <button className="btn danger" onClick={() => { if (confirm('退出登录？需要重新输入密码进入。')) { onLogout(); } }}>退出登录</button>
        </div>
        <p className="muted small mt8">数据以 SQLite 单文件保存在服务器，导出即全量备份</p>
      </div>
    </>
  );
}
