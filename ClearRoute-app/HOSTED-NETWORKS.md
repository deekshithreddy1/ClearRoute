# ClearRoute hosted operations

This implementation is in the authenticated app at
`ClearRoute/ClearRoute-app`.
The hosted workspace replaces the LocalNet deployment tab with Devnet,
Testnet and Mainnet selection. Missing environments stay unconfigured.
No participant, party, package upload, token transfer or traffic purchase was
performed as part of this change.

## Implemented

- Isolated network profiles, pinned package IDs and distinct provider/customer
  identities; credentials are environment references and never returned to UI.
- New `clearroute-service` template mappings for all eleven templates.
  Supported commands: offer, accept, decline, withdraw, issue/revoke allowance,
  close agreement, submit/complete sample job, record usage, issue invoice,
  record verified payment and dispute invoice. Implicit archive choices and
  native funding receipt creation are intentionally not exposed as payment APIs.
- Authenticated customer requests for managed USD credit or direct CC top-up;
  operator review with immutable decision history, policy approval/suspension.
  Reviewing a request does not execute funding or change account policy.
- Durable command journal, stable idempotency, original identity recovery,
  one unresolved command per customer/network, aggregate allowance limits,
  customer consent and invoice exposure checks.
- Monthly invoiced USD, collected USD, attested CC burn, transferred CC and usage.
  Invoice successor contracts do not count as new sales.
- Reserve planner with three complete UTC calendar months, default 20% growth,
  30 reserve days and seven procurement lead days. It requires activity in all
  three months and a balance observation less than 24 hours old before suggesting
  a purchase. USD sales never convert implicitly into CC.
- Responsive customer/admin workspace, charts with accessible value tables,
  decision trail, pending-command recovery and separate customer visibility.

## Configure Devnet

1. Upload the tested DAR only after reviewing the Daml release report:
   `ClearRoute-DAML/release/clearroute-service-0.1.0.dar`.
   Expected main package:
   `a5d7aff449a19279433832cda0a58adc9632f832a15ce05d427a305bc4b012f5`.
   DAR SHA-256:
   `b027bc5df95f0f424bc8084ae9a6f401ee61b25634824b2483405b43ef91b50f`.
2. Create separate provider and customer parties in NODERS. Obtain the
   synchronizer ID and independently scoped ledger users/tokens. The supplied
   JWT subject is a ledger user, not a party ID. Do not reuse one broad token
   for provider and customer consent.
3. Copy `config/networks.example.json` to a deployment configuration outside
   version control. Replace every `REPLACE_WITH_...` value. Keep
   `writesEnabled: false` initially. Store tokens in the host secret manager.
4. Set these environment variables in the process supervisor:

   ```text
   CLEARROUTE_MODE=hosted
   CLEARROUTE_AUTH_MODE=required
   CLEARROUTE_NETWORK_MODE=devnet
   CLEARROUTE_PUBLIC_ORIGIN=https://your-clearroute-host
   CLEARROUTE_NETWORKS_FILE=/absolute/path/to/networks.json
   CLEARROUTE_DATA_DIR=/absolute/path/to/persistent-private-data
   CLEARROUTE_DEVNET_PROVIDER_TOKEN=<secret supplied by host>
   CLEARROUTE_DEVNET_CUSTOMER_TOKEN=<independently scoped secret>
   ```

5. Build with `npm run build`. Provision application accounts using
   `npm run auth:admin -- create --id admin --name Administrator --role operator`
   and `npm run auth:admin -- create --id customer-owner --name Customer --role customer --tenant first-customer`.
   Issue short-lived access keys with
   `npm run auth:admin -- issue --id admin --days 7` (likewise customer-owner).
   Deliver keys securely; these keys are distinct from ledger JWTs.
6. Run `npm start` behind TLS at the exact configured public origin. The API
   listens on loopback. The same process serves the built frontend.
   Hosted sessions use Secure cookies, origin checking and restrictive headers.
