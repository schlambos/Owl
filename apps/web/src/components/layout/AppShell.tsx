import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";
import { ConnectionBar } from "../ConnectionBar";
import { ContextNav } from "./ContextNav";
import { NavigateMenu } from "./NavigateMenu";
import { PrimaryNav } from "./PrimaryNav";
import { useMediaQuery } from "./useMediaQuery";

export function AppShell(props: { children: ReactNode }) {
  const { pathname, search } = useLocation();
  const compact = useMediaQuery("(max-width: 799px)");
  const path = `${pathname}${search}`;

  return (
    <div className="omo-shell">
      <a className="omo-skip" href="#main-content">
        Skip to content
      </a>
      <header className="omo-chrome">
        <div className="omo-topbar">
          <div className="omo-brand">
            <span className="omo-brand-name">Owl</span>
          </div>
          <div className="omo-primary-slot">
            {compact ? (
              <NavigateMenu pathname={path} />
            ) : (
              <PrimaryNav pathname={path} />
            )}
          </div>
          <div className="omo-utilities">
            <ThemeToggle />
            <ConnectionBar />
          </div>
        </div>
        {!compact ? <ContextNav pathname={path} /> : null}
      </header>
      <main className="omo-main" id="main-content">
        {props.children}
      </main>
    </div>
  );
}
