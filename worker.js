import { onRequest as handleApiRequest } from "./functions/api/[[path]].js";

const EMBEDDED_ASSETS = globalThis.__STATIC_ASSETS__ || {};
const REMOTE_ASSET_URLS = {
  "/index.html": "https://gist.githubusercontent.com/ge503369290-commits/646125b1043b88fffa2b673d41972413/raw/9d8185c0656746a5be628a9041800a117c54e645/index.html",
  "/app.js": "https://gist.githubusercontent.com/ge503369290-commits/646125b1043b88fffa2b673d41972413/raw/bb115e8922a23ab8f430862c8237d7f4f027c959/app.js?v=inline-richtext-20260613",
  "/styles.css": "https://gist.githubusercontent.com/ge503369290-commits/646125b1043b88fffa2b673d41972413/raw/1c042f0397bddfe3b22a8847d902dae1ecd6dafa/styles.css?v=inline-richtext-20260613"
};

const STATIC_CACHE_HEADERS = {
  "Cache-Control": "public, max-age=3600"
};

const HTML_HEADERS = {
  "Cache-Control": "no-cache"
};

function contentTypeForPath(path) {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

function withHeaders(response, headers) {
  const nextHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) {
    nextHeaders.set(key, value);
  }
  nextHeaders.set("X-Content-Type-Options", "nosniff");
  nextHeaders.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: nextHeaders
  });
}

async function serveAsset(request, env) {
  const url = new URL(request.url);
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  const asset = EMBEDDED_ASSETS[path] || (!path.includes(".") ? EMBEDDED_ASSETS["/index.html"] : null);
  if (asset) {
    return new Response(asset.body, {
      headers: {
        "Content-Type": asset.contentType,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        ...(path.endsWith(".html") || path === "/" ? HTML_HEADERS : STATIC_CACHE_HEADERS)
      }
    });
  }

  const remoteUrl = REMOTE_ASSET_URLS[path] || (!path.includes(".") ? REMOTE_ASSET_URLS["/index.html"] : null);
  if (remoteUrl) {
    const remoteResponse = await fetch(remoteUrl, {
      cf: { cacheTtl: path.endsWith(".html") ? 60 : 3600, cacheEverything: true }
    });
    if (remoteResponse.ok && (!remoteResponse.headers.get("content-type")?.includes("text/html") || path.endsWith(".html"))) {
      return withHeaders(remoteResponse, {
        "Content-Type": contentTypeForPath(path),
        ...(path.endsWith(".html") || path === "/" ? HTML_HEADERS : STATIC_CACHE_HEADERS)
      });
    }
  }

  if (!env.ASSETS) {
    return new Response("Not found", { status: 404 });
  }

  const response = await env.ASSETS.fetch(request);
  if (response.status !== 404) {
    return withHeaders(response, url.pathname.endsWith(".html") || url.pathname === "/" ? HTML_HEADERS : STATIC_CACHE_HEADERS);
  }

  if (!url.pathname.includes(".")) {
    const indexUrl = new URL("/index.html", request.url);
    const indexResponse = await env.ASSETS.fetch(new Request(indexUrl, request));
    return withHeaders(indexResponse, HTML_HEADERS);
  }

  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleApiRequest({
        request,
        env,
        waitUntil: ctx.waitUntil.bind(ctx),
        next: () => serveAsset(request, env)
      });
    }

    return serveAsset(request, env);
  }
};
