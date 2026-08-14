import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requireAdmin } from '@/lib/auth/current-user';
import { listAgencies } from '@/lib/dal/agencies';
import { listUsers } from '@/lib/dal/users';
import { formatDateForDisplay } from '@/lib/dates';

import { setUserActiveAction } from '../actions';
import { InviteUserForm } from './invite-user-form';

export default async function UsersPage() {
  const actor = await requireAdmin();
  const [users, agencies] = await Promise.all([listUsers(actor), listAgencies(actor)]);
  const agencyName = new Map(agencies.map((a) => [a.id, a.name]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-sm text-muted-foreground">
          Access is invite-only. An email that is not on this list gets no code and no account —
          the login page says the same thing either way.
        </p>
      </div>

      <InviteUserForm agencies={agencies.map((a) => ({ id: a.id, name: a.name }))} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Everyone with access</CardTitle>
          <CardDescription>{users.length} account(s)</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Agency</TableHead>
                <TableHead>Last signed in</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground">
                    Nobody has been invited yet.
                  </TableCell>
                </TableRow>
              ) : (
                users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">{user.name}</TableCell>
                    <TableCell className="text-muted-foreground">{user.email}</TableCell>
                    <TableCell>{user.role === 'admin' ? 'Admin' : 'Agency'}</TableCell>
                    <TableCell>{user.agencyId ? (agencyName.get(user.agencyId) ?? '—') : '—'}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {user.lastLoginAt ? formatDateForDisplay(user.lastLoginAt) : 'Never'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={user.active ? 'default' : 'secondary'}>
                        {user.active ? 'Active' : 'Deactivated'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {/* Deactivating revokes their open sessions in the same call. */}
                      <form action={setUserActiveAction}>
                        <input type="hidden" name="userId" value={user.id} />
                        <input type="hidden" name="active" value={String(!user.active)} />
                        <Button type="submit" size="sm" variant="ghost">
                          {user.active ? 'Deactivate' : 'Reactivate'}
                        </Button>
                      </form>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
