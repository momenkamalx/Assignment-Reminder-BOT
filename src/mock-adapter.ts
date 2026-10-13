import type { WhatsAppAdapter, SendOptions } from './types.js';
export class MockWhatsAppAdapter implements WhatsAppAdapter {
  readonly sent: { id: string; groupId: string; text: string; replyTo?: string; options?: SendOptions }[] = [];
  readonly groupMembers = new Map<string, string[]>();
  async members(groupId: string) { return this.groupMembers.get(groupId) ?? []; }
  async send(groupId: string, text: string, replyTo?: string, options?: SendOptions): Promise<string> {
    const id = options?.messageId ?? `mock-${crypto.randomUUID()}`;
    if (this.sent.some(m => m.id === id && m.groupId === groupId)) return id;
    this.sent.push({ id, groupId, text, replyTo, options });
    return id;
  }
}
