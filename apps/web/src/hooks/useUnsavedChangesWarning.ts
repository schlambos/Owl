import { useEffect } from "react";

/**
 * Warn before refresh/close and before in-app link navigation that would
 * discard a dirty draft. Same-path search-param changes stay allowed
 * unless `block` says otherwise.
 */
export function useUnsavedChangesWarning(
  dirty: boolean,
  message: string,
  block?: (next: { pathname: string; search: string }) => boolean,
): void {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = message;
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty, message]);

  useEffect(() => {
    if (!dirty) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) return;
      let next: URL;
      try {
        const base =
          window.location?.href && /^https?:/i.test(window.location.href)
            ? window.location.href
            : "http://localhost/";
        next = new URL(href, base);
      } catch {
        return;
      }
      const currentOrigin = (() => {
        try {
          return new URL(window.location.href).origin;
        } catch {
          return next.origin;
        }
      })();
      if (next.origin !== currentOrigin) return;
      const leavingPath = next.pathname !== (window.location.pathname || "/");
      const shouldBlock = block
        ? block({ pathname: next.pathname, search: next.search })
        : leavingPath;
      if (!shouldBlock) return;
      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty, message, block]);
}
