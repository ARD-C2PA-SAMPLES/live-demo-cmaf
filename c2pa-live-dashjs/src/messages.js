// UI strings for statuses and sequence anomalies.
// Codes follow C2PA spec §15/§18/§19.7 and the plugin's values.
// Human-readable messages for validation error codes come from the plugin's
// ERROR_CODE_MESSAGES export.

export const STATUS_LABELS = {
  valid: 'Valid',
  invalid: 'Invalid',
  replayed: 'Replay detected',
  reordered: 'Reordered',
  missing: 'Segments missing',
  warning: 'Warning',
  unverified: 'Unverified',
};

// Severity used to aggregate the overall status (higher = worse)
export const STATUS_SEVERITY = {
  valid: 1,
  unverified: 2,
  warning: 3,
  reordered: 4,
  replayed: 5,
  missing: 6,
  invalid: 7,
};

export const SEQUENCE_REASONS = {
  duplicate: 'Duplicate – segment was already played (possible replay attack)',
  out_of_order: 'Segment out of the expected order',
  gap_detected: 'Gap detected in the sequence (missing segments)',
  sequence_number_below_minimum: 'Sequence number below the session key minimum',
};

// The plugin only validates video and audio; text segments show up in the CAWG
// section because their manifest box is read as well.
export const MEDIA_TYPE_LABELS = {
  video: 'Video',
  audio: 'Audio',
  text: 'Text',
};
