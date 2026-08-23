export class StateError extends Error {
  constructor(message, code = 'STATE_ERROR') {
    super(message);
    this.name = 'StateError';
    this.code = code;
  }
}
