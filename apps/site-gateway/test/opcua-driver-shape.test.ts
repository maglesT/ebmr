/**
 * The OPC UA driver's fixed shape (Phase 6 slice 6b-0): the endpoint certificate check (DI-20, D-P6b-2) and the series
 * chunker whose chunks the database accepts (numbered, hashed, cut by samples or span; DI-32).
 */
import { SeriesChunkV1 } from '@ebmr/integration-sdk/adapter';
import { describe, expect, it } from 'vitest';
import { certificateProblem, SeriesChunker } from '../src/drivers/opcua.ts';

const endpoint = { endpointUrl: 'opc.tcp://press-01:4840/ua', securityMode: 'SignAndEncrypt', securityPolicy: 'Basic256Sha256', certificateThumbprint: 'a'.repeat(64), equipmentCodes: ['PRESS-01'], areaCode: 'RM-COMP-1' };

describe('OPC UA driver shape (6b-0)', () => {
  it('[DI-20] an endpoint whose certificate is not the enrolled one, or that is not SignAndEncrypt, is refused', () => {
    expect(certificateProblem(endpoint, 'a'.repeat(64))).toBeNull();
    expect(certificateProblem(endpoint, 'b'.repeat(64))).toMatch(/certificate changed/);
    expect(certificateProblem({ ...endpoint, securityMode: 'None' }, 'a'.repeat(64))).toMatch(/not enrolled for SignAndEncrypt/);
  });

  it('[DI-32] the chunker numbers its chunks, cuts them by sample count or span, and each chunk is one the contract accepts', () => {
    const c = new SeriesChunker({ kind: 'EQUIPMENT', code: 'PRESS-01' }, 'force.main_kN', 'kN', 7n, 3, 1_000_000n);
    const s = (us: bigint, raw: string) => ({ sourceTime: us.toString(), serverTime: null, raw, value: raw, status: '0x00000000' });
    const out = [c.add(s(1n, '12.5')), c.add(s(2n, '12.6')), c.add(s(3n, '12.7')), c.add(s(4n, '12.8')), c.add(s(2_000_000n, '12.9')), c.flush(), c.flush()];
    const chunks = out.filter((x) => x !== null);
    expect(chunks.map((x) => [x.chunkNo, x.samples.length])).toEqual([['7', 3], ['8', 1], ['9', 1]]);
    for (const x of chunks) expect(SeriesChunkV1.safeParse(x).success).toBe(true);
  });
});
