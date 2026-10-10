# Continuous hosted authentication and connection recovery

Use this runbook on the actual app host after confirming its deployed commit,
Compose files and NODERS authentication capabilities. Local configuration is not
proof of the running AWS configuration. Do not copy credentials into Git or chat.

## What the application does

- The active operator workspace checks participant identity, package availability
  and ledger readiness on its regular refresh. The backend still requires a
  successful check within five minutes; no command is submitted by the check.
- The credential broker runs every 30 seconds when the hosted network and OIDC
  configuration are enabled. It starts renewal 60 seconds before access expiry.
- During a temporary renewal-endpoint outage it can use the existing token only
  while more than five seconds remain. It respects the retry delay and blocks on
  expired tokens, reauthorization, identity mismatch or credential-storage failure.
- CC funding shows the broker's authentication status separately from wallet
  observations and transfer status. Renewal does not replay a monetary POST.

Background browser timers can pause when a tab sleeps. A readiness failure still
blocks ledger submission; refresh the workspace after returning to an idle tab.
Server credential renewal does not depend on keeping a browser tab open.

## Enable supported renewal on AWS

1. Confirm the actual instance and app directory, deployed revision, network,
   restart history and whether the failure is an HTTP authentication error,
   connectivity timeout or stale readiness check. `/healthz` tests the app process,
   not wallet or participant authentication. Do not dump expanded Compose output,
   process environments or token-bearing logs.
2. Obtain the provider's supported unattended grant and exact token endpoint,
   client, audience, subject and party rights. The broker supports refresh tokens
   and client credentials with the current implementation's request format.
   Do not assume an ordinary browser refresh session will last indefinitely or
   that a new service-account subject has the same ledger/wallet rights.
3. On the server, create private `config/oidc.json` using the schema illustrated
   by `config/oidc.example.json`. Replace example identity details with verified
   provider configuration. Map wallet and ledger token environment names to their
   appropriate provider entries. Share one entry only when the subject and rights
   really are shared; do not pool different parties' authority.
4. Configure the grant's secret in the private environment used by Compose
   (`deploy/app.env` for the checked-in base file). Set a persistent secret
   `CLEARROUTE_TOKEN_STORE_KEY` containing a base64-encoded 32-byte random key.
   Keep credentials and that key out of frontend configuration and logs.
5. Keep the application data volume persistent and run one application writer.
   The broker saves rotated refresh tokens in
   `/app/data/credentials/renewal.enc.json` under the current Compose mapping.
   Never replace the encryption key on an existing store or delete the data
   volume to recover authentication. Use the provider reauthorization procedure
   if a refresh grant is revoked. Do not have another app reuse the same rotating
   refresh credential.
6. Ensure UID 1000 can read the private OIDC file and write the data volume.
   After reviewing and deploying the tested app revision, activate the overlay
   from the app directory:

   ```sh
   docker compose -f deploy/compose.yaml -f deploy/compose.oidc.yaml up -d --build
   docker compose -f deploy/compose.yaml -f deploy/compose.oidc.yaml ps
   ```

   Use both files in future lifecycle commands. Do not run this against a
   deployment that uses different Compose files without adapting its runbook.
   Keep new sends disabled during configuration and validation; status
   reconciliation can continue without enabling new sends.

## Acceptance without financial transactions

Verify an authenticated wallet read and participant readiness check. Observe
`ready`, the expiry timestamp and last-renewal timestamp on the operator funding
page. Wait across an actual access-token expiry and confirm a later renewal and
successful reads; do not count a still-valid manually supplied token as evidence
that renewal works. In an approved maintenance window, verify recovery across
container recreation with the persistent store/key. Check that unresolved
operations keep their original command/tracking identity. Never create a transfer
merely to test connectivity, and never mark an offer delivered before its supported
completion evidence exists.

Monitor renewal failures, node/wallet checks, disk space and container restarts.
Run a multi-day soak after activation. Provider outages, revocation and session
policy still impose limits; automatic recovery is not an availability guarantee.

## Source and current verification limits

Keycloak documents access lifetimes, refresh rotation and separate session/offline
limits in its [server administration guide](https://www.keycloak.org/docs/26.8.0/server_admin/#_offline-access),
reviewed 2026-10-10. This is reference behavior, not confirmation of NODERS'
installed Keycloak version, client settings or granted permissions.

The local AWS env copy has renewal settings empty and no private OIDC JSON is
present locally. The running AWS configuration and actual provider grant remain
unverified until instance access is supplied. Do not activate a placeholder grant.
