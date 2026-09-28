/**
 * New master record from a template (module C2; plan section 12, screen 5). The author names the family, the product
 * and the approved discrete batch sizes (PR-01: a batch can later be made only at one of them), and the markets:
 * India is always included and cannot be unticked (INV-28).
 */
import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { routes, type CallError } from '@ebmr/api-contract';
import { Button, DecimalField, Field } from '@ebmr/ui-kit';
import { api } from '../../api/client.ts';
import { useApiQuery } from '../../api/hooks.ts';
import { RefusalMessage } from '../../app/refusal.tsx';
import { dcls } from './classes.ts';
import { Check } from './components/common.tsx';
import { KNOWN_MARKETS } from './model/ops.ts';

interface SizeRow {
  quantity: string;
  unit: 'kg' | 'g';
}

export function NewFromTemplate() {
  const templates = useApiQuery(routes.designer.templates);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const templateGroup = useId();
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [familyCode, setFamilyCode] = useState<string | null>(null);
  const [productEdit, setProductEdit] = useState<{ code: string; name: string; strength: string } | null>(null);
  const [sizes, setSizes] = useState<SizeRow[]>([{ quantity: '', unit: 'kg' }]);
  const [markets, setMarkets] = useState<string[]>(['IN']);
  const [error, setError] = useState<CallError | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());

  // Defaults come from the chosen template (the first one until the author picks another) until edited.
  const list = templates.data?.templates ?? [];
  const chosen = list.find((t) => t.templateId === templateId) ?? list[0];
  const product = productEdit ?? chosen?.product ?? { code: '', name: '', strength: '' };
  const code = familyCode ?? (chosen ? `${chosen.product.code}-DC` : '');
  const setProduct = (patch: Partial<typeof product>): void => setProductEdit({ ...product, ...patch });

  const complete = chosen !== undefined && code.trim() !== '' && product.code.trim() !== '' && product.name.trim() !== '' && product.strength.trim() !== '' && sizes.every((s) => s.quantity !== '');

  const create = async (): Promise<void> => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    const r = await api.call(routes.designer.createFamily, {
      body: { templateId: chosen.templateId, familyCode: code.trim(), product: { code: product.code.trim(), name: product.name.trim(), strength: product.strength.trim() }, batchSizes: sizes, markets },
      idempotencyKey: key,
    });
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
      <h1>New master record from a template</h1>
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
      <Field label="Family code" name="familyCode" value={code} onChange={setFamilyCode} description="Letters, digits, dots, dashes; one family per product, strength, dosage form and batch-size set." />
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
              <select className={dcls('select')} value={s.unit} onChange={(e) => setSizes((all) => all.map((x, j) => (j === i ? { ...x, unit: e.target.value === 'g' ? 'g' : 'kg' } : x)))}>
                <option value="kg">kg</option>
                <option value="g">g</option>
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
