/**
 * Background-check request errors a route turns into a clear status instead
 * of a 500 (#527). Messages are operator-facing text written here, never
 * record data.
 */
export type BackgroundCheckOperationErrorCode =
  | "PREVIEW_CHANGED"
  | "REVIEW_NOT_FOUND"
  | "NOT_A_CANDIDATE"
  | "MATCH_NOT_FOUND"
  | "NOT_A_MANUAL_MATCH"
  | "UPLOAD_IN_PROGRESS"
  | "LIST_CHANGED";

const statusByCode: Record<BackgroundCheckOperationErrorCode, number> = {
  PREVIEW_CHANGED: 409,
  REVIEW_NOT_FOUND: 404,
  NOT_A_CANDIDATE: 400,
  MATCH_NOT_FOUND: 404,
  NOT_A_MANUAL_MATCH: 400,
  UPLOAD_IN_PROGRESS: 409,
  LIST_CHANGED: 409,
};

export class BackgroundCheckOperationError extends Error {
  readonly status: number;

  constructor(readonly code: BackgroundCheckOperationErrorCode, message: string) {
    super(message);
    this.name = "BackgroundCheckOperationError";
    this.status = statusByCode[code];
  }
}
