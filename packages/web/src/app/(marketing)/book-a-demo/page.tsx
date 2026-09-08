import type { ReactElement } from "react";
import { BookDemoForm } from "@/components/marketing/book-demo-form";

export const metadata = {
  title: "Book a Demo — AlltixOMS",
  description: "See AlltixOMS running on your own catalog -- a real walkthrough, not a canned demo script.",
};

/**
 * New page -- the supplied HTML had "Book a Demo" buttons everywhere but no
 * actual demo-request page/form to send them to. Follows the same
 * hero-tagline + section-head pattern as the other marketing pages, with
 * BookDemoForm (a new component, see its own header comment) as the page's
 * one piece of real functionality.
 */
export default function BookADemoPage(): ReactElement {
  return (
    <main>
      <section style={{ paddingTop: 64 }}>
        <div className="wrap">
          <div className="section-head">
            <span className="eyebrow">Book a Demo</span>
            <p className="hero-tagline">
              One platform. <span className="hl">Every channel</span> you sell in.
            </p>
            <h2>See it running on your own catalog.</h2>
            <p className="lead" style={{ margin: "0 auto" }}>
              A real walkthrough with a real person, not a canned demo script. Tell us a bit about your
              business and we&apos;ll find a time that works.
            </p>
          </div>
          <BookDemoForm />
        </div>
      </section>
    </main>
  );
}
