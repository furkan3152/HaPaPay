import { useEffect, useRef, useState, type MouseEvent } from "react";

/**
 * Copies a text and says so on the button for two seconds. Where the browser refuses, it selects the text shown beside
 * it (the `code` in the same row) to copy by hand (audit, 2026-10-06: the Copy buttons gave no sign either way).
 */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy(event: MouseEvent<HTMLButtonElement>) {
    const row = event.currentTarget.parentElement;
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
      const code = row?.querySelector("code");
      const selection = window.getSelection();
      if (code && selection) {
        const range = document.createRange();
        range.selectNodeContents(code);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    timer.current = window.setTimeout(() => setState("idle"), 2_000);
  }

  return <button type="button" onClick={(event) => void copy(event)} aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Selected: copy it" : label}</button>;
}
