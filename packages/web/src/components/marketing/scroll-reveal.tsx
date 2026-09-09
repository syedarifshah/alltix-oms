"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

// Every classname below already exists, unchanged, in the marketing pages
// (page.tsx / why-alltixoms / pricing / book-a-demo) -- this file adds no
// markup and no new classnames, only behavior. `.demo-form` is deliberately
// left out: BookDemoForm swaps its whole tree for a "Thanks -- we've got
// it" success card after submit, which would never get observed (it isn't
// in the DOM at mount time) and would be stuck at opacity: 0 forever if it
// were included -- see marketing.module.css for the matching reveal rules.
const REVEAL_SELECTOR = [
  ".hero",
  ".trust-item",
  ".section-head",
  ".testi-card",
  ".card",
  ".compare-wrap",
  ".step",
  ".cta-band",
  ".price-card",
  ".faq",
  ".logo-row",
].join(", ");

/**
 * Progressive-enhancement scroll reveal for the public marketing site:
 * fades + slides each section/card into place the first time it scrolls
 * into view. Rendered once from app/(marketing)/layout.tsx, which stays
 * mounted across client-side navigation between the four marketing pages
 * -- so this re-runs on `pathname` change (same pattern MarketingHeader
 * already uses for its active-tab highlight) to find and observe the new
 * page's elements instead of only ever seeing the first page rendered.
 *
 * The corresponding CSS (marketing.module.css) only hides these elements
 * pre-reveal inside `@media (prefers-reduced-motion: no-preference)`, so a
 * visitor who has asked for reduced motion -- or whose browser lacks
 * IntersectionObserver, handled below -- simply sees everything rendered
 * visible immediately; nothing can get stuck invisible waiting on JS that
 * a user has opted out of.
 */
export function ScrollReveal(): null {
  const pathname = usePathname();

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const targets = Array.from(document.querySelectorAll<HTMLElement>(REVEAL_SELECTOR));
    if (targets.length === 0) {
      return;
    }

    const revealAll = (): void => {
      for (const el of targets) {
        el.setAttribute("data-revealed", "true");
      }
    };

    if (typeof IntersectionObserver === "undefined") {
      // No API support -- reveal immediately rather than leaving content
      // hidden with no way to un-hide it.
      revealAll();
      return;
    }

    let observer: IntersectionObserver;
    try {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              entry.target.setAttribute("data-revealed", "true");
              observer.unobserve(entry.target);
            }
          }
        },
        { threshold: 0.15, rootMargin: "0px 0px -40px 0px" },
      );
    } catch {
      revealAll();
      return;
    }

    for (const el of targets) {
      observer.observe(el);
    }

    return () => {
      observer.disconnect();
    };
  }, [pathname]);

  return null;
}
