import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

async function getExpectedToken(): Promise<string> {
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || "admin";
  const message = `${username}:${password}`;

  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Paths that do not require cookie-based admin authentication.
  // The Worker Bridge is intentionally excluded from this middleware because
  // Lightning is a machine client and cannot provide the browser auth cookie.
  // /api/worker/* authenticates independently with the short-lived Worker
  // Credential in lib/worker-auth.ts.
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/worker") ||
    pathname === "/login" ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  const token = request.cookies.get("auth_token")?.value;
  const expectedToken = await getExpectedToken();

  // Validate the token value against the expected SHA-256 hash
  if (!token || token !== expectedToken) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }
    const loginUrl = new URL("/login", request.url);
    const response = NextResponse.redirect(loginUrl);
    response.cookies.delete("auth_token");
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (Next.js static assets)
     * - _next/image (Next.js image optimization)
     * - favicon.ico
     *
     * /api/worker is still matched by the middleware but explicitly bypassed
     * above so it can use its own Worker Credential authentication.
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
