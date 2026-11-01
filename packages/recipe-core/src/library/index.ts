/**
 * Library block definitions (decision 0026, slice S1): the data model of a block as a digital form, and the sanity
 * checks of a definition and of a product's values for it. Pure: no kernel, no database, no node core module.
 */
export * from './model.ts';
export { checkBlockDefinition, slotsOf, commensurable } from './check-definition.ts';
export { checkBlockUse } from './check-use.ts';
