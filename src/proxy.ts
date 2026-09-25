import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/health"];

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const ok = await verifySessionToken(token);
  if (ok) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Build the target on req.url's own origin: Next's adapter then rewrites a
  // same-host redirect to a RELATIVE Location. (Behind Apache with the server
  // bound to 127.0.0.1, other absolute URLs would point the browser at
  // http://localhost:3005 and break the login; a bare relative Location is
  // rejected by Next 16.) Keep the query (e.g. a shared view link) so the user
  // lands on it after logging in.
  const login = new URL("/login", req.url);
  login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login, 307);
}

export const config = {
  // Protect everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|robots.txt).*)"],
};
