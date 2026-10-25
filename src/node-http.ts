import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

const BODYLESS = new Set(["GET", "HEAD"]);

export function toWebRequest(req: IncomingMessage, publicOrigin: URL): Request {
  const method = (req.method ?? "GET").toUpperCase();
  const forwardedProto = headerValue(req.headers["x-forwarded-proto"]);
  const proto = forwardedProto?.split(",")[0]?.trim() || publicOrigin.protocol.replace(":", "");
  const host = headerValue(req.headers.host) || publicOrigin.host;
  const url = `${proto}://${host}${req.url ?? "/"}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || key === "transfer-encoding") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }

  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
  };
  if (!BODYLESS.has(method)) {
    init.body = Readable.toWeb(req) as ReadableStream;
    init.duplex = "half";
  }
  return new Request(url, init);
}

export async function sendWebResponse(
  res: ServerResponse,
  response: Response
): Promise<void> {
  res.statusCode = response.status;
  const headers = new Headers(response.headers);
  headers.delete("transfer-encoding");
  headers.delete("connection");
  for (const [key, value] of headers.entries()) {
    res.setHeader(key, value);
  }
  if (!response.body) {
    res.end();
    return;
  }
  await pipeline(
    Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
    res
  );
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}
