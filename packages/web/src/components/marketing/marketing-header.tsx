"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactElement } from "react";

interface NavItem {
  href: string;
  label: string;
}

// Mirrors the supplied HTML's 3-page nav (Home / Why AlltixOMS / Pricing)
// plus one addition: Login, so a visitor can reach the existing Clerk
// sign-in form (src/app/(app)/sign-in) straight from the marketing site --
// that's the one new nav entry; everything else here is a routed port of
// the original showPage()-driven single-page nav.
const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Home" },
  { href: "/why-alltixoms", label: "Why AlltixOMS" },
  { href: "/pricing", label: "Pricing" },
  { href: "/sign-in", label: "Login" },
];

/**
 * Public marketing header, shared by every app/(marketing) page via that
 * group's layout.tsx. A client component because it needs the mobile
 * hamburger's open/closed state and the current route (to highlight the
 * active nav tab) -- the original file did both with plain DOM JS
 * (toggleMobileNav(), showPage()'s classList.toggle), ported here to
 * React state + usePathname now that each page is a real route instead of
 * a JS-toggled <main id="page-*"> section.
 */
export function MarketingHeader(): ReactElement {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="site-nav">
      <div className="nav-inner">
        <Link className="logo" href="/">
          <span className="logo-mark">A</span>
          <span className="logo-text">
            AlltixOMS
            <span className="logo-sub">Order Management System</span>
          </span>
        </Link>
        <nav className="links">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`navlink${pathname === item.href ? " active" : ""}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="nav-cta">
          <Link className="btn btn-outline" href="/pricing">
            Pricing
          </Link>
          <Link className="btn btn-primary" href="/book-a-demo">
            Book a Demo
          </Link>
          <button
            className="hamburger"
            type="button"
            aria-label="Menu"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((open) => !open)}
          >
            ☰
          </button>
        </div>
      </div>
      <div className={`mobile-nav${mobileOpen ? " open" : ""}`}>
        {NAV_ITEMS.map((item) => (
          <Link key={item.href} href={item.href} className="navlink" onClick={() => setMobileOpen(false)}>
            {item.label}
          </Link>
        ))}
      </div>
    </header>
  );
}
