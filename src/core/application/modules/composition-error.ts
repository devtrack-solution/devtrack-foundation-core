export type CompositionErrorCode =
  | 'INVALID_DESCRIPTOR'
  | 'DUPLICATE_MODULE'
  | 'INCOMPATIBLE_API'
  | 'UNKNOWN_FEATURE'
  | 'INVALID_BINDING'
  | 'MISSING_PROVIDER'
  | 'INCOMPATIBLE_CAPABILITY'
  | 'AMBIGUOUS_PROVIDER'
  | 'DEPENDENCY_CYCLE';

export class CompositionError extends Error {
  constructor(
    readonly code: CompositionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CompositionError';
  }
}
