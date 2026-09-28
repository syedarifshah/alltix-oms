import { SignUp } from "@clerk/nextjs";
import type { ReactElement } from "react";

// See the matching comment in sign-in/[[...sign-in]]/page.tsx --
// fallbackRedirectUrl here for the same reason: "/" is now the public
// marketing home, not the app. Same visual-redesign wrapping/appearance
// treatment as that page too, see its own comment for why.
export default function SignUpPage(): ReactElement {
  return (
    <main className="page" style={{ display: "flex", justifyContent: "center", paddingTop: 48 }}>
      <SignUp
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
