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
}
export interface WhatsAppAdapter {
  send(groupId: string, text: string, replyTo?: string): Promise<string>;
}
