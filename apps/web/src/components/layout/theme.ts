export const THEME_STORAGE_KEY = "omo-control.theme.v1";
export type ThemeName = "light" | "dark";

const THEME_COLOR: Record<ThemeName, string> = {
  light: "#FAFBFC",
  dark: "#15191E",
};

export function isThemeName(value: unknown): value is ThemeName {
  return value === "light" || value === "dark";
}

export function readStoredTheme(): ThemeName {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeName(stored) ? stored : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(theme: ThemeName): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLOR[theme]);
}

export function persistTheme(theme: ThemeName): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* private mode / blocked storage */
  }
  applyTheme(theme);
}
