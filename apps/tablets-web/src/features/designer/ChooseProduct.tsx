/**
 * "Choose a product" (decision 0006 part 1; Phase 3 slice 6): the author names the product, strength and batch size in
 * units, and the server answers with the approved formula version's bill of materials, every quantity computed by the
 * database from the per-unit composition and the batch size (INV-25). The BOM is shown read only, never typed or
 * edited here; the new MBR takes it from the formula version the server pins (createFamily's formulaVersionId).
 * Reading it needs FORMULA.READ (DI-13); a refusal is shown in the server's words.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, type CallError, type FormulaChoiceView } from '@ebmr/api-contract';
import { Button, Field } from '@ebmr/ui-kit';
import { api } from '../../api/client.ts';
import { RefusalMessage } from '../../app/refusal.tsx';
import { dcls } from './classes.ts';

export function ChooseProduct({ onChosen }: { onChosen: (choice: FormulaChoiceView | null) => void }) {
  const [product, setProduct] = useState('');
  const [strength, setStrength] = useState('');
  const [batchSize, setBatchSize] = useState('');
  const [choice, setChoice] = useState<FormulaChoiceView | null>(null);
  const [error, setError] = useState<CallError | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = product.trim() !== '' && strength.trim() !== '' && /^[1-9][0-9]{0,11}$/.test(batchSize.trim());
  const choose = async () => {
    setBusy(true);
    setError(null);
    const r = await api.call(routes.designer.formulaChoice, { query: { product: product.trim(), strength: strength.trim(), batchSize: batchSize.trim() } });
    setBusy(false);
    if (!r.ok) {
      setChoice(null);
      onChosen(null);
      setError(r.error);
      return;
    }
    setChoice(r.value);
    onChosen(r.value);
  };
  return (
    <fieldset className={dcls('fieldset')} data-testid="choose-product">
      <legend className={dcls('legend')}>Choose a product</legend>
      <p className={dcls('small')}>
        The bill of materials comes from the product&apos;s approved formula; its quantities are computed, never typed. A new product&apos;s formula
        is written and approved in the <Link to="/master-data/formulas">formula library</Link> (its materials and the product in{' '}
        <Link to="/master-data/erp">Products and materials</Link>).
      </p>
      <Field label="Formula product" name="choiceProduct" value={product} onChange={setProduct} />
      <Field label="Formula strength" name="choiceStrength" value={strength} onChange={setStrength} />
      <Field label="Formula batch size (tablets)" name="choiceBatchSize" value={batchSize} onChange={setBatchSize} inputMode="numeric" />
      <Button onPress={() => void choose()} isDisabled={!ready || busy}>
        Choose this product
      </Button>
      {error ? <RefusalMessage error={error} /> : null}
      {choice ? (
        <table aria-label="Bill of materials from the formula" data-testid="formula-bom">
          <caption>
            Formula version {choice.versionNumber} of {choice.productCode} {choice.strength}, {choice.batchSizeUnits} tablets
            {choice.target ? `; target tablet weight ${choice.target.targetUnitMassMg} mg; batch sizes ${choice.target.batchSizesUnits.join(', ')} tablets` : ''} (
            <Link to="/master-data/formulas/$formulaId" params={{ formulaId: choice.formulaId }}>
              open the formula
            </Link>
            )
          </caption>
          <thead>
            <tr>
              <th scope="col">Material</th>
              <th scope="col">Role</th>
              <th scope="col">Per unit or batch</th>
              <th scope="col">Batch quantity (computed)</th>
            </tr>
          </thead>
          <tbody>
            {choice.bom.map((l) => (
              <tr key={l.lineId}>
                <td>
                  {l.materialName ?? ''} ({l.materialCode})
                </td>
                <td>{l.role}</td>
                <td>
                  {l.quantity} {l.quantityUnit}
                </td>
                <td>
                  {l.batchQuantity} {l.batchUnit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </fieldset>
  );
}

/** Whether the contract's createFamily takes the formula version to pin (6a adds it with the formulation library). */
export function createFamilyTakesFormula(): boolean {
  const body = routes.designer.createFamily.body as unknown as { shape?: Record<string, unknown> } | undefined;
  return body?.shape !== undefined && 'formulaVersionId' in body.shape;
}
