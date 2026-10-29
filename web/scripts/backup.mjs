import { DatabaseSync, backup } from 'node:sqlite';
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const source = resolve(process.env.DATA_DIR || 'var', 'pixel-world.sqlite');
const destination = process.argv[2] && resolve(process.argv[2]);
if (!destination) throw new Error('Usage: npm run backup -- /secure/path/backup.sqlite');
if (!existsSync(source)) throw new Error('Source database does not exist. Set DATA_DIR to the running database directory.');
if (source === destination) throw new Error('Choose a separate backup destination.');
mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
// Refuse to overwrite any file or symlink. Backups contain private account data.
closeSync(openSync(destination, 'wx', 0o600));
const db = new DatabaseSync(source, { readOnly: true });
try {
  await backup(db, destination);
  const copy = new DatabaseSync(destination, { readOnly: true });
  try {
    const result = copy.prepare('PRAGMA integrity_check').get();
    if (result.integrity_check !== 'ok') throw new Error('Backup integrity check failed.');
  } finally { copy.close(); }
  console.log('Consistent SQLite backup created and integrity checked.');
} catch (error) {
  unlinkSync(destination);
  throw error;
} finally { db.close(); }
