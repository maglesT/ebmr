/**
 * "Add a coating layer" (Phase 7 slice 7o, R4 second check product and R8 C3; decision D-7o-2): the layer's steps and
 * items are built by `@ebmr/recipe-core/pure` (flow/coating-layer.ts; moved there in slice 7s, D-7s-2, so the DEMO-ONLY
 * P3 seed of the tablets server builds the same layers as the designer). Re-exported here for the designer.
 */
import { flow } from '@ebmr/recipe-core/pure';

export type CoatingLayer = flow.CoatingLayer;
export type LayerParts = flow.LayerParts;
export const coatingLayerParts = flow.coatingLayerParts;
export const layerProblem = flow.layerProblem;
