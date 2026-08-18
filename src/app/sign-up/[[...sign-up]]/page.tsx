import { SignUp } from '@clerk/nextjs';

/**
 * Sign-up exists because Clerk's flows link to it and a dead link is worse than a page
 * that explains itself. It creates a Clerk account and grants nothing: authorization
 * comes from an invited record in our `users` collection, which only an admin can create.
 *
 * Restricting sign-up further belongs in the Clerk dashboard (Restrictions → allowlist),
 * not here — a check in this file would only move the door, not lock it.
 */
export default function SignUpPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <SignUp />
      <p className="text-muted-foreground max-w-sm text-center text-sm">
        Creating an account does not grant access on its own. The portal holds real
        passport data, and an administrator has to invite your email address before you
        can see anything.
      </p>
    </main>
  );
}
