'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { countryOptions } from '@/config/countries';
import { GENDERS, PRIORITIES } from '@/config/validation';
import type { PassportView } from '@/lib/dal/passports';
import { formatDateOnly } from '@/lib/dates';

import { updatePassportAction } from '@/app/(app)/passports/actions';

const selectClass =
  'border-input bg-background flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs disabled:opacity-60';

/**
 * Editing a passport's details.
 *
 * `readOnly` covers both cases where changes are refused — a booked passport, and an admin
 * in a view-as session — but it only hides the controls. The server refuses the write
 * either way, which is what actually enforces it.
 */
export function PassportEditForm({
  passport,
  readOnly,
  isAdmin,
}: {
  passport: PassportView;
  readOnly: boolean;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const countries = countryOptions();

  const onSubmit = (formData: FormData) => {
    setMessage(null);
    setErrors({});

    startTransition(async () => {
      const result = await updatePassportAction(passport.id, {
        firstName: String(formData.get('firstName') ?? ''),
        lastName: String(formData.get('lastName') ?? ''),
        passportExpiryDate: String(formData.get('passportExpiryDate') ?? ''),
        dateOfBirth: String(formData.get('dateOfBirth') ?? ''),
        nationality: String(formData.get('nationality') ?? ''),
        gender: String(formData.get('gender') ?? '') as 'Male' | 'Female',
        contactNumber: String(formData.get('contactNumber') ?? '') || null,
        contactNumberDialCode: String(formData.get('contactNumberDialCode') ?? '') || null,
        contactEmail: String(formData.get('contactEmail') ?? '') || null,
        notes: String(formData.get('notes') ?? '') || null,
        holdUntil: String(formData.get('holdUntil') ?? '') || null,
        priority: String(formData.get('priority') ?? 'normal') as 'normal' | 'urgent',
      });

      if ('error' in result) {
        setMessage(result.error);
        setErrors(result.fieldErrors ?? {});
        return;
      }
      setMessage('Saved.');
      router.refresh();
    });
  };

  return (
    <form action={onSubmit} className="grid gap-4 sm:grid-cols-2">
      <Field name="firstName" label="First name" defaultValue={passport.firstName} disabled={readOnly} errors={errors} />
      <Field name="lastName" label="Last name" defaultValue={passport.lastName} disabled={readOnly} errors={errors} />

      <div className="space-y-2">
        <Label htmlFor="passportNumber">Passport number</Label>
        {/* Not editable: changing it would move the record out from under the unique
            index that already accepted it. */}
        <Input id="passportNumber" defaultValue={passport.passportNumber} disabled className="font-mono" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="nationality">Nationality</Label>
        <select
          id="nationality"
          name="nationality"
          className={selectClass}
          defaultValue={passport.nationality}
          disabled={readOnly}
        >
          {countries.map((country) => (
            <option key={country.code} value={country.code}>
              {country.name}
            </option>
          ))}
        </select>
      </div>

      <Field
        name="passportExpiryDate"
        label="Passport expiry"
        type="date"
        defaultValue={formatDateOnly(passport.passportExpiryDate)}
        disabled={readOnly}
        errors={errors}
      />
      <Field
        name="dateOfBirth"
        label="Date of birth"
        type="date"
        defaultValue={formatDateOnly(passport.dateOfBirth)}
        disabled={readOnly}
        errors={errors}
      />

      <div className="space-y-2">
        <Label htmlFor="gender">Gender</Label>
        <select id="gender" name="gender" className={selectClass} defaultValue={passport.gender} disabled={readOnly}>
          {GENDERS.map((gender) => (
            <option key={gender} value={gender}>
              {gender}
            </option>
          ))}
        </select>
      </div>

      <Field
        name="contactNumber"
        label="Phone"
        defaultValue={passport.contactNumber ?? ''}
        disabled={readOnly}
        errors={errors}
      />
      <Field
        name="contactNumberDialCode"
        label="Dial code"
        defaultValue={passport.contactNumberDialCode ?? ''}
        disabled={readOnly}
        errors={errors}
        hint="Digits only, no +"
      />
      <Field
        name="contactEmail"
        label="Email"
        type="email"
        defaultValue={passport.contactEmail ?? ''}
        disabled={readOnly}
        errors={errors}
      />

      <Field
        name="holdUntil"
        label="Hold until"
        type="date"
        defaultValue={passport.holdUntil ? formatDateOnly(passport.holdUntil) : ''}
        disabled={readOnly}
        errors={errors}
        hint="Leave empty unless this one should wait"
      />

      <div className="space-y-2">
        <Label htmlFor="priority">Priority</Label>
        <select
          id="priority"
          name="priority"
          className={selectClass}
          defaultValue={passport.priority}
          disabled={readOnly || !isAdmin}
        >
          {PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {priority === 'urgent' ? 'Urgent' : 'Normal'}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="notes">Notes</Label>
        <textarea
          id="notes"
          name="notes"
          dir="auto"
          rows={3}
          defaultValue={passport.notes ?? ''}
          disabled={readOnly}
          className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm shadow-xs disabled:opacity-60"
        />
      </div>

      {readOnly ? null : (
        <div className="sm:col-span-2 flex items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
          {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
        </div>
      )}
      {readOnly && message ? <p className="sm:col-span-2 text-sm text-destructive">{message}</p> : null}
    </form>
  );
}

function Field({
  name,
  label,
  defaultValue,
  disabled,
  errors,
  type = 'text',
  hint,
}: {
  name: string;
  label: string;
  defaultValue: string;
  disabled: boolean;
  errors: Record<string, string[]>;
  type?: string;
  hint?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} type={type} defaultValue={defaultValue} disabled={disabled} />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {errors[name] ? <p className="text-xs text-destructive">{errors[name].join(', ')}</p> : null}
    </div>
  );
}
