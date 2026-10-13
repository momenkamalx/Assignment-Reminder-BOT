import type { WhatsAppAdapter } from './types.js';
export class MockWhatsAppAdapter implements WhatsAppAdapter {
  readonly sent: { id: string; groupId: string; text: string; replyTo?: string }[] = [];
  async send(groupId: string, text: string, replyTo?: string): Promise<string> {
    const id = `mock-${crypto.randomUUID()}`;
    this.sent.push({ id, groupId, text, replyTo });
    return id;
  }
}
