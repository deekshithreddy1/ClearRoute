import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AppError } from './money.js';
import type { Session } from './store.js';
import { tenantKey } from './networks.js';

const DAY = 86400000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const denied = () => new AppError('UNAUTHORIZED', 'Sign in with a valid, unexpired access key.', 401);
export type Principal = Session & { name: string };
type CredentialRow = { id: string; name: string; role: 'operator' | 'customer'; tenantId: string | null; expiresAt: number; credentialId: string };
const accountInput = z.discriminatedUnion('role', [
  z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/), name: z.string().trim().min(1).max(100), role: z.literal('operator'), tenantId: z.null() }).strict(),
  z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/), name: z.string().trim().min(1).max(100), role: z.literal('customer'), tenantId: tenantKey }).strict(),
]);

/** Opaque, high-entropy credentials. Only hashes are persisted; provisioning is
 * a local administrator operation, never a public HTTP registration route. */
export class IdentityStore {
  private db: DatabaseSync;
  constructor(file: string, private now = Date.now) {
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA foreign_keys=OFF; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      if (version > 2) throw new Error('Identity database version is newer than this application.');
      if (version === 0) this.db.exec(`
        CREATE TABLE accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('operator','customer')),tenantId TEXT,disabled INTEGER NOT NULL DEFAULT 0,CHECK((role='operator' AND tenantId IS NULL) OR (role='customer' AND tenantId IN ('atlas','nova'))));
        CREATE TABLE credentials(id TEXT PRIMARY KEY,accountId TEXT NOT NULL REFERENCES accounts(id),hash TEXT NOT NULL UNIQUE,expiresAt INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE sessions(hash TEXT PRIMARY KEY,credentialId TEXT NOT NULL REFERENCES credentials(id),expiresAt INTEGER NOT NULL);
        CREATE TABLE auth_audit(id TEXT PRIMARY KEY,at INTEGER NOT NULL,accountId TEXT NOT NULL,kind TEXT NOT NULL);
        PRAGMA user_version=1;
      `);
      if (version <= 1) this.db.exec(`
        CREATE TABLE accounts_v2(id TEXT PRIMARY KEY,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('operator','customer')),tenantId TEXT,disabled INTEGER NOT NULL DEFAULT 0,CHECK((role='operator' AND tenantId IS NULL) OR (role='customer' AND tenantId IS NOT NULL)));
        INSERT INTO accounts_v2 SELECT * FROM accounts;
        DROP TABLE accounts;
        ALTER TABLE accounts_v2 RENAME TO accounts;
        PRAGMA user_version=2;
      `);
      if (this.db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Identity migration failed referential integrity checks.');
      this.db.exec('COMMIT; PRAGMA foreign_keys=ON');
    } catch (e) { try { this.db.exec('ROLLBACK'); } finally { this.db.close(); } throw e; }
  }
  close() { this.db.close(); }
  private event(id: string, kind: string) { this.db.prepare('INSERT INTO auth_audit VALUES (?,?,?,?)').run(randomUUID(), this.now(), id, kind); }
  private principal(row: CredentialRow): Principal { return { id: row.id, name: row.name, role: row.role, tenantId: row.tenantId }; }
  createAccount(input: z.infer<typeof accountInput>) {
    const account = accountInput.parse(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT id FROM accounts WHERE id=?').get(account.id)) throw new AppError('ACCOUNT_EXISTS', 'An account with this ID already exists.', 409);
      this.db.prepare('INSERT INTO accounts(id,name,role,tenantId) VALUES (?,?,?,?)').run(account.id, account.name, account.role, account.tenantId);
      this.event(account.id, 'account.created'); this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return account;
  }
  issueKey(accountId: string, validDays = 30) {
    z.number().int().min(1).max(90).parse(validDays);
    const account = this.db.prepare('SELECT id FROM accounts WHERE id=? AND disabled=0').get(accountId);
    if (!account) throw new AppError('ACCOUNT_UNAVAILABLE', 'Account not found or disabled.', 404);
    const token = `crk_${randomBytes(32).toString('base64url')}`, id = randomUUID(), expiresAt = this.now() + validDays * DAY;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO credentials(id,accountId,hash,expiresAt) VALUES (?,?,?,?)').run(id, accountId, digest(token), expiresAt);
      this.event(accountId, 'credential.issued'); this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { id, token, expiresAt };
  }
  private keyRow(token: string): CredentialRow {
    if (!/^crk_[A-Za-z0-9_-]{43}$/.test(token)) throw denied();
    const row = this.db.prepare('SELECT a.id,a.name,a.role,a.tenantId,c.expiresAt,c.id AS credentialId FROM credentials c JOIN accounts a ON a.id=c.accountId WHERE c.hash=? AND c.revoked=0 AND a.disabled=0 AND c.expiresAt>?').get(digest(token), this.now()) as CredentialRow | undefined;
    if (!row) throw denied(); return row;
  }
  authenticateKey(token: string) { return this.principal(this.keyRow(token)); }
  login(token: string) {
    const row = this.keyRow(token), session = `crs_${randomBytes(32).toString('base64url')}`;
    const expiresAt = Math.min(this.now() + 8 * 3600000, row.expiresAt);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM sessions WHERE expiresAt<=?').run(this.now());
      // Bound live sessions for a credential, including repeated login attempts.
      this.db.prepare('DELETE FROM sessions WHERE hash IN (SELECT hash FROM sessions WHERE credentialId=? ORDER BY rowid DESC LIMIT -1 OFFSET 9)').run(row.credentialId);
      this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(session), row.credentialId, expiresAt);
      this.event(row.id, 'session.created'); this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { session, expiresAt, principal: this.principal(row) };
  }
  authenticateSession(token: string) {
    if (!/^crs_[A-Za-z0-9_-]{43}$/.test(token)) throw denied();
    const row = this.db.prepare('SELECT a.id,a.name,a.role,a.tenantId,c.expiresAt,c.id AS credentialId FROM sessions s JOIN credentials c ON c.id=s.credentialId JOIN accounts a ON a.id=c.accountId WHERE s.hash=? AND s.expiresAt>? AND c.expiresAt>? AND c.revoked=0 AND a.disabled=0').get(digest(token), this.now(), this.now()) as CredentialRow | undefined;
    if (!row) throw denied(); return this.principal(row);
  }
  logout(token: string) { this.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(token)); }
  revokeKey(id: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT accountId FROM credentials WHERE id=?').get(id) as { accountId: string } | undefined;
      if (!row) throw new AppError('NOT_FOUND', 'Credential not found.', 404);
      this.db.prepare('UPDATE credentials SET revoked=1 WHERE id=?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE credentialId=?').run(id);
      this.event(row.accountId, 'credential.revoked'); this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  disableAccount(id: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('UPDATE accounts SET disabled=1 WHERE id=?').run(id).changes) throw new AppError('NOT_FOUND', 'Account not found.', 404);
      this.event(id, 'account.disabled'); this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  listAccounts() { return this.db.prepare('SELECT id,name,role,tenantId,disabled FROM accounts ORDER BY id').all(); }
  listKeys() { return this.db.prepare('SELECT id,accountId,expiresAt,revoked FROM credentials ORDER BY rowid').all(); }
}
