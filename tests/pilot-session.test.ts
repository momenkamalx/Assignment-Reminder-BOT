import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { BufferJSON, initAuthCreds, Curve, proto } from '@whiskeysockets/baileys';
import { validateSavedSession } from '../src/pilot/session.js';
import { pairedSession } from './helpers/paired-session.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(content?: string) {
  const root = await mkdtemp(join(tmpdir(), 'session-guard-')); roots.push(root);
  const path = join(root, 'creds.json'); if (content !== undefined) await writeFile(path, content);
  return path;
}
const expected = '249900000003@s.whatsapp.net';
it.each([false, true])('accepts a signed QR session with registered=%s without modifying it', async registered => {
  const credentials = pairedSession(); credentials.registered = registered;
  const content = JSON.stringify(credentials, BufferJSON.replacer); const path = await fixture(content); const before = await stat(path);
  await validateSavedSession(path, expected);
  expect(await readFile(path, 'utf8')).toBe(content); expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
});
it('supports hosted signatures and explicitly verified LID identity', async () => {
  await validateSavedSession(await fixture(JSON.stringify(pairedSession(true), BufferJSON.replacer)), '100000000003@lid');
});
it('accepts the SDK protobuf account serialization with base64 strings and registered=false', async () => {
  const credentials = pairedSession();
  credentials.account = proto.ADVSignedDeviceIdentity.fromObject(credentials.account!);
  const content = JSON.stringify(credentials, BufferJSON.replacer);
  expect(typeof JSON.parse(content).account.details).toBe('string');
  const path = await fixture(content);
  await validateSavedSession(path, expected);
  expect(await readFile(path, 'utf8')).toBe(content);
});
it.each([undefined, '', '{invalid', 'null', '[]', '{}', '{"registered":true}', JSON.stringify(initAuthCreds(), BufferJSON.replacer)])('rejects missing, malformed or unpaired session %#', async content => {
  const path = await fixture(content); await expect(validateSavedSession(path, expected)).rejects.toThrow('Saved pilot session');
  if (content !== undefined) expect(await readFile(path, 'utf8')).toBe(content);
});
it.each(['me', 'account', 'noiseKey', 'signedIdentityKey', 'signedPreKey', 'advSecretKey', 'registrationId'])('rejects missing %s', async field => {
  const credentials = pairedSession() as unknown as Record<string, unknown>; delete credentials[field];
  await expect(validateSavedSession(await fixture(JSON.stringify(credentials, BufferJSON.replacer)), expected)).rejects.toThrow();
});
it.each(['accountSignature', 'deviceSignature', 'accountSignatureKey', 'details'])('rejects corrupt account %s', async field => {
  const credentials = pairedSession(); const account = credentials.account as unknown as Record<string, unknown>;
  account[field] = Buffer.alloc(field === 'details' ? 1 : field === 'accountSignatureKey' ? 32 : 64, 1);
  await expect(validateSavedSession(await fixture(JSON.stringify(credentials, BufferJSON.replacer)), expected)).rejects.toThrow();
});
it.each(['noiseKey', 'signedIdentityKey'])('rejects mismatched %s key pairs', async field => {
  const credentials = pairedSession(); credentials[field as 'noiseKey' | 'signedIdentityKey'].private = Curve.generateKeyPair().private;
  await expect(validateSavedSession(await fixture(JSON.stringify(credentials, BufferJSON.replacer)), expected)).rejects.toThrow();
});
it('rejects wrong account, malformed IDs, invalid secret and corrupted prekey signature', async () => {
  const credentials = pairedSession();
  await expect(validateSavedSession(await fixture(JSON.stringify(credentials, BufferJSON.replacer)), '249900000009@s.whatsapp.net')).rejects.toThrow();
  for (const mutate of [() => { credentials.me!.id = 'wrong@g.us'; }, () => { credentials.advSecretKey = 'bad'; }, () => { credentials.signedPreKey.signature = Buffer.alloc(64); }]) {
    const fresh = pairedSession(); Object.assign(credentials, fresh); mutate();
    await expect(validateSavedSession(await fixture(JSON.stringify(credentials, BufferJSON.replacer)), expected)).rejects.toThrow();
  }
});
