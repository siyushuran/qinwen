import React, { useEffect, useRef, useState } from 'react';
import { api, streamChat, toast } from '../api.js';
import { navigate } from '../App.jsx';

const ERROR_TAGS = ['概念不清', '计算失误', '审题偏差', '纯手滑'];

// 计算正确选项的下标：兼容 answer 为字母 / 选项原文 / 数字序号
function correctIndexOf(question) {
  if (!question) return -1;
  const ans = String(question.answer ?? '').trim().toUpperCase();
  const opts = Array.isArray(question.options) ? question.options : [];
  if (!ans) return -1;
  const idx = opts.findIndex(o => String(o).trim().toUpperCase() === ans);
  if (idx >= 0) return idx;
  if (/^[A-Z]$/.test(ans)) return Math.min(25, ans.charCodeAt(0) - 65);
  if (/^\d+$/.test(ans)) return Math.min(25, Number(ans) - 1);
  return -1;
}

export default function Learn({ domainId }) {
  const [domain, setDomain] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [question, setQuestion] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle | asking | ready | judging | done
  const [selected, setSelected] = useState(null);
  const [result, setResult] = useState(null);
  const [errorTags, setErrorTags] = useState([]);
  const [followups, setFollowups] = useState([]);
  const [chat, setChat] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [difficulty, setDifficulty] = useState(1);
  const chatEndRef = useRef(null);
  const askStartRef = useRef(0);

  const loadDomain = async () => {
    try {
      const data = await api(`/api/domains/${domainId}`);
      setDomain(data.domain);
      setNodes(data.nodes.filter(n => n.status === 'active'));
      if (data.nodes.length > 0) ask(data.nodes[0].id);
    } catch (e) { toast(e.message, 'err'); }
  };
  useEffect(() => { loadDomain(); }, [domainId]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [chat]);

  const ask = async (nodeId, diff = null) => {
    setPhase('asking');
    setSelected(null); setResult(null); setErrorTags([]); setFollowups([]); setChat([]);
    if (diff) setDifficulty(diff);
    askStartRef.current = Date.now();
    try {
      const data = await api('/api/questions', {
        method: 'POST',
        body: JSON.stringify({ node_id: Number(nodeId), difficulty: diff ?? difficulty }),
      });
      setQuestion(data.question);
      setPhase('ready');
    } catch (e) {
      setPhase('idle');
      toast(e.message, 'err');
    }
  };

  const submitAnswer = async () => {
    if (!selected || !question || phase !== 'ready') return;
    setPhase('judging');
    try {
      const data = await api('/api/attempts', {
        method: 'POST',
        body: JSON.stringify({ question_id: question.id, answer: selected, duration_ms: Date.now() - askStartRef.current, error_tags: errorTags }),
      });
      setResult(data);
      setPhase('done');
    } catch (e) {
      toast(e.message, 'err');
      setPhase('ready');
    }
  };

  const sendChat = async () => {
    const text = chatInput.trim();
    if (!text || streaming || !question) return;
    const history = chat.map(c => ({ role: c.role, content: c.content }));
    const next = [...chat, { role: 'user', content: text }];
    setChat(next);
    setChatInput('');
    setStreaming(true);
    let acc = '';
    await streamChat(
      { question_id: question.id, content: text, history },
      (delta) => { acc += delta; setChat([...next, { role: 'assistant', content: acc }]); },
      () => setStreaming(false),
      (e) => { setStreaming(false); toast(`追问失败：${e.message}`, 'err'); }
    );
  };

  const nextSimilar = () => {
    const node = nodes.find(n => n.id === question.node_id);
    ask(node.id, Math.min(5, difficulty + 1));
  };
  const nextNew = () => {
    const others = nodes.filter(n => n.id !== question.node_id);
    const target = others[Math.floor(Math.random() * others.length)] || nodes[0];
    ask(target.id, difficulty);
  };
  const skip = () => {
    const others = nodes.filter(n => n.id !== question.node_id);
    const target = others[Math.floor(Math.random() * others.length)] || nodes[0];
    ask(target.id, Math.max(1, difficulty - 1));
  };

  if (!domain) return <div className="card enter"><p className="muted center" style={{ padding: 30 }}>正在载入<span className="dots"></span></p></div>;

  return (
    <>
      {/* 领域导航条 */}
      <div className="card enter tight">
        <div className="row between">
          <div className="row" style={{ gap: 8 }}>
            <button className="btn ghost sm" onClick={() => navigate('/')}>← 领域</button>
            <strong>{domain.name}</strong>
            <span className="muted small">难度 {difficulty}/5</span>
          </div>
          <button className="btn ghost sm" onClick={() => navigate(`/map/${domainId}`)}>知识地图</button>
        </div>
      </div>

      {/* 题目卡 */}
      <div className="card enter-d1">
        {phase === 'asking' && (
          <div className="center" style={{ padding: '36px 10px' }}>
            <div className="pulse-ring" style={{ width: 56, height: 56, borderRadius: '50%', margin: '0 auto 14px', background: 'var(--grad-soft)', display: 'grid', placeItems: 'center', fontSize: '1.6em' }}>🧠</div>
            <p>小问正在打草稿<span className="dots"></span></p>
            <p className="muted small">前半程屏幕不动是在构思，不是卡住</p>
          </div>
        )}

        {phase !== 'asking' && question && (
          <>
            <div className="row between mb12">
              <span className="chip" style={{ background: 'var(--grad-soft)' }}>{question.type === 'judge' ? '判断题' : '单选题'} · 难度 {question.difficulty}</span>
              <span className="muted small">知识点 #{question.node_id}</span>
            </div>
            <h2 style={{ fontSize: '1.1em', lineHeight: 1.6, marginBottom: 14 }}>{question.stem}</h2>

            {/* 作答区 */}
            {phase === 'ready' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {(Array.isArray(question.options) ? question.options : []).map((opt, i) => (
                  <button key={i} className={`option ${selected && i === correctIndexOf(question) ? 'correct' : ''} ${selected === String(opt) && i !== correctIndexOf(question) ? 'wrong' : ''}`}
                    disabled={selected !== null}
                    onClick={() => setSelected(String(opt))}>
                    <span className="key">{String.fromCharCode(65 + i)}</span>
                    <span className="grow">{opt}</span>
                  </button>
                ))}
                {selected && (
                  <button className="btn primary block enter" onClick={submitAnswer}>提交作答</button>
                )}
              </div>
            )}

            {/* 判定结果 + 讲解 */}
            {phase === 'judging' && (
              <p className="center muted" style={{ padding: 24 }}>正在批改并写讲解<span className="dots"></span></p>
            )}
            {phase === 'done' && result && (
              <div className={result.is_correct ? 'result-ok' : 'result-bad'}>
                <div className="row mb12" style={{ gap: 10 }}>
                  <span style={{ fontSize: '2em' }}>{result.is_correct ? '🎉' : '💡'}</span>
                  <div>
                    <strong>{result.is_correct ? '答对了，这个点稳了' : '答错了，别灰心'}</strong>
                    <div className="muted small">当前掌握度 {Math.round(result.mastery * 100)}%</div>
                  </div>
                </div>
                <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius)', padding: '12px 14px', fontSize: '.94em', whiteSpace: 'pre-wrap' }}>
                  {result.explanation}
                </div>
                {!result.is_correct && (
                  <div className="mt12">
                    <p className="small mb8" style={{ fontWeight: 600 }}>错在哪里？（可多选，用于归类复习）</p>
                    <div className="chips">
                      {ERROR_TAGS.map(t => (
                        <button key={t} className={`chip ${errorTags.includes(t) ? 'on' : ''}`}
                          onClick={() => setErrorTags(errorTags.includes(t) ? errorTags.filter(x => x !== t) : [...errorTags, t])}>{t}</button>
                      ))}
                    </div>
                  </div>
                )}
                {followups.length > 0 && (
                  <div className="chips mt12">
                    {followups.map(f => (
                      <button key={f} className="chip" onClick={() => { setChatInput(f); }}>💬 {f}</button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 追问面板 */}
            {phase === 'done' && (
              <div className="mt12">
                <div className="card tight" style={{ background: 'var(--surface-2)' }}>
                  <p className="small mb8" style={{ fontWeight: 600, color: 'var(--ink-soft)' }}>💬 追问小问（苏格拉底式引导，不直接报答案）</p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 260, overflowY: 'auto', padding: 2 }}>
                    {chat.map((c, i) => (
                      <div key={i} className={`chat-line ${c.role}`}>{c.content}</div>
                    ))}
                    {streaming && <div className="chat-line assistant">{chatInput || '正在组织回答'}<span className="dots"></span></div>}
                    <div ref={chatEndRef} />
                  </div>
                  <div className="row mt12" style={{ gap: 8 }}>
                    <input className="input" style={{ flex: 1 }} value={chatInput}
                      placeholder="问点什么…（Enter 发送）"
                      onChange={e => setChatInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') sendChat(); }} disabled={streaming} />
                    <button className="btn primary" onClick={sendChat} disabled={streaming || !chatInput.trim()}>发送</button>
                  </div>
                </div>
              </div>
            )}

            {/* 快捷操作 */}
            {phase === 'done' && (
              <div className="row mt12" style={{ gap: 8 }}>
                <button className="btn sm grow" onClick={nextSimilar}>出个类似的</button>
                <button className="btn sm grow" onClick={nextNew}>同层换新</button>
                <button className="btn sm grow" onClick={skip}>换个方向</button>
              </div>
            )}
          </>
        )}
      </div>

      {/* 知识点切换 */}
      {nodes.length > 0 && (
        <div className="card enter-d2">
          <p className="small mb8" style={{ fontWeight: 600, color: 'var(--ink-soft)' }}>🎯 知识点</p>
          <div className="chips">
            {nodes.map(n => (
              <button key={n.id} className={`chip ${question && question.node_id === n.id ? 'on' : ''}`}
                onClick={() => ask(n.id)}>
                {n.name}{n.mastery > 0 ? ` · ${Math.round(n.mastery * 100)}%` : ''}
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="muted small center" style={{ textAlign: 'center' }}>内容由 AI 生成，仅供参考</p>
    </>
  );
}
