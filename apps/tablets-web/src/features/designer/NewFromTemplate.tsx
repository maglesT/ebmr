/**
 * New master record (module C2; plan section 12, screen 5). From a template: the author names the family, the product
 * and the approved discrete batch sizes (PR-01: a batch can later be made only at one of them), and the markets:
 * India is always included and cannot be unticked (INV-28). The product and the batch sizes start as the template's.
 *
 * Without a template (slice 7j, R4; D-7j-5): the author chooses the product's approved formula and starts from the
 * required skeleton, a blank master or a copy of an approved master; the server takes the header, the batch sizes and
 * the bill of materials from the formula.
 *
 * A packaging master for a product (slice 7o, R4 and R8; D-7o-3): a copy of an approved packaging master of another
 * product, for the product's code and strength, each printed item taking the product's own printed material and artwork
 * version (the server refuses a printed item left with another product's print).
 */
import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { routes, type CallError, type FormulaChoiceView } from '@ebmr/api-contract';
import { Button, DecimalField, Field } from '@ebmr/ui-kit';
import { api } from '../../api/client.ts';
import { useApiQuery } from '../../api/hooks.ts';
import { RefusalMessage } from '../../app/refusal.tsx';
import { dcls } from './classes.ts';
import { Check } from './components/common.tsx';
import { KNOWN_MARKETS } from './model/ops.ts';
import { ChooseProduct, createFamilyTakesFormula } from './ChooseProduct.tsx';

interface SizeRow {
  quantity: string;
  /** kg or g; a template's size in another unit is shown in that unit (the server says whether it takes it). */
  unit: string;
}

const UNITS = ['kg', 'g'];

type Start = 'TEMPLATE' | 'SKELETON' | 'BLANK' | 'COPY' | 'PACKAGING_COPY' | 'PACKAGING_BLANK';
const STARTS: { value: Start; label: string }[] = [
  { value: 'TEMPLATE', label: 'From a template' },
  { value: 'SKELETON', label: 'From the formula, with the required skeleton (dispensing, and blending for a tablet or capsule)' },
  { value: 'BLANK', label: 'From the formula, blank (clearance and balance status only)' },
  { value: 'COPY', label: 'From the formula, as a copy of an approved master' },
  { value: 'PACKAGING_COPY', label: 'A packaging master for a product, as a copy of an approved packaging master' },
];
/**
 * API plan A1b (C6): a blank packaging master from the chosen formula's product and batch sizes, offered only where the
 * server's formula choice lists the start (the API edition); the screen keeps no list of its own.
 */
const PACKAGING_BLANK = { value: 'PACKAGING_BLANK' as const, label: 'A packaging master from the formula, blank (line clearance only; add the printed materials and the pack from the library)' };

interface PackingRow {
  material: string;
  quantity: string;
  unit: string;
}

interface Printed {
  material: string;
  artwork: string;
}

/** The printed items (G-21) of a master's content: item id and the material it names. */
function printedItemsOf(content: unknown): { item: string; material: string }[] {
  const out: { item: string; material: string }[] = [];
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) n.forEach(visit);
    else if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>;
      const block = o['block'] as { type?: string } | undefined;
      const items = (o['config'] as { items?: unknown } | undefined)?.items;
      if (o['kind'] === 'phase' && block?.type === 'G-21' && Array.isArray(items)) {
        for (const i of items as { id?: unknown; material?: unknown }[]) if (typeof i.id === 'string' && typeof i.material === 'string') out.push({ item: i.id, material: i.material });
      }
      Object.values(o).forEach(visit);
    }
  };
  visit(content);
  return out;
}

