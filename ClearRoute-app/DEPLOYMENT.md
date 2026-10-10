# ClearRoute: local development and cloud deployment

## The two repositories

Use **ClearRoute/ClearRoute-app** for the web application. Its **frontend/**
contains React files; **backend/** contains the Node API, authentication,
ledger adapters and database logic. One Node server serves the built frontend
and API. You do not need two cloud services.

Use **ClearRoute-DAML/** for contracts. **daml/ClearRoute/** contains production
modules; **tests/daml/ClearRoute/** contains tests; **release/** contains the
tested DAR, package ID and checksum. Only this repository goes to
https://github.com/deekshithreddy1/ClearRoute-DAML.

The containing Quickstart workspace and its older app copy are not deployment
inputs. The canonical app remote is https://github.com/deekshithreddy1/ClearRoute.

## Local browser preview, no Canton connection required

Install Node 22.14 or newer in the Node 22 line. From ClearRoute/ClearRoute-app:

```powershell
npm ci
npm run verify
npm run auth:admin -- create --id admin --name Administrator --role operator
npm run auth:admin -- issue --id admin --days 7
npm start
```

Open http://127.0.0.1:3001 and sign in with the issued application access key.
For hot reload, use `npm run dev` and http://127.0.0.1:5173 instead.
Offline mode is the default; it displays the real application with unconfigured
networks. Application access keys are not ledger JWTs.

## Cloud: use one persistent VM for the hackathon

Recommended shape: one Ubuntu VM with at least 2 vCPU / 4 GB RAM as a starting
point for building and running this app, a persistent disk and a domain.
Choose AWS Lightsail/EC2 or GCP Compute Engine. This is a starting sizing
assumption, not a load-tested capacity guarantee.

SQLite needs a persistent filesystem and one application writer. Do not place
this version on ephemeral serverless storage or scale it across replicas.

1. Create the VM, attach/reserve a stable public IP and point your domain's A
   record to it. Open TCP 80/443; restrict SSH to your administrator IP.
2. Install Docker Engine and the Compose plugin using the official instructions
   for your Ubuntu version. Clone the app repository and select the current pilot
   branch. Do not assume `main` already contains the pilot:

   ```sh
   git clone https://github.com/deekshithreddy1/ClearRoute.git
   git -C ClearRoute switch feature/hosted-cc-funding
   cd ClearRoute/ClearRoute-app
   cp config/networks.example.json config/networks.json
   cp deploy/app.env.example deploy/app.env
   chmod 600 deploy/app.env config/networks.json
   ```

3. Edit both copies. Set your real domain, exact HTTPS origin, NODERS party/user
   bindings and synchronizer. Keep writesEnabled false until the connection
   and permission checks are complete. Supply tokens in the private env file.
   Never commit either populated file or paste tokens into chat.
4. Start:

   ```sh
   docker compose -f deploy/compose.yaml up -d --build
   docker compose -f deploy/compose.yaml ps
   docker compose -f deploy/compose.yaml logs --tail=100 app
   ```

   The image build runs the complete test gate. Caddy obtains HTTPS for your
   domain; the backend port is not exposed to the internet. /healthz reports
   process health, not NODERS connectivity. Compose restarts crashed processes;
   an unhealthy container still needs an alert/operator investigation.
5. Provision accounts in the persistent volume:

   ```sh
   docker compose -f deploy/compose.yaml exec app node dist-backend/auth-admin.js --id admin --name Administrator --role operator create
   docker compose -f deploy/compose.yaml exec app node dist-backend/auth-admin.js --id admin --days 7 issue
   docker compose -f deploy/compose.yaml exec app node dist-backend/auth-admin.js --id customer-owner --name Customer --role customer --tenant first-customer create
   docker compose -f deploy/compose.yaml exec app node dist-backend/auth-admin.js --id customer-owner --days 7 issue
   ```

6. Open your HTTPS domain. Run Check connection, verify rights/party hosting,
   then follow [HOSTED-NETWORKS.md](HOSTED-NETWORKS.md) for the controlled Devnet
   workflow. Mainnet stays disabled.

## Keep it running

### Optional renewable authentication

For activation and nonfinancial acceptance checks, follow
[Continuous hosted authentication](deploy/CONTINUOUS-AUTH.md).

The base Compose setup uses manually supplied tokens. Leave
`CLEARROUTE_OIDC_CONFIG_FILE` empty for that initial test. Copy
`config/oidc.example.json` to private `config/oidc.json`, confirm its subject and
audience, and configure `CLEARROUTE_TOKEN_STORE_KEY` and the NODERS refresh token
in private `deploy/app.env` before enabling renewal. A placeholder refresh token
does not work. Keep the same encryption key across restarts.

The optional overlay mounts the OIDC configuration and selects it:

```sh
docker compose -f deploy/compose.yaml -f deploy/compose.oidc.yaml up -d --build
```

Use both Compose files for subsequent lifecycle commands while renewal is enabled.
The runtime process runs as UID 1000. The mounted JSON files must be readable by
that UID. On a standard Ubuntu host owned by UID 1000, mode 600 is sufficient.
Never make token-bearing files world-readable. Verify actual renewal with NODERS
before describing the deployment as unattended. Do not print Compose's resolved
configuration to shared logs because it includes secret environment values.

- Keep one app instance. Named volumes retain the identity and operations
  databases across container recreation. Never use `docker compose down -v`
  on a deployment you want to retain.
- Take encrypted VM/disk snapshots after stopping the app for a consistent
  backup; then restart it. Test restoring a snapshot to a separate VM.
- Before upgrades, snapshot data and retain the previous Git commit/image.
  Roll back code only when its database schema is compatible; otherwise restore
  the matching snapshot. Do not overwrite uncertain-command records.
- Monitor HTTPS and /healthz externally, disk space, restart count and unresolved
  operations. Configure restart alerts. Log rotation is included in Compose.
- Rotate/revoke access keys and ledger tokens; keep ledger credentials separately
  scoped. Access keys expire; reissue before your demo if necessary.
- Add monitoring, restore rehearsal and a multi-day soak before claiming
  uninterrupted production operation. No test can guarantee days without failure.

## What can be live today

The portal, customer requests, admin review, service-contract operations,
invoice attestations and dashboard can be hosted after configuration.
Production CC top-ups/traffic funding still need the NODERS-supported
native APIs and verification. Current metrics are indexed attestations and the
balance is manually observed. Continuous ledger coverage and production funding
acceptance remain release gates; uploading the DAR alone does not provide them.

## Official deployment references

- [AWS Lightsail static IP](https://docs.aws.amazon.com/lightsail/latest/userguide/lightsail-create-static-ip.html)
- [GCP persistent disks](https://docs.cloud.google.com/compute/docs/disks/persistent-disks)
- [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Caddy HTTPS](https://caddyserver.com/docs/quick-starts/https)

## CC funding requests while wallet onboarding is pending
After building and restarting, open CC funding in the hosted workspace. Existing customer accounts can register a receiving party and request an exact CC amount. Operators review the saved request and ownership evidence. Approval does not verify ownership or submit a transfer. Recipient details are snapshots attached to requests and do not change existing service-agreement parties. Requests persist in operations.sqlite and are isolated by network and customer.
The wallet connector, live balance, transfer submission, delivery evidence and automatic TopUpReceipt creation are not enabled by this UI. Connect and validate those against NODERS after onboarding. Never convert an approved request into a confirmed delivery without native evidence. Public signup remains separate from this authenticated request flow.

## Public Devnet pilot
The separate **Demo transfers** operator page and public `/funding` page now support
visitor requests and a NODERS Devnet transfer-offer adapter. See [DEVNET-PILOT.md](DEVNET-PILOT.md)
for activation, treasury variables, recipient requirements, HTTPS sharing and failure
handling. This pilot does not create app customer accounts, service agreements or
TopUpReceipt contracts. It uses wallet-status evidence, not the older attested records.
It does not enable Mainnet or replace the production-readiness requirements above.
