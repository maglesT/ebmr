/**
 * Shared pieces of the administration screens (Phase 7 slice 7g-1, decision 0025): the reads each act refreshes, who is
 * offered which act (display only: the database decides every act, and an act shown to a role that may not do it is
 * refused with the database's words), a labelled native select and checkbox, and the one-time hand-over of an issued
 * secret.
 */
import { useId, useState, type ReactNode } from 'react';
import { routes, type IssuedCredentialView } from '@ebmr/api-contract';
import { Banner, Button } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';

export const PEOPLE_READS: readonly string[] = [routes.people.directory.id, routes.people.grants.id, routes.people.recertification.id];
export const GRANT_READS: readonly string[] = [routes.people.grants.id, routes.people.directory.id];
export const RECERT_READS: readonly string[] = [routes.people.recertification.id, routes.people.grants.id, routes.people.directory.id];
export const BREAK_GLASS_READS: readonly string[] = [routes.people.breakGlass.id];
export const DEVICE_READS: readonly string[] = [routes.deviceRegistry.list.id];

/** Roles offered the administrator's acts (IAM.PERSON_MANAGE, ACCOUNT_MANAGE, CREDENTIAL_ISSUE, GRANT_REQUEST, DEVICE_MANAGE). */
export const ADMINISTRATORS = /^(SYSTEM_ADMINISTRATOR)$/;
/** Roles offered a device or account act a break-glass administrator also holds (DEVICE_MANAGE, ACCOUNT_MANAGE, UNLOCK). */
export const DEVICE_MANAGERS = /^(SYSTEM_ADMINISTRATOR|BREAK_GLASS_ADMIN)$/;
/** Roles offered the decision on a grant (IAM.GRANT_APPROVE): never on a grant the session's person requested or receives. */
export const GRANT_APPROVERS = /^(PROCESS_OWNER|SYSTEM_ADMINISTRATOR)$/;
/** Roles offered recertification, the break-glass approval and review (IAM.ACCESS_RECERTIFY, IAM.BREAK_GLASS_APPROVE). */
export const PROCESS_OWNERS = /^PROCESS_OWNER$/;

export const offeredTo = (role: string | null, re: RegExp): boolean => role !== null && re.test(role);

/** The session's person id (null until known). */
export function useSessionPerson(): string | null {
  const s = useApiQuery(routes.session.get, {}, { staleTime: 60_000 });
  return s.data?.person.personId ?? null;
}

/** A server code as words (display only). */
export const words = (code: string): string => code.charAt(0) + code.slice(1).toLowerCase().replaceAll('_', ' ');

/** A labelled native select (keyboard and screen readers as the platform gives them). */
export function Select({ label, value, onChange, options, name }: { label: string; value: string; onChange: (v: string) => void; options: readonly { value: string; label: string }[]; name: string }) {
  const id = useId();
  return (
    <div style={{ marginBlock: '0.5rem' }}>
      <label htmlFor={id} style={{ display: 'block' }}>
        {label}
      </label>
      <select id={id} name={name} value={value} onChange={(e) => onChange(e.target.value)} style={{ minHeight: '2.75rem', minWidth: '16rem' }}>
        <option value="">Choose…</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A labelled native checkbox. */
export function Check({ label, checked, onChange, name }: { label: string; checked: boolean; onChange: (v: boolean) => void; name: string }) {
  const id = useId();
  return (
    <div style={{ marginBlock: '0.25rem', minHeight: '2.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <input id={id} name={name} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ width: '1.5rem', height: '1.5rem' }} />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

/**
 * The hand-over of an issued initial or reset secret (DI-15): the server generated it and stored only its verifier, so
 * this answer is the only time it exists outside the person's head. It is hidden until shown to the person it belongs
 * to, never stored by the page, and dropped when the hand-over is confirmed. It is single-use, expires, and must be
 * changed at the first sign-in; if anyone else uses it first, the person's own first sign-in fails and the security
 * unit is alerted.
 */
export function SecretHandover({ issued, onDone }: { issued: IssuedCredentialView; onDone: () => void }) {
  const [shown, setShown] = useState(false);
  const what = issued.kind === 'PIN' ? 'initial PIN' : issued.kind === 'SERVICE_KEY' ? 'service key' : 'initial password';
  return (
    <div data-testid="secret-handover">
      <Banner tone="warning" title={`Hand the ${what} for ${issued.loginName} to its owner now: it is shown only here, once.`}>
        <p>
          Show it to the person it belongs to and nobody else. It works once{issued.expiresAt ? `, until ${issued.expiresAt.text}` : ''}, and must be changed at the first sign-in. Nothing
          keeps it: when you confirm, it is gone from this page.
        </p>
        {shown ? (
          <p>
            <output aria-label={`The ${what}`} data-testid="issued-secret" style={{ fontFamily: 'monospace', fontSize: '1.4rem', userSelect: 'all' }}>
              {issued.secret}
            </output>
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {shown ? null : (
            <Button variant="secondary" onPress={() => setShown(true)}>
              Show it to the person
            </Button>
          )}
          <Button variant="primary" onPress={onDone}>
            Handed over: remove it from the screen
          </Button>
        </div>
      </Banner>
    </div>
  );
}

/** The opener of a disclosure (`<summary>`): a target of at least 44 px, as the floor screens' (WCAG 2.2 target size). */
export const SUMMARY_STYLE = { minHeight: '2.75rem', paddingBlock: '0.65rem', cursor: 'pointer', boxSizing: 'border-box' } as const;

/** A small row of items. */
export function Row({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>{children}</div>;
}
