import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "../../lib/cn";

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full border transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:opacity-40",
        checked
          ? "border-transparent bg-[var(--accent)] dark:bg-[#3a3a3e] dark:border-[#3a3a3e]"
          : "border-[var(--inner-border)] bg-[var(--track)]"
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "absolute left-0.5 top-0.5 block h-4 w-4 rounded-full bg-[#f8f8f8] shadow transition-transform duration-150 dark:bg-[#e8e8ea] dark:shadow-[0_1px_3px_rgba(0,0,0,0.4)]",
          checked ? "translate-x-[18px]" : "translate-x-0"
        )}
      />
    </SwitchPrimitive.Root>
  );
}
