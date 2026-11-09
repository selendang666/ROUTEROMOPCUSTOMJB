import { Maximize2, Minus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
  extraWide,
  onExited,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  extraWide?: boolean;
  onExited?: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const onExitedRef = useRef(onExited);
  const [present, setPresent] = useState(open);
  const [minimized, setMinimized] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  onCloseRef.current = onClose;
  onExitedRef.current = onExited;

  const requestClose = useCallback(() => {
    if (!present) return;
    setPresent(false);
    onCloseRef.current();
    onExitedRef.current?.();
  }, [present]);

  const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: dragOffset.x, origY: dragOffset.y };
    const onMove = (ev: MouseEvent) => {
      if (!dragState.current) return;
      setDragOffset({ x: dragState.current.origX + ev.clientX - dragState.current.startX, y: dragState.current.origY + ev.clientY - dragState.current.startY });
    };
    const onUp = () => {
      dragState.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [dragOffset.x, dragOffset.y]);

  useEffect(() => {
    if (open) setDragOffset({ x: 0, y: 0 });
  }, [open]);

  useEffect(() => {
    if (open) {
      setPresent(true);
      setMinimized(false);
      setExpanded(false);
      return;
    }
    if (present) requestClose();
    // The close callback intentionally reads the latest refs/state while this
    // effect only reacts to the parent's open transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !present) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusableSelector = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";
    const focusInitial = () => {
      if (dialogRef.current?.contains(document.activeElement)) return;
      dialogRef.current?.querySelector<HTMLElement>(focusableSelector)?.focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector)];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    requestAnimationFrame(focusInitial);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      returnFocusRef.current?.focus();
    };
  }, [open, present, requestClose]);

  if (!present) return null;

  return createPortal(
    <div className="motion-dialog-overlay fixed inset-0 z-90 flex items-center justify-center p-4">
      <button type="button" aria-label="Close dialog" className="dialog-backdrop absolute inset-0 h-full w-full cursor-default select-none bg-black/10 dark:bg-black/20 backdrop-blur-[1px]" onClick={requestClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dashboard-dialog-title"
        tabIndex={-1}
        style={{ transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)` }}
        className={`motion-dialog-panel card-solid card-elevated relative flex w-full flex-col select-text ${extraWide || expanded ? "max-w-4xl max-h-[95vh]" : wide ? "max-w-2xl max-h-[85vh]" : "max-w-md max-h-[85vh]"} rounded-2xl p-5`}
      >
        <div onMouseDown={onHeaderMouseDown} className="mb-3 flex shrink-0 cursor-move select-none items-center gap-3 border-b border-[var(--inner-border)] pb-3">
          <div className="flex items-center gap-2" role="group" aria-label="Window controls">
            <button type="button" onClick={requestClose} aria-label="Close dialog" title="Close" className="grid size-3.5 place-items-center rounded-full bg-[#ff5f57] text-[#7a1c17] transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff5f57]">
              <X size={9} strokeWidth={2.5} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => setMinimized((value) => !value)} aria-label={minimized ? "Restore dialog" : "Minimize dialog"} title={minimized ? "Restore" : "Minimize"} className="grid size-3.5 place-items-center rounded-full bg-[#febc2e] text-[#6d4b00] transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#febc2e]">
              <Minus size={9} strokeWidth={2.5} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => { setExpanded((value) => !value); setMinimized(false); }} aria-label={expanded ? "Restore dialog size" : "Expand dialog"} title={expanded ? "Restore" : "Expand"} className="grid size-3.5 place-items-center rounded-full bg-[#28c840] text-[#0b5a22] transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#28c840]">
              <Maximize2 size={8} strokeWidth={2.5} aria-hidden="true" />
            </button>
          </div>
          <h2 id="dashboard-dialog-title" className="min-w-0 flex-1 cursor-move select-none truncate text-center text-base font-bold">{title}</h2>
          <span className="w-[3.75rem]" aria-hidden="true" />
        </div>
        {!minimized && <>
          <div className="min-w-0 flex-1 select-text overflow-y-auto">{children}</div>
          {footer && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
        </>}
      </div>
    </div>,
    document.body,
  );
}
