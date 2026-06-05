export const EVIDENCE_JSON_SCHEMA = {
  name: 'evidence_response',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            claimId: { type: 'string' },
            subject: { type: 'string' },
            polarity: { type: 'string', enum: ['match', 'mismatch', 'uncertainty', 'error'] },
            claim: { type: 'string' },
            confidence: { type: 'number' },
            severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] },
            blocking: { type: 'boolean' },
            source: { type: 'string' },
            proposedChangeVector: { type: 'string' },
            expectedValue: {},
            actualValue: {}
          },
          required: ['claimId', 'subject', 'polarity', 'claim', 'confidence', 'severity', 'blocking'],
          additionalProperties: false
        }
      }
    },
    required: ['evidence'],
    additionalProperties: false
  }
};
