import { escape } from "../../../shared/protocol";

export type PublicResource = { body: string; contentType: string };

export function privatePage(path: string, origin: string): PublicResource | undefined {
  if (path === "/private/catalog")
    return {
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><head><meta charset="utf-8"><title>Northstar private catalog</title><link rel="stylesheet" href="/private/catalog.css"></head><body><main><h1>Northstar jackets</h1><p>Public catalog with MOLE access limits.</p><img src="/private/jacket.svg" alt="Stormline insulated jacket" width="240" height="240"><h2>Stormline Insulated Jacket</h2><p>$250 · Warm, weather-resistant insulation.</p><a href="${escape(origin)}/private/redirect">Continue browsing</a></main></body></html>`,
    };

  if (path === "/private/catalog.css")
    return {
      contentType: "text/css; charset=utf-8",
      body: "body{font:18px system-ui;background:#f5f4ef;color:#28372d;margin:3rem}main{max-width:42rem;margin:auto}img{display:block}a{color:#355e45}",
    };

  if (path === "/private/jacket.svg")
    return {
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><path d="m85 35 35 18 35-18 42 35 30 95-35 15-25-65 5 105H68l5-105-25 65-35-15 30-95Z" fill="#92734d"/><path d="M120 53v167M75 100h90M72 140h96M70 180h100" stroke="#52452e" stroke-width="3"/></svg>',
    };

  return undefined;
}
