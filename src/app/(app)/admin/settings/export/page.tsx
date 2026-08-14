import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireAdmin } from '@/lib/auth/current-user';
import { getExportTemplate } from '@/lib/dal/settings';
import { DEFAULT_EXPORT_TEMPLATE, renderCsv } from '@/lib/export/template';

import { ExportTemplateForm } from './template-form';

/**
 * The export column template.
 *
 * The mapping lives here rather than in the export function so that when the main
 * dashboard changes its format, it is a settings change rather than a code change and a
 * wait for a deploy.
 */
export default async function ExportSettingsPage() {
  // Called for the access check itself: a non-admin is redirected before anything renders.
  await requireAdmin();
  const template = await getExportTemplate();

  // A live preview built from the same renderer the real export uses, on invented data.
  const preview = renderCsv(
    [
      {
        firstName: 'John',
        lastName: "O'Brien, Jr",
        passportNumber: 'A04415418',
        passportExpiryDate: new Date(Date.UTC(2031, 11, 3)),
        dateOfBirth: new Date(Date.UTC(1984, 3, 5)),
        nationality: 'EGY',
        gender: 'Male',
        contactNumber: '1234567890',
        contactNumberDialCode: '20',
        contactEmail: 'john@example.com',
      },
    ],
    template,
  );

  const isDefault = JSON.stringify(template) === JSON.stringify(DEFAULT_EXPORT_TEMPLATE);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Export format</h1>
        <p className="text-sm text-muted-foreground">
          The columns the handoff CSV is written with. Change these when the main dashboard changes
          what it accepts.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Careful with the headings</CardTitle>
          <CardDescription>
            Three of them end in a literal <code> (optional)</code> — spaces and brackets included.
            They look like documentation and they are not: they are the column names that importer
            matches on. Optional columns stay in the file even when empty, because a missing column
            shifts everything after it.
          </CardDescription>
        </CardHeader>
      </Card>

      <ExportTemplateForm template={template} isDefault={isDefault} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What a file looks like</CardTitle>
          <CardDescription>
            Rendered by the same code as a real export, on made-up data. Note the quoting around the
            name with a comma in it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{preview}</pre>
        </CardContent>
      </Card>
    </div>
  );
}
