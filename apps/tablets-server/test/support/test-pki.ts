/**
 * A test PKI made at run time (Phase 7 slice 7a; 6jc-R9): a CA, and server and client certificates it signs, written to a
 * fresh temporary directory with the OpenSSL command line. No key material is committed; every key is made for the test
 * run and named TEST-ONLY.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestCa {
  dir: string;
  /** PEM file paths of the CA's certificate and key. */
  cert: string;
  key: string;
}

export interface TestCertificate {
  cert: string;
  key: string;
}

const openssl = (dir: string, args: string[]): void => {
  execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
};

/** A new CA (EC P-256, one day) in its own temporary directory. */
export function testCa(name: string): TestCa {
  const dir = mkdtempSync(join(tmpdir(), `ebmr-test-pki-${name.toLowerCase()}-`));
  openssl(dir, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca.key.pem', '-out', 'ca.cert.pem', '-days', '1',
    '-subj', `/CN=TEST-ONLY ${name} CA`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  return { dir, cert: join(dir, 'ca.cert.pem'), key: join(dir, 'ca.key.pem') };
}

/** A certificate signed by `ca` for `cn`, with the DNS names and IP addresses `san` and the extended key usage `usage`. */
export function testCertificate(ca: TestCa, cn: string, usage: 'serverAuth' | 'clientAuth', san: { dns?: string[]; ip?: string[] } = {}): TestCertificate {
  const base = `${usage}-${cn.replace(/[^A-Za-z0-9]/g, '_')}`;
  const ext = join(ca.dir, `${base}.ext`);
  const names = [...(san.dns ?? []).map((d) => `DNS:${d}`), ...(san.ip ?? []).map((i) => `IP:${i}`)];
  writeFileSync(ext, [`extendedKeyUsage=${usage}`, 'keyUsage=critical,digitalSignature', ...(names.length > 0 ? [`subjectAltName=${names.join(',')}`] : [])].join('\n'));
  openssl(ca.dir, ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', `${base}.key.pem`, '-out', `${base}.csr`, '-subj', `/CN=TEST-ONLY ${cn}`]);
  openssl(ca.dir, ['x509', '-req', '-in', `${base}.csr`, '-CA', ca.cert, '-CAkey', ca.key, '-CAcreateserial', '-out', `${base}.cert.pem`, '-days', '1', '-extfile', ext]);
  return { cert: join(ca.dir, `${base}.cert.pem`), key: join(ca.dir, `${base}.key.pem`) };
}
