export interface ConfigIssue {
  readonly field: string;
  readonly constraint: string;
}

export class ConfigValidationError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(`Configuration validation failed for: ${issues.map((issue) => issue.field).join(', ')}`);
    this.name = 'ConfigValidationError';
    this.issues = Object.freeze([...issues]);
  }
}
