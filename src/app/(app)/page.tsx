import { requireUser } from '@/lib/auth/current-user';

import { AdminHome } from './admin-home';
import { AgencyHome } from './agency-home';

/**
 * Home.
 *
 * The admin sees the whole system; an agency sees only their own numbers, counted through
 * the same scoped calls — so there is no second definition of "their data" to drift.
 * An admin inside a view-as session gets the agency view, exactly as that agency sees it.
 */
export default async function HomePage() {
  const actor = await requireUser();
  const isAdmin = actor.role === 'admin' && !actor.viewingAsAgencyId;

  return isAdmin ? <AdminHome actor={actor} /> : <AgencyHome actor={actor} />;
}
