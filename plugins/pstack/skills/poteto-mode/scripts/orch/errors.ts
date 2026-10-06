export interface NotFoundOutput {
  readonly compact: string;
  readonly json: unknown;
}

export class UserError extends Error {}
export class UsageError extends UserError {}
export class NotFoundError extends UserError {
  public constructor(
    message: string,
    public readonly output?: NotFoundOutput
  ) {
    super(message);
  }
}
