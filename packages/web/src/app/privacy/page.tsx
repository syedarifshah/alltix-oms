import type { ReactElement } from "react";

export const metadata = {
  title: "Privacy Policy | Alltix OMS",
  description: "How Alltix OMS collects, uses, and protects your data.",
};

// Public, unauthenticated legal page -- see src/proxy.ts's isPublicRoute
// matcher, which must include "/privacy" or Clerk will gate it behind
// sign-in. Required by Google's OAuth consent screen (Branding page) before
// the app can be published out of Testing mode, and referenced from the
// account settings / billing pages for real customers.
export default function PrivacyPolicyPage(): ReactElement {
  return (
    <main className="page">
      <h1>Privacy Policy</h1>
      <p className="subtitle">Last updated: September 2026</p>

      <div className="card stack">
        <section>
          <h2>1. Who we are</h2>
          <p>
            Alltix OMS (&quot;Alltix&quot;, &quot;we&quot;, &quot;us&quot;) provides multichannel order and
            inventory management software for e-commerce sellers, connecting to marketplaces such as
            Amazon, Walmart, and Shopify. This policy explains what information we collect through
            alltixoms.com and our application, how we use it, and the choices you have.
          </p>
        </section>

        <section>
          <h2>2. Information we collect</h2>
          <p>We collect the following categories of information:</p>
          <ul>
            <li>
              <strong>Account information</strong>: name, email address, and authentication details
              provided when you sign up or sign in (including via Google or other identity providers).
            </li>
            <li>
              <strong>Marketplace connection data</strong>: OAuth tokens and API credentials you
              authorize us to use to connect your Amazon, Walmart, Shopify, or other sales channel
              accounts, so we can sync orders, inventory, and listings on your behalf.
            </li>
            <li>
              <strong>Business data</strong>: order, product, inventory, and fulfillment records
              synced from your connected sales channels or entered directly into Alltix.
            </li>
            <li>
              <strong>Billing information</strong>: subscription and payment details, processed for us
              by Stripe. We do not store full payment card numbers on our own servers.
            </li>
            <li>
              <strong>Usage data</strong>: log and diagnostic information generated as you use the
              application, used to operate and improve the service.
            </li>
          </ul>
        </section>

        <section>
          <h2>3. How we use your information</h2>
          <ul>
            <li>To provide, operate, and maintain the Alltix OMS service.</li>
            <li>To sync orders, inventory, and listings between your connected sales channels.</li>
            <li>To authenticate you and secure your account.</li>
            <li>To process subscription billing.</li>
            <li>To communicate with you about your account or changes to the service.</li>
            <li>To detect, investigate, and prevent fraud, abuse, or security incidents.</li>
          </ul>
        </section>

        <section>
          <h2>4. How we share information</h2>
          <p>
            We do not sell your personal information. We share information only with the following
            categories of service providers, and only as needed to operate Alltix:
          </p>
          <ul>
            <li>Authentication providers (Clerk) to manage sign-in.</li>
            <li>Payment processors (Stripe) to process subscription billing.</li>
            <li>
              The marketplaces you explicitly connect (Amazon, Walmart, Shopify, etc.), to sync the
              order, inventory, and listing data you authorize.</li>
            <li>Infrastructure and hosting providers that run our application and database.</li>
          </ul>
        </section>

        <section>
          <h2>5. Data retention</h2>
          <p>
            We retain account and business data for as long as your account is active, and for a
            reasonable period afterward to comply with legal obligations, resolve disputes, and
            enforce our agreements. You may request deletion of your account and associated data by
            contacting us.
          </p>
        </section>

        <section>
          <h2>6. Security</h2>
          <p>
            We use industry-standard measures to protect your information, including encryption of
            marketplace credentials at rest and role-based access controls. No system is completely
            secure, and we cannot guarantee absolute security.
          </p>
        </section>

        <section>
          <h2>7. Your choices</h2>
          <p>
            You may disconnect a sales channel at any time from your account settings, which revokes
            our access to that channel&apos;s data going forward. You may also request access to,
            correction of, or deletion of your personal information by contacting us.
          </p>
        </section>

        <section>
          <h2>8. Contact us</h2>
          <p>
            Questions about this policy can be sent to{" "}
            <a href="mailto:legal@alltixoms.com">legal@alltixoms.com</a>.
          </p>
        </section>
      </div>
    </main>
  );
}
