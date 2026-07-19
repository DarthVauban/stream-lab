import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INTERNAL_API_URL = process.env.MEDIA_INTERNAL_API_URL || "http://127.0.0.1:8788";

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  const incomingUrl = new URL(request.url);
  const target = new URL(`/api/${path.map(encodeURIComponent).join("/")}`, INTERNAL_API_URL);
  target.search = incomingUrl.search;

  const headers = new Headers();
  for (const name of ["accept", "content-type", "cookie", "x-csrf-token"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const hasBody = !["GET", "HEAD"].includes(request.method);
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: "manual",
    cache: "no-store",
  };
  if (hasBody) init.duplex = "half";

  try {
    const upstream = await fetch(target, init);
    const responseHeaders = new Headers();
    for (const name of ["content-type", "cache-control", "set-cookie", "retry-after", "location"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set("X-Content-Type-Options", "nosniff");
    responseHeaders.set("X-Frame-Options", "DENY");
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch {
    return Response.json(
      { error: { code: "MEDIA_SERVER_UNAVAILABLE", message: "Медіасервер недоступний." } },
      { status: 503 },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
