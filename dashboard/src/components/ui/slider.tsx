import { cn } from "../../lib/cn";

export interface SliderProps {
  /** Current numeric value. */
  value: number;
  /** Minimum value (inclusive). */
  min: number;
  /** Maximum value (inclusive). */
  max: number;
  /** Step increment. Defaults to 1. */
  step?: number;
  /** Accessible label for the range input. */
  ariaLabel: string;
  /** Optional id forwarded to the native input. */
  id?: string;
  /** Called with the new numeric value on change. */
  onValueChange: (value: number) => void;
  /** Disabled state. */
  disabled?: boolean;
  /** Extra class for the wrapper. */
  className?: string;
}

/**
 * Reusable range slider — thin track, accent thumb, consistent with
 * dashboard design tokens. Wraps native `<input type="range">`.
 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  ariaLabel,
  id,
  onValueChange,
  disabled,
  className,
}: SliderProps) {
  return (
    <input
      id={id}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onValueChange(Number(event.target.value))}
      className={cn(
        // reset + track/thumb — works on WebKit + Firefox
        "h-1.5 w-full cursor-pointer appearance-none rounded-full bg-[var(--track)] accent-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50",
        "[&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-[var(--track)]",
        "[&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--accent)] [&::-webkit-slider-thumb]:shadow [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:active:scale-110",
        "[&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-[var(--track)]",
        "[&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[var(--accent)]",
        className,
      )}
    />
  );
}

export interface LabeledSliderProps extends SliderProps {
  label: string;
  description?: string;
  /** Formatted value shown on the right (e.g. "21%"). If omitted, shows raw number. */
  valueLabel?: string;
}

/**
 * Slider with label row + value display — the pattern used on
 * Customization (opacity / blur). Keeps label/description/value
 * layout consistent without duplicating markup per page.
 */
export function LabeledSlider({
  label,
  description,
  valueLabel,
  value,
  ...sliderProps
}: LabeledSliderProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-[var(--text-1)]">{label}</div>
          {description ? (
            <div className="text-[11px] leading-relaxed text-[var(--text-3)]">{description}</div>
          ) : null}
        </div>
        <span className="shrink-0 font-mono text-[11px] font-semibold tabular-nums text-[var(--text-2)]">
          {valueLabel ?? String(value)}
        </span>
      </div>
      <Slider value={value} {...sliderProps} />
    </div>
  );
}
