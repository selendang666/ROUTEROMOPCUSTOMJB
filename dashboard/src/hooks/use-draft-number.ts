/**
 * Draft number input — string state with clamp on blur.
 * @param initial - initial number
 * @param opts - min/max/onCommit
 * @returns value/onChange/onBlur/onKeyDown
 */
import { useCallback, useState, type ChangeEvent, type KeyboardEvent } from "react";

export function useDraftNumber(
  initial: number,
  opts: { readonly min?: number; readonly max?: number; readonly onCommit: (n: number) => void },
) {
  const [value, setValue] = useState(String(initial));
  const commit = useCallback(() => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      setValue(String(initial));
      return;
    }
    let clamped = parsed;
    if (opts.min !== undefined) clamped = Math.max(opts.min, clamped);
    if (opts.max !== undefined) clamped = Math.min(opts.max, clamped);
    setValue(String(clamped));
    opts.onCommit(clamped);
  }, [value, initial, opts]);

  const onChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setValue(event.target.value);
  }, []);

  const onBlur = useCallback(() => {
    commit();
  }, [commit]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") commit();
      if (event.key === "Escape") setValue(String(initial));
    },
    [commit, initial],
  );

  return { value, onChange, onBlur, onKeyDown };
}
