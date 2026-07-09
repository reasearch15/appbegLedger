#!/usr/bin/env node
import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import bcrypt from 'bcrypt';
import { createDataStore } from '../src/db/index.js';

const BCRYPT_ROUNDS = 12;

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

async function promptValue(label, { envKey } = {}) {
  if (process.env[envKey]) {
    return String(process.env[envKey]).trim();
  }

  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(label)).trim();
  } finally {
    rl.close();
  }
}

async function main() {
  const username = normalizeUsername(
    process.env.ADMIN_USERNAME || await promptValue('Admin username: ', { envKey: 'ADMIN_USERNAME' })
  );
  const password = process.env.ADMIN_PASSWORD || await promptValue('Admin password: ', { envKey: 'ADMIN_PASSWORD' });

  if (!username || username.length < 3) {
    console.error('Username must be at least 3 characters.');
    process.exit(1);
  }
  if (!password || password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const store = await createDataStore();
  const existing = await store.getLedgerUserByUsername(username);
  if (existing) {
    console.error(`User "${username}" already exists.`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await store.createLedgerUser({
    username,
    passwordHash,
    role: 'admin',
    isActive: true
  });

  console.log(`Created admin user "${user.username}" (id ${user.id}).`);
  process.exit(0);
}

main().catch((error) => {
  console.error('Failed to create admin user:', error.message || error);
  process.exit(1);
});
