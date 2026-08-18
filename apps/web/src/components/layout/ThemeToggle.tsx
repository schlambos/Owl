import { Moon, Sun } from "lucide-react";
import { IconButton } from "../ui/IconButton";
import { useTheme } from "./ThemeProvider";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <IconButton
      label={next === "dark" ? "Use dark theme" : "Use light theme"}
      onClick={toggleTheme}
      data-testid="theme-toggle"
    >
      {theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
    </IconButton>
  );
}
