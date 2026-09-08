import Link from "next/link";
import type { ReactElement } from "react";

export const metadata = {
  title: "AlltixOMS — Order Management, Simplified",
  description:
    "AlltixOMS is the order management platform built for e-commerce brands who are done with slow support tickets, buried fees, and month-long onboarding.",
};

/**
 * Public home page (alltixoms.com/). Content is a routed port of the "Home"
 * page from the supplied alltixoms_site.html -- same copy, same section
 * order (Hero -> Trust bar -> Testimonials -> 6 benefits -> Comparison
 * teaser -> 3 steps -> CTA band), same class names (styled by
 * marketing.module.css via the (marketing) layout). Only the CTAs changed:
 * every button that used to fire a JS alert() placeholder now links
 * somewhere real (/book-a-demo, /pricing, /why-alltixoms).
 */
export default function MarketingHomePage(): ReactElement {
  return (
    <main>
      <section className="hero">
        <div className="wrap hero-grid">
          <div>
            <span className="eyebrow">● Order Management, Reinvented</span>
            <p className="hero-tagline">
              One platform. <span className="hl">Every channel</span> you sell in.
            </p>
            <h1>
              Sell more.
              <br />
              Chase less.
            </h1>
            <p className="lead">
              AlltixOMS is the order management platform built for e-commerce brands who are done with slow
              support tickets, buried fees, and month-long onboarding. Get live in days — not quarters.
            </p>
            <div className="hero-actions">
              <Link className="btn btn-primary" href="/book-a-demo">
                Book a Demo
              </Link>
              <Link className="btn btn-outline" href="/pricing">
                See Pricing
              </Link>
            </div>
            <div className="hero-meta">
              <div>
                <span className="check-dot">✓</span> No forced annual lock-in
              </div>
              <div>
                <span className="check-dot">✓</span> Human support, fast
              </div>
              <div>
                <span className="check-dot">✓</span> Live in days
              </div>
            </div>
          </div>
          <div className="hero-visual">
            <div className="hv-card">
              <div className="hv-row">
                <span>Support response time</span>
                <span className="hv-badge">2h avg</span>
              </div>
              <div className="hv-bar">
                <span style={{ width: "92%" }} />
              </div>
            </div>
            <div className="hv-card">
              <div className="hv-row">
                <span>Orders synced today</span>
                <span className="hv-stat" style={{ fontSize: 18 }}>
                  12,480
                </span>
              </div>
              <div className="hv-bar">
                <span style={{ width: "100%" }} />
              </div>
            </div>
            <div className="hv-card">
              <div className="hv-row" style={{ alignItems: "flex-end" }}>
                <div>
                  <div className="hv-label">Time to go live</div>
                  <div className="hv-stat">6 days</div>
                </div>
                <div>
                  <div className="hv-label">Uptime</div>
                  <div className="hv-stat">99.98%</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="trust-bar">
        <div className="trust-item">
          <span className="ti-ico">🔒</span> Data encrypted in transit &amp; at rest
        </div>
        <div className="trust-item">
          <span className="ti-ico">🕐</span> 99.98% uptime target
        </div>
        <div className="trust-item">
          <span className="ti-ico">💬</span> Real people, real fast
        </div>
        <div className="trust-item">
          <span className="ti-ico">🔄</span> No long-term lock-in
        </div>
      </div>

      <section>
        <div className="wrap">
          <div className="section-head">
            <span className="eyebrow">Trusted by growing sellers</span>
            <h2>Sellers notice the difference fast.</h2>
          </div>
          <div className="testi-grid">
            <div className="testi-card">
              <div className="testi-stars">★★★★★</div>
              <p className="tq">
                &quot;We finally stopped babysitting our order management system and started running our
                business.&quot;
              </p>
              <div className="testi-who">
                <div className="testi-avatar">JD</div>
                <div>
                  <div className="testi-name">Placeholder Name</div>
                  <div className="testi-role">Ops Lead, Placeholder Brand</div>
                </div>
              </div>
            </div>
            <div className="testi-card">
              <div className="testi-stars">★★★★★</div>
              <p className="tq">
                &quot;Support actually answers. That alone was worth switching for after years of waiting on
                tickets.&quot;
              </p>
              <div className="testi-who">
                <div className="testi-avatar">AK</div>
                <div>
                  <div className="testi-name">Placeholder Name</div>
                  <div className="testi-role">Founder, Placeholder Brand</div>
                </div>
              </div>
            </div>
            <div className="testi-card">
              <div className="testi-stars">★★★★★</div>
              <p className="tq">
                &quot;We were live in under two weeks. Our old platform took us four months and we still had
                bugs.&quot;
              </p>
              <div className="testi-who">
                <div className="testi-avatar">MR</div>
                <div>
                  <div className="testi-name">Placeholder Name</div>
                  <div className="testi-role">COO, Placeholder Brand</div>
                </div>
              </div>
            </div>
          </div>
          <p className="note-pill">Placeholder testimonials — swap in real customer quotes once available.</p>
          <div className="logo-row">
            <div>BRAND ONE</div>
            <div>BRAND TWO</div>
            <div>BRAND THREE</div>
            <div>BRAND FOUR</div>
            <div>BRAND FIVE</div>
          </div>
        </div>
      </section>

      <section style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="section-head">
            <span className="eyebrow">Why teams switch to us</span>
            <h2>Everything the old platforms made hard, made simple.</h2>
            <p>Six reasons growing e-commerce sellers move to AlltixOMS.</p>
          </div>
          <div className="grid-3">
            <div className="card">
              <div className="ico">⚡</div>
              <h3>Fast, human support</h3>
              <p>Real answers in hours, not months. No ticket black holes, no chasing a case number for weeks.</p>
            </div>
            <div className="card">
              <div className="ico">$</div>
              <h3>Transparent pricing</h3>
              <p>One clear price, published up front. No renewal shock, no hidden per-seat or per-integration fees.</p>
            </div>
            <div className="card">
              <div className="ico">≋</div>
              <h3>Flexible terms</h3>
              <p>Monthly billing available. Prove the fit for your business before you ever sign a long-term contract.</p>
            </div>
            <div className="card">
              <div className="ico">▶</div>
              <h3>Live in days</h3>
              <p>Guided onboarding gets you fully operational fast — not a 3–6 month implementation project.</p>
            </div>
            <div className="card">
              <div className="ico">◧</div>
              <h3>Built for your team</h3>
              <p>A modern, intuitive interface your team runs from week one. No dedicated &quot;platform expert&quot; required.</p>
            </div>
            <div className="card">
              <div className="ico">↻</div>
              <h3>Integrations that just work</h3>
              <p>We monitor and patch marketplace API changes before they become your problem — especially during peak season.</p>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="wrap">
          <div className="section-head">
            <span className="eyebrow">Switching from a legacy OMS?</span>
            <h2>You&apos;re not alone — and the difference shows up fast.</h2>
            <p>A quick look at how AlltixOMS stacks up against the order management platforms most sellers are leaving behind.</p>
          </div>
          <div className="compare-wrap">
            <table className="compare">
              <thead>
                <tr>
                  <th>What matters</th>
                  <th>Traditional OMS platforms</th>
                  <th className="colhead-new">AlltixOMS</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Support response</td>
                  <td className="old">Days to months per ticket</td>
                  <td className="new">Hours, with a real person</td>
                </tr>
                <tr>
                  <td>Pricing model</td>
                  <td className="old">Hidden tiers, add-on fees</td>
                  <td className="new">One transparent price</td>
                </tr>
                <tr>
                  <td>Time to launch</td>
                  <td className="old">3–6 month implementation</td>
                  <td className="new">Days, with guided onboarding</td>
                </tr>
                <tr>
                  <td>Integration reliability</td>
                  <td className="old">Breaks silently on API changes</td>
                  <td className="new">Monitored and patched for you</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="note-pill">
            <Link href="/why-alltixoms" style={{ color: "var(--accent)", fontWeight: 700 }}>
              See the full comparison on the Why AlltixOMS page →
            </Link>
          </p>
        </div>
      </section>

      <section>
        <div className="wrap">
          <div className="section-head">
            <span className="eyebrow">How switching works</span>
            <h2>Three steps. No war stories.</h2>
            <p>Migrations have a reputation for being painful. Here&apos;s why yours won&apos;t be.</p>
          </div>
          <div className="steps">
            <div className="step">
              <div className="step-num">1</div>
              <h3>Connect your channels</h3>
              <p>Link your sales channels, warehouse, and existing data in a guided setup session with a real specialist — not a help article.</p>
            </div>
            <div className="step">
              <div className="step-num">2</div>
              <h3>We migrate your data</h3>
              <p>Orders, inventory, and history move over with our team doing the heavy lifting alongside you, not leaving you to figure it out solo.</p>
            </div>
            <div className="step">
              <div className="step-num">3</div>
              <h3>Go live, in days</h3>
              <p>Launch with confidence, with support on standby for the first weeks — because week one shouldn&apos;t feel like a leap of faith.</p>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="wrap">
          <div className="cta-band">
            <h2>Ready for order management that doesn&apos;t fight you?</h2>
            <p>See how fast a real migration can be — no long sales cycle, no pressure.</p>
            <div className="hero-actions">
              <Link className="btn btn-primary" href="/book-a-demo">
                Book a Demo
              </Link>
              <Link className="btn btn-light" href="/why-alltixoms">
                Why AlltixOMS →
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
