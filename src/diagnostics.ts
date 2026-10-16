export type DiagnosticCode = 'message_received' | 'group_matched' | 'group_rejected' | 'leader_matched' | 'leader_rejected'
  | 'keyword_detected' | 'keyword_absent' | 'parser_accepted' | 'parser_incomplete' | 'parser_empty'
  | 'draft_created' | 'preview_queued' | 'outgoing_attempted' | 'outgoing_acknowledged' | 'outgoing_failed'
  | 'quoted_announcement_rejected' | 'pilot_limit_rejected' | 'receive_failed' | 'raw_group_message' | 'offline_message_rejected'
  | 'transport_message_received' | 'transport_route_rejected' | 'transport_key_invalid' | 'sdk_handler_forwarded' | 'sdk_handler_missing'
  | 'upsert_received' | 'upsert_notify' | 'upsert_append' | 'upsert_other' | 'upsert_disconnected'
  | 'message_key_invalid' | 'self_message_rejected' | 'sender_resolved' | 'sender_unresolved' | 'sender_conflict'
  | 'parser_invoked' | 'pilot_message_ignored' | 'listener_registered' | 'sdk_message_handlers'
  | 'message_update_received' | 'history_event_received' | 'pending_notifications_ready'
  | 'timestamp_missing' | 'timestamp_invalid' | 'timestamp_before_start' | 'timestamp_since_start'
  | 'pilot_message_received' | 'pilot_group_matched' | 'pilot_leader_matched' | 'pilot_leader_rejected' | 'pilot_parser_invoked'
  | 'adapter_upsert_notify' | 'adapter_upsert_append' | 'adapter_upsert_other' | 'adapter_disconnected'
  | 'wire_payload_received' | 'decoded_frame_received' | 'decoded_message_frame' | 'decoded_notification_frame' | 'decoded_other_frame'
  | 'sdk_warning' | 'sdk_error' | 'connection_open_received' | 'receive_pipeline_ready' | 'receive_route_lost'
  | 'sdk_sync_disabled' | 'sdk_buffer_timeout' | 'sdk_activation_warning' | 'sdk_digest_warning' | 'sdk_prekey_warning'
  | 'sdk_presence_warning' | 'sdk_lid_warning' | 'sdk_key_commit_warning' | 'sdk_warning_unclassified'
  | 'pending_offline_preview_frame' | 'pending_offline_marker_frame' | 'pending_offline_preview_callback' | 'pending_offline_marker_callback'
  | 'offline_flag_absent' | 'offline_flag_zero' | 'offline_flag_one' | 'offline_flag_other'
  | 'sync_connecting' | 'sync_open' | 'sync_closed' | 'sync_unexpected_close' | 'sync_account_verified'
  | 'sync_pending_false' | 'sync_pending_true' | 'sync_buffer_active' | 'sync_buffer_released' | 'sync_finished' | 'sync_duration_elapsed' | 'sync_connection_timeout'
  | 'sync_application_send_blocked' | 'signal_write_attempt' | 'signal_write_ok' | 'signal_write_failed'
  | 'credentials_save_attempt' | 'credentials_save_ok' | 'credentials_save_failed'
  | 'protocol_ack_attempt' | 'protocol_notification_ack_attempt' | 'protocol_receipt_ack_attempt' | 'protocol_message_ack_attempt'
  | 'protocol_receipt_attempt' | 'offline_batch_request_attempt';
export interface DiagnosticEvent { code: DiagnosticCode; count: number }
export type DiagnosticSink = (event: DiagnosticEvent) => void;
export const noDiagnostics: DiagnosticSink = () => {};
/** Fixed codes and integer counts only; never accepts context, identifiers, text or errors. */
export function diagnostic(sink: DiagnosticSink, code: DiagnosticCode, count = 1) {
  try { sink({ code, count: Number.isSafeInteger(count) && count >= 0 ? count : 0 }); } catch { /* Observability must not alter transactions or delivery. */ }
}
