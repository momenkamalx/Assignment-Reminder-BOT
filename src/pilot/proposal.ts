import { parseGroups, normalizePerson } from '../whatsapp/config.js';

export function verifiedProposal(input: unknown) {
  const value = input as { groupVerified?: boolean; spareAccountMember?: boolean; expectedAccount?: string;
    proposedGroups?: unknown; identities?: { leader?: { id: string; phoneNumber?: string; lid?: string }; admins?: { id: string; phoneNumber?: string; lid?: string }[] } };
  if (!value || value.groupVerified !== true || value.spareAccountMember !== true || !value.expectedAccount || !value.identities?.leader || !value.identities.admins?.length) throw new Error('Verified proposal missing.');
  const groups = parseGroups(value.proposedGroups);
  const group = groups[0]!;
  if (groups.length !== 1 || group.timezone !== 'Africa/Khartoum' || group.reminders?.mentions !== 'none' ||
      JSON.stringify(group.reminders.offsetHours) !== '[24]') throw new Error('Unsafe proposed settings.');
  const aliases = (person: { id: string; phoneNumber?: string; lid?: string }) => [person.id, person.phoneNumber, person.lid].filter((id): id is string => !!id).map(normalizePerson);
  if (!aliases(value.identities.leader).includes(group.leader) || group.admins.length !== value.identities.admins.length ||
      group.admins.some((id, index) => !aliases(value.identities!.admins![index]!).includes(id))) throw new Error('Selected permission mapping mismatch.');
  return { groups, group, expectedAccount: normalizePerson(value.expectedAccount) };
}
