"use client";

import { useEffect, useState } from "react";

/**
 * The landing header's small-screen navigation.
 *
 * The desktop nav is hidden under 720px; this supplies the same links behind a
 * hamburger toggle. Kept as its own client component so the server-rendered
 * page stays static — only the open/closed state needs the client.
 */
export function MobileMenu({ readyCount }: { readyCount: number }) {
  const [open, setOpen] = useState(false);

  // Close on Escape, and lock body scroll while the sheet is open so the page
  // behind it does not move under the finger.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <div className="l-mobile">
      <button
        type="button"
        className="l-menu-btn"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12" />
            <path d="M18 6L6 18" />
          </svg>
        ) : (
          <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
            <path d="M3 6h18" />
            <path d="M3 12h18" />
            <path d="M3 18h18" />
          </svg>
        )}
      </button>

      {open && (
        <>
          <div className="l-mobile-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <nav className="l-mobile-sheet">
            <a href="#capabilities" onClick={() => setOpen(false)}>
              Capabilities
            </a>
            <a href="#start" onClick={() => setOpen(false)}>
              How it works
            </a>
            <a
              href="https://github.com/sonukrr/ai-cs-builder"
              target="_blank"
              rel="noreferrer"
              onClick={() => setOpen(false)}
            >
              GitHub
            </a>
            <span className="l-mobile-status">
              <i /> {readyCount} agents ready
            </span>
            <a
              href="#start"
              className="l-btn l-btn--primary white-btn"
              onClick={() => setOpen(false)}
            >
              Start building
            </a>
          </nav>
        </>
      )}
    </div>
  );
}
