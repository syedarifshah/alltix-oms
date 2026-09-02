import { Show, UserButton } from "@clerk/nextjs";
import type { ReactElement } from "react";

// <SignedIn>/<SignedOut> were removed in Clerk Core 3 (installed here:
// @clerk/nextjs 7.8.3) in favor of a single <Show when="..."> component --
// see node_modules/@clerk/nextjs/dist/types/removedControlComponents.d.ts
// for Clerk's own migration notes. This isn't a wrong/outdated installed
// version; 7.8.3 is what's in package.json and what's on disk, so the fix
// is updating this usage, not pinning an older Clerk.
export default function HomePage(): ReactElement {
  return (
    <main>
      <h1>alltix-oms</h1>
      <Show when="signed-in">
        <UserButton />
      </Show>
      <Show when="signed-out">
        <a href="/sign-in">Sign in</a>
      </Show>
    </main>
  );
}
