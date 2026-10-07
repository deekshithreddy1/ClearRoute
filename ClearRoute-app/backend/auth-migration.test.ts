import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IdentityStore } from './auth.js';

test('identity v1 migration preserves existing credentials and sessions while allowing new customer tenants', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'clearroute-auth-migration-')), 'identities.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL,role TEXT NOT NULL,tenantId TEXT,disabled INTEGER NOT NULL DEFAULT 0,CHECK((role='operator' AND tenantId IS NULL) OR (role='customer' AND tenantId IN ('atlas','nova'))));
    CREATE TABLE credentials(id TEXT PRIMARY KEY,accountId TEXT NOT NULL REFERENCES accounts(id),hash TEXT NOT NULL UNIQUE,expiresAt INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sessions(hash TEXT PRIMARY KEY,credentialId TEXT NOT NULL REFERENCES credentials(id),expiresAt INTEGER NOT NULL);
    CREATE TABLE auth_audit(id TEXT PRIMARY KEY,at INTEGER NOT NULL,accountId TEXT NOT NULL,kind TEXT NOT NULL);
    PRAGMA user_version=1;
    INSERT INTO accounts VALUES ('atlas-owner','Atlas','customer','atlas',0);
  `);
  const key = 'crk_' + 'a'.repeat(43), session = 'crs_' + 'b'.repeat(43);
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  db.prepare('INSERT INTO credentials VALUES (?,?,?,?,0)').run('credential', 'atlas-owner', hash(key), Date.now() + 60000);
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(session), 'credential', Date.now() + 60000);
  db.close();
  const ids = new IdentityStore(file);
  try {
    assert.equal(ids.authenticateKey(key).tenantId, 'atlas');
    assert.equal(ids.authenticateSession(session).tenantId, 'atlas');
    ids.createAccount({ id: 'next-owner', name: 'Next', role: 'customer', tenantId: 'next-company' });
    ids.revokeKey('credential');
    assert.throws(() => ids.authenticateSession(session), /Sign in/);
  } finally { ids.close(); }
  const reopened = new IdentityStore(file);
  try { assert.equal(reopened.listAccounts().length, 2); assert.throws(() => reopened.authenticateKey(key), /Sign in/); } finally { reopened.close(); }
});
