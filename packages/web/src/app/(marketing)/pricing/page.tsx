import Link from "next/link";
import type { ReactElement } from "react";

export const metadata = {
  title: "Pricing — AlltixOMS",
  description: "One monthly price, no hidden extras — plus a one-time setup fee that gets everything fully configured for you.",
};

/**
 * Routed port of the "Pricing" page from the supplied HTML. Numbers and
 * copy are exactly what was in the file, including its own "Placeholder
 * pricing — figures shown are illustrative" note -- that note is Arif's own
 * flag in the source file to confirm real numbers before this goes fully
 * live, not something this pass invented.
 */
export default function PricingPage(): ReactElement {
  return (
    <main>
      <section style={{ paddingTop: 64 }}>
        <div className="wrap">
          <div className="section-head">
            <span className="eyebrow">Pricing</span>
            <p className="hero-tagline">
              One platform. <span className="hl">Every channel</span> you sell in.
            </p>
            <h2>Pricing that&apos;s easy to say yes to.</h2>
            <p className="lead" style={{ margin: "0 auto" }}>
              One monthly price, no hidden extras — plus a one-time setup fee that gets everything fully
              configured and running for you, start to finish.
            </p>
          </div>

          <div className="price-grid">
            <div className="price-card">
              <h3>Starter Plan</h3>
              <div className="price-amount">
                $56<span>&nbsp;/mo</span>
              </div>
              <div className="price-sub" style={{ color: "var(--amber)", fontWeight: 700, marginBottom: 6 }}>
                + $199 one-time, to get you set up and running
              </div>
              <div className="price-sub">Perfect for sellers outgrowing spreadsheets</div>
              <ul className="price-features">
                <li>
                  <span className="tick">✓</span> Up to 2 sales channels, connected for you
                </li>
                <li>
                  <span className="tick">✓</span> Orders &amp; inventory stay in sync automatically
                </li>
                <li>
                  <span className="tick">✓</span> Easy-to-read reporting
                </li>
                <li>
                  <span className="tick">✓</span> Friendly email support, fast replies
                </li>
              </ul>
              <Link className="btn btn-outline" href="/book-a-demo">
                Get Started
              </Link>
            </div>

            <div className="price-card featured">
              <span className="badge-pop">Most Popular</span>
              <h3>Growth Plan</h3>
              <div className="price-amount">
                $170<span>&nbsp;/mo</span>
              </div>
              <div className="price-sub" style={{ color: "var(--amber)", fontWeight: 700, marginBottom: 6 }}>
                + $349 one-time, to get you set up and running
              </div>
              <div className="price-sub">Built for teams selling across more channels</div>
              <ul className="price-features">
                <li>
                  <span className="tick">✓</span> Unlimited sales channels
                </li>
                <li>
                  <span className="tick">✓</span> Automations that do the busywork for you
                </li>
                <li>
                  <span className="tick">✓</span> Deeper reporting &amp; insights
                </li>
                <li>
                  <span className="tick">✓</span> Priority support — real people, real fast
                </li>
                <li>
                  <span className="tick">✓</span> We handle your onboarding, start to finish
                </li>
              </ul>
              <Link className="btn btn-primary" href="/book-a-demo">
                Get Started
              </Link>
            </div>

            <div className="price-card">
              <h3>Scale Plan</h3>
              <div className="price-amount" style={{ fontSize: 26 }}>
                Let&apos;s talk
              </div>
              <div className="price-sub" style={{ color: "var(--amber)", fontWeight: 700, marginBottom: 6 }}>
                Setup scoped around your rollout
              </div>
              <div className="price-sub">For high-volume sellers who need extra hands</div>
              <ul className="price-features">
                <li>
                  <span className="tick">✓</span> Everything in the Growth Plan
                </li>
                <li>
                  <span className="tick">✓</span> Multiple warehouses &amp; 3PL, handled
                </li>
                <li>
                  <span className="tick">✓</span> A dedicated person who knows your account
                </li>
                <li>
                  <span className="tick">✓</span> A setup plan built around you
                </li>
              </ul>
              <Link className="btn btn-dark" href="/book-a-demo">
                Talk to Sales
              </Link>
            </div>
          </div>
          <p className="note-pill">Placeholder pricing — figures shown are illustrative; confirm final numbers before publishing.</p>
        </div>
      </section>

      <section>
        <div className="wrap">
          <div className="section-head left">
            <span className="eyebrow">FAQ</span>
            <h2>Questions sellers ask before switching</h2>
          </div>
          <div className="faq">
            <h3>What does the one-time setup fee actually cover?</h3>
            <p>
              It&apos;s what gets your system fully set up and running: connecting your channels, migrating your
              existing data, and a guided go-live with a real person on hand — not a self-service checklist.
            </p>
          </div>
          <div className="faq">
            <h3>Can I pay monthly instead of committing to a year?</h3>
            <p>Yes. Monthly billing is available on every plan — annual billing is optional, not required.</p>
          </div>
          <div className="faq">
            <h3>How long does migration actually take?</h3>
            <p>Most sellers are live within days using guided onboarding, not a multi-month implementation project.</p>
          </div>
          <div className="faq">
            <h3>Will my existing integrations keep working?</h3>
            <p>We actively monitor marketplace API changes and patch integrations proactively, so you&apos;re not caught off guard mid-peak-season.</p>
          </div>
          <div className="faq">
            <h3>What happens to pricing at renewal?</h3>
            <p>Your price is transparent from day one — no surprise double-digit renewal hikes.</p>
          </div>
        </div>
      </section>

      <section>
        <div className="wrap">
          <div className="cta-band">
            <p className="hero-tagline">
              One platform. <span className="hl">Every channel</span> you sell in.
            </p>
            <h2>Still deciding? Talk to a human, not a script.</h2>
            <p>15 minutes to see if AlltixOMS is the right fit — no pressure, no hard sell.</p>
            <div className="hero-actions">
              <Link className="btn btn-primary" href="/book-a-demo">
                Book a Demo
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
