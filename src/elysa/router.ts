import { useEffect, useState } from "react";

/** The page's path, kept in step with the history API so links move without reloading. */
export function usePath() {
  const [path, setPath] = useState(() => window.location.pathname + window.location.search);
  useEffect(() => {
    const update = () => setPath(window.location.pathname + window.location.search);
    window.addEventListener("popstate", update);
    window.addEventListener("elysa:navigate", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("elysa:navigate", update);
    };
  }, []);
  return path;
}

export function navigate(to: string, options: { replace?: boolean } = {}) {
  if (to === window.location.pathname + window.location.search) return;
  const go = () => {
    window.history[options.replace ? "replaceState" : "pushState"](null, "", to);
    window.dispatchEvent(new Event("elysa:navigate"));
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  };
  const doc = document as Document & { startViewTransition?: (callback: () => void) => unknown };
  if (doc.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) doc.startViewTransition(go);
  else go();
}

/** An in-app link: a real anchor that moves without a reload on a plain click. */
export function linkProps(to: string) {
  return {
    href: to,
    onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(to);
    },
  };
}
