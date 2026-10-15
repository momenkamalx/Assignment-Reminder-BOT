import { Curve, initAuthCreds, proto, WA_ADV_ACCOUNT_SIG_PREFIX, WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX, WA_ADV_DEVICE_SIG_PREFIX } from '@whiskeysockets/baileys';

/** Synthetic signed credentials only; never loads a real account or opens a socket. */
export function pairedSession(hosted = false) {
  const creds = initAuthCreds();
  creds.me = { id: '249900000003:7@s.whatsapp.net', name: 'Mock spare', lid: '100000000003@lid' };
  const signer = Curve.generateKeyPair();
  const details = proto.ADVDeviceIdentity.encode({ rawId: 1, timestamp: 1800000000, keyIndex: 1,
    deviceType: hosted ? proto.ADVEncryptionType.HOSTED : proto.ADVEncryptionType.E2EE }).finish();
  const prefix = hosted ? WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX : WA_ADV_ACCOUNT_SIG_PREFIX;
  creds.account = { details, accountSignatureKey: signer.public,
    accountSignature: Curve.sign(signer.private, Buffer.concat([prefix, details, creds.signedIdentityKey.public])),
    deviceSignature: Curve.sign(creds.signedIdentityKey.private, Buffer.concat([WA_ADV_DEVICE_SIG_PREFIX, details, creds.signedIdentityKey.public, signer.public])) };
  return creds;
}
