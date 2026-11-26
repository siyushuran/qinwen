import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, toast } from '../api.js';

// 把已划线片段在原文中高亮：用最长的匹配优先，避免短片段切断长片段
function markText(text, highlights) {
  if (!text || !highlights?.length) return text;
  const segments = highlights
    .map(h => (typeof h.text === 'string' ? h.text.trim() : ''))
    .filter(t => t.length >= 2 && text.includes(t))
    .sort((a, b) => b.length - a.length);
  if (!segments.length) return text;

  const nodes = [];
  let rest = text;
  let guard = 0;
  while (rest && guard++ < 100) {
    let hit = -1, hitSeg = '';
    for (const seg of segments) {
      const i = rest.indexOf(seg);
      if (i >= 0 && (hit < 0 || i < hit)) { hit = i; hitSeg = seg; }
    }
    if (hit < 0) { nodes.push(rest); break; }
    if (hit > 0) nodes.push(rest.slice(0, hit));
    nodes.push(<mark key={`${hitSeg}-${hit}-${nodes.length}`} className="hl-mark" title="已划线">{hitSeg}</mark>);
    rest = rest.slice(hit + hitSeg.length);
  }
  return nodes;
}

/**
 * 可划线文本：选中文字后浮出「划线」按钮，保存后原文高亮显示。
 * 桌面走 mouseup；触屏走 touchend + selectionchange 兜底——
 * 手机上系统选字往往不派发 mouseup，只靠 mouseup 会导致浮层永远不出现。
 * highlightList: 已保存的划线（用于高亮）；onAdded: 新增成功回调
 * meta: { source, question_id, node_id, domain_id }
 */
export default function Highlightable({ text, highlights = [], meta = {}, onAdded, className = '', style }) {
  const ref = useRef(null);
  const timerRef = useRef(null);
  const [pending, setPending] = useState(null); // {text, x, y}
  const [saving, setSaving] = useState(false);

  // 统一选区捕获：桌面/触屏/系统长按菜单三条路径都汇到这里
  const capture = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const selected = sel.toString().trim();
    if (selected.length < 2 || selected.length > 2000) return;
    // 只允许在自身节点内选中，避免跨区块误划
    const anchor = ref.current;
    if (!anchor || !anchor.contains(sel.anchorNode) || !anchor.contains(sel.focusNode)) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    // 触屏把浮层放在选区下方，避开系统长按菜单；桌面放在上方
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    const x = Math.max(8, Math.min(window.innerWidth - 216, rect.left));
    const wantedTop = coarse ? rect.bottom + 8 : rect.top - 46;
    const y = Math.max(8, Math.min(window.innerHeight - 64, wantedTop));
    setPending(prev => (prev?.text === selected && prev.x === x && prev.y === y
      ? prev : { text: selected, x, y }));
  }, []);

  const scheduleCapture = useCallback((delay) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(capture, delay);
  }, [capture]);

  const onMouseUp = () => requestAnimationFrame(capture);
  const onTouchEnd = () => scheduleCapture(120); // 等浏览器把系统选区建好

  // 触屏/系统菜单可能既不派发 mouseup 也不派发 touchend，用 selectionchange 兜底
  useEffect(() => {
    const onChange = () => scheduleCapture(160);
    document.addEventListener('selectionchange', onChange);
    return () => {
      clearTimeout(timerRef.current);
      document.removeEventListener('selectionchange', onChange);
    };
  }, [scheduleCapture]);

  const save = async () => {
    const payload = pending; // 先存快照：点击按钮可能让浏览器清空选区
    if (!payload || saving) return;
    setSaving(true);
    try {
      const r = await api('/api/highlights', {
        method: 'POST',
        body: JSON.stringify({ text: payload.text, ...meta }),
      });
      toast('已加入划线收藏', 'ok');
      onAdded?.(r.highlight);
      window.getSelection()?.removeAllRanges();
    } catch (e) {
      toast(e.message || '划线保存失败', 'err');
    } finally {
      setSaving(false);
      setPending(null);
    }
  };

  // 点别处收起：pointerdown 同时覆盖鼠标 / 触摸 / 触控笔
  useEffect(() => {
    if (!pending) return;
    const close = (e) => { if (!e.target.closest?.('.hl-pop')) setPending(null); };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [pending]);

  const content = useMemo(() => markText(text, highlights), [text, highlights]);
  return (
    <>
      <div ref={ref} className={`highlightable ${className}`} style={style}
        onMouseUp={onMouseUp} onTouchEnd={onTouchEnd}>
        {content}
      </div>
      {pending && (
        <div className="hl-pop" style={{ left: pending.x, top: pending.y }}>
          <button className="hl-btn" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '✍️ 划线收藏'}
          </button>
          <span className="hl-count">{pending.text.length} 字</span>
        </div>
      )}
    </>
  );
}
