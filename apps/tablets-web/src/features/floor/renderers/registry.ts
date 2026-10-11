/**
 * Renderer registry (module C4): block version -> renderer. Executable versions without a dedicated renderer
 * use the schema-driven fallback; test/floor/registry.test.tsx lists which (strict in A2).
 */
import type { StepScreenView } from '@ebmr/api-contract';
import { FallbackRenderer } from './Fallback.tsx';
import { G03Renderer } from './G-03@1.tsx';
import { G04Renderer } from './G-04@1.tsx';
import { G07Renderer } from './G-07@1.tsx';
import { G08Renderer } from './G-08@1.tsx';
import { G09Renderer } from './G-09@1.tsx';
import { G10Renderer } from './G-10@1.tsx';
import { G20Renderer } from './G-20@1.tsx';
import { G22Renderer } from './G-22@1.tsx';
import { HoldPointRenderer } from './HoldPoint.tsx';
import { TABLET_RENDERERS } from './tablets.tsx';
import type { BlockRenderer } from './types.ts';

/**
 * Dedicated renderers of the A1 block versions (G-17 hold points are steps of kind HOLD, without a block), and from
 * Phase 3 slice 6 those of the tablet blocks TB-01 to TB-24, G-06@1, G-21@1 and G-24@2 (tablets.tsx).
 */
export const RENDERERS: Readonly<Record<string, BlockRenderer>> = {
  ...TABLET_RENDERERS,
  'G-03@1': G03Renderer,
  'G-04@1': G04Renderer,
  'G-07@1': G07Renderer,
  'G-08@1': G08Renderer,
  'G-09@1': G09Renderer,
  'G-10@1': G10Renderer,
  'G-17@1': HoldPointRenderer,
  'G-20@1': G20Renderer,
  'G-22@1': G22Renderer,
};

export interface RendererChoice {
  key: string;
  Renderer: BlockRenderer;
  fallback: boolean;
}

export function rendererFor(view: StepScreenView): RendererChoice {
  const key = view.step.kind === 'HOLD' ? 'G-17@1' : (view.step.block ?? 'none');
  const Renderer = RENDERERS[key];
  return Renderer ? { key, Renderer, fallback: false } : { key, Renderer: FallbackRenderer, fallback: true };
}
