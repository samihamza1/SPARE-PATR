import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

const isBlank = (value: unknown) =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

/**
 * Required fields, checked in code before anything is sent: the browser does not enforce
 * `required` on a Mantine Select (its input is read-only), and its own messages are not in the
 * app's language (so forms are `noValidate`, see Form). Pass only the values that are required
 * right now; errors show after the first submit and clear as the user fills the fields.
 * `messages` replaces "Required" for a field with another translation key.
 */
export function useRequired<T extends Record<string, unknown>>(
  values: T,
  messages: Partial<Record<keyof T, string>> = {},
) {
  const { t } = useTranslation();
  const [checked, setChecked] = useState(false);
  const missing = (Object.keys(values) as (keyof T)[]).filter((field) => isBlank(values[field]));
  const errors: Partial<Record<keyof T, string>> = {};
  if (checked) {
    for (const field of missing) errors[field] = t(messages[field] ?? 'validation.required');
  }
  return {
    /** On submit: true when nothing required is missing; otherwise the fields show errors. */
    ok: (): boolean => {
      setChecked(true);
      return missing.length === 0;
    },
    /** Each missing field's translated error, once the form was submitted. */
    errors,
    /** After a save that empties the form, so the cleared fields are not flagged. */
    reset: () => {
      setChecked(false);
    },
  };
}

/** A form whose fields are checked in code (useRequired), not by the browser. */
export function Form({ onSubmit, children }: { onSubmit: () => void; children: ReactNode }) {
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}
