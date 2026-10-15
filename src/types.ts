export interface Assignment {
  course: string | null;
  name: string | null;
  description: string | null;
  deadline: string | null;
  deadlineIssue: string | null;
  submissionMethod: string | null;
  destination: string | null;
}
export interface IncomingMessage {
  id: string; groupId: string; senderId: string; text: string; replyTo?: string;
  key?: MessageReference;
}
export interface WhatsAppAdapter {
  send(groupId: string, text: string, replyTo?: string, options?: SendOptions): Promise<string>;
  members?(groupId: string): Promise<string[]>;
  authorized?(groupId: string): boolean;
  ready?(groupId: string): boolean;
}
export interface MessageReference { id: string; remoteJid: string; participant?: string; participantAlt?: string; fromMe?: boolean }
export interface SendOptions { messageId?: string; mentions?: string[]; mentionAll?: boolean; quote?: MessageReference }
export interface ReminderSettings { offsetHours: number[]; mentions: 'none' | 'individual' | 'native_all' }
