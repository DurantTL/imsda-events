import { AsyncLocalStorage } from "node:async_hooks";
import { requestCorrelationId, setLogRequestFieldSource } from "@/lib/logger";

/**
 * One correlation ID per request, reachable from anywhere inside it.
 *
 * Structured logging landed with an ID minted per log call, which meant two
 * lines from the same request could not be tied together. Threading a parameter
 * through every handler, service, and repository was the alternative to this;
 * an async-context store is the same result without changing thirty signatures.
 *
 * `AuditLog.correlationId` already exists for domain events. This is the same
 * idea for the request itself, and the two use the same header, so one
 * registration can be followed from the proxy log to the audit entry.
 */

export type RequestContext = {
  correlationId: string;
  method?: string;
  path?: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

// Every log line written inside a request carries the request's identity,
// without each of the ~30 route-level error helpers having to pass it.
setLogRequestFieldSource(() => {
  const context = storage.getStore();
  if (!context) return undefined;
  return {
    correlationId: context.correlationId,
    ...(context.method ? { method: context.method } : {}),
    ...(context.path ? { path: context.path } : {}),
  };
});

export function runWithRequestContext<T>(context: RequestContext, run: () => T): T {
  return storage.run(context, run);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export const CORRELATION_HEADER = "x-correlation-id";

/**
 * Wraps a route handler so everything it calls shares one correlation ID, and
 * so the response carries that ID back. Echoing it is what lets someone
 * reporting a failed registration quote a value that appears in the logs.
 */
export function withRequestContext<Arguments extends unknown[]>(
  handler: (request: Request, ...rest: Arguments) => Promise<Response>,
) {
  return async function handleWithContext(
    request: Request,
    ...rest: Arguments
  ): Promise<Response> {
    const url = safePath(request.url);
    const context: RequestContext = {
      // Reuses a proxy-supplied ID when there is one, so a single request keeps
      // one identity across hops. The inbound value is bounded and constrained
      // by requestCorrelationId, because it is attacker-controlled.
      correlationId: requestCorrelationId(request),
      method: request.method,
      path: url,
    };

    const response = await runWithRequestContext(context, () => handler(request, ...rest));
    // Response headers are immutable once set on some responses, so failing to
    // attach the header must never turn a successful response into an error.
    try {
      response.headers.set(CORRELATION_HEADER, context.correlationId);
      return response;
    } catch {
      return response;
    }
  };
}

function safePath(url: string) {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}
