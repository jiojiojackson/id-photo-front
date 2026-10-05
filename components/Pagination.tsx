import Icon from "./Icon";

export type PaginationData = { page: number; pageSize: number; total: number; totalPages: number };
export const emptyPagination = (pageSize: number): PaginationData => ({ page: 1, pageSize, total: 0, totalPages: 1 });

export default function Pagination({ data, onChange, disabled = false, compact = false }: { data: PaginationData; onChange: (page: number) => void; disabled?: boolean; compact?: boolean }) {
  const { page, pageSize, total, totalPages } = data;
  const numbers = [...new Set([1, page - 1, page, page + 1, totalPages])].filter(n => n >= 1 && n <= totalPages).sort((a, b) => a - b);
  return <nav className={`pagination ${compact ? "compact" : ""}`} aria-label="列表分页">
    <span className="pagination-summary">{total ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)}` : "0"}<span> / {total} 项</span></span>
    <div className="pagination-controls">
      <button className="page-button" aria-label="上一页" disabled={disabled || page <= 1} onClick={() => onChange(page - 1)}><Icon name="chevron-left"/></button>
      <span className="mobile-page-label">{page}<span> / {totalPages}</span></span>
      <div className="page-numbers">{numbers.map((number, index) => <span key={number}>{index > 0 && number - numbers[index - 1] > 1 && <span className="page-ellipsis">…</span>}<button className={`page-button ${number === page ? "current" : ""}`} disabled={disabled} aria-current={number === page ? "page" : undefined} aria-label={`第 ${number} 页`} onClick={() => onChange(number)}>{number}</button></span>)}</div>
      <button className="page-button" aria-label="下一页" disabled={disabled || page >= totalPages} onClick={() => onChange(page + 1)}><Icon name="chevron-right"/></button>
    </div>
  </nav>;
}
