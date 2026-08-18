import { SignIn } from '@clerk/nextjs';

/**
 * Clerk's hosted sign-in, mounted here as a catch-all so it can own its own sub-routes
 * (factor-two, reset, SSO callbacks) without a route for each.
 *
 * Signing in proves who someone is and nothing more. Access still depends on an invited
 * record in our `users` collection — a stranger who signs up successfully lands on
 * /no-access, having gained nothing.
 */
export default function SignInPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <SignIn />
    </main>
  );
}
