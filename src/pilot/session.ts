import { readFile } from 'node:fs/promises';
import { verifySignature } from 'whatsapp-rust-bridge';
import {
  BufferJSON, Curve, generateSignalPubKey, jidNormalizedUser, proto,
  WA_ADV_ACCOUNT_SIG_PREFIX, WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX, WA_ADV_DEVICE_SIG_PREFIX,
  type AuthenticationCreds, type KeyPair,
} from '@whiskeysockets/baileys';

const failure = 'Saved pilot session is missing, incomplete, invalid or belongs to another account. Pair separately before live testing.';
const challenge = Buffer.from('assignment-reminder-offline-session-key-check');
// Baileys rc14 Curve.verify ignores libsignal's false return. Inspect the actual result.
const verify = (key: Uint8Array, message: Uint8Array, signature: Uint8Array) => verifySignature(generateSignalPubKey(key), message, signature) === true;
function bytes(value: unknown, length: number): value is Uint8Array {
  return value instanceof Uint8Array && value.length === length && value.some(byte => byte !== 0);
}
function keyPair(pair: KeyPair | undefined) {
  if (!pair || !bytes(pair.public, 32) || !bytes(pair.private, 32) ||
      !verify(pair.public, challenge, Curve.sign(pair.private, challenge))) throw new Error(failure);
}

/** Read-only local integrity validation. Never initializes, repairs or saves auth files. */
export async function validateSavedSession(path: string, expectedAccount: string): Promise<void> {
  try {
    const credentials = JSON.parse(await readFile(path, 'utf8'), BufferJSON.reviver) as AuthenticationCreds;
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error(failure);
    const me = credentials.me;
    if (!me || typeof me.id !== 'string' || !/^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(me.id)) throw new Error(failure);
    if (me.lid !== undefined && (typeof me.lid !== 'string' || !/^\d+(?::\d+)?@lid$/.test(me.lid))) throw new Error(failure);
    if (![me.id, me.lid].some(id => id && jidNormalizedUser(id) === expectedAccount)) throw new Error(failure);
    keyPair(credentials.noiseKey);
    keyPair(credentials.signedIdentityKey);
    keyPair(credentials.signedPreKey?.keyPair);
    if (!Number.isInteger(credentials.registrationId) || credentials.registrationId < 0 || credentials.registrationId > 16383 ||
        !Number.isInteger(credentials.signedPreKey.keyId) || credentials.signedPreKey.keyId < 1 ||
        typeof credentials.advSecretKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(credentials.advSecretKey) ||
        Buffer.from(credentials.advSecretKey, 'base64').length !== 32 ||
        !bytes(credentials.signedPreKey.signature, 64) ||
        !verify(credentials.signedIdentityKey.public, generateSignalPubKey(credentials.signedPreKey.keyPair.public), credentials.signedPreKey.signature)) throw new Error(failure);
    if (!credentials.account || typeof credentials.account !== 'object' || Array.isArray(credentials.account)) throw new Error(failure);
    // Protobuf account.toJSON emits base64 strings; older/plain objects use BufferJSON.
    const account = proto.ADVSignedDeviceIdentity.fromObject(credentials.account);
    if (!bytes(account.accountSignatureKey, 32) || !bytes(account.accountSignature, 64) ||
        !bytes(account.deviceSignature, 64) || !(account.details instanceof Uint8Array) || !account.details.length) throw new Error(failure);
    const details = proto.ADVDeviceIdentity.decode(account.details);
    if (details.keyIndex == null || details.rawId == null || details.timestamp == null) throw new Error(failure);
    const prefix = details.deviceType === proto.ADVEncryptionType.HOSTED ? WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX : WA_ADV_ACCOUNT_SIG_PREFIX;
    const accountMessage = Buffer.concat([prefix, account.details, credentials.signedIdentityKey.public]);
    const deviceMessage = Buffer.concat([WA_ADV_DEVICE_SIG_PREFIX, account.details, credentials.signedIdentityKey.public, account.accountSignatureKey]);
    if (!verify(account.accountSignatureKey, accountMessage, account.accountSignature) ||
        !verify(credentials.signedIdentityKey.public, deviceMessage, account.deviceSignature)) throw new Error(failure);
    // registered is intentionally not evidence: SDK QR pairing does not update it.
  } catch { throw new Error(failure); } // Never expose raw JSON, keys, paths or SDK errors.
}
