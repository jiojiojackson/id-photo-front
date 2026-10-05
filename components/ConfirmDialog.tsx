"use client";

import { useEffect, useRef } from "react";
import Icon from "./Icon";

export default function ConfirmDialog({ busy, total, onClose, onConfirm }: { busy: boolean; total: number; onClose: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
      if (event.key === "Tab") {
        const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || []);
        if (!buttons.length) { event.preventDefault(); return; }
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = overflow; previous?.focus(); };
  }, [busy, onClose]);

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={dialog} tabIndex={-1} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="clear-title" aria-describedby="clear-description">
      <div className="confirm-icon"><Icon name="trash" width="28" height="28"/></div>
      <h2 id="clear-title">清空全部记录？</h2>
      <p id="clear-description">将永久删除 {total} 条任务记录和存储中的全部照片。删除后无法恢复。</p>
      <div className="dialog-actions"><button className="button secondary" onClick={onClose} disabled={busy}>保留记录</button><button className="button destructive" onClick={onConfirm} disabled={busy}>{busy ? "正在清空…" : "确认清空"}</button></div>
    </div>
  </div>;
}
