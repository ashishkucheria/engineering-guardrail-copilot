export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(err: ApiError): Response {
  return json({ error: { code: err.code, message: err.message } }, err.status);
}

/** Read a JSON object body with a size cap. The cap is checked on the bytes, not on Content-Length. */
export async function readJson(req: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) throw new ApiError(415, "unsupported_media_type", "Send the body as application/json.");
  const buf = await req.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new ApiError(413, "payload_too_large", `Body is over the ${maxBytes}-byte limit.`);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new ApiError(400, "invalid_json", "Body is not valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ApiError(400, "invalid_body", "Body must be a JSON object.");
  return body as Record<string, unknown>;
}
