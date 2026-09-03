import { NextResponse, type NextRequest } from "next/server";

/** Redirects back to `path` with `?error=<message>`, for a mutation Route
 *  Handler whose UI is a plain HTML form (no client JS to show an inline
 *  error) -- the destination page reads `searchParams.error` and renders an
 *  alert banner. Mirrors the pattern already used by
 *  src/app/api/channels/amazon/callback/route.ts's redirectWithError. */
export function redirectWithError(req: NextRequest, path: string, error: string): Response {
  const url = new URL(path, req.url);
  url.searchParams.set("error", error);
  return NextResponse.redirect(url, { status: 303 });
}

export function redirectTo(req: NextRequest, path: string): Response {
  return NextResponse.redirect(new URL(path, req.url), { status: 303 });
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
