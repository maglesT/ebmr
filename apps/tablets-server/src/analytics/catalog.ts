/**
 * The analytics catalogue and the identity of the running code (ADR 0020 points 5 and 6; PR-60; D-6A-1-7, D-6A-1-13).
 * The analytics feature (features/analytics/) serves these through the analytics* routes; it never imports
 * @ebmr/analytics itself (only this folder does: dependency-cruiser analytics-only-from-runner).
 *   catalogMethods()           every method of the registry with its intended use, inputs, output kinds, flag rules and
 *                              "changes GMP data: no" (PR-60).
 *   parametersSha256(p)        the SHA-256 of the canonical text of a method version's parameters.
 *   methodDefinitionProblems() what is wrong with a method version a person asks for: an unknown method, parameters
 *                              that do not fit its schema.
 *   codeIdentity(commit)       what a method version records as the code it was validated with, and whether a recorded
 *                              identity names the running package (codeRuns).
 */
import {
  ANALYTICS_PACKAGE_VERSION,
  METHOD_IDS,
  METHODS,
  RUNTIME_LIBRARIES,
  canonicalText,
  defaultParameters,
  parameterProblems,
  sha256Hex,
  type MethodId,
  type OutputKind,
  type Parameters,
} from '@ebmr/analytics';

export interface CatalogMethod {
  id: MethodId;
  title: string;
  intendedUse: string;
  slice: string;
  outputKinds: OutputKind[];
  flagRules: string[];
  inputs: string[];
  changesGmpData: false;
}

export function catalogMethods(): CatalogMethod[] {
  return METHOD_IDS.map((id) => {
    const m = METHODS[id];
    return { id, title: m.title, intendedUse: m.intendedUse, slice: m.slice, outputKinds: [...m.outputKinds], flagRules: [...m.flagRules], inputs: [...m.inputs], changesGmpData: m.changesGmpData };
  });
}

export const isMethodId = (id: string): id is MethodId => (METHOD_IDS as readonly string[]).includes(id);

/** The plan's default parameters of a method (the starting point of a first version). */
export const methodDefaults = (id: MethodId): Parameters => defaultParameters(id);

export function parametersSha256(parameters: unknown): string {
  return sha256Hex(canonicalText(parameters));
}

/** Problems with a method version a person asks for; empty when it may be written. */
export function methodDefinitionProblems(method: string, parameters: Readonly<Record<string, unknown>>): string[] {
  if (!isMethodId(method)) return [`${method} is not an analytics method (the catalogue lists ${METHOD_IDS.join(', ')})`];
  return parameterProblems(method, parameters);
}

const PACKAGE = `@ebmr/analytics ${ANALYTICS_PACKAGE_VERSION}`;

/** The code identity a method version records: the package version and the commit of the running build. */
export function codeIdentity(commit: string): string {
  return `${PACKAGE} (commit ${commit})`;
}

/** Whether a recorded code identity names the running package version (a version validated with other code is not run). */
export function codeRuns(identity: string): boolean {
  return identity === PACKAGE || identity.startsWith(`${PACKAGE} `);
}

/** What a run records as its runtime (interfaces section 2, analytics.run runtime). */
export function runtimeOf(commit: string, node: string): { package: string; commit: string; node: string; libraries: Record<string, string> } {
  return { package: PACKAGE, commit, node, libraries: { ...RUNTIME_LIBRARIES } };
}
