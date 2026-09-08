import { ClerkProvider } from "@clerk/nextjs";
import type { ReactElement, ReactNode } from "react";
import "./globals.css";

/**
 * Root layout for the whole app -- both the public marketing site
 * (app/(marketing)) and the authenticated dashboard (app/(app)). Deliberately
 * has no Nav of its own: the dashboard Nav and the marketing header/footer
 * are different UIs for different audiences, so each route group supplies
 * its own via its own nested layout.tsx.
 */
export default function RootLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
