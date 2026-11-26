import React, { useEffect, useMemo, useRef, useState } from 'react';
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
 * highlightList: 已保存的划线（用于高亮）；onAdded: 新增成功回调
 * meta: { source, question_id, node_id, domain_id }
 */
export default function Highlightable({ text, highlights = [], meta = {}, onAdded, className = '', style }) {
  const ref = useRef(null);
  const [pending, setPending] = useState(null); // {text, x, y}
  const [saving, setSaving] = useState(false);

  const onMouseUp = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const selected = sel.toString().trim();
    if (selected.length < 2 || selected.length > 2000) return;
    // 只允许在自身节点内选中，避免跨区块误划
    const anchor = ref.current;
    if (!anchor || !anchor.contains(sel.anchorNode) || !anchor.contains(sel.focusNode)) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setPending({ text: selected, x: Math.max(8, Math.min(window.innerWidth - 120, rect.left)), y: Math.max(8, rect.top - 42) });
  };

  const save = async () => {
    if (!pending || saving) return;
    setSaving(true);
    try {
      const r = await api('/api/highlights', {
        method: 'POST',
        body: JSON.stringify({ text: pending.text, ...meta }),
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

  // 点击别处收起浮层
  useEffect(() => {
    if (!pending) return;
    const close = (e) => { if (!e.target.closest?.('.hl-pop')) setPending(null); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [pending]);

  const content = useMemo(() => markText(text, highlights), [text, highlights]);
  return (
    <>
      <div ref={ref} className={`highlightable ${className}`} style={style} onMouseUp={onMouseUp}>
        {content}
      </div>
      {pending && (
        <div className="hl-pop" style={{ left: pending.x, top: pending.y }}>
          <button className="hl-btn" onMouseDown={e => e.preventDefault()} onClick={save} disabled={saving}>
            {saving ? '保存中…' : '✍️ 划线收藏'}
          </button>
          <span className="hl-count">{pending.text.length} 字</span>
        </div>
      )}
    </>
  );
}
