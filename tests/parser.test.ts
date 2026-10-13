import { describe, expect, it } from 'vitest';
import { extractAssignments, parseDeadline } from '../src/parser.js';
import { expectedAssignments, missingDeadlineAnnouncement, sudaneseAnnouncement } from './fixtures/sudanese-announcement.js';

describe('conservative assignment extraction', () => {
  it('extracts three Sudanese Arabic assignments with separate subjects, UTC deadlines and destinations', () => {
    expect(extractAssignments(sudaneseAnnouncement)).toEqual(expectedAssignments);
  });
  it('handles Arabic numbering without subject headers or blank lines', () => {
    const text = '١. عندنا واجب تسليم ٢٠٢٧-٠٥-٢٠ ١٨:٠٠\n٢. عندنا مشروع تسليم ٢٠٢٧-٠٥-٢١ ١٢:٣٠\n٣. عندنا تمرين تسليم ٢٠٢٧-٠٥-٢٢ ٢٠:١٥';
    const drafts = extractAssignments(text);
    expect(drafts).toHaveLength(3);
    expect(drafts.map(d => d.deadline)).toEqual(expectedAssignments.map(d => d.deadline));
    expect(drafts.every(d => d.course === null)).toBe(true);
  });
  it('retains a missing-deadline assignment without borrowing a neighboring deadline', () => {
    const drafts = extractAssignments(missingDeadlineAnnouncement);
    expect(drafts).toHaveLength(3);
    expect(drafts.slice(0, 2)).toEqual(expectedAssignments.slice(0, 2));
    expect(drafts[2]).toMatchObject({ ...expectedAssignments[2], deadline: null, deadlineIssue: expect.any(String) });
  });
  it.each(['عندنا تمرين', 'عندنا تمارين', 'Please complete exercise', 'Please complete exercises'])('detects an explicitly assigned exercise with no deadline: %s', text => {
    const drafts = extractAssignments(text);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ deadline: null, deadlineIssue: expect.any(String), course: null, name: null, destination: null });
  });
  it.each(['تمرين', 'تمارين', 'exercise', 'exercises'])('detects %s with an explicit date and Arabic subject', term => {
    expect(extractAssignments(`المادة: الرياضيات\n${term}\n2027-05-20 18:00`)).toMatchObject([{ course: 'الرياضيات', deadline: '2027-05-20T16:00:00.000Z' }]);
  });
  it('ignores exercise chat and English keyword substrings', () => {
    expect(extractAssignments('That exercise was fun')).toEqual([]);
    expect(extractAssignments('يا شباب التمرين كان ساهل')).toEqual([]);
    expect(extractAssignments('Course: Math\nexerciseology')).toEqual([]);
    expect(extractAssignments('يا شباب عندنا التكليفات دي، كل مادة تسليمها براها:')).toEqual([]);
    expect(extractAssignments('مادة: رياضة\nنحن متمرين')).toEqual([]);
  });
  it('ignores ordinary conversation and unrelated words', () => {
    expect(extractAssignments('السلام عليكم يا شباب')).toEqual([]);
    expect(extractAssignments('That project was fun')).toEqual([]);
    expect(extractAssignments('assignmentology')).toEqual([]);
  });
  it('extracts separate mixed Arabic/English assignments without inventing fields', () => {
    const result = extractAssignments('المادة: الرياضيات\nعندنا واجب\nتسليم ٢٠٢٧-٠٥-٢٠ ١٨:٠٠\nMoodle https://moodle.example.edu/a\n\nCourse: Physics\nproject due 2027-05-21 12:00\nlecturer@example.edu');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ course: 'الرياضيات', deadline: '2027-05-20T16:00:00.000Z', name: null, submissionMethod: 'Moodle', destination: 'https://moodle.example.edu/a' });
    expect(result[1]).toMatchObject({ course: 'Physics', submissionMethod: 'email', destination: 'lecturer@example.edu' });
  });
  it('splits numbered announcements', () => {
    expect(extractAssignments('1. assignment due 2027-05-20 18:00\n2. project due 2027-05-21 18:00')).toHaveLength(2);
  });
  it.each(['بكرة', '2027-05-20', '20/05/27', '2027-02-30 18:00', '2027-05-20 25:00', '2027-05-20 18:00 or 2027-05-21 18:00', '2027-05-20 06:00 PM', '2027-05-20 18:00:99', '2027-05-20 18:00 or 2027-05-21'])('flags uncertain or invalid deadline: %s', value => {
    expect(parseDeadline(value).deadline).toBeNull();
    expect(parseDeadline(value).deadlineIssue).toBeTruthy();
  });
  it('respects explicit UTC and configured timezone', () => {
    expect(parseDeadline('2027-05-20 18:00Z').deadline).toBe('2027-05-20T18:00:00.000Z');
    expect(parseDeadline('2027-05-20 18:00', 'Asia/Riyadh').deadline).toBe('2027-05-20T15:00:00.000Z');
  });
  it('preserves seconds rather than silently discarding them', () => {
    expect(parseDeadline('2027-05-20 18:00:30Z').deadline).toBe('2027-05-20T18:00:30.000Z');
  });
  it.each([
    ['https://forms.gle/abc', 'Google Forms'], ['https://drive.google.com/a', 'Google Drive'],
    ['التسليم: حضوري', 'in person'], ['submission: department office', 'custom'],
  ])('recognizes destination %s', (destination, method) => {
    expect(extractAssignments(`assignment due 2027-05-20 18:00\n${destination}`)[0]?.submissionMethod).toBe(method);
  });
});
