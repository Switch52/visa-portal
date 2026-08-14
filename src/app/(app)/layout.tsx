import Link from 'next/link';

import { logoutAction } from '@/app/login/actions';
import { Button } from '@/components/ui/button';
import { requireUser } from '@/lib/auth/current-user';
import { getAgency } from '@/lib/dal/agencies';
import { ObjectId } from 'mongodb';

import { EndViewAsButton } from './view-as-banner';

/**
 * The signed-in shell. Nothing here is rendered for a visitor without a session, and the
 * navigation is built from the actor's role rather than hidden with CSS.
 */
export default async function AppLayout({ children }: LayoutProps<'/'>) {
  const actor = await requireUser();
  const isAdmin = actor.role === 'admin';
  const viewingAs = actor.viewingAsAgencyId
    ? await getAgency({ ...actor, viewingAsAgencyId: null }, new ObjectId(actor.viewingAsAgencyId))
    : null;

  const links = isAdmin && !viewingAs
    ? [
        { href: '/', label: 'Home' },
        { href: '/admin/handoff', label: 'Handoff' },
        { href: '/admin/passports', label: 'Passports' },
        { href: '/admin/agencies', label: 'Agencies' },
        { href: '/admin/users', label: 'Users' },
        { href: '/admin/routes', label: 'Routes' },
        { href: '/admin/settings/export', label: 'Export format' },
      ]
    : [
        { href: '/', label: 'Home' },
        { href: '/passports', label: 'Passports' },
        { href: '/balance', label: 'Balance' },
      ];

  return (
    <div className="flex min-h-full flex-1 flex-col">
      {viewingAs ? (
        <div className="flex items-center justify-between gap-4 bg-amber-500 px-4 py-2 text-sm font-medium text-amber-950">
          <span>
            Viewing as <strong>{viewingAs.name}</strong> — read-only. Nothing you do here can change
            their data.
          </span>
          <EndViewAsButton />
        </div>
      ) : null}

      <header className="border-b bg-background">
        <nav className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
          <span className="font-semibold">Passport Portal</span>
          <div className="flex flex-1 gap-4 text-sm">
            {links.map((link) => (
              <Link key={link.href} href={link.href} className="text-muted-foreground hover:text-foreground">
                {link.label}
              </Link>
            ))}
          </div>
          <span className="text-sm text-muted-foreground">{actor.email}</span>
          <form action={logoutAction}>
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 p-4">{children}</main>
    </div>
  );
}
