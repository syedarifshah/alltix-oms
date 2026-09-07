import type { ReactElement } from "react";

export const metadata = {
  title: "Terms of Service | Alltix OMS",
  description: "The terms that govern use of Alltix OMS.",
};

// Public, unauthenticated legal page -- see src/proxy.ts's isPublicRoute
// matcher, which must include "/terms" or Clerk will gate it behind
// sign-in. Linked from the Privacy Policy page and Google's OAuth consent
// screen (Branding page).
export default function TermsOfServicePage(): ReactElement {
  return (
    <main className="page">
      <h1>Terms of Service</h1>
      <p className="subtitle">Last updated: September 2026</p>

      <div className="card stack">
        <section>
          <h2>1. Agreement to terms</h2>
          <p>
            These Terms of Service (&quot;Terms&quot;) govern your access to and use of Alltix OMS
            (&quot;Alltix&quot;, &quot;we&quot;, &quot;us&quot;), a multichannel order and inventory
            management platform available at alltixoms.com. By creating an account or using the
            service, you agree to these Terms.
          </p>
        </section>

        <section>
          <h2>2. Your account</h2>
          <p>
            You are responsible for maintaining the confidentiality of your account credentials and
            for all activity that occurs under your account. You must provide accurate information
            when registering and connecting sales channels.
          </p>
        </section>

        <section>
          <h2>3. Connected marketplaces</h2>
          <p>
            When you connect a sales channel (such as Amazon, Walmart, or Shopify), you authorize
            Alltix to access and sync order, inventory, and listing data on your behalf using the
            permissions you grant. You remain responsible for complying with each marketplace&apos;s
            own seller policies and agreements.
          </p>
        </section>

        <section>
          <h2>4. Subscriptions and billing</h2>
          <p>
            Paid plans are billed in advance on a recurring basis through our payment processor,
            Stripe. Fees are non-refundable except as required by law or as we expressly state. We
            may change our pricing with advance notice.
          </p>
        </section>

        <section>
          <h2>5. Acceptable use</h2>
          <p>You agree not to:</p>
          <ul>
            <li>Use the service for any unlawful purpose or in violation of any marketplace&apos;s policies.</li>
            <li>Attempt to gain unauthorized access to the service or other accounts.</li>
            <li>Interfere with or disrupt the integrity or performance of the service.</li>
            <li>Reverse engineer or resell the service without our written consent.</li>
          </ul>
        </section>

        <section>
          <h2>6. Data ownership</h2>
          <p>
            You retain ownership of the business data (orders, inventory, listings) you sync into or
            enter within Alltix. We use that data solely to provide the service to you, as described
            in our <a href="/privacy">Privacy Policy</a>.
          </p>
        </section>

        <section>
          <h2>7. Disclaimer and limitation of liability</h2>
          <p>
            The service is provided &quot;as is&quot; without warranties of any kind. To the maximum
            extent permitted by law, Alltix will not be liable for indirect, incidental, or
            consequential damages, including lost sales or inventory discrepancies arising from
            marketplace API delays or outages outside our control.
          </p>
        </section>

        <section>
          <h2>8. Termination</h2>
          <p>
            You may cancel your account at any time. We may suspend or terminate access for
            violation of these Terms or for non-payment, with reasonable notice where practicable.
          </p>
        </section>

        <section>
          <h2>9. Changes to these terms</h2>
          <p>
            We may update these Terms from time to time. Continued use of the service after changes
            take effect constitutes acceptance of the updated Terms.
          </p>
        </section>

        <section>
          <h2>10. Contact us</h2>
          <p>
            Questions about these Terms can be sent to{" "}
            <a href="mailto:legal@alltixoms.com">legal@alltixoms.com</a>.
          </p>
        </section>
      </div>
    </main>
  );
}
