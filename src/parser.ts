import { DateTime } from 'luxon';
import type { Assignment } from './types.js';

// Arabic uses Unicode letter boundaries; JavaScript \b only handles Latin word characters.
const keyword = /\b(?:assignment|deadline|project|due|exercises?)\b|(?<![\p{L}\p{N}_])(?:و|ف|ب|ل)?(?:ال)?(?:واجب|تسليم|مشروع|تمرين|تمارين)(?![\p{L}\p{N}_])/iu;
export const hasAssignmentKeyword = (text: string): boolean => keyword.test(text);
const digits = (text: string) => text.replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)));

export function parseDeadline(text: string, zone = 'Africa/Khartoum'): Pick<Assignment, 'deadline' | 'deadlineIssue'> {
  const normalized = digits(text);
  // Only fully specified Arabic calendar dates with an explicit 12-hour qualifier.
  const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  const arabicDates = [...normalized.matchAll(/(\d{1,2})\s+(يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر)\s+(\d{4})\s+الساعة\s+(\d{1,2}):(\d{2})\s+(صباحًا|صباحاً|مساءً|مساءًا)(?:\s+بتوقيت\s+السودان)?/gu)];
  if (arabicDates.length) {
    const calendarMentions = [...normalized.matchAll(/\d{1,2}\s+(?:يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر)/gu)].length;
    if (arabicDates.length !== 1 || calendarMentions !== 1 || /\b\d{4}-\d{2}-\d{2}\b/u.test(normalized)) return { deadline: null, deadlineIssue: 'Multiple deadlines: specify one deadline.' };
    const m = arabicDates[0]!; const hour = Number(m[4]);
    if (hour < 1 || hour > 12) return { deadline: null, deadlineIssue: 'Invalid 12-hour time.' };
    const date = DateTime.fromObject({year:Number(m[3]),month:months.indexOf(m[2]!)+1,day:Number(m[1]),hour:hour%12+(m[6]!.startsWith('مساء')?12:0),minute:Number(m[5])}, {zone:m[0].includes('بتوقيت السودان')?'Africa/Khartoum':zone});
    return date.isValid ? {deadline:date.toUTC().toISO(),deadlineIssue:null} : {deadline:null,deadlineIssue:'Invalid date, time or timezone.'};
  }
  const matches = [...normalized.matchAll(/\b(\d{4}-\d{2}-\d{2})[ T]+(\d{2}:\d{2}(?::\d{2})?)(Z|[+-]\d{2}:\d{2})?/g)];
  const dateCount = [...normalized.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].length;
  if (dateCount > 1 || /\b(?:am|pm)\b|صباحاً|مساءً/iu.test(normalized)) {
    return { deadline: null, deadlineIssue: 'Ambiguous deadline: specify one date and a 24-hour time.' };
  }
  if (matches.length !== 1) return { deadline: null, deadlineIssue: matches.length > 1 ? 'Multiple deadlines: specify one deadline.' : 'Missing or ambiguous deadline: use YYYY-MM-DD HH:mm.' };
  const m = matches[0]!;
  const dt = DateTime.fromISO(`${m[1]}T${m[2]}${m[3] ?? ''}`, { zone, setZone: true });
  return dt.isValid ? { deadline: dt.toUTC().toISO(), deadlineIssue: null } : { deadline: null, deadlineIssue: 'Invalid date, time or timezone.' };
}

/** Blank lines format fields; repeated subject/title headers or numbered entries identify new items. */
export function extractAssignments(text: string, zone = 'Africa/Khartoum'): Assignment[] {
  if (!keyword.test(text)) return [];
  const parts = text.trim().split(/\n\s*\n|\n(?=\s*[0-9٠-٩]+[.)]\s)|\n(?=\s*(?:course|subject|المادة|مادة)\s*[:：])/iu);
  const blocks: string[] = [];
  const subject = /(?:course|subject|المادة|مادة)\s*[:：]/iu;
  const title = /(?:assignment name|name|اسم التكليف|اسم الواجب)\s*[:：]/iu;
  for (const part of parts) {
    const previous = blocks.at(-1);
    const newItem = /^\s*[0-9٠-٩]+[.)]\s/u.test(part) ||
      (subject.test(part) && previous && subject.test(previous)) ||
      (title.test(part) && previous && title.test(previous)) ||
      (previous && parseDeadline(previous, zone).deadline && parseDeadline(part, zone).deadline && keyword.test(part));
    if (!previous || newItem) blocks.push(part); else blocks[blocks.length-1] += `\n\n${part}`;
  }
  return blocks.filter(block => keyword.test(block) && (/\d{4}-\d{2}-\d{2}|deadline|\bdue\b|تسليم|(?:course|subject|المادة|مادة)\s*[:：]|(?:عندنا|عليكم|مطلوب)\s+(?:واجب|مشروع|تمرين|تمارين)|\b(?:complete|submit|solve)\s+(?:the\s+)?(?:assignment|project|exercises?)\b/iu.test(digits(block)) || /^\s*(?:assignment|project|exercises?|واجب|مشروع|تمرين|تمارين)\s*(?::|$)/iu.test(block))).map(block => {
    const course = block.match(/(?:course|subject|المادة|مادة)\s*[:：]\s*([^\n;]+)/iu)?.[1]?.trim() ?? null;
    const name = block.match(/(?:assignment name|name|اسم التكليف|اسم الواجب)\s*[:：]\s*([^\n;]+)/iu)?.[1]?.trim() ?? null;
    const description = block.match(/(?:description|الوصف)\s*[:：]\s*([^\n]+)/iu)?.[1]?.trim() ?? null;
    const url = block.match(/https?:\/\/[^\s<>]+/iu)?.[0]?.replace(/[،,.)]+$/, '') ?? null;
    const email = block.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu)?.[0] ?? null;
    const candidate = block.match(/(?:^|\n)\s*(?:submission|(?:مكان|طريقة|وجهة)\s+التسليم|التسليم)\s*[:：]\s*([^\n]+)/iu)?.[1]?.trim();
    // A deadline under a submission label is not evidence of a submission destination.
    const custom = candidate && !/^(?:\d{4}[-/]|يوم\b|بكرة|غد|tomorrow\b)/iu.test(digits(candidate)) ? candidate : undefined;
    const submissionMethod = /moodle|مودل|موودل/iu.test(block) ? (/SUST|السودان للعلوم/iu.test(block) ? 'SUST Moodle' : 'Moodle')
      : /forms\.gle|forms\.google|docs\.google\.com\/forms|google forms/iu.test(block) ? 'Google Forms'
      : /drive\.google|google drive/iu.test(block) ? 'Google Drive'
      : email || /email|إيميل|ايميل|البريد/iu.test(block) ? 'email'
      : /in person|حضوري|باليد/iu.test(block) ? 'in person' : custom || url ? 'custom' : null;
    return { course, name, description, ...parseDeadline(block, zone), submissionMethod, destination: email ?? url ?? custom ?? null };
  });
}
