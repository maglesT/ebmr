/**
 * Decision 0026 O-6: after the library acceptance (S11) the designer's "Insert a step" dialog offers only insertable
 * blocks; the tablet blocks TB-01 to TB-24 are left out (the library replaces them) while still described for existing
 * steps.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { InsertDialog } from '../../src/features/designer/components/ProcedureTable.tsx';
import type { PaletteItem } from '../../src/features/designer/model/types.ts';
import { PALETTE } from './support.tsx';

afterEach(() => cleanup());

const retired: PaletteItem = {
  key: 'TB-09@1', type: 'TB-09', version: '1', title: 'Compression run', plainName: 'Compression run', level: 'PHASE', roles: [], significant: true,
  availability: 'ALL', badge: 'existing masters only (library replaces it)', insertable: false, configSchema: { type: 'object', description: 'x', fields: {} }, defaultConfig: {}, controls: [],
};

describe('the Insert a step dialog (decision 0026 O-6)', () => {
  it('[PR-05] lists the insertable blocks and not a tablet block that left the palette', () => {
    render(<InsertDialog open onClose={() => undefined} palette={[...PALETTE, retired]} onInsert={() => undefined} />);
    for (const b of PALETTE) expect(screen.getByRole('button', { name: `Insert ${b.plainName}` })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Insert Compression run' })).toBeNull();
    expect(screen.getByText(/A product's own process steps are library blocks/)).toBeTruthy();
  });
});
