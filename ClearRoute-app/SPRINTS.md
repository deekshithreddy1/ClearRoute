# ClearRoute delivery plan

## 2026-10-07: ClearRoute naming and deployment candidate

Canonical app: ClearRoute/ClearRoute-app. Renamed source directories to frontend
and backend, environment variables to CLEARROUTE_*, and Daml identifiers to
ClearRoute.*. The separately versioned contract release is pinned in the example
profile. Added a single-instance Docker/Compose deployment, HTTPS proxy, durable
data volume, process health endpoint and deployment instructions.

Verification: 83 backend tests, 38 frontend tests, typechecks and builds passed
on Windows and in the Linux image. Dependency audit: zero reported vulnerabilities.
Container smoke test passed frontend delivery, authentication, operations access
and identity persistence after restart. See container-verification.json.
Renamed contracts separately passed 31 interpreter and 31 actual sandbox Ledger
API tests plus upgrade checks. No NODERS or cloud account was configured.

The user explicitly authorized committing and publishing both repositories with
sprint → dev → main branch structure. This promotion is a verified deployment
candidate, not approval to spend Mainnet funds.

## 2026-10-04: native LocalNet wallet funding

Branch: `sprint/04-wallet-funding`, created from `dev` at the existing common
commit. Previous uncommitted sprint work is preserved. No commit, push or merge.

Delivered scope:

- A separate Wallet funding workspace backed by native Splice wallet offers,
  operator-only spending, customer acceptance, exact ten-place decimals and a
  durable SQLite journal. Configured Atlas/Nova wallets only; LocalNet only.
- Evidence verification ties delivery to the synchronizer, transaction, tracking
  ID, sender, receiver, native coin contract and exact delivered amount.
- Retain original IDs and expiry across retry/restart. Never re-create an
  observed offer after a missing status. Unknown results block further spending.
- Explicit customer wallet installation and repeatable bounded wallet and
  gas-station acceptance commands. No changes to the DAR or its contracts.
- Fix metering to honor the external LocalNet identity path used by the other
  connectors. Configure the DAR input path and identity output for ledger setup.
- Document treasury replenishment, supplier arrangements and the commercial
  implementation gaps in FUNDING-MVP.md.

Acceptance: offline full gate plus separately reported live proofs. Unit/API
tests cover exact delivery, invalid input, authorization, isolation, concurrency,
spending caps, lost responses, restart, missing history, identity changes and
evidence mismatch. Frontend tests cover customer acceptance, unknown-response
replay, pending states and navigation. Limit concurrent jsdom workers to two to
avoid resource contention with the running LocalNet; the multi-page navigation
test has a 15-second budget.

The compatibility adapter uses deprecated Splice wallet transfer offers. Current
Token Standard integration, arbitrary external parties, real payment collection,
supplier deposit accounting and production custody remain outside this release.

ClearRoute sponsors application submissions by purchasing validator traffic and
verifying transaction and usage evidence. Customer allowances, shared validator
capacity, token spending and customer billing must remain distinct records.

Development follows `dev` → sprint branch → user review/commit → `dev` → `main`.
Finish and test one sprint before starting the next. A green local gate is a
review milestone, not proof of production readiness.

## Sprint 1 — account and authorization foundation

Branch: `sprint/01-production-foundation`.

Delivered scope:

- Persist administrator-provisioned operator/customer accounts with fixed tenant
  bindings. Store only credential and session hashes, with versioned schema.
- Enforce identity in every API workspace; forged demo headers cannot elevate
  privileges. Demo role selection requires an explicit runtime setting.
- Support credential expiry, rotation, revocation and account disabling. Record
  provisioning/session events without secrets; cap sessions per credential.
- Provide browser login/logout with HttpOnly cookies, Origin checks, login
  throttling and failure-closed session checks. Separate pending operation storage
  by account and discard stale session refresh responses after logout.
- Default to offline startup: no connector instances or polling workers.
- Preserve financial arithmetic, replay behavior and existing sponsorship tests.

Acceptance: typechecks, backend/API tests with isolated SQLite databases,
frontend interaction tests and both builds must pass through `npm run verify`.
Include negative permission cases, expiry boundaries, persistence after restart,
revocation, tenant isolation and delayed browser responses. Tests require no
running containers, browser automation or credentials from the existing app.

Verification on 2026-10-01: `npm run verify` passed all typechecks, 61 backend
tests, 31 frontend tests and both builds. The isolated startup test blocked
outbound fetches, exercised shutdown and confirmed that offline mode created
only application and identity databases. No browser or live LocalNet validation
was performed. Changes remain uncommitted for user review.

## Sprint 2 — application-party and validator onboarding

Implemented on the same sprint branch after Sprint 1 review work began:

- Persist application registrations with tenant ownership, Canton party ID,
  participant binding, approval state, revision and audit events.
- Persist validator registrations with participant, synchronizer domain and
  party-prefix identity, approval state, revision and audit events.
- Require operator approval for both records before binding. Application and
  validator parties are separate identities and therefore may have different
  prefixes; the approved validator identity is recorded with the binding.
- Scope customer reads and writes to their tenant; operator-only validator
  administration and approval are enforced by the authenticated API.
- Add the Settings onboarding workspace for customer registration and operator
  validator registration, approval and binding.

