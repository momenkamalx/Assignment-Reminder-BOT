import type { Assignment } from '../../src/types.js';

// One WhatsApp message, Arabic numbering, no blank lines between assignments.
export const sudaneseAnnouncement = `يا شباب عندنا التكليفات دي، كل مادة تسليمها براها:
١. المادة: البرمجة
عندنا واجب
اسم التكليف: الدوال
الوصف: حلوا الأسئلة وارفعوها في SUST Moodle
آخر تسليم: ٢٠٢٧-٠٥-٢٠ ١٨:٠٠
التسليم: SUST Moodle https://moodle.sust.example/course/programming
٢. المادة: الفيزياء
عندنا مشروع
اسم التكليف: تقرير المعمل
الوصف: أرسلوا التقرير للدكتور بالإيميل
آخر تسليم: ٢٠٢٧-٠٥-٢١ ١٢:٣٠
التسليم: lab@example.edu
٣. المادة: الرياضيات
عندنا تمرين
اسم التكليف: المصفوفات
الوصف: حلوا التمرين وسلموه في الرابط دا
آخر تسليم: ٢٠٢٧-٠٥-٢٢ ٢٠:١٥
التسليم عبر الرابط: https://submit.example.edu/matrices`;

export const expectedAssignments: Assignment[] = [
  { course: 'البرمجة', name: 'الدوال', description: 'حلوا الأسئلة وارفعوها في SUST Moodle', deadline: '2027-05-20T16:00:00.000Z', deadlineIssue: null, submissionMethod: 'SUST Moodle', destination: 'https://moodle.sust.example/course/programming' },
  { course: 'الفيزياء', name: 'تقرير المعمل', description: 'أرسلوا التقرير للدكتور بالإيميل', deadline: '2027-05-21T10:30:00.000Z', deadlineIssue: null, submissionMethod: 'email', destination: 'lab@example.edu' },
  { course: 'الرياضيات', name: 'المصفوفات', description: 'حلوا التمرين وسلموه في الرابط دا', deadline: '2027-05-22T18:15:00.000Z', deadlineIssue: null, submissionMethod: 'custom', destination: 'https://submit.example.edu/matrices' },
];

export const missingDeadlineAnnouncement = sudaneseAnnouncement.replace('آخر تسليم: ٢٠٢٧-٠٥-٢٢ ٢٠:١٥\n', '');
