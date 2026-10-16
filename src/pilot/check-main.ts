import { checkPilot } from './preflight.js';
try { console.log(JSON.stringify(await checkPilot())); }
catch { console.error('Offline pilot validation failed. No WhatsApp connection attempted.'); process.exitCode = 1; }
