import { describe, expect, it } from 'vitest';
import { isUnknownModelResponse } from './model-errors';

/**
 * Story 4.7, AC7. Every body below is the shape a real provider returns; the
 * point of the file is that classification reads the machine fields in them and
 * never the prose, so a provider rewording its message changes nothing here.
 */

const GROQ_404 = JSON.stringify({
  error: {
    message: 'The model `llama-3.1-8b` does not exist or you do not have access to it.',
    type: 'invalid_request_error',
    code: 'model_not_found',
  },
});

const OPENAI_400 = JSON.stringify({
  error: {
    message: 'Invalid value for model.',
    type: 'invalid_request_error',
    param: 'model',
    code: null,
  },
});

const GOOGLE_404 = JSON.stringify({
  error: { code: 404, message: 'models/nope is not found for API version v1beta', status: 'NOT_FOUND' },
});

const BAD_KEY_401 = JSON.stringify({
  error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' },
});

const RATE_LIMIT_429 = JSON.stringify({
  error: { message: 'Rate limit reached for model', type: 'tokens', code: 'rate_limit_exceeded' },
});

describe('telling an unknown model from every other failure (AC7)', () => {
  it('recognises a 404 from a completions endpoint', () => {
    // For every provider here the model is the only variable part of the
    // address being requested, so a 404 is about the model by construction.
    expect(isUnknownModelResponse(404, GROQ_404)).toBe(true);
    expect(isUnknownModelResponse(404, GOOGLE_404)).toBe(true);
    expect(isUnknownModelResponse(404, '')).toBe(true);
  });

  it('recognises the machine-readable codes without reading the message', () => {
    expect(isUnknownModelResponse(400, GROQ_404)).toBe(true);
    expect(isUnknownModelResponse(400, OPENAI_400)).toBe(true);
    expect(isUnknownModelResponse(400, JSON.stringify({ code: 'model_terminated' }))).toBe(true);
    expect(isUnknownModelResponse(400, JSON.stringify({ error: { status: 'NOT_FOUND' } }))).toBe(true);
  });

  it('is not fooled by a bad key or a rate limit, which have their own answers', () => {
    // The whole value of AC7 is that these three stay distinguishable: telling
    // a visitor "unknown model" when their key expired sends them to the wrong
    // place, and 4.6 already answers both of these correctly.
    expect(isUnknownModelResponse(401, BAD_KEY_401)).toBe(false);
    expect(isUnknownModelResponse(403, BAD_KEY_401)).toBe(false);
    expect(isUnknownModelResponse(429, RATE_LIMIT_429)).toBe(false);
    expect(isUnknownModelResponse(500, '{"error":{"message":"internal"}}')).toBe(false);
  });

  it('reads no prose at all, which is the discipline being pinned', () => {
    // A message that says every word a naive regex would look for, with no
    // machine tag and a status that is not 404. Anything that classified this
    // as an unknown model would be reading the sentence.
    const prose = JSON.stringify({
      error: { message: 'model not found: this model does not exist or was retired', code: 'server_error' },
    });
    expect(isUnknownModelResponse(500, prose)).toBe(false);

    // And the mirror: a machine tag with a message that mentions nothing.
    expect(isUnknownModelResponse(400, '{"error":{"code":"model_not_found","message":"nope"}}')).toBe(
      true,
    );
  });

  it('survives a body that is not JSON at all', () => {
    // A gateway between the visitor and the provider may answer in HTML.
    expect(isUnknownModelResponse(502, '<html>Bad Gateway</html>')).toBe(false);
    expect(isUnknownModelResponse(400, '')).toBe(false);
    expect(isUnknownModelResponse(400, 'null')).toBe(false);
    expect(isUnknownModelResponse(400, '"a string"')).toBe(false);
    expect(isUnknownModelResponse(400, '[]')).toBe(false);
  });
});
