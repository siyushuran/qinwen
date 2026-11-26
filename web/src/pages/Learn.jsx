import React, { useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react';
import { api, streamChat, toast } from '../api.js';
import { navigate } from '../App.jsx';
import Highlightable from '../components/Highlightable.jsx';

const ERROR_TAGS = ['概念不清', '计算失误', '审题偏差', '纯手滑'];

export default function Learn({ domainId, focusNode, focusQuestion }) {
  const [domain, setDomain] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [question, setQuestion] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle | asking | ready | judging | done
  const [selected, setSelected] = useState(null);
  const [orderDraft, setOrderDraft] = useState([]); // 排序题：用户点选出的顺序
  const [result, setResult] = useState(null);
  const [errorTags, setErrorTags] = useState([]);
  const [tagsSaved, setTagsSaved] = useState(false);
  const [followups, setFollowups] = useState([]);
  const [chat, setChat] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [difficulty, setDifficulty] = useState(1);
  const chatEndRef = useRef(null);
  const questionCardRef = useRef(null);
  const cardHeightRef = useRef(0); // 切题前卡片高度，出题动画期间占位，避免页面骤缩把滚动位置弹回顶部
  const askStartRef = useRef(0);
  const seenIdsRef = useRef([]); // 本轮已见过的题目，「出下一题」用它避免重复
  const [highlights, setHighlights] = useState([]); // 当前题目的划线
  const hlRef = useRef([]); // 每次 ask 后刷新，避免闭包拿到旧值

  const loadHighlights = async () => {
    try {
      const r = await api('/api/highlights?limit=500');
      hlRef.current = r.items || [];
      setHighlights(hlRef.current);
    } catch { /* 划线加载失败不影响做题 */ }
  };

  const loadDomain = async () => {
    seenIdsRef.current = [];
    setSelected(null); setOrderDraft([]); setResult(null); setErrorTags([]); setFollowups([]); setChat([]); setTagsSaved(false);
    try {
      const data = await api(`/api/domains/${domainId}`);
      const active = data.nodes.filter(n => n.status === 'active');
      setDomain(data.domain);
      setNodes(active);

      // 直达指定题目：错题本「重练这题」，加载时就亮出这道题而不是另出一道
      if (focusQuestion) {
        try {
          const r = await api(`/api/questions/${focusQuestion}`);
          const q = r.question;
          if (q && active.some(n => n.id === q.node_id) && (!focusNode || q.node_id === Number(focusNode))) {
            seenIdsRef.current = [q.id];
            setOrderDraft([]);
            setQuestion(q);
            setDifficulty(q.difficulty || 1);
            askStartRef.current = Date.now();
            setPhase('ready');
            return;
          }
        } catch (e) { toast('指定题目不可用，已切到该知识点练习', 'err'); }
      }
      // 直达指定知识点：地图/复习页点节点
      const focused = active.find(n => n.id === Number(focusNode));
      if (focused) {
        const p = data.progress;
        ask(focused.id, p?.node_id === focused.id && p.difficulty ? p.difficulty : difficulty);
        return;
      }
      // 接着上次的进度练：优先回到上次知识点；上次那题已作答则跳过，避免又从第一题/旧题开始
      const p = data.progress;
      const target = active.find(n => n.id === p?.node_id) || active[0];
      if (target) {
        const excludeIds = p?.question_id && p.node_id === target.id && p.answered ? [p.question_id] : [];
        ask(target.id, p?.difficulty || difficulty, { fresh: excludeIds.length > 0, excludeIds });
      }
    } catch (e) { toast(e.message, 'err'); }
  };
  useEffect(() => { loadDomain(); loadHighlights(); }, [domainId, focusNode, focusQuestion]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [chat]);

  // 新题就绪后定位到题干：切题时结果/追问面板卸载会让页面变短，浏览器会把视口弹到顶部
  useLayoutEffect(() => {
    if (phase !== 'ready' || !question || !questionCardRef.current) return;
    const top = questionCardRef.current.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight * 0.6) {
      questionCardRef.current.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
  }, [phase, question?.id]);

  // 按来源类型/文本筛选当前题的划线，供题干/讲解/追问各自高亮
  const hlFor = (source, text) => hlRef.current.filter(h =>
    h.question_id === question?.id && h.source === source && text && h.text && text.includes(h.text)
  );
  const hlMeta = (source) => ({
    source,
    question_id: question?.id || null,
    node_id: question?.node_id || null,
    domain_id: Number(domainId) || null,
  });
  const onHlAdded = (item) => { hlRef.current = [item, ...hlRef.current]; setHighlights(hlRef.current); };

  const ask = async (nodeId, diff = null, opts = {}) => {
    cardHeightRef.current = questionCardRef.current?.offsetHeight || 0;
    setPhase('asking');
    setSelected(null); setOrderDraft([]); setResult(null); setErrorTags([]); setFollowups([]); setChat([]); setTagsSaved(false);
    if (diff) setDifficulty(diff);
    askStartRef.current = Date.now();
    const excludeIds = [...new Set([...(opts.excludeIds || []), ...seenIdsRef.current])];
    try {
      const data = await api('/api/questions', {
        method: 'POST',
        body: JSON.stringify({
          node_id: Number(nodeId),
          difficulty: diff ?? difficulty,
          ...(opts.type ? { type: opts.type } : {}),
          ...(opts.fresh || excludeIds.length ? { force_new: true, exclude_ids: excludeIds } : {}),
        }),
      });
      setQuestion(data.question);
      if (data.question?.id && !seenIdsRef.current.includes(data.question.id)) {
        seenIdsRef.current = [...seenIdsRef.current, data.question.id];
      }
      setPhase('ready');
    } catch (e) {
      setPhase('idle');
      toast(e.message, 'err');
    }
  };

  const submitAnswer = async () => {
    if (!question || phase !== 'ready') return;
    const isOrder = question.type === 'order';
    const answerPayload = isOrder ? JSON.stringify(orderDraft) : selected;
    if (!answerPayload || (isOrder && orderDraft.length !== (question.options || []).length)) return;
    setPhase('judging');
    try {
      const data = await api('/api/attempts', {
        method: 'POST',
        body: JSON.stringify({ question_id: question.id, answer: answerPayload, duration_ms: Date.now() - askStartRef.current, error_tags: errorTags }),
      });
      setResult(data);
      setPhase('done');
    } catch (e) {
      toast(e.message, 'err');
      setPhase('ready');
    }
  };

  const saveTags = async () => {
    if (!result?.attempt_id) return;
    try {
      await api(`/api/attempts/${result.attempt_id}/error-tags`, {
        method: 'POST',
        body: JSON.stringify({ error_tags: errorTags }),
      });
      setTagsSaved(true);
      toast('错因已记录', 'ok');
    } catch (e) { toast(e.message, 'err'); }
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

  const nextQuestion = () => {
    if (!question || nodes.length === 0) return;
    const idx = nodes.findIndex(n => n.id === question.node_id);
    // 按知识点顺序推进、到末尾回到开头；只有一个知识点时就在原知识点出新题
    const target = idx >= 0 && nodes.length > 1 ? nodes[(idx + 1) % nodes.length] : nodes[0];
    ask(target.id, difficulty, { fresh: true });
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
      <div ref={questionCardRef} className="card enter-d1" style={{ scrollMarginTop: 12 }}>
        {phase === 'asking' && (
          <div className="center" style={{ padding: '36px 10px', minHeight: Math.max(0, cardHeightRef.current - 36) || undefined }}>
            <div className="pulse-ring" style={{ width: 56, height: 56, borderRadius: '50%', margin: '0 auto 14px', background: 'var(--grad-soft)', display: 'grid', placeItems: 'center', fontSize: '1.6em' }}>
              <span className="think-orb">🧠</span>
            </div>
            <p>小问正在打草稿<span className="dots"></span></p>
            <div className="column" style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 'min(100%, 260px)', margin: '16px auto 0' }}>
              <div className="skeleton" style={{ height: 14, width: '90%' }} />
              <div className="skeleton" style={{ height: 14, width: '70%' }} />
              <div className="skeleton" style={{ height: 14, width: '82%' }} />
            </div>
            <p className="muted small mt12">前半程屏幕不动是在构思，不是卡住</p>
          </div>
        )}

        {phase !== 'asking' && question && (
          <>
            <div className="row between mb12">
              <span className="chip" style={{ background: 'var(--grad-soft)' }}>{question.type === 'order' ? '排序题' : question.type === 'judge' ? '判断题' : '单选题'} · 难度 {question.difficulty}</span>
              <span className="muted small">知识点 #{question.node_id}</span>
            </div>
            <Highlightable text={question.stem} highlights={hlFor('stem', question.stem)} meta={hlMeta('stem')} onAdded={onHlAdded}
              className="hl-stem" style={{ fontSize: '1.1em', lineHeight: 1.6, marginBottom: 14 }} />

            {/* 作答区 */}
            {phase === 'ready' && question.type === 'order' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p className="small muted">按正确顺序依次点击，点错了可以撤回重排</p>
                <div className="order-slots">
                  {orderDraft.length === 0 && <span className="muted small">你的顺序：（还没选）</span>}
                  {orderDraft.map((s, i) => (
                    <button key={i} className="order-slot" title="点击撤回"
                      onClick={() => setOrderDraft(orderDraft.filter((_, j) => j !== i))}>
                      <span className="key">{i + 1}</span><span className="grow">{s}</span><span className="muted">✕</span>
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {(question.options || []).map((opt, i) => {
                    const used = orderDraft.includes(String(opt));
                    return (
                      <button key={i} className={`option ${used ? 'selected' : ''}`} disabled={used}
                        onClick={() => setOrderDraft([...orderDraft, String(opt)])}>
                        <span className="key">{String.fromCharCode(65 + i)}</span>
                        <span className="grow">{opt}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="row" style={{ gap: 8 }}>
                  {orderDraft.length > 0 && <button className="btn sm" onClick={() => setOrderDraft([])}>清空重排</button>}
                  {orderDraft.length === (question.options || []).length && (
                    <button className="btn primary grow" onClick={submitAnswer}>提交作答</button>
                  )}
                </div>
              </div>
            )}
            {phase === 'ready' && question.type !== 'order' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {(Array.isArray(question.options) ? question.options : []).map((opt, i) => (
                  <button key={i} className={`option ${selected === String(opt) ? 'selected' : ''}`}
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
            {/* 排序题：提交后才揭晓正确顺序，并逐个标出用户放错的位置 */}
            {phase === 'done' && result && question.type === 'order' && (
              <div className="enter" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
                <p className="small" style={{ fontWeight: 600 }}>正确顺序（点击撤回仅用于作答阶段）</p>
                {(result.correct_order || []).map((s, i) => (
                  <div key={i} className={`option ${orderDraft[i] === s ? 'correct' : 'wrong'}`}>
                    <span className="key">{i + 1}</span>
                    <span className="grow">{s}</span>
                    <span className="small muted">{orderDraft[i] === s ? '位置正确' : `你放了：${orderDraft[i] || '（空）'}`}</span>
                  </div>
                ))}
              </div>
            )}
            {/* 提交完成后才亮出对错 */}
            {phase === 'done' && result && question.type !== 'order' && (
              <div className="enter" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
                {(Array.isArray(question.options) ? question.options : []).map((opt, i) => {
                  const isCorrect = i === result.correct_index;
                  const isWrongPick = selected === String(opt) && !isCorrect;
                  return (
                    <div key={i} className={`option opt-reveal ${isCorrect ? 'correct' : ''} ${isWrongPick ? 'wrong' : ''}`}
                      style={{ animationDelay: `${0.05 + i * 0.06}s` }}>
                      <span className="key">{isCorrect ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path className="check-draw" d="M5 12l5 5L20 7" /></svg>
                      ) : String.fromCharCode(65 + i)}</span>
                      <span className="grow">{opt}</span>
                      {isCorrect && <span className="small" style={{ color: 'var(--ok)' }}>正确答案</span>}
                      {isWrongPick && <span className="small" style={{ color: 'var(--err)' }}>你的选择</span>}
                    </div>
                  );
                })}
              </div>
            )}
            {phase === 'done' && result && (
              <div className={result.is_correct ? 'result-ok' : 'result-bad'}>
                <div className="row mb12" style={{ gap: 12 }}>
                  <span className={`verdict-badge ${result.is_correct ? 'ok' : 'bad'}`}>
                    {result.is_correct ? (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path className="check-draw" d="M5 12l5 5L20 7" /></svg>
                    ) : <span style={{ fontSize: '1.2em' }}>💡</span>}
                  </span>
                  <div>
                    <strong>{result.is_correct ? '答对了，这个点稳了' : '答错了，别灰心'}</strong>
                    <div className="muted small">当前掌握度 {Math.round(result.mastery * 100)}%</div>
                  </div>
                </div>
                <Highlightable text={result.explanation || ''} highlights={hlFor('explanation', result.explanation)} meta={hlMeta('explanation')} onAdded={onHlAdded}
                  style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius)', padding: '12px 14px', fontSize: '.94em', whiteSpace: 'pre-wrap' }} />
                {!result.is_correct && (
                  <div className="mt12">
                    <p className="small mb8" style={{ fontWeight: 600 }}>错在哪里？（可多选，保存后错题本按错因归类）</p>
                    <div className="chips">
                      {ERROR_TAGS.map(t => (
                        <button key={t} className={`chip ${errorTags.includes(t) ? 'on' : ''}`}
                          onClick={() => {
                            setTagsSaved(false);
                            setErrorTags(errorTags.includes(t) ? errorTags.filter(x => x !== t) : [...errorTags, t]);
                          }}>{t}</button>
                      ))}
                    </div>
                    <div className="row mt8" style={{ gap: 8 }}>
                      <button className="btn sm" disabled={tagsSaved} onClick={saveTags}>
                        {tagsSaved ? '错因已记录' : '保存错因'}
                      </button>
                      {!tagsSaved && <span className="muted small">不选也可直接保存（表示未归类）</span>}
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
                    {chat.map((c, i) => c.role === 'assistant' ? (
                      <Highlightable key={i} text={c.content} highlights={hlFor('chat', c.content)} meta={hlMeta('chat')} onAdded={onHlAdded}
                        className={`chat-line ${c.role}`} />
                    ) : (
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

            {/* 答对后主推：出下一题 */}
            {phase === 'done' && result?.is_correct && (
              <button className="btn primary block mt12" onClick={nextQuestion}>➡️ 出下一题</button>
            )}

            {/* 快捷操作 */}
            {phase === 'done' && (
              <div className="row mt12" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button className="btn sm grow" onClick={nextSimilar}>出个类似的</button>
                <button className="btn sm grow" onClick={nextNew}>同层换新</button>
                <button className="btn sm grow" onClick={skip}>换个方向</button>
                <button className="btn sm grow" onClick={() => ask(question.node_id, difficulty, { type: 'order', fresh: true })}>出排序题</button>
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
