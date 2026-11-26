import { useEffect, useRef } from 'react';
import { analytics } from '@/lib/analytics';
import type { AccessTokenScope, Expiry } from './api';

/**
 * The Create token form as a funnel: one event when it opens, one per field a person changes, and one when it ends,
 * as created, failed or abandoned. Abandoned says how far they got and which field they touched last, so drop-off
 * can be read per field. The token name is free text and is never sent: only whether it was filled and its length.
 */
export const tokenFormEvents = {
  opened: 'access_token_form_opened',
  fieldChanged: 'access_token_form_field_changed',
  submitted: 'access_token_form_submitted',
  failed: 'access_token_form_failed',
  created: 'access_token_created',
  copied: 'access_token_copied',
  abandoned: 'access_token_form_abandoned',
} as const;

export type TokenFormField = 'name' | 'scope' | 'expiry';
type Form = { name: string; scopes: ReadonlySet<AccessTokenScope>; expiry: Expiry };

const errorCode = /^[a-z][a-z0-9_.-]{0,63}$/;
const shape = (form: Form) => ({
  nameFilled: form.name.trim().length > 0,
  nameLength: form.name.trim().length,
  scopes: [...form.scopes].sort(),
  scopeCount: form.scopes.size,
  expiry: form.expiry,
});

export function useTokenFormAnalytics(read: () => Form) {
  const started = useRef(Date.now());
  const touched = useRef(new Set<TokenFormField>());
  const lastField = useRef<TokenFormField | null>(null);
  const ended = useRef(false);
  const readRef = useRef(read);
  readRef.current = read;

  const progress = () => ({
    ...shape(readRef.current()),
    fieldsTouched: [...touched.current].sort(),
    lastField: lastField.current,
    durationMs: Date.now() - started.current,
  });

  useEffect(() => {
    // Development runs effects twice; each run is a fresh form.
    ended.current = false;
    started.current = Date.now();
    analytics.capture(tokenFormEvents.opened, shape(readRef.current()));
    // Leaving the page or the route with the form open is a drop-off too.
    const abandon = (how: 'navigated' | 'page-closed') => {
      if (ended.current) return;
      ended.current = true;
      analytics.capture(tokenFormEvents.abandoned, { ...progress(), how });
    };
    const pageHidden = () => abandon('page-closed');
    window.addEventListener('pagehide', pageHidden);
    return () => {
      window.removeEventListener('pagehide', pageHidden);
      abandon('navigated');
    };
  }, []);

  return {
    /**
     * A field was changed. `next` is the change itself, since state set in the same handler isn't readable yet. Text
     * fields report on blur, so typing doesn't send an event per keystroke.
     */
    changed(field: TokenFormField, next: Partial<Form> = {}, detail: Record<string, unknown> = {}) {
      touched.current.add(field);
      lastField.current = field;
      analytics.capture(tokenFormEvents.fieldChanged, {
        field,
        ...detail,
        ...shape({ ...readRef.current(), ...next }),
      });
    },
    submitted() {
      analytics.capture(tokenFormEvents.submitted, progress());
    },
    failed(code: string | undefined) {
      analytics.capture(tokenFormEvents.failed, {
        ...progress(),
        ...(code && errorCode.test(code) ? { code } : {}),
      });
    },
    created() {
      ended.current = true;
      analytics.capture(tokenFormEvents.created, progress());
    },
    copied(result: 'copied' | 'failed') {
      analytics.capture(tokenFormEvents.copied, { result });
    },
    /** Closed without creating a token: Cancel, Escape or a click outside. */
    abandoned(how: 'cancel' | 'dismissed') {
      if (ended.current) return;
      ended.current = true;
      analytics.capture(tokenFormEvents.abandoned, { ...progress(), how });
    },
  };
}
