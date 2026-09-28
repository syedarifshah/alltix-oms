import { SignIn } from "@clerk/nextjs";
import type { ReactElement } from "react";

// fallbackRedirectUrl: since "/" became the public marketing home (see
// src/proxy.ts), Clerk's own post-sign-in default (redirect back to "/")
// would land a freshly-authenticated user back on the marketing page
// instead of the app. This only applies when no explicit redirect_url was
// already part of the sign-in flow (e.g. someone hitting a gated page,
// getting bounced here, and expecting to land back where they started).
//
// Visual redesign pass: wrapped in the same centered `.page` container
// every other route uses, and given a light `appearance.variables` map so
// Clerk's own hosted widget picks up this app's accent/surface/text colors
// (via CSS custom properties, which resolve live -- so this automatically
// follows the light/dark toggle, same as everything else) instead of
// looking like an unstyled default widget dropped into a themed shell.
// Clerk's own internal layout/behavior is untouched -- this only maps
// colors/radius, nothing else.
export default function SignInPage(): ReactElement {
  return (
    <main className="page" style={{ display: "flex", justifyContent: "center", paddingTop: 48 }}>
      <SignIn
        fallbackRedirectUrl="/orders"
        appearance={{
          variables: {
            colorPrimary: "var(--accent)",
            colorBackground: "var(--surface)",
            colorForeground: "var(--text)",
            colorMutedForeground: "var(--text-muted)",
            colorInput: "var(--surface-2)",
            colorInputForeground: "var(--text)",
            colorBorder: "var(--border)",
            borderRadius: "var(--radius)",
          },
        }}
      />
    </main>
  );
}
