import { getBinaryNodeChild, getBinaryNodeChildren, jidNormalizedUser, type BinaryNode, type Contact } from '@whiskeysockets/baileys';
import { isGroupId, normalizePerson } from '../whatsapp/config.js';

export interface MetadataRequest { expectedGroupName: string; groupJid?: string; inviteCode?: string; leader: string; admins: string[] }
function person(input: unknown): string {
  if (typeof input !== 'string') throw new Error('Selected identity missing.');
  const value = input.trim();
  return normalizePerson(/^\+[1-9]\d{6,14}$/.test(value) ? `${value.slice(1)}@s.whatsapp.net` : value);
}
export function parseMetadataRequest(input: unknown): MetadataRequest {
  if (!input || typeof input !== 'object') throw new Error('Invalid local metadata request.');
  const value = input as Record<string, unknown>;
  if (typeof value.expectedGroupName !== 'string' || !value.expectedGroupName.trim() || !Array.isArray(value.admins) || !value.admins.length) throw new Error('Group name and selected roles required.');
  const groupJid = typeof value.groupJid === 'string' ? value.groupJid.trim() : '';
  const inviteLink = typeof value.inviteLink === 'string' ? value.inviteLink.trim() : '';
  if (!!groupJid === !!inviteLink) throw new Error('Specify exactly one group JID or invite link; names cannot be searched.');
  let inviteCode: string | undefined;
  if (groupJid && !isGroupId(groupJid)) throw new Error('Invalid group JID.');
  if (inviteLink) {
    let url: URL; try { url = new URL(inviteLink); } catch { throw new Error('Invalid invite link.'); }
    if (url.protocol !== 'https:' || url.hostname !== 'chat.whatsapp.com' || url.port || url.username || url.password || url.hash ||
        !/^\/[A-Za-z0-9_-]{10,64}\/?$/.test(url.pathname) || [...url.searchParams.keys()].some(key => !['mode', 's', 'p', 'mlu', 'ilr'].includes(key))) throw new Error('Invalid invite link.');
    inviteCode = url.pathname.replaceAll('/', '');
  }
  const admins = value.admins.map(person);
  if (new Set(admins).size !== admins.length) throw new Error('Duplicate selected admin.');
  return { expectedGroupName: value.expectedGroupName.trim(), ...(groupJid ? { groupJid } : { inviteCode }), leader: person(value.leader), admins };
}
function group(node: BinaryNode, expectedName: string) {
  const result = getBinaryNodeChild(node, 'group');
  if (!result || result.attrs.subject?.trim() !== expectedName) throw new Error('Specified group could not be verified.');
  const id = result.attrs.id?.includes('@') ? result.attrs.id : `${result.attrs.id}@g.us`;
  if (!isGroupId(id)) throw new Error('Invalid group response.');
  return { node: result, id };
}
function identity(attrs: BinaryNode['attrs']) {
  const result: { id: string; phoneNumber?: string; lid?: string } = { id: normalizePerson(attrs.jid ?? '') };
  if (attrs.phone_number) { const phone = normalizePerson(attrs.phone_number); if (!phone.endsWith('@s.whatsapp.net')) throw new Error('Invalid phone mapping.'); result.phoneNumber = phone; }
  if (attrs.lid) { const lid = normalizePerson(attrs.lid); if (!lid.endsWith('@lid')) throw new Error('Invalid LID mapping.'); result.lid = lid; }
  return result;
}
export async function identifyPrivateGroup(request: MetadataRequest, account: Pick<Contact, 'id' | 'lid'>,
  query: (node: BinaryNode) => Promise<BinaryNode>) {
  let target = request.groupJid;
  if (!target) {
    const response = await query({ tag: 'iq', attrs: { type: 'get', xmlns: 'w:g2', to: '@g.us' }, content: [{ tag: 'invite', attrs: { code: request.inviteCode! } }] });
    target = group(response, request.expectedGroupName).id;
  }
  const response = await query({ tag: 'iq', attrs: { type: 'get', xmlns: 'w:g2', to: target }, content: [{ tag: 'query', attrs: { request: 'interactive' } }] });
  const verified = group(response, request.expectedGroupName);
  if (verified.id !== target) throw new Error('Group identity mismatch.');
  const selected = new Set([request.leader, ...request.admins]);
  const matches = new Map<string, ReturnType<typeof identity>>();
  const own = new Set([account.id, account.lid].filter((id): id is string => !!id).map(normalizePerson));
  let member = false;
  // The server returns this group's roster. Inspect references transiently, retaining only selected matches.
  for (const participant of getBinaryNodeChildren(verified.node, 'participant')) {
    const ids = [participant.attrs.jid, participant.attrs.phone_number, participant.attrs.lid].filter((id): id is string => !!id).map(jidNormalizedUser);
    if (ids.some(id => own.has(id))) member = true;
    for (const choice of selected) if (ids.includes(choice)) {
      if (matches.has(choice)) throw new Error('Ambiguous selected participant.');
      matches.set(choice, identity(participant.attrs));
    }
  }
  if (!member || [...selected].some(choice => !matches.has(choice))) throw new Error('Spare account or selected participant is not a verified member.');
  const leader = matches.get(request.leader)!;
  const admins = request.admins.map(choice => matches.get(choice)!);
  if (new Set(admins.map(admin => admin.id)).size !== admins.length) throw new Error('Selected admin aliases overlap.');
  return {
    expectedAccount: normalizePerson(account.id),
    groupVerified: true, spareAccountMember: true,
    identities: { leader, admins },
    proposedGroups: [{ id: target, leader: leader.phoneNumber ?? leader.id, admins: admins.map(admin => admin.phoneNumber ?? admin.id),
      timezone: 'Africa/Khartoum', reminders: { offsetHours: [24], mentions: 'none' } }],
  };
}
