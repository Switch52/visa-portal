import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

/**
 * Next 16 calls this Proxy; it was Middleware before, and Clerk's docs cover both — the
 * filename is the only difference.
 *
 * It decides one thing: has this request got a Clerk session at all. It does not decide
 * what anyone may see. Every page and every DAL call re-reads the user server-side and
 * applies the agency scope itself, so getting past this buys nothing on its own.
 *
 * `/api/health` stays public because it is the container's liveness probe and has to
 * answer before anyone signs in. Left protected, it would redirect, the probe would
 * follow to a 200 and report healthy — a check that passes without reaching the app.
 */
const isPublic = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/no-access',
  '/api/health',
]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublic(request)) await auth.protect();
});

export const config = {
  matcher: [
    // Everything except Next internals and static files.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
    // Clerk's own frontend API routes.
    '/__clerk/(.*)',
  ],
};