7. Use **Check connection**. It validates participant identity, package presence
   and ledger offset. It does not establish native wallet or traffic capability.
   Review party hosting, user rights, synchronizer and package vetting separately.
8. After that review, enable writes in the Devnet profile and restart. Approve
   the customer policy, issue an offer, sign in as the customer to accept, then
   exercise the managed service workflow. A connection check is required within
   five minutes before each new submission.

## Testnet and Mainnet

Add separate `testnet` and `mainnet` objects with the same profile structure
only after their endpoints, synchronizers, party bindings and package IDs are
known. Do not copy Devnet identities. A changed network binding on an existing
database is rejected; use a reviewed migration or separate data directory.
Mainnet writes require both profile `writesEnabled: true` and
`CLEARROUTE_MAINNET_WRITES=ENABLED`. Those flags are release controls, not proof
of readiness. Use separate process/data/secrets for production deployment even
though the operator UI supports multiple environments.

## Recovery and data meaning

The backend writes intent before making a ledger request. A timeout or rejected
response is retained as uncertain, never automatically reissued under a new ID.
Use Activity to reconcile the ledger update with the original command ID.
Do not delete journal rows to unblock a customer. Definitive rejection recovery
requires an operator-reviewed completion/status integration; it is not yet
automated.

Reconciliation uses Canton 3.5 `POST /v2/updates/update-by-id`, an update format
and the transaction response envelope from the
[official JSON Ledger API specification](https://archived.docs.digitalasset.com/build/3.5/reference/json-api/openapi.html).
Imports must follow increasing offsets. This release indexes submitted commands
and explicitly imported updates; it does not run a complete background ledger
stream. Out-of-band contract changes can leave the index stale. Do not use
incomplete history for production credit decisions or procurement.

CC metrics derive from provider-signed FundingReceipt/TopUpReceipt contracts.
They are attestations, not independent proof of native CC movement. Treasury
balance is an operator observation. Missing history is shown without invented
activity, but zero indexed activity does not prove zero actual spending.
Current-month sales are partial and explicitly compared against the prior full
month. Sales here means invoiced amount, not accounting revenue recognition.

## Remaining production release gates

- Obtain NODERS-supported token-transfer, traffic-purchase, holdings and metering
  APIs plus permission model; implement and verify their evidence and recovery
  adapters on Devnet. A Ledger API endpoint alone cannot establish these rights.
  Hosted native transfer and traffic purchase capabilities remain disabled.
- Implement continuous ledger ingestion with durable cursor, pruning/reassignment
  handling, coverage checks, rejection reconciliation and background recovery.
  The current serial/manual import mechanism is for controlled integration.
- Automate verified pricing quotes, billable-event linkage and 15-day billing;
  current invoice/payment forms are operator attestations. Confirm USDC rail
  settlement evidence independently before recording payment.
- Verify identity rights and customer party hosting, credential rotation,
  TLS/proxy deployment, revocation and production identity-provider integration.
  Current authentication uses administrator-issued access keys, not public signup.
- Run a real Devnet end-to-end flow, then Testnet rehearsal with network failure,
  restart and reconciliation cases. No live hosted integration has been run.
- Review UI in a browser (desktop/mobile/accessibility), load behavior, alerting,
  dependency/security audit and backup/restore. Use a single application writer
  with persistent SQLite for this implementation; do not horizontally replicate
  it without moving the journal and locking to a shared transactional database.
- Stop the service before filesystem backups and copy the entire private data
  directory; protect keys, journal and identity database with filesystem access
  controls and encrypted backups. Rehearse restoring into an isolated environment.

These gates prevent describing this release as production-ready today.

## Verification evidence

On 2026-10-06, `npm run verify` passed server/application/test typechecks,
83 backend tests, 38 frontend interaction tests and both builds. Tests use
isolated databases and explicit API fixtures. They cover authorization, exact
decimals, duplicate submissions, lost responses, restart recovery, network and
tenant isolation, procurement assumptions, identity migration and stale UI
responses. Browser review and hosted-network integration remain unperformed.
