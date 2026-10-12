import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';

export function listenHost(value = '127.0.0.1') {
  if (typeof value !== 'string' || !isIP(value)) throw new Error('LISTEN_HOST must be an IPv4 or IPv6 address');
  return value;
}

export function listenPort(value = 8787) {
  if (!/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return Number(value);
}

// Read only: asking installation questions must not initialize or migrate storage.
export function savedListenPort(root, file = process.env.DATABASE_FILE || path.join(root, 'data', 'kukuai.sqlite')) {
  if (file === ':memory:' || !existsSync(file)) return undefined;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get()) return undefined;
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get('installation');
    return row ? JSON.parse(row.value).port : undefined;
  } finally { db.close(); }
}
