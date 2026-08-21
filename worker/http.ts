export const ALLOW_READ_METHODS = 'GET, HEAD, OPTIONS';
export const WORKER_VERSION_HEADER = 'X-FRANK-Worker-Version';

const textEncoder = new TextEncoder();
const UNCONFIGURED_WARM_TOKEN = 'frank-warm-token-is-not-configured';

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', textEncoder.encode(value));
}

export async function hasValidWarmAuthorization(
  request: Request,
  configuredToken: string | undefined,
): Promise<boolean> {
  const tokenConfigured = typeof configuredToken === 'string' && configuredToken.length > 0;
  const expectedToken = tokenConfigured ? configuredToken : UNCONFIGURED_WARM_TOKEN;
  const [providedHash, expectedHash] = await Promise.all([
    sha256(request.headers.get('Authorization') ?? ''),
    sha256(`Bearer ${expectedToken}`),
  ]);

  // Hashing first gives timingSafeEqual two fixed-size inputs. A missing
  // binding still performs the same comparison and always fails closed.
  return tokenConfigured && crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

export type WorkerRoute =
  | { kind: 'root' }
  | { kind: 'health' }
  | { kind: 'status' }
  | { kind: 'forecast'; locationId: string };

export function matchRoute(pathname: string): WorkerRoute | null {
  const normalizedPath = pathname.replace(/\/+$/, '') || '/';
  if (normalizedPath === '/') return { kind: 'root' };
  if (normalizedPath === '/health') return { kind: 'health' };
  if (normalizedPath === '/status') return { kind: 'status' };
  const forecastMatch = normalizedPath.match(/^\/forecast\/([a-z0-9-]+)$/);
  return forecastMatch
    ? { kind: 'forecast', locationId: forecastMatch[1] }
    : null;
}

export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': ALLOW_READ_METHODS,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Expose-Headers': `Retry-After, X-FRANK-Background-Check, ${WORKER_VERSION_HEADER}`,
    'Access-Control-Max-Age': '86400',
  };
}

export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

export function headResponse(response: Response): Response {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function withWorkerVersion(response: Response, versionId: string): Response {
  // Every route, status, and error response identifies the immutable Worker
  // version that produced it. The post-deploy gate compares this value with
  // Cloudflare's active control-plane version, so an older edge response can
  // never make a new release look healthy.
  response.headers.set(WORKER_VERSION_HEADER, versionId);
  return response;
}

export function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(),
      Allow: ALLOW_READ_METHODS,
    },
  });
}

export function methodNotAllowedResponse(): Response {
  return jsonResponse(
    { error: 'Method not allowed' },
    405,
    { Allow: ALLOW_READ_METHODS },
  );
}

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
