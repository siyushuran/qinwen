import React, { useState } from 'react';
import { api, setToken, toast } from '../api.js';
import { navigate } from '../App.jsx';

export default function Login({ onAuthed }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasPw, setHasPw] = useState(true);

  // 先探测是否已设置密码
  React.useEffect(() => {
    api('/api/auth/status').then(s => setHasPw(Boolean(s.configured))).catch(() => {});
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!pw) return toast('请输入密码', 'err');
    if (hasPw && pw.length < 4) return toast('密码至少 4 位', 'err');
    if (!hasPw && pw !== pw2) return toast('两次输入的密码不一致', 'err');
    setLoading(true);
    try {
      const path = hasPw ? '/api/auth/login' : '/api/auth/setup';
      const data = await api(path, { method: 'POST', body: JSON.stringify({ password: pw }) });
      setToken(data.token);
      toast(hasPw ? '欢迎回来，开始练吧' : '密码已创建，开始练吧', 'ok');
      onAuthed();
      navigate('/');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-shell" style={{ justifyContent: 'center', maxWidth: 460 }}>
      <div className="card enter" style={{ textAlign: 'center', padding: '36px 24px' }}>
        <div className="brand" style={{ justifyContent: 'center', marginBottom: 14 }}>
          <span className="logo" style={{ width: 52, height: 52, fontSize: '1.5em', borderRadius: 16 }}>问</span>
          <span style={{ fontSize: '1.5em' }}>轻问练</span>
        </div>
        <p className="muted small mb16">说想学什么，它拆出知识清单，<br />逐题现写现练，答完即讲。</p>
        <form onSubmit={submit}>
          <div className="field">
            <label>{hasPw ? '访问密码' : '设置访问密码'}</label>
            <input className="input" type="password" autoComplete="current-password"
              value={pw} onChange={e => setPw(e.target.value)} placeholder={hasPw ? '请输入密码' : '至少 4 位'} />
          </div>
          {!hasPw && (
            <div className="field">
              <label>确认密码</label>
              <input className="input" type="password" value={pw2} onChange={e => setPw2(e.target.value)} />
            </div>
          )}
          <button className="btn primary block" disabled={loading}>
            {loading ? <>正在开门<span className="dots"></span></> : hasPw ? '进入' : '创建并进入'}
          </button>
        </form>
        <p className="muted small mt12">个人自用 · 数据保存在这台设备上</p>
      </div>
    </div>
  );
}
