import pg from 'pg';
import { k } from '../../../packages/kernel/src/index.ts';
import { ok } from './verify/ok.ts';
export const bad = [pg, k, ok];