Acceptance tests cover approval ordering, tenant isolation, operator-only
actions, malformed identities, independent party prefixes, idempotent approval and
durable registry state. This registry is intentionally a pre-execution control:
the existing connector still owns live Canton identity resolution until Sprint
3 wires approved registrations into sponsorship execution. No Daml contracts or
DAR artifacts changed in this sprint.

Verification on 2026-10-01: `npm run verify` passed all typechecks, 64 backend
tests, 31 frontend tests and both builds. No browser or live LocalNet validation
was performed. Changes remain uncommitted for user review.

No Daml changes are necessary for this sprint. Authentication controls access to
the existing workflow; it does not alter ledger contract semantics. The existing
DAR remains unchanged, and no Daml script or live transaction is claimed here.

Known boundaries: two fixture tenants, local access-key administration, single
process rate limiting, local HTTP cookies, fixture commercial terms. Hosting on
a public node requires TLS, deployment configuration, identity operations and
the later acceptance gates below.

## Sprint 3 — hackathon end-to-end path

Branch: `sprint/03-hackathon-e2e`.

The hackathon slice keeps one complete path visible: operator readiness and
capacity approval → customer sponsorship request → native LocalNet traffic
purchase → five-step Daml workflow → measured evidence. A dedicated Hackathon
demo screen presents those three actions without requiring judges to navigate
billing or operational pages. `npm run hackathon:e2e` exercises the same API
boundaries with real LocalNet calls after Docker is intentionally started.

The runtime accepts `CLEARROUTE_LOCALNET_CONFIG`, allowing the new authenticated
server's isolated database directory to use the existing setup-generated
`data/localnet.json`. Offline remains the default and is still the component-test
mode. The server never silently falls back from LocalNet to fixtures.

The existing direct CC top-up page remains explicitly simulated. This sprint's
real funded action is the gas-station path: provider wallet test CC buys native
validator traffic, and that capacity funds the application workflow. Native
wallet-to-wallet CC transfer is outside this acceptance path and remains a
separate wallet operation until its exact LocalNet API contract is locked down.

Verification on 2026-10-03: `npm run verify` passed all typechecks, 64 backend
tests, 31 frontend tests and both builds. No live LocalNet acceptance run was
performed in this turn. Changes remain uncommitted.

## Sprint 4 — sponsorship execution and recovery

Replace fixed customer bindings with persisted application registrations and
explicit party/participant/validator/domain bindings. Specify which submission
forms can be sponsored, who may register them and how operator approval works.
Test invalid bindings, tenant isolation and policy changes with mocked APIs.
Define Daml changes only where the contract workflow requires them; validate
those with isolated Daml script tests before rebuilding the DAR.

## Sprint 3 — sponsorship execution and recovery

Generalize supported submissions within approved policy. Add spending controls,
capacity reservation/concurrency checks, durable recovery and revocation during
in-flight work. Test failed purchases, uncertain responses, restart recovery,
duplicate submissions and proof requirements before reporting completion.

## Sprint 4 — accounting and operations

Reconcile purchased capacity, attributed customer usage and provider overhead.
Add operational audit views, failure diagnostics, backup/restore and schema
upgrade tests. Define commercial pricing and settlement requirements separately
from test invoices; never infer token spending from a customer's byte count.

## Sprint 5 — node deployment and controlled integration

After the earlier gates pass, configure node hosting, secrets, TLS and production
identity integration. Review API/ledger compatibility using locally available
specifications or user-supplied output. Then perform an explicitly bounded
LocalNet acceptance flow: approve → fund traffic → submit → confirm → reconcile.
The user handles browser inspection and can supply sanitized results. Record
integration evidence separately from component test results before release review.
## Hosted network operations — sprint/05-network-operations

Scope: the authenticated app moves to Devnet, Testnet and Mainnet profiles.
Remove the LocalNet deployment navigation; map the tested clearroute-service
package; add customer funding requests, admin policies, command recovery and
decision history; distinguish invoiced sales, collected payments, CC burn and
CC transfers; add an explicit next-month procurement model.

Acceptance:

- Separate network identity and credentials; mainnet writes gated; no hosted
  route exposes legacy simulated finance or LocalNet deployment mutations.
- Requests and decisions persist; tenants cannot inspect another tenant's
  activity or control operator settings.
- Ledger intent survives restarts. Retries preserve identifiers; uncertain
  outcomes remain blocked until matching evidence is imported.
- Financial arithmetic is exact to ten decimal places. Replays and invoice
  successor contracts do not inflate monthly sales.
- Reserve suggestions expose assumptions and require three observed complete
  months plus a recent treasury balance; no synthetic activity is seeded.
- Offline typechecks, backend/HTTP tests, frontend interaction tests and builds
  pass before any user-controlled browser or live Devnet acceptance.

The branch was created from dev at a710aba570c4df1f94f7d310c3f2a7f75bcbb774.
Existing uncommitted application work was preserved. No commits or promotions.
Live native funding, continuous ledger ingestion and production deployment
acceptance remain release gates in HOSTED-NETWORKS.md.

Verification on 2026-10-06: `npm run verify` passed all three TypeScript checks,
83 backend tests, 38 frontend tests and both builds. This includes hosted HTTP
authorization, network isolation, command recovery, exact procurement arithmetic,
request review, identity v1-to-v2 migration and stale frontend response checks.
The legacy wallet fixture now matches the existing verifier's createdAmulets
evidence shape; the verifier was not weakened. No browser or live hosted-network
test was run. DAR content was unchanged and its release SHA-256 was rechecked.
