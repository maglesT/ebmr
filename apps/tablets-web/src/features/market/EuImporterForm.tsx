/**
 * Slice 7h WP-C (gap C3; recipe-core 0824; DI-39, ST-10): QA registers an EU importer named in a technical agreement, with
 * its MIA number, the Ed25519 public key its QP messages are verified with and the products it imports, by signing the
 * definition through the ceremony (EU_IMPORTER_REGISTER, meaning EU_IMPORTER_APPROVED). The database decides: the right
 * (RECORD.QA_REVIEW), a code once, one importer per product, a 32-byte key.
 */
import { useState } from 'react';
import { Field } from '@ebmr/ui-kit';
import { ActButton, ActResult, Section, useSignedAct } from '../../app/acts.tsx';
import { QP_READS } from './reads.ts';

const CODE = /^[A-Z0-9][A-Z0-9-]{1,31}$/;
const KEY = /^[A-Za-z0-9+/]{43}=$/;

export function EuImporterForm() {
  const signed = useSignedAct(QP_READS);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [agreement, setAgreement] = useState('');
  const [mia, setMia] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [products, setProducts] = useState('');
  const list = products
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  const ok = CODE.test(code.trim()) && name.trim() !== '' && agreement.trim() !== '' && mia.trim() !== '' && KEY.test(publicKey.trim()) && list.length > 0;
  return (
    <Section title="Register an EU importer (QA)" testId="eu-importer-register">
      <p>The importer named in the technical agreement: its EU QP certifies the batches it imports, by transcription or by a signed message verified with its public key.</p>
      <Field name="importerCode" label="Importer code (capitals, digits, -)" value={code} onChange={setCode} />
      <Field name="importerName" label="Name" value={name} onChange={setName} />
      <Field name="importerAgreement" label="Technical agreement reference" value={agreement} onChange={setAgreement} />
      <Field name="importerMia" label="MIA number" value={mia} onChange={setMia} />
      <Field name="importerKey" label="Ed25519 public key (base64, 44 characters)" value={publicKey} onChange={setPublicKey} />
      <Field name="importerProducts" label="Products it imports (codes, separated by commas)" value={products} onChange={setProducts} />
      <ActButton
        label="Sign the importer's registration"
        disabled={signed.busy || !ok}
        onPress={() =>
          ok &&
          signed.sign(
            { kind: 'EU_IMPORTER_REGISTER', code: code.trim(), name: name.trim(), technicalAgreementRef: agreement.trim(), miaNumber: mia.trim(), publicKey: publicKey.trim(), products: list },
            `Register ${code.trim()} (${name.trim()}) as EU importer of ${list.join(', ')}`,
          )
        }
      />
      <ActResult error={signed.error} outcome={signed.outcome} label="The importer is registered." />
    </Section>
  );
}
