'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { requestCodeAction, verifyCodeAction, type LoginState } from './actions';

const initial: LoginState = { step: 'email' };

export default function LoginPage() {
  const [requestState, requestCode, requestPending] = useActionState(requestCodeAction, initial);
  const [verifyState, verifyCode, verifyPending] = useActionState(verifyCodeAction, initial);

  // Once a code has been asked for we stay on step two, unless verifying sent us back.
  const state = verifyState.email ? verifyState : requestState;
  const onCodeStep = state.step === 'code';

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            {onCodeStep
              ? 'Enter the 6-digit code we sent you.'
              : 'We will email you a sign-in code. Access is by invitation.'}
          </CardDescription>
        </CardHeader>

        <CardContent>
          {onCodeStep ? (
            <form action={verifyCode} className="space-y-4">
              <input type="hidden" name="email" value={state.email ?? ''} />
              <div className="space-y-2">
                <Label htmlFor="code">Sign-in code</Label>
                <Input
                  id="code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="123456"
                  autoFocus
                  className="text-center text-lg tracking-[0.4em]"
                />
              </div>

              {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
              {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

              <Button type="submit" className="w-full" disabled={verifyPending}>
                {verifyPending ? 'Checking…' : 'Sign in'}
              </Button>

              {/* Same form, different action — a nested <form> would be invalid HTML. */}
              <Button
                type="submit"
                formAction={requestCode}
                variant="ghost"
                className="w-full"
                disabled={requestPending}
              >
                Send a new code
              </Button>
            </form>
          ) : (
            <form action={requestCode} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@agency.com"
                  autoFocus
                />
              </div>

              {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

              <Button type="submit" className="w-full" disabled={requestPending}>
                {requestPending ? 'Sending…' : 'Send code'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
