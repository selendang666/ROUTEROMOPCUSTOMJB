import { cn } from "../../lib/cn";

export function Tabs({
  tabs,
  value,
  onChange,
  panelId,
  ariaLabel,
}: {
  tabs: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
  panelId?: string;
  ariaLabel?: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          id={`${tab.id}-tab`}
          role="tab"
          aria-selected={value === tab.id}
          aria-controls={panelId}
          tabIndex={value === tab.id ? 0 : -1}
          onClick={() => onChange(tab.id)}
          className={cn(
            "rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-[color,background-color,border-color,transform] duration-150 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]",
            value === tab.id
              ? "border-transparent bg-[var(--accent-soft)] text-[var(--accent)]"
              : "border-[var(--inner-border)] bg-[var(--hover)] text-[var(--text-2)] hover:bg-[var(--active-pill)] hover:text-[var(--text-1)]"
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

