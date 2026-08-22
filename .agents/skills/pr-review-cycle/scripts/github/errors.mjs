export class GitHubWorkflowError extends Error {
  constructor(message, code = 'GITHUB_WORKFLOW_ERROR') {
    super(message);
    this.name = 'GitHubWorkflowError';
    this.code = code;
  }
}
