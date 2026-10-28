import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { id, now, OWNER_ID } from './validation.mjs';
import { fail } from './errors.mjs';

export class Store {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL, id TEXT NOT NULL, owner_id TEXT NOT NULL, body TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL,
        PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS records_kind ON records(kind,owner_id,updated_at);
      CREATE TABLE IF NOT EXISTS operations (
        scope TEXT NOT NULL, operation_id TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(scope,operation_id));
      PRAGMA user_version=1;`);
  }

  decode(row) {
    if (!row) return null;
    return { ...JSON.parse(row.body), id: row.id, ownerId: row.owner_id,
      createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision };
  }

  get(kind, recordId) {
    if (typeof recordId !== 'string' || !recordId) return null;
    return this.decode(this.db.prepare('SELECT * FROM records WHERE kind=? AND id=? AND owner_id=?').get(kind, recordId, OWNER_ID));
  }

  require(kind, recordId) {
    const record = this.get(kind, recordId);
    if (!record) fail(404, 'NOT_FOUND', '记录不存在。');
    return record;
  }

  all(kind) {
    return this.db.prepare('SELECT * FROM records WHERE kind=? AND owner_id=? ORDER BY created_at DESC,id').all(kind, OWNER_ID).map(row => this.decode(row));
  }

  put(kind, fields, recordId = fields.id ?? id()) {
    const existing = this.get(kind, recordId);
    const timestamp = now();
    const body = { ...fields };
    for (const key of ['id', 'ownerId', 'createdAt', 'updatedAt', 'revision']) delete body[key];
    if (existing) {
      const previous = { ...existing };
      for (const key of ['id', 'ownerId', 'createdAt', 'updatedAt', 'revision']) delete previous[key];
      if (JSON.stringify(previous) === JSON.stringify(body)) return existing;
    }
    this.db.prepare(`INSERT INTO records VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at, revision=excluded.revision`)
      .run(kind, recordId, OWNER_ID, JSON.stringify(body), existing?.createdAt ?? timestamp, timestamp, (existing?.revision ?? 0) + 1);
    return this.get(kind, recordId);
  }

  insertImported(kind, record) {
    const body = { ...record };
    for (const key of ['id', 'ownerId', 'createdAt', 'updatedAt', 'revision']) delete body[key];
    this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(kind, record.id, OWNER_ID, JSON.stringify(body), record.createdAt, record.updatedAt, record.revision);
    return this.get(kind, record.id);
  }

  remove(kind, recordId) { this.db.prepare('DELETE FROM records WHERE kind=? AND id=? AND owner_id=?').run(kind, recordId, OWNER_ID); }

  transaction(work) {
    if (this.transactionActive) return work();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionActive = true;
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.transactionActive = false; }
  }

  operation(scope, operationId) {
    const row = this.db.prepare('SELECT body FROM operations WHERE scope=? AND operation_id=?').get(scope, operationId);
    return row ? JSON.parse(row.body) : null;
  }

  operations(scope) {
    return this.db.prepare('SELECT body FROM operations WHERE scope=?').all(scope).map(row => JSON.parse(row.body));
  }

  saveOperation(scope, operationId, body) {
    this.db.prepare(`INSERT INTO operations VALUES(?,?,?) ON CONFLICT(scope,operation_id) DO UPDATE SET body=excluded.body`)
      .run(scope, operationId, JSON.stringify({ ...body, operationId, updatedAt: now() }));
    return this.operation(scope, operationId);
  }

  removeOperation(scope, operationId) { this.db.prepare('DELETE FROM operations WHERE scope=? AND operation_id=?').run(scope, operationId); }

  close() { this.db.close(); }
}
