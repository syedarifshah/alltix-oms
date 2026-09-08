import Link from "next/link";
import type { ReactElement } from "react";

export const metadata = {
  title: "Why AlltixOMS — Order Management, Simplified",
  description:
    "Built for sellers who outgrew spreadsheets — and outgrew clunky legacy order management platforms too.",
};

/** Routed port of the "Why AlltixOMS" page from the supplied HTML. */
export default function WhyAlltixOmsPage(): ReactElement {
  return (
    <main>
      <section style={{ paddingTop: 64 }}>
        <div className="wrap">
          <div className="section-head">
            <span className="eyebrow">Why AlltixOMS</span>
            <p className="hero-tagline">
              One platform. <span className="hl">Every channel</span> you sell in.
            </p>
            <h2>Built for sellers who outgrew spreadsheets — and outgrew clunky legacy platforms too.</h2>
            <p className="lead" style={{ margin: "0 auto" }}>
              Most order management platforms were built a decade ago and it shows: slow support, buried
              pricing, and interfaces that need a manual. Here&apos;s the difference.
            </p>
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
                  <td>Contract terms</td>
                  <td className="old">Annual only, auto-renew hikes</td>
                  <td className="new">Monthly or annual, your choice</td>
                </tr>
                <tr>
                  <td>Time to launch</td>
                  <td className="old">3–6 month implementation</td>
                  <td className="new">Days, with guided onboarding</td>
                </tr>
                <tr>
                  <td>Learning curve</td>
                  <td className="old">Weeks of training, dedicated admin</td>
                  <td className="new">Productive from week one</td>
                </tr>
                <tr>
                  <td>Integration reliability</td>
                  <td className="old">Breaks silently on API changes</td>
                  <td className="new">Monitored and patched for you</td>
                </tr>
                <tr>
                  <td>Reporting accuracy</td>
                  <td className="old">Cancellations/returns often misstated</td>
                  <td className="new">Accurate order lifecycle by default</td>
                </tr>
                <tr>
                  <td>Roadmap focus</td>
                  <td className="old">Shifts to enterprise post-acquisition</td>
                  <td className="new">Shaped by customer feedback</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="note-pill">
            Comparisons reflect commonly reported experiences with legacy OMS platforms, based on public
            reviews — not a specific named competitor.
          </p>
        </div>
      </section>

      <section>
        <div className="wrap">
          <div className="section-head left">
            <span className="eyebrow">Platform</span>
            <h2>Everything you need to run orders, inventory, and fulfillment in one place.</h2>
          </div>
          <div className="grid-3">
            <div className="card">
              <div className="ico">⇄</div>
              <h3>Order sync</h3>
              <p>Every channel, one queue. Orders flow in and update in real time, no manual reconciliation.</p>
            </div>
            <div className="card">
              <div className="ico">▤</div>
              <h3>Inventory management</h3>
              <p>Live stock levels across warehouses and channels, with low-stock alerts before you oversell.</p>
            </div>
            <div className="card">
              <div className="ico">☷</div>
              <h3>Multi-channel listings</h3>
              <p>Manage listings across your sales channels from a single, consistent source of truth.</p>
            </div>
            <div className="card">
              <div className="ico">↺</div>
              <h3>Returns &amp; exchanges</h3>
              <p>A returns workflow that actually updates your books correctly — no manual journal entries.</p>
            </div>
            <div className="card">
              <div className="ico">▦</div>
              <h3>Reporting &amp; analytics</h3>
              <p>Dashboards that reflect real order status, including cancellations and returns, out of the box.</p>
            </div>
            <div className="card">
              <div className="ico">⚙</div>
              <h3>Automation rules</h3>
              <p>Set rules once — routing, fulfillment, alerts — and let AlltixOMS handle the repetitive work.</p>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="wrap">
          <div className="cta-band">
            <h2>See it running on your own catalog.</h2>
            <p>A real walkthrough, not a canned demo script.</p>
            <div className="hero-actions">
              <Link className="btn btn-primary" href="/book-a-demo">
                Book a Demo
              </Link>
              <Link className="btn btn-light" href="/pricing">
                See Pricing →
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
