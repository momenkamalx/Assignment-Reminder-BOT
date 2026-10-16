import qr from 'qrcode-terminal';
import { pilotConfig } from './config.js';
import { pairingRuntime } from './pairing.js';
import { liveDependencies } from '../whatsapp/runtime.js';

let runtime: ReturnType<typeof pairingRuntime> | undefined;
try {
  const config = await pilotConfig('pair'); // All approvals checked before auth access/socket creation.
  runtime = pairingRuntime(liveDependencies({ authorized: () => false }, config.authDir, value => qr.generate(value, { small: true })));
  const stop = () => { runtime?.stop(); void runtime?.idle(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  console.log('Pairing only. No assignment processing, delivery workers or group messages. Keep the QR private.');
  await runtime.start();
} catch {
  runtime?.stop(); await runtime?.idle();
  console.error('Pilot pairing refused or failed. Check approvals, private paths and configuration; no credentials logged.');
  process.exitCode = 1;
}
