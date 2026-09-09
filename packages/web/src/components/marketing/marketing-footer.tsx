import Link from "next/link";
import type { ReactElement } from "react";

/**
 * Static footer, shared by every app/(marketing) page. A direct port of the
 * supplied HTML's footer, with two changes beyond routing (JS showPage()
 * calls -> real <Link>s): Privacy/Terms now point at the real, already-live
 * /privacy and /terms pages instead of the file's `onclick="return false"`
 * placeholders, and Contact points at /book-a-demo (the one real lead
 * channel this pass wires up). About/Careers have no real destination yet
 * and stay inert, same as the source file.
 */
export function MarketingFooter(): ReactElement {
  return (
    <footer>
      <div className="wrap">
        <div className="footer-grid">
          <div>
            <Link className="logo" href="/">
              {/* eslint-disable-next-line @next/next/no-img-element -- a small, fixed
                  brand mark; not worth the next/image config for a single static file */}
              <img className="logo-mark" src="/logo-mark.png" alt="" width={36} height={39} />
              <span className="logo-text">
                AlltixOMS
                <span className="logo-sub">Order Management System</span>
              </span>
            </Link>
            <p className="hero-tagline" style={{ fontSize: 14.5, marginTop: 14, marginBottom: 8 }}>
              One platform. <span className="hl">Every channel</span> you sell in.
            </p>
            <p style={{ maxWidth: 280, fontSize: 14 }}>
              Order management built for e-commerce brands who want to sell more and chase less.
            </p>
          </div>
          <div>
            <h4>Product</h4>
            <Link href="/">Home</Link>
            <Link href="/why-alltixoms">Why AlltixOMS</Link>
            <Link href="/pricing">Pricing</Link>
          </div>
          <div>
            <h4>Company</h4>
            <a href="#">About (placeholder)</a>
            <a href="#">Careers (placeholder)</a>
            <Link href="/book-a-demo">Contact</Link>
          </div>
          <div>
            <h4>Legal</h4>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
          </div>
        </div>
        <div className="footer-bottom">
          <div>Â© 2026 AlltixOMS. All rights reserved.</div>
          <div>hello@alltixoms.com (placeholder)</div>
        </div>
      </div>
    </footer>
  );
}
