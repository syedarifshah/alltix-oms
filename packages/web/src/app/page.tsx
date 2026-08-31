import { SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import type { ReactElement } from "react";

export default function HomePage(): ReactElement {
  return (
    <main>
      <h1>alltix-oms</h1>
      <SignedIn>
        <UserButton />
      </SignedIn>
      <SignedOut>
        <a href="/sign-in">Sign in</a>
      </SignedOut>
    </main>
  );
}
