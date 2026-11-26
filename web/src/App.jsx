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
  { path: '/review', label: '复习', ico: '🔁' },
  { path: '/mistakes', label: '错题', ico: '📝' },
  { path: '/report', label: '报告', ico: '📈' },
  { path: '/settings', label: '设置', ico: '⚙️' },
];

export default function App() {
  const route = useHashRoute();
  const [authed, setAuthed] = useState(Boolean(getToken()));

  useEffect(() => {
    api('/api/auth/status').then(s => {
      if (!s.authed) { setToken(''); setAuthed(false); }
      else setAuthed(true);
    }).catch(() => {});
  }, [route]);

  const onAuthed = useCallback(() => { setToken(localStorage.getItem('qw_token')); setAuthed(true); }, []);
  const onLogout = useCallback(() => { setToken(''); setAuthed(false); navigate('/'); }, []);

  if (!authed) return <Login onAuthed={onAuthed} />;

  let page = null;
  if (route === '/' || route === '') page = <Home />;
  else if (route.startsWith('/domains/new')) page = <DomainNew />;
  else if (route.startsWith('/building/')) page = <Building domainId={route.split('/')[2]} />;
  else if (route.startsWith('/learn/')) page = <Learn domainId={route.split('/')[2]} />;
  else if (route.startsWith('/map/')) page = <MapPage domainId={route.split('/')[2]} />;
  else if (route === '/review') page = <Review />;
  else if (route === '/mistakes') page = <Mistakes />;
  else if (route === '/report') page = <Report />;
  else if (route === '/settings') page = <Settings onLogout={onLogout} />;
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
            {route !== '/settings' && <button className="btn ghost sm" onClick={() => navigate('/settings')}>设置</button>}
          </div>
        </header>
        <main>{page}</main>
      </div>
      <nav className="tabbar">
        <div className="inner">
          {TABS.map(t => (
            <button
              key={t.path}
              className={`tab ${(route === t.path || (t.path === '/' && route.startsWith('/learn')) || (t.path === '/' && (route.startsWith('/domains') || route.startsWith('/building') || route.startsWith('/map')))) ? 'active' : ''}`}
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
