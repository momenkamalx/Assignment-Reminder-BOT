/** Explicit, process-local scope for the supervised launcher. No I/O or connections. */
export function controlledPermissions(env: NodeJS.ProcessEnv) {
  if (env.PILOT_CONTROLLED_TEST !== 'true' || env.PILOT_CORRECTIONS_APPROVED !== 'true') throw new Error('Explicit controlled preview/feedback approval required.');
  const diagnosticOnly = env.PILOT_DIAGNOSTIC_ONLY === 'true';
  if (diagnosticOnly) {
    if (env.PILOT_DIAGNOSTIC_APPROVED !== 'true' || env.PILOT_REMINDER_TEST === 'true') throw new Error('Diagnostic approval required; reminders must be disabled.');
  } else if (env.PILOT_REMINDER_TEST !== 'true') throw new Error('Explicit reminder test approval required.');
  return { diagnosticOnly };
}
