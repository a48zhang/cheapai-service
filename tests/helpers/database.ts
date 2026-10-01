/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { afterEach, beforeEach, inject, vi } from 'vitest';
import type { Env } from '../../apps/worker/env';

declare module 'vitest' {
  interface ProvidedContext {
    d1Migrations: D1Migration[];
  }
}

export const testEnv = env as unknown as Env;

/** Numbered migration tests validate that schema version, not later business triggers. */
export function migrationsForTest(migrations: D1Migration[], filePath: string): D1Migration[] {
  const match = /\/tests\/db\/(\d{4})_[^/]+\.test\.ts$/.exec(filePath.replaceAll('\\', '/'));
  if (!match) return migrations;
  const ordinal = Number(match[1]);
  return migrations.filter((migration) => {
    const prefix = /^(\d{4})_/.exec(migration.name);
    return prefix !== null && Number(prefix[1]) <= ordinal;
  });
}

let currentMigrations: D1Migration[] | undefined;

/** Native D1 migration application; supports triggers and records applied names. */
export async function migrateTestDatabase(migrations: D1Migration[] = currentMigrations ?? inject('d1Migrations')): Promise<void> {
  if (migrations.length > 0) await applyD1Migrations(testEnv.DB, migrations);
}

/** Clears D1/KV/DO state, then rebuilds the checked-in SQL schema for a new case. */
export async function resetTestDatabase(migrations?: D1Migration[]): Promise<void> {
  await reset();
  await migrateTestDatabase(migrations);
}

// This file is the Workers setup file. Do not import it from the Node project.
// Use sequential test cases; await all DB operations and waitUntil work before exit.
beforeEach(async (context) => {
  currentMigrations = migrationsForTest(inject('d1Migrations'), context.task.file.filepath);
  await resetTestDatabase();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await reset();
  currentMigrations = undefined;
});
