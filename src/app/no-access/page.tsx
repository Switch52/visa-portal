import { SignOutButton } from '@clerk/nextjs';
import { currentUser } from '@clerk/nextjs/server';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Signed in to Clerk, but not invited here.
 *
 * This page exists to break a loop: sending these people back to sign-in would have Clerk
 * hand them straight back as authenticated, forever. It is also the honest answer — they
 * really are signed in, and they really do have no access.
 *
 * It says nothing about whether an account with that address exists, which agencies exist,
 * or who the administrator is. Someone who guesses a colleague's address should learn
 * nothing from what this page tells them.
 */
export default async function NoAccessPage() {
  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses[0]?.emailAddress;

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>No access</CardTitle>
          <CardDescription>
            You are signed in{email ? ` as ${email}` : ''}, but this address has not been
            given access to the portal.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-sm">
            Access is by invitation. Ask whoever administers the portal to invite this
            address — or sign in with a different one if you have been invited under
            another.
          </p>
          <SignOutButton redirectUrl="/sign-in">
            <Button variant="outline" className="w-full">
              Sign out
            </Button>
          </SignOutButton>
        </CardContent>
      </Card>
    </main>
  );
}
