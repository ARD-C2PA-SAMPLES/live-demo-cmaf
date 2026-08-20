// UI strings for statuses and sequence anomalies.
// Codes follow C2PA spec §15/§18/§19.7 and the plugin's values.
// Human-readable messages for validation error codes come from the plugin's
// ERROR_CODE_MESSAGES export.

// `replayed`, `reordered` and `warning` are deliberately absent: this
// deployment does not report them, see IGNORED_STATUSES in main.js.
export const STATUS_LABELS = {
  valid: 'Valid',
  invalid: 'Invalid',
  missing: 'Segments missing',
  unverified: 'Unverified',
};

// Severity used to aggregate the overall status (higher = worse)
export const STATUS_SEVERITY = {
  valid: 1,
  unverified: 2,
  missing: 6,
  invalid: 7,
};

export const SEQUENCE_REASONS = {
  gap_detected: 'Gap detected in the sequence (missing segments)',
};

// The plugin only validates video and audio; text segments show up in the CAWG
// section because their manifest box is read as well.
export const MEDIA_TYPE_LABELS = {
  video: 'Video',
  audio: 'Audio',
  text: 'Text',
};
