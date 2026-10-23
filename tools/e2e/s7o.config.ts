// DEV ONLY (slice 7o, not committed): the E2E config against a running s7o-stack (EBMR_E2E_STATE set), no global set-up.
import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

export default defineConfig({ ...base, globalSetup: undefined, reporter: [['list']] });
