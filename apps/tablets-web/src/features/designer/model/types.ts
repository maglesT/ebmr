/** View types of the designer, from the frozen contract's routes (some views are exported as schemas only). */
import type { RouteResponse, routes } from '@ebmr/api-contract';

type D = typeof routes.designer;

export type TemplateItem = RouteResponse<D['templates']>['templates'][number];
export type FamilyItem = RouteResponse<D['families']>['families'][number];
export type PaletteItem = RouteResponse<D['palette']>['blocks'][number];
export type VersionData = RouteResponse<D['version']>;
export type EvidenceItem = VersionData['evidence'][number];
export type JustificationItem = VersionData['justifications'][number];
export type ValidationData = RouteResponse<D['validate']>;
export type FindingItem = ValidationData['findings'][number];
export type SimulationData = RouteResponse<D['simulate']>;
export type PackageResult = RouteResponse<D['testPackage']>;
