import { readFile, writeFile, rename, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pilotConfig } from './config.js';
import { verifiedProposal } from './proposal.js';
import { Store } from '../database.js';
import { applyGroups } from '../whatsapp/config.js';
import { checkPilot } from './preflight.js';

try {
  const config = await pilotConfig('configure');
  const proposalPath = resolve('data/pilot/metadata-result.json'); const recordPath = resolve('data/pilot/one-shot-online-now.json');
  if (await realpath(proposalPath) !== proposalPath || await realpath(recordPath) !== recordPath) throw new Error('Redirected pilot files refused.');
  const proposal = verifiedProposal(JSON.parse(await readFile(proposalPath, 'utf8')));
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as { target?: string; status?: string };
  if (record.status !== 'accepted' || record.target !== proposal.group.id || proposal.expectedAccount !== config.expectedAccount) throw new Error('Successful one-shot proof required.');
  await checkPilot(); // Before configuration: empty isolated database and no outgoing queue.
  const temporary = resolve('data/pilot/groups.configuring.json');
  await writeFile(temporary, JSON.stringify(proposal.groups, null, 2), { flag: 'wx', mode: 0o600 });
  const store = new Store(config.database);
  try { applyGroups(store, proposal.groups); } finally { store.close(); }
  await rename(temporary, resolve('data/pilot/groups.json'));
  const result = await checkPilot();
  console.log('Verified single-group configuration applied offline. Leader/admin permissions and disabled mentions match the verified proposal.');
  console.log(JSON.stringify(result));
} catch { console.error('Pilot configuration failed safety validation. No live mode started; inspect private pilot files before continuing.'); process.exitCode = 1; }
