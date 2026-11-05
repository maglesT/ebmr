/**
 * The editions (API edition plan A0; lead decision of 5 November 2026). The database's list is kernel.editions()
 * (kernel 1403); the pure recipe-core code, which may not import the kernel, keeps the same list as `flow.EDITIONS`, and
 * a test ties the three together. A new edition is added here, in recipe-core's `flow.EDITIONS` and in kernel.editions().
 */
export const EDITIONS = ['tablets', 'injectables', 'substance'] as const;
export type Edition = (typeof EDITIONS)[number];
