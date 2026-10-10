import { z } from 'zod';

export const credentialStatusSchema = z.object({
  mode: z.string(), status: z.string(), expiresAt: z.string().nullable(), lastRenewedAt: z.string().nullable(),
});

const messages: Record<string, string> = {
  manual_token: 'Automatic authentication renewal is not configured. Access stops when the supplied token expires.',
  not_checked: 'Automatic authentication renewal is starting.',
  ready: 'Automatic authentication renewal is active.',
  renewal_unavailable: 'Authentication renewal is temporarily unavailable. The server will retry; access may stop when the current token expires.',
  expired: 'The access token has expired. Waiting for authentication renewal.',
  reauthorization_required: 'The identity provider requires reauthorization. An operator must renew the server credentials.',
  missing_refresh_token: 'The server is missing its refresh credential. An operator must configure it.',
  missing_client_secret: 'The server is missing its service-account credential. An operator must configure it.',
  storage_error: 'Renewal credentials could not be saved. An operator must check the persistent credential store.',
  invalid_token_response: 'The renewed credential did not pass validation. An operator must check the configured identity and audience.',
};

export function CredentialStatus({ value }: { value?: z.infer<typeof credentialStatusSchema> }) {
  if (!value) return null;
  return <div className="ops-alert attention" role="status" aria-label="Wallet authentication">
    <div><strong>Wallet authentication</strong><p>{messages[value.status] ?? 'Authentication status needs an operator review.'}</p>
      {value.expiresAt && <p>Current access expires: {new Date(value.expiresAt).toLocaleString()}.</p>}
      {value.lastRenewedAt && <p>Last renewed: {new Date(value.lastRenewedAt).toLocaleString()}.</p>}
    </div>
  </div>;
}
