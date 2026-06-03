export const PIXEL_DIFF_KEY = 'pixelDiff';
export const INVALID_CAPTURE_SOURCE = 'invalidCapture';
export const INVALID_CAPTURE_CLAIM_ID = 'invalid-capture-detected';
export const RADIAL_GEOMETRY_SOURCE = 'radialGeometry';
export const SCALE_ONLY_MISMATCH_VERDICT = 'scaleOnlyMismatch';
export const ROI_QUALITY_SOURCE = 'roiQuality';
export const CRITICAL_ROI_FAILED_TYPE = 'critical_roi_failed';
export const CRITICAL_VISUAL_ASSERTION_FAILED_TYPE = 'critical_visual_assertion_failed';
export const EXCESSIVE_DYNAMIC_MASKING_TYPE = 'excessive_dynamic_masking';
export const INVALID_CAPTURE_TYPE = 'invalid_capture';
export const VLM_UNUSABLE_MESSAGE = 'VLM analysis is required but no configured Ollama model could be loaded.';
export const VLM_ASK_USER_UNAVAILABLE_MESSAGE = 'Start Ollama and ensure a vision model is available, or disable VLM analysis in your config, then rerun.';

// Runtime set used by model-judge providers to validate proposedChangeVector values
// before they enter Evidence (prevents arbitrary model strings reaching AgentActionContract).
// TODO(roi-quality): migrate inline ROI quality evaluation (RunOrchestrator) to a
// dedicated RoiQualityAnalyzer that populates 'roiQuality' evidence in EvidenceGraph,
// letting VerdictEngine consume it uniformly rather than reading RunOrchestrator state.
export const VALID_CHANGE_VECTORS: ReadonlySet<string> = new Set([
  'seed_data', 'fixture_plan',
  'ring_stroke_width', 'ring_radius_size', 'ring_gap',
  'ring_start_angle', 'ring_sweep_mapping', 'ring_center_alignment',
  'ring_glow_track',
  'component_layout', 'card_spacing_padding',
  'text_style', 'color_token',
  'thumbnail_gradient', 'badge_style', 'bottom_nav_padding',
  'expected_baseline', 'roi_threshold', 'device_profile',
  'dynamic_mask', 'none'
]);