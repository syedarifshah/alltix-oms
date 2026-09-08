import { SignUp } from "@clerk/nextjs";
import type { ReactElement } from "react";

// See the matching comment in sign-in/[[...sign-in]]/page.tsx --
// fallbackRedirectUrl here for the same reason: "/" is now the public
// marketing home, not the app.
export default function SignUpPage(): ReactElement {
  return <SignUp fallbackRedirectUrl="/orders" />;
}