export function NewFromTemplate() {
  const templates = useApiQuery(routes.designer.templates);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const templateGroup = useId();
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [familyCode, setFamilyCode] = useState<string | null>(null);
  const [productEdit, setProductEdit] = useState<{ code: string; name: string; strength: string } | null>(null);
  const [sizesEdit, setSizesEdit] = useState<SizeRow[] | null>(null);
  const [markets, setMarkets] = useState<string[]>(['IN']);
  const [error, setError] = useState<CallError | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [formula, setFormula] = useState<FormulaChoiceView | null>(null);
  const [start, setStart] = useState<Start>('TEMPLATE');
  const [copyOf, setCopyOf] = useState<string | null>(null);
  const families = useApiQuery(routes.designer.families);
  const approved = (families.data?.families ?? []).flatMap((f) =>
    f.versions.filter((v) => v.state === 'APPROVED' || v.state === 'EFFECTIVE').map((v) => ({ versionId: v.versionId, label: `${f.familyCode} version ${v.number} (${f.product.name} ${f.product.strength})` })),
  );
  const startGroup = useId();
  const copyGroup = useId();
  const fromTemplate = start === 'TEMPLATE';
  const packaging = start === 'PACKAGING_COPY';
  const [packProduct, setPackProduct] = useState({ code: '', strength: '' });
  const [printed, setPrinted] = useState<Record<string, Printed>>({});
  const [packing, setPacking] = useState<PackingRow[]>([{ material: '', quantity: '', unit: '1' }]);
  const packingBlankListed = formula?.starts.includes('PACKAGING_BLANK') ?? false;
  const startOptions = packingBlankListed ? [...STARTS, PACKAGING_BLANK] : STARTS;
  const source = useApiQuery(routes.designer.version, { params: { versionId: copyOf ?? '' } }, { enabled: packaging && copyOf !== null });
  const sourceContent = source.data?.content as { header?: { recordKind?: string }; procedure?: unknown } | undefined;
  const sourceIsPackaging = sourceContent?.header?.recordKind === 'PACKAGING';
  const items = sourceIsPackaging ? printedItemsOf(sourceContent?.procedure) : [];

  // Defaults come from the chosen template (the first one until the author picks another) until edited.
  const list = templates.data?.templates ?? [];
  const chosen = list.find((t) => t.templateId === templateId) ?? list[0];
  const product = productEdit ?? chosen?.product ?? { code: '', name: '', strength: '' };
  const code = familyCode ?? (fromTemplate ? (chosen ? `${chosen.product.code}-DC` : '') : formula ? `${formula.productCode}-01` : '');
  const setProduct = (patch: Partial<typeof product>): void => setProductEdit({ ...product, ...patch });
  // The approved batch sizes start as the template's (its first is the reference its bill of materials is written for),
  // until the author edits them (lead TODO T6; PR-01).
  const sizes: SizeRow[] = sizesEdit ?? (chosen?.batchSizes.map((b) => ({ quantity: b.quantity, unit: b.unit })) ?? [{ quantity: '', unit: 'kg' }]);
  const setSizes = (change: (all: SizeRow[]) => SizeRow[]): void => setSizesEdit(change(sizes));

  const complete = packaging
    ? code.trim() !== '' && packProduct.code.trim() !== '' && packProduct.strength.trim() !== '' && sourceIsPackaging && items.every((i) => (printed[i.item]?.material ?? '').trim() !== '' && (printed[i.item]?.artwork ?? '').trim() !== '')
    : fromTemplate
    ? chosen !== undefined && code.trim() !== '' && product.code.trim() !== '' && product.name.trim() !== '' && product.strength.trim() !== '' && sizes.every((s) => s.quantity !== '')
    : formula !== null && code.trim() !== '' && (start !== 'COPY' || copyOf !== null) &&
      (start !== 'PACKAGING_BLANK' || (packingBlankListed && packing.every((l) => l.material.trim() !== '' && l.quantity.trim() !== '' && l.unit.trim() !== '')));

  const create = async (): Promise<void> => {
    if (fromTemplate && !chosen) return;
    if (!fromTemplate && !packaging && !formula) return;
    setBusy(true);
    setError(null);
    const body = packaging
      ? {
          familyCode: code.trim(),
          product: { code: packProduct.code.trim(), name: packProduct.code.trim(), strength: packProduct.strength.trim() },
          markets,
          start: 'PACKAGING_COPY' as const,
          ...(copyOf ? { copyOfVersionId: copyOf } : {}),
          printed: items.map((i) => ({ item: i.item, material: (printed[i.item]?.material ?? '').trim(), artwork: (printed[i.item]?.artwork ?? '').trim() })),
        }
      : fromTemplate && chosen
      ? {
          templateId: chosen.templateId,
          familyCode: code.trim(),
          product: { code: product.code.trim(), name: product.name.trim(), strength: product.strength.trim() },
          batchSizes: sizes,
          markets,
          // "Choose a product": the server writes the BOM from the approved formula version and pins it (never the browser's quantities).
          ...(formula && createFamilyTakesFormula() ? { formulaVersionId: formula.versionId } : {}),
        }
      : {
          familyCode: code.trim(),
          product: { code: formula?.productCode ?? '', name: formula?.productCode ?? '', strength: formula?.strength ?? '' },
          markets,
          formulaVersionId: formula?.versionId ?? '',
          start: start as Exclude<Start, 'TEMPLATE' | 'PACKAGING_COPY'>,
          ...(start === 'COPY' && copyOf ? { copyOfVersionId: copyOf } : {}),
          ...(start === 'PACKAGING_BLANK' ? { packing: packing.map((l) => ({ material: l.material.trim(), quantity: l.quantity.trim(), unit: l.unit.trim() })) } : {}),
        };
    const r = await api.call(routes.designer.createFamily, { body, idempotencyKey: key });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setKey(crypto.randomUUID());
    void queryClient.invalidateQueries({ queryKey: [routes.designer.families.id] });
    void navigate({ to: '/mbr/versions/$versionId', params: { versionId: r.value.versionId } });
  };

  if (templates.error) return <RefusalMessage error={templates.error.error} />;
  // The form's defaults come from the template: nothing can be typed before the templates are there (an entry
  // typed earlier would replace the template's product with blank fields).
  if (templates.isPending) return <p aria-busy="true">Loading the templates…</p>;
  return (
    <div className={dcls('page')} style={{ maxWidth: 820 }}>
      <h1>New master record</h1>
      <fieldset className={dcls('fieldset')}>
        <legend className={dcls('legend')}>How the master starts</legend>
        {startOptions.map((o) => (
          <div key={o.value} className={dcls('checkbox')}>
            <input type="radio" id={`${startGroup}-${o.value}`} name={startGroup} checked={start === o.value} onChange={() => setStart(o.value)} />
            <label htmlFor={`${startGroup}-${o.value}`}>{o.label}</label>
          </div>
        ))}
      </fieldset>
      {start === 'COPY' || packaging ? (
        <fieldset className={dcls('fieldset')}>
          <legend className={dcls('legend')}>{packaging ? 'Approved packaging master to copy' : 'Approved master to copy'}</legend>
          {approved.length === 0 ? <p className={dcls('small')}>No master version is approved yet.</p> : null}
          {approved.map((a) => (
            <div key={a.versionId} className={dcls('checkbox')}>
              <input type="radio" id={`${copyGroup}-${a.versionId}`} name={copyGroup} checked={copyOf === a.versionId} onChange={() => setCopyOf(a.versionId)} />
              <label htmlFor={`${copyGroup}-${a.versionId}`}>{a.label}</label>
            </div>
          ))}
        </fieldset>
      ) : null}
      {packaging ? (
        <fieldset className={dcls('fieldset')} data-testid="packaging-copy">
          <legend className={dcls('legend')}>The product and its printed packaging</legend>
          <Field label="Packaging product code" name="packProductCode" value={packProduct.code} onChange={(v) => setPackProduct((p) => ({ ...p, code: v }))} />
          <Field label="Packaging product strength" name="packProductStrength" value={packProduct.strength} onChange={(v) => setPackProduct((p) => ({ ...p, strength: v }))} />
          {copyOf && source.data && !sourceIsPackaging ? <p role="alert">The chosen master is not a packaging master.</p> : null}
          {items.map((i) => (
            <div key={i.item} className={dcls('inline')} data-testid={`printed-${i.item}`}>
              <span>
                {i.item} (now {i.material})
              </span>
              <Field label={`Printed material for ${i.item}`} name={`material-${i.item}`} value={printed[i.item]?.material ?? ''} onChange={(v) => setPrinted((p) => ({ ...p, [i.item]: { material: v, artwork: p[i.item]?.artwork ?? '' } }))} />
              <Field label={`Artwork version for ${i.item}`} name={`artwork-${i.item}`} value={printed[i.item]?.artwork ?? ''} onChange={(v) => setPrinted((p) => ({ ...p, [i.item]: { material: p[i.item]?.material ?? '', artwork: v } }))} />
            </div>
          ))}
        </fieldset>
      ) : null}
      {packaging ? null : fromTemplate ? (
      <fieldset className={dcls('fieldset')}>
        <legend className={dcls('legend')}>Template</legend>
        {list.map((t) => (
          <div key={t.templateId} className={dcls('checkbox')}>
            <input
              type="radio"
              id={`${templateGroup}-${t.templateId}`}
              name={templateGroup}
              checked={chosen?.templateId === t.templateId}
              onChange={() => {
                setTemplateId(t.templateId);
                setProductEdit(null);
                setSizesEdit(null);
              }}
            />
            <label htmlFor={`${templateGroup}-${t.templateId}`}>
              <strong>{t.title}</strong> · {t.steps} steps · markets {t.markets.join(', ')}
              <br />
              <span className={dcls('small')}>{t.description}</span>
            </label>
          </div>
        ))}
      </fieldset>
      ) : (
        <p className={dcls('small')} data-testid="from-formula-note">
          The product, the approved batch sizes and the bill of materials come from the chosen product&apos;s approved formula; nothing is taken from a template.
        </p>
      )}
      {start === 'PACKAGING_BLANK' && packingBlankListed ? (
        <fieldset className={dcls('fieldset')} data-testid="packing-materials">
          <legend className={dcls('legend')}>Packing materials (for the reference batch size)</legend>
          {packing.map((l, i) => (
            <div key={i} className={dcls('inline')}>
              <Field label={`Packing material ${i + 1}`} name={`packing-material-${i}`} value={l.material} onChange={(v) => setPacking((p) => p.map((x, j) => (j === i ? { ...x, material: v } : x)))} />
              <Field label={`Quantity of packing material ${i + 1}`} name={`packing-quantity-${i}`} value={l.quantity} onChange={(v) => setPacking((p) => p.map((x, j) => (j === i ? { ...x, quantity: v } : x)))} />
              <Field label={`Unit of packing material ${i + 1}`} name={`packing-unit-${i}`} value={l.unit} onChange={(v) => setPacking((p) => p.map((x, j) => (j === i ? { ...x, unit: v } : x)))} />
            </div>
          ))}
          <Button onPress={() => setPacking((p) => [...p, { material: '', quantity: '', unit: '1' }])}>Add a packing material</Button>
        </fieldset>
      ) : null}
      {packaging ? null : <ChooseProduct
        onChosen={(c) => {
          setFormula(c);
          if (c) setProductEdit({ ...product, code: c.productCode, strength: c.strength });
        }}
      />}
      <Field label="Family code" name="familyCode" value={code} onChange={setFamilyCode} description="Letters, digits, dots, dashes; one family per product, strength, dosage form and batch-size set." />
      {fromTemplate ? (
        <>
      <Field label="Product code" name="productCode" value={product.code} onChange={(v) => setProduct({ code: v })} />
      <Field label="Product name" name="productName" value={product.name} onChange={(v) => setProduct({ name: v })} />
      <Field label="Strength" name="strength" value={product.strength} onChange={(v) => setProduct({ strength: v })} />
      <fieldset className={dcls('fieldset')}>
        <legend className={dcls('legend')}>Approved batch sizes</legend>
        <p className={dcls('small')}>List each approved size once. A batch can be made only at one of them; there is no free scaling. The first size is the reference for the bill of materials.</p>
        {sizes.map((s, i) => (
          <div key={i} className={dcls('inline')}>
            <DecimalField label={`Batch size ${i + 1}`} unit={s.unit} value={s.quantity} maxDecimals={3} onChange={(v) => setSizes((all) => all.map((x, j) => (j === i ? { ...x, quantity: v } : x)))} />
            <label>
              Unit{' '}
              <select className={dcls('select')} value={s.unit} onChange={(e) => setSizes((all) => all.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))}>
                {(UNITS.includes(s.unit) ? UNITS : [s.unit, ...UNITS]).map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </label>
            {sizes.length > 1 ? (
              <Button variant="quiet" onPress={() => setSizes((all) => all.filter((_, j) => j !== i))} aria-label={`Remove batch size ${i + 1}`}>
                Remove
              </Button>
            ) : null}
          </div>
        ))}
        <Button onPress={() => setSizes((all) => [...all, { quantity: '', unit: 'kg' }])}>Add a batch size</Button>
      </fieldset>
        </>
      ) : null}
      <fieldset className={dcls('fieldset')}>
        <legend className={dcls('legend')}>Markets</legend>
        {KNOWN_MARKETS.map((m) => (
          <Check
            key={m}
            label={m === 'IN' ? 'India (IN): always included, Revised Schedule M' : m === 'US' ? 'United States (US)' : 'European Union (EU)'}
            checked={markets.includes(m)}
            disabled={m === 'IN'}
            onChange={(on) => setMarkets((all) => KNOWN_MARKETS.filter((x) => (x === m ? on : all.includes(x))))}
          />
        ))}
      </fieldset>
      {error ? <RefusalMessage error={error} /> : null}
      <div className={dcls('inline')}>
        <Button variant="primary" onPress={() => void create()} isDisabled={!complete || busy}>
          {busy ? 'Creating…' : 'Create the family and its draft'}
        </Button>
      </div>
    </div>
  );
}
