import type { StepScreenView } from '@ebmr/api-contract';
import type { ComponentType } from 'react';

/** A block renderer draws the body of the step card from the server's step view. */
export interface RendererProps {
  view: StepScreenView;
}

export type BlockRenderer = ComponentType<RendererProps>;
