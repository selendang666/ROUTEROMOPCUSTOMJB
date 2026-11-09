import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Shared surface for floating controls. Base styling stays identical across desktop/mobile; callers only extend placement/width. */
export function PopoverPanel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("z-50 max-h-[min(70vh,28rem)] overflow-y-auto rounded-2xl p-3 text-[var(--text-1)] card-solid card-elevated", className)}>{children}</div>;
}
