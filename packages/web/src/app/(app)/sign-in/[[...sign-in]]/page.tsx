import { SignIn } from "@clerk/nextjs";
import type { ReactElement } from "react";

// fallbackRedirectUrl: since "/" became the public marketing home (see
// src/proxy.ts), Clerk's own post-sign-in default (redirect back to "/")
// would land a freshly-authenticated user back on the marketing page
// instead of the app. This only applies when no explicit redirect_url was
// already part of the sign-in flow (e.g. someone hitting a gated page,
// getting bounced here, and expecting to land back where they started).
export default function SignInPage(): ReactElement {
  return <SignIn fallbackRedirectUrl="/orders" />;
}
