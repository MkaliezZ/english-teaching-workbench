import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const data = path.resolve(process.env.M0_DATA || path.join(root, '.m0-data'));
const key = path.join(data, 'localhost.key');
const cert = path.join(data, 'localhost.crt');

mkdirSync(data, { recursive: true });
if (!existsSync(key) || !existsSync(cert)) {
  const gitOpenSsl = path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'usr', 'bin', 'openssl.exe');
  const openssl = process.env.M0_OPENSSL || (process.platform === 'win32' && existsSync(gitOpenSsl) ? gitOpenSsl : 'openssl');
  const result = spawnSync(openssl, [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '30',
    '-keyout', key, '-out', cert, '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('Certificate generation failed. Install OpenSSL or set M0_OPENSSL.', { cause: result.error });
}
console.log('Local HTTPS certificate is ready.');
