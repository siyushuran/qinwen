import React, { useEffect, useState, useCallback } from 'react';
import { api, getToken, setToken } from './api.js';
import Login from './pages/Login.jsx';
import Home from './pages/Home.jsx';
import DomainNew from './pages/DomainNew.jsx';
import Building from './pages/Building.jsx';
import Learn from './pages/Learn.jsx';
import MapPage from './pages/Map.jsx';
import Review from './pages/Review.jsx';
import Mistakes from './pages/Mistakes.jsx';
import Report from './pages/Report.jsx';
import Stats from './pages/Stats.jsx';
import Highlights from './pages/Highlights.jsx';
import Materials from './pages/Materials.jsx';
import MaterialDetail from './pages/MaterialDetail.jsx';
import Settings from './pages/Settings.jsx';

// 极简 hash 路由（自用轻量，避免引入路由库）
function useHashRoute() {
  const [route, setRoute] = useState(() => location.hash.replace(/^#/, '') || '/');
  useEffect(() => {
    const onHash = () => { setRoute(location.hash.replace(/^#/, '') || '/'); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}
export function navigate(to) { location.hash = to; }

const TABS = [
  { path: '/', label: '领域', ico: '📘' },
  { path: '/materials', label: '资料', ico: '📄' },
  { path: '/review', label: '复习', ico: '🔁' },
  { path: '/mistakes', label: '错题', ico: '📝' },
  { path: '/highlights', label: '划线', ico: '✍️' },
  { path: '/report', label: '报告', ico: '📈' },
  { path: '/stats', label: '统计', ico: '📊' },
  { path: '/settings', label: '设置', ico: '⚙️' },
];

export default function App() {
  const route = useHashRoute();
  // hash 里可带查询参数，例如 /learn/3?node=12&q=45（地图/错题本直达）
  const [pathname, search = ''] = route.split('?');
  const query = new URLSearchParams(search);
  const [authed, setAuthed] = useState(Boolean(getToken()));

  useEffect(() => {
    api('/api/auth/status').then(s => {
      if (!s.authed) { setToken(''); setAuthed(false); }
      else setAuthed(true);
    }).catch(() => {});
  }, [route]);

  const onAuthed = useCallback(() => { setToken(localStorage.getItem('qw_token')); setAuthed(true); }, []);
  const onLogout = useCallback(async () => {
    // 退出时让服务端令牌同步失效；即使请求失败也清掉本地状态
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* 本地继续退出 */ }
    setToken(''); setAuthed(false); navigate('/');
  }, []);

  if (!authed) return <Login onAuthed={onAuthed} />;

  let page = null;
  if (pathname === '/' || pathname === '') page = <Home />;
  else if (pathname === '/materials') page = <Materials />;
  else if (pathname.startsWith('/material/')) page = <MaterialDetail materialId={pathname.split('/')[2]} />;
  else if (pathname.startsWith('/domains/new')) page = <DomainNew />;
  else if (pathname.startsWith('/building/')) page = <Building domainId={pathname.split('/')[2]} />;
  else if (pathname.startsWith('/learn/')) page = (
    <Learn domainId={pathname.split('/')[2]} focusNode={query.get('node')} focusQuestion={query.get('q')} />
  );
  else if (pathname.startsWith('/map/')) page = <MapPage domainId={pathname.split('/')[2]} />;
  else if (pathname === '/review') page = <Review />;
  else if (pathname === '/mistakes') page = <Mistakes />;
  else if (pathname === '/highlights') page = <Highlights />;
  else if (pathname === '/report') page = <Report />;
  else if (pathname === '/stats') page = <Stats />;
  else if (pathname === '/settings') page = <Settings onLogout={onLogout} />;
  else page = <Home />;

  return (
    <>
      <div className="app-shell">
        <header className="topbar enter">
          <div className="brand">
            <span className="logo">问</span>
            <span>轻问练</span>
          </div>
          <div className="actions">
            {pathname !== '/settings' && <button className="btn ghost sm" onClick={() => navigate('/settings')}>设置</button>}
          </div>
        </header>
        <main>{page}</main>
      </div>
      <nav className="tabbar">
        <div className="inner">
          {TABS.map(t => (
            <button
              key={t.path}
              className={`tab ${(pathname === t.path || (t.path === '/' && pathname.startsWith('/learn')) || (t.path === '/' && (pathname.startsWith('/domains') || pathname.startsWith('/building') || pathname.startsWith('/map'))) || (t.path === '/materials' && pathname.startsWith('/material/'))) ? 'active' : ''}`}
              onClick={() => navigate(t.path)}
            >
              <span className="ico">{t.ico}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </>
  );
}
