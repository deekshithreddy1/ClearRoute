# ClearRoute engineering workflow

Build and verify the backend and frontend independently of Canton LocalNet.
The existing DAR is an integration artifact; do not rebuild it unless a Daml
change requires it. Do not restart Quickstart or mutate LocalNet as a substitute
for component testing.

For behavior changes, add meaningful regression tests covering success, invalid
input, authorization, and relevant failure/retry paths. Financial operations
must retain exact decimal arithmetic, transaction rollback, tenant isolation,
durable idempotency, and evidence before confirmation. An uncertain external
result must never cause a new purchase or payment identifier on retry.

Run `npm run verify` in this directory. It typechecks application and test code,
recompiles and runs backend tests, runs frontend interaction tests, and builds
both artifacts. Fix failures and rerun affected tests, then the full gate.
Unit/component tests use temporary databases and explicit connector fixtures;
they must not depend on running containers, real credentials, or application data.

Only after this gate passes proceed to a separately identified LocalNet
integration stage. Report its results separately. Passing component tests does
not establish production readiness or compatibility with future Canton versions.

Keep tests and the dependency lockfile in the change. Do not claim live payment
settlement, production authentication, or deployment readiness while those
capabilities remain unimplemented.
