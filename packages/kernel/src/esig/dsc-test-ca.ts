/**
 * TEST certificate authority for the India DSC option (IN-10; decision 0001 item 3: a test CA in v1, with a banner,
 * while the counsel questions are open; D-P6f-4). It issues X.509 v3 certificates (RSA 2048, SHA-256) in memory for the
 * demo and the tests. It is never the CCA root and never a licensed CA: a certificate it issues is not legally valid.
 * No private key of a real CA is ever committed; every key here is generated at run time.
 *
 * Only the DER the verifier needs is written: a minimal encoder for the certificate fields, the basic constraints and
 * the key usage extensions.
 */
import { createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';

const tlv = (tag: number, content: Buffer): Buffer => {
  const n = content.length;
  let len: Buffer;
  if (n < 0x80) len = Buffer.from([n]);
  else {
    const bytes: number[] = [];
    for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
    len = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), len, content]);
};
const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const integer = (b: Buffer): Buffer => {
  let v = b;
  while (v.length > 1 && v[0] === 0 && ((v[1] ?? 0) & 0x80) === 0) v = v.subarray(1);
  return tlv(0x02, (v[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
};
const oid = (dotted: string): Buffer => {
  const parts = dotted.split('.').map((p) => Number.parseInt(p, 10));
  const out: number[] = [(parts[0] ?? 0) * 40 + (parts[1] ?? 0)];
  for (const p of parts.slice(2)) {
    const stack: number[] = [p % 128];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) stack.unshift((v % 128) | 0x80);
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'));
const printable = (s: string): Buffer => tlv(0x13, Buffer.from(s, 'ascii'));
const bitString = (unused: number, b: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));
const octets = (b: Buffer): Buffer => tlv(0x04, b);
const explicit = (n: number, b: Buffer): Buffer => tlv(0xa0 | n, b);
const TRUE = Buffer.from([0x01, 0x01, 0xff]);
const NULL = Buffer.from([0x05, 0x00]);

const pad = (n: number): string => String(n).padStart(2, '0');
/** UTCTime (years 1950 to 2049) or GeneralizedTime, as RFC 5280 asks. */
const time = (d: Date): Buffer => {
  const y = d.getUTCFullYear();
  const rest = `${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return y < 2050 ? tlv(0x17, Buffer.from(`${pad(y % 100)}${rest}`, 'ascii')) : tlv(0x18, Buffer.from(`${y}${rest}`, 'ascii'));
};

export interface DistinguishedName {
  commonName: string;
  organisation?: string;
  /** Two-letter country code. */
  country?: string;
}

const name = (dn: DistinguishedName): Buffer =>
  seq(
    ...(dn.country ? [set(seq(oid('2.5.4.6'), printable(dn.country)))] : []),
    ...(dn.organisation ? [set(seq(oid('2.5.4.10'), utf8(dn.organisation)))] : []),
    set(seq(oid('2.5.4.3'), utf8(dn.commonName))),
  );

const SHA256_RSA = seq(oid('1.2.840.113549.1.1.11'), NULL);

export interface TestCertificate {
  /** DER of the certificate. */
  der: Buffer;
  subject: DistinguishedName;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export interface IssueOptions {
  subject: DistinguishedName;
  /** The issuing CA; omitted for a self-signed root. */
  issuer?: TestCertificate;
  ca: boolean;
  notBefore: Date;
  notAfter: Date;
  /** Sign with this key instead of the issuer's (a forged or broken chain, for tests). */
  signingKey?: KeyObject;
}

/** Issues one certificate: a CA (key usage keyCertSign, cRLSign) or an end-entity signer (digitalSignature, nonRepudiation). */
export function issueTestCertificate(o: IssueOptions): TestCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issuerName = o.issuer ? o.issuer.subject : o.subject;
  const basic = seq(oid('2.5.29.19'), TRUE, octets(seq(...(o.ca ? [TRUE] : []))));
  const usage = seq(oid('2.5.29.15'), TRUE, octets(o.ca ? bitString(1, Buffer.from([0x06])) : bitString(6, Buffer.from([0xc0]))));
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(Buffer.concat([Buffer.from([0x01]), randomBytes(15)])),
    SHA256_RSA,
    name(issuerName),
    seq(time(o.notBefore), time(o.notAfter)),
    name(o.subject),
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(basic, usage)),
  );
  const signer = createSign('sha256');
  signer.update(tbs);
  const key = o.signingKey ?? o.issuer?.privateKey ?? privateKey;
  const signature = signer.sign(key);
  return { der: seq(tbs, SHA256_RSA, bitString(0, signature)), subject: o.subject, privateKey, publicKey };
}

export interface TestCa {
  root: TestCertificate;
  /** The intermediate (a Class 3 sub-CA, as a licensed CA issues from). */
  subCa: TestCertificate;
}

/** A TEST root and its Class 3 sub-CA, valid from `at` minus a day for ten years. */
export function createTestCa(at: Date, label = 'eBMR TEST CA (not legally valid)'): TestCa {
  const notBefore = new Date(at.getTime() - 86_400_000);
  const notAfter = new Date(at.getTime() + 10 * 365 * 86_400_000);
  const root = issueTestCertificate({ subject: { commonName: label, organisation: 'eBMR test', country: 'IN' }, ca: true, notBefore, notAfter });
  const subCa = issueTestCertificate({
    subject: { commonName: 'eBMR TEST Class 3 sub-CA', organisation: 'eBMR test', country: 'IN' }, issuer: root, ca: true, notBefore, notAfter,
  });
  return { root, subCa };
}

/** A signer's Class 3 TEST certificate (two years), issued by the sub-CA. */
export function issueTestSigner(ca: TestCa, commonName: string, at: Date): TestCertificate {
  return issueTestCertificate({
    subject: { commonName, organisation: 'eBMR test signer', country: 'IN' }, issuer: ca.subCa, ca: false,
    notBefore: new Date(at.getTime() - 86_400_000), notAfter: new Date(at.getTime() + 2 * 365 * 86_400_000),
  });
}

/** What the signer's token does through the local signing bridge: an RSA SHA-256 signature over the statement's UTF-8. */
export function signDscStatement(signer: TestCertificate, statement: string): Buffer {
  const s = createSign('sha256');
  s.update(Buffer.from(statement, 'utf8'));
  return s.sign(signer.privateKey);
}
