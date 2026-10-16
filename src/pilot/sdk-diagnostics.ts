import { diagnostic, type DiagnosticCode, type DiagnosticSink } from '../diagnostics.js';

/** Exact installed-SDK messages mapped to fixed codes. No payload, errors or text escape this boundary. */
export function observeSdkLog(line: string, sink: DiagnosticSink) {
  try {
    const entry = JSON.parse(line) as {level?:number;msg?:unknown};
    diagnostic(sink, Number(entry.level) >= 50 ? 'sdk_error' : 'sdk_warning');
    const message = typeof entry.msg === 'string' ? entry.msg : '';
    let code: DiagnosticCode = 'sdk_warning_unclassified';
    if (message.includes('DISABLING ALL SYNC BY shouldSyncHistoryMsg')) code = 'sdk_sync_disabled';
    else if (message === 'Buffer timeout reached, auto-flushing') code = 'sdk_buffer_timeout';
    else if (message === 'failed to send initial passive iq') code = 'sdk_activation_warning';
    else if (message === 'failed to run digest after login') code = 'sdk_digest_warning';
    else if (message === 'Failed to check/upload pre-keys during initialization') code = 'sdk_prekey_warning';
    else if (message === 'no name present, ignoring presence update request...') code = 'sdk_presence_warning';
    else if (message === 'Failed to store LID-PN mapping') code = 'sdk_lid_warning';
    else if (message.startsWith('failed to commit mutations, retries left=')) code = 'sdk_key_commit_warning';
    diagnostic(sink, code);
  } catch { diagnostic(sink, 'sdk_error'); }
}
