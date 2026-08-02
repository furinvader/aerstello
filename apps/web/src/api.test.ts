import { describe, expect, it } from 'vitest';
import { ApiError, apiErrorMessage } from './api';

describe('localized API errors', () => {
  it('renders stable server error codes in every supported language', () => {
    const error = new ApiError('UNDO_PENDING', 'Server detail', 409);
    expect(apiErrorMessage(error, 'de', 'Fallback')).toContain('Rückgängig');
    expect(apiErrorMessage(error, 'it', 'Fallback')).toContain('annullamento');
    expect(apiErrorMessage(error, 'en', 'Fallback')).toContain('undo');
  });

  it('does not expose unrecognized server messages', () => {
    expect(apiErrorMessage(new ApiError('UNKNOWN', 'Internal detail', 400), 'de', 'Sicherer Fehler')).toBe('Sicherer Fehler');
  });
});
