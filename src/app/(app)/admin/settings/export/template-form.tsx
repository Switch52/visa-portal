'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { ExportTemplate } from '@/lib/export/template';

import { resetExportTemplateAction, saveExportTemplateAction, type FormState } from '../../actions';

const SOURCES = [
  'firstName',
  'lastName',
  'passportNumber',
  'passportExpiryDate',
  'dateOfBirth',
  'nationality',
  'gender',
  'contactNumber',
  'contactNumberDialCode',
  'contactEmail',
  'empty',
] as const;

const TRANSFORMS = [
  { value: 'none', label: 'As stored' },
  { value: 'date', label: 'Date as YYYY-MM-DD' },
  { value: 'upper', label: 'Upper case' },
  { value: 'digits', label: 'Digits only' },
] as const;

const selectClass = 'border-input bg-background h-9 w-full rounded-md border px-2 text-sm shadow-xs';

export function ExportTemplateForm({
  template,
  isDefault,
}: {
  template: ExportTemplate;
  isDefault: boolean;
}) {
  const [state, action, pending] = useActionState(saveExportTemplateAction, {} as FormState);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Columns</CardTitle>
        <CardDescription>
          In the order they appear in the file.
          {isDefault ? ' Currently the format shipped with the app.' : ' Edited from the shipped format.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="w-10 py-1">#</th>
                <th className="py-1">Heading written to the file</th>
                <th className="py-1">Value</th>
                <th className="py-1">Formatting</th>
              </tr>
            </thead>
            <tbody>
              {template.columns.map((column, index) => (
                <tr key={index}>
                  <td className="py-1 text-xs text-muted-foreground">{index + 1}</td>
                  <td className="py-1 pr-2">
                    <Input name="header" defaultValue={column.header} className="font-mono text-xs" />
                  </td>
                  <td className="py-1 pr-2">
                    <select name="source" defaultValue={column.source} className={selectClass}>
                      {SOURCES.map((source) => (
                        <option key={source} value={source}>
                          {source === 'empty' ? '(always empty)' : source}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1">
                    <select name="transform" defaultValue={column.transform} className={selectClass}>
                      {TRANSFORMS.map((transform) => (
                        <option key={transform.value} value={transform.value}>
                          {transform.label}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="space-y-2 border-t pt-4">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="includeBom" defaultChecked={template.includeBom} className="mt-1" />
              <span>
                Write a UTF-8 BOM
                <span className="block text-xs text-muted-foreground">
                  Keep this on. Without it, Arabic and accented names open as mojibake in Excel.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="excelTextFormulas"
                defaultChecked={template.excelTextFormulas}
                className="mt-1"
              />
              <span>
                Force passport numbers to text with <code>=&quot;…&quot;</code>
                <span className="block text-xs text-muted-foreground">
                  Off by default. It stops Excel eating a leading zero or turning a long number into
                  scientific notation — but the main dashboard&apos;s importer may not accept the
                  formula syntax. Turn it on only if you open these files in Excel rather than
                  feeding them straight in.
                </span>
              </span>
            </label>
          </div>

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save format'}
            </Button>
            <Button type="submit" variant="ghost" formAction={resetExportTemplateAction}>
              Reset to the shipped format
            </Button>
            {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
            {state.ok ? <p className="text-sm text-muted-foreground">Saved.</p> : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
