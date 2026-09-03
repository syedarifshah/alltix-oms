import { ClerkProvider } from "@clerk/nextjs";
import type { ReactElement, ReactNode } from "react";
import { Nav } from "@/components/nav";
import "./globals.css";

export default function RootLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>
          <Nav />
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
