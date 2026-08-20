export const ALLOW_READ_METHODS = 'GET, HEAD, OPTIONS';

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
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'Retry-After, X-FRANK-Background-Check',
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
