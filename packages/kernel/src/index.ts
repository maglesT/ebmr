/**
 * Compliance kernel: identity and access, e-signatures, audit trail, trusted time, sealing, control
 * register, market-profile engine, retention, true copies.
 *
 * The database is the enforcement point (ADR 0012): every module's SQL lives in ../sql and is applied
 * by `migrate`. The TypeScript modules below are thin, typed callers of those functions. Modules are
 * exported as namespaces because several define similarly named types (Market, RetentionKey, ...).
 */

export const PACKAGE = { name: '@ebmr/kernel', version: '0.1.0' } as const;

// Foundation: migrations, commands with an actor context, audit-chain verification.
export { KERNEL_MIGRATIONS, migrate, type AppliedMigration, type MigrationSource } from './db/migrate.ts';
export { FACT_NEEDED, registerFactResolver, toDbContext, withCommand, type ActorContext, type CommandSource, type FactRecorder, type FactResolver } from './db/command.ts';
export { runChainVerification, verifyAllChains, verifyAnchor, verifyChain, type ChainProblem, type VerificationRun } from './audit/verify.ts';

export { EDITIONS, type Edition } from './editions.ts';
export * as identity from './identity/index.ts';
export * as market from './market/index.ts';
export * as records from './records/index.ts';
export * as time from './time/index.ts';
export * as commands from './commands/index.ts';
export * as state from './state/index.ts';
export * as continuity from './continuity/index.ts';
export * as esig from './esig/index.ts';
export * as sandbox from './sandbox/index.ts';
export * as config from './config/index.ts';
