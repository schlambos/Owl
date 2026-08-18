import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";

/**
 * Release web static handler.
 *
 * Serves the built web application (`<install>/web`) from the control-plane
 * server so a prebuilt binary can expose the UI on its own port without a
 * separate Vite dev server. The handler is a pure function of the request
 * and the install/authorized-root configuration; it returns `undefined`
 * whenever it is not responsible for the request (non-GET/HEAD, `/api` and
 * `/api/*`, or no usable web directory), letting the caller fall through to
 * the generic JSON 404.
 */

const MIME_TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",
  wasm: "application/wasm",
  json: "application/json; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  map: "application/json; charset=utf-8",
};

/** One year in seconds, for immutable `/assets/*` caching. */
const ONE_YEAR_SECONDS = 31_536_000;

export interface ReleaseWebConfig {
  /** Discovered omo-control-plane install root (realpath). */
  owlInstallDirectory: string;
  /** Authorized read roots (install + project + OpenCode config). */
  authorizedRoots: string[];
}

/** Strict lexical containment: `target` is `root` or a descendant of it. */
function isWithin(root: string, target: string): boolean {
  const r = root.endsWith(sep) ? root.slice(0, -1) : root;
  return target === r || target.startsWith(r + sep);
}

/** Plain static 404 (no JSON body, no path echo). */
function notFound(): Response {
  return new Response(null, { status: 404 });
}

/**
 * Resolve the web root: `<install>/web` must realpath to a directory under
 * the authorized install root. Returns `undefined` when absent or invalid so
 * the caller preserves the dev JSON 404.
 */
function resolveWebRoot(cfg: ReleaseWebConfig): string | undefined {
  try {
    const webPath = join(cfg.owlInstallDirectory, "web");
    const webRoot = realpathSync(webPath);
    if (!statSync(webRoot).isDirectory()) return undefined;
    if (!isWithin(cfg.owlInstallDirectory, webRoot)) return undefined;
    return webRoot;
  } catch {
    return undefined;
  }
}

/**
 * Split the raw pathname and decode each segment, rejecting anything unsafe.
 * Returns the decoded segments, or `undefined` when the path must be
 * rejected (malformed encoding, NUL, backslash, decoded slash, empty, `.`,
 * or `..`). Dots inside filenames are allowed.
 */
function decodeSegments(pathname: string): string[] | undefined {
  let p = pathname;
  if (p !== "/" && p.endsWith("/")) p = p.slice(0, -1);
  const rawSegments = p === "/" ? [] : p.split("/").slice(1);

  const segments: string[] = [];
  for (const raw of rawSegments) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return undefined; // malformed percent-encoding
    }
    if (seg === "" || seg === "." || seg === "..") return undefined;
    if (seg.includes("\0")) return undefined; // NUL
    if (seg.includes("\\")) return undefined; // backslash
    if (seg.includes("/")) return undefined; // decoded slash
    segments.push(seg);
  }
  return segments;
}

function serveIndex(webRoot: string, method: string): Response {
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache",
  };
  if (method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  let body: Uint8Array;
  try {
    body = readFileSync(join(webRoot, "index.html"));
  } catch {
    return notFound();
  }
  return new Response(body, { status: 200, headers });
}

export function handleReleaseWeb(
  req: Request,
  cfg: ReleaseWebConfig,
): Response | undefined {
  // GET/HEAD only; everything else bypasses.
  if (req.method !== "GET" && req.method !== "HEAD") return undefined;

  const url = new URL(req.url);
  const pathname = url.pathname;

  // `/api` and `/api/*` always bypass to the JSON API routes.
  if (pathname === "/api" || pathname.startsWith("/api/")) return undefined;

  // Absent/invalid web directory → undefined (dev JSON 404 preserved).
  const webRoot = resolveWebRoot(cfg);
  if (webRoot === undefined) return undefined;

  // Decode and validate every path segment.
  const segments = decodeSegments(pathname);
  if (segments === undefined) return notFound();

  // Root and extensionless paths are SPA routes → serve index.html.
  const last = segments[segments.length - 1];
  const hasExtension = last !== undefined && extname(last) !== "";
  if (!hasExtension) {
    return serveIndex(webRoot, req.method);
  }

  // Asset path: only known MIME extensions are served.
  const ext = extname(last!).slice(1).toLowerCase();
  const mime = MIME_TYPES[ext];
  if (mime === undefined) return notFound();

  // Resolve the real file, enforce strict web-root containment, and require
  // an existing regular file (reject symlink escape and directories).
  const fullPath = join(webRoot, ...segments);
  let real: string;
  try {
    real = realpathSync(fullPath);
  } catch {
    return notFound(); // missing
  }
  if (!isWithin(webRoot, real)) return notFound(); // symlink escape
  let stats;
  try {
    stats = statSync(real);
  } catch {
    return notFound();
  }
  if (!stats.isFile()) return notFound(); // directory or special file

  const isAsset = segments[0] === "assets";
  const headers: Record<string, string> = {
    "content-type": mime,
    "cache-control": isAsset
      ? `public, max-age=${ONE_YEAR_SECONDS}, immutable`
      : "no-cache",
  };

  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  return new Response(readFileSync(real), { status: 200, headers });
}
