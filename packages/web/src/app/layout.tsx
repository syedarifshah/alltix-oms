import { ClerkProvider } from "@clerk/nextjs";
import type { ReactElement, ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
