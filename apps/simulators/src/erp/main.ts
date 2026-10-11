/**
 * The ERP stub (Phase 3 slice 5a, DEMO-ONLY): posts its seeded catalogue to the tablets server once and exits.
 *
 *   EBMR_SERVER_URL=http://127.0.0.1:3000 EBMR_ERP_LOGIN=erp.interface EBMR_ERP_SERVICE_KEY=... EBMR_ERP_FINGERPRINT=... \
 *   EBMR_ERP_ORDERS=4 node --import tsx apps/simulators/src/erp/main.ts
 */
import { erpCatalogue, postCatalogue } from './catalogue.ts';

async function main(): Promise<void> {
  const env = process.env;
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required`);
    return v;
  };
  const orders = Number(env['EBMR_ERP_ORDERS'] ?? '4');
  if (!Number.isInteger(orders) || orders < 0) throw new Error('EBMR_ERP_ORDERS must be a whole number');
  const out = await postCatalogue(
    need('EBMR_SERVER_URL'),
    { loginName: need('EBMR_ERP_LOGIN'), serviceKey: need('EBMR_ERP_SERVICE_KEY'), fingerprint: need('EBMR_ERP_FINGERPRINT') },
    erpCatalogue({ orders }),
  );
  console.log(`ERP stub: ${String(out.products)} products, ${String(out.materials)} materials and ${String(out.orders)} orders posted (SIMULATOR, DEMO-ONLY)`);
}

main().catch((error: unknown) => {
  console.error(`ERP stub: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
