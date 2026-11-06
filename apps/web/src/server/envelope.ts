import type { ZodError } from "zod";

export type ValidationIssue = { path: string; message: string };

export type ApiError = {
  code: string;
  message: string;
  issues?: ValidationIssue[];
  details?: Record<string, unknown>;
};

export type ApiSuccess<T> = { success: true; data: T };
export type ApiFailure = { success: false; error: ApiError };
export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

export function success<T>(data: T): ApiSuccess<T> {
  return { success: true, data };
}

export function failure(
  code: string,
  message: string,
  options: { issues?: ValidationIssue[]; details?: Record<string, unknown> } = {},
): ApiFailure {
  const error: ApiError = { code, message };
  if (options.issues !== undefined) error.issues = options.issues;
  if (options.details !== undefined) error.details = options.details;
  return { success: false, error };
}

export function issueFromZod(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) => String(part)).join("."),
    message: issue.message,
  }));
}

export function validationFailure(error: ZodError): ApiFailure {
  return failure("VALIDATION_ERROR", "Request validation failed", { issues: issueFromZod(error) });
}

export function notFoundFailure(message = "Resource not found"): ApiFailure {
  return failure("NOT_FOUND", message);
}

export function forbiddenFailure(message = "Forbidden"): ApiFailure {
  return failure("FORBIDDEN", message);
}

export function unauthorizedFailure(message = "Authentication required"): ApiFailure {
  return failure("UNAUTHORIZED", message);
}

/** Parse a request body without letting malformed JSON throw out of the handler. */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
