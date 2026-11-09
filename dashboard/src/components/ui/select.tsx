import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../../lib/cn";

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  ariaLabel?: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Radix Select wrapper — replaces native `<select>` kotak.
 * Keeps same props as the old tabs.tsx Select (value/onChange/options)
 * but renders portal content with card-elevated + accent highlight.
 */
export function Select({
  value,
  onChange,
  options,
  ariaLabel,
  className,
  placeholder = "Select…",
  disabled,
}: SelectProps) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cn(
          "flex h-8 min-w-[8rem] items-center justify-between gap-2 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-2.5 py-0 text-xs font-medium text-[var(--text-1)] outline-none transition-colors hover:bg-[var(--active-pill)] focus-visible:border-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)] disabled:opacity-50",
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon asChild>
          <ChevronDown size={14} className="shrink-0 text-[var(--text-3)] opacity-70" aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className="card-solid card-elevated z-50 min-w-[8rem] max-h-[min(22rem,60vh)] overflow-hidden rounded-xl p-1 shadow-[var(--shadow-card)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1"
        >
          <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center bg-[var(--surface-1)] text-[var(--text-3)]">
            <ChevronDown size={12} className="rotate-180" />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="p-1">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                className="relative flex w-full cursor-default select-none items-center rounded-[var(--radius-control)] py-1.5 pl-7 pr-2 text-xs font-medium text-[var(--text-1)] outline-none data-[highlighted]:bg-[var(--accent-soft)] data-[highlighted]:text-[var(--accent)] data-[state=checked]:bg-[var(--accent-soft)] data-[state=checked]:text-[var(--accent)] focus:bg-[var(--accent-soft)]"
              >
                <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
                  <SelectPrimitive.ItemIndicator>
                    <Check size={12} aria-hidden="true" />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center bg-[var(--surface-1)] text-[var(--text-3)]">
            <ChevronDown size={12} />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
