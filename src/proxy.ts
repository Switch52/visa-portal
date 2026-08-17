import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE } from '@/lib/auth/session';

/**
 * Optimistic redirect only — Next 16 calls this Proxy (it was Middleware before).
 *
 * It checks that a session cookie is *present*, nothing more: it never validates it and
 * never decides what anyone may see. Every page and every DAL call re-reads the session
 * server-side and applies the agency scope itself, so a forged cookie gets past this and
 * then gets nothing.
 */
export function proxy(request: NextRequest) {
  const hasSession = request.cookies.has(SESSION_COOKIE);
  const { pathname } = request.nextUrl;

  if (!hasSession && pathname !== '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  if (hasSession && pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // `api/health` is exempt: it is the container's liveness probe and has to answer
  // before anyone has signed in. Left in, it would be redirected to /login, the probe
  // would follow the redirect to a 200 and report healthy — a check that passes without
  // ever reaching the thing it claims to be checking. The route returns a fixed
  // {status:"ok"} and reads nothing, so exempting it discloses nothing.
  matcher: ['/((?!api/health|_next/static|_next/image|favicon.ico|.*\\.png$).*)'],
};
