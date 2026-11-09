import { useCallback, useEffect, useState } from "react";

type Theme = "dark" | "light";

function preferredTheme(): Theme {
  const stored = localStorage.getItem("ohmyomop-router.theme");
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Stores the selected theme locally and applies it at the document root. */
export function useTheme(): { readonly resolvedTheme: Theme; readonly setTheme: (theme: Theme) => void } {
  const [resolvedTheme, setResolvedTheme] = useState<Theme>(preferredTheme);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
    localStorage.setItem("ohmyomop-router.theme", resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback((theme: Theme): void => setResolvedTheme(theme), []);
  return { resolvedTheme, setTheme };
}
