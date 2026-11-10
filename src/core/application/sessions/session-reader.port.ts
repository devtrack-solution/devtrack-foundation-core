import type {
  SessionReference,
  SessionState,
} from '../../domain/sessions/session';
export interface SessionReader {
  /** Shared authoritative store. Errors are not equivalent to an active session. */
  find(sessionId: string): Promise<
    | (SessionReference & {
        readonly subjectId: string;
        readonly state: SessionState;
      })
    | null
  >;
}
