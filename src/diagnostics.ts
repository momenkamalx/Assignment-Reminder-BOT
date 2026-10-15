export type DiagnosticCode = 'message_received' | 'group_matched' | 'group_rejected' | 'leader_matched' | 'leader_rejected'
  | 'keyword_detected' | 'keyword_absent' | 'parser_accepted' | 'parser_incomplete' | 'parser_empty'
  | 'draft_created' | 'preview_queued' | 'outgoing_attempted' | 'outgoing_acknowledged' | 'outgoing_failed'
  | 'quoted_announcement_rejected' | 'pilot_limit_rejected' | 'receive_failed' | 'raw_group_message' | 'offline_message_rejected';
export interface DiagnosticEvent { code: DiagnosticCode; count: number }
export type DiagnosticSink = (event: DiagnosticEvent) => void;
export const noDiagnostics: DiagnosticSink = () => {};
/** Fixed codes and integer counts only; never accepts context, identifiers, text or errors. */
export function diagnostic(sink: DiagnosticSink, code: DiagnosticCode, count = 1) {
  try { sink({ code, count: Number.isSafeInteger(count) && count >= 0 ? count : 0 }); } catch { /* Observability must not alter transactions or delivery. */ }
}
