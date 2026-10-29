import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function openDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'pixel-world.sqlite'));
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(readFileSync(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations).filter(file => /^\d{3}_[a-z_]+\.sql$/.test(file)).sort()) {
    const version = Number(file.slice(0, 3));
    if (version === 1 || db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(readFileSync(new URL(file, migrations), 'utf8'));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  return db;
}
