import type { Browser } from "playwright";

// Chromium's Fetch domain intercepts redirects as well as first requests. The
// context stays offline, so an unhandled popup or request cannot bypass the
// wallet transport and reach the network. The runtime owns every credential.
export async function privateContext(
  browser: Browser,
  origin: string,
  request: (url: string) => Promise<Response>,
) {
  const context = await browser.newContext({
    serviceWorkers: "block",
    javaScriptEnabled: false,
    acceptDownloads: false,
    offline: true,
  });

  return {
    cookies: () => context.cookies(),
    close: () => context.close(),
    async newPage() {
      const page = await context.newPage();
      const session = await context.newCDPSession(page);
      session.on("Fetch.requestPaused", (event) => {
        const handle = async () => {
          const url = new URL(event.request.url);

          if (
            event.request.method !== "GET" ||
            url.origin !== origin ||
            url.username ||
            url.password
          ) {
            await session.send("Fetch.failRequest", {
              requestId: event.requestId,
              errorReason: "BlockedByClient",
            });

            return;
          }

          // No browser headers, cookies, storage or account state cross here.
          const response = await request(url.href);

          const headers = [...response.headers].flatMap(([name, value]) =>
            ["content-type", "location"].includes(name) ? [{ name, value }] : [],
          );

          headers.push({ name: "cache-control", value: "no-store" });
          await session.send("Fetch.fulfillRequest", {
            requestId: event.requestId,
            responseCode: response.status,
            responseHeaders: headers,
            body: Buffer.from(await response.arrayBuffer()).toString("base64"),
          });
        };

        void handle().catch(async () => {
          // Closing a page can also close its CDP session while a fetch finishes.
          if (!page.isClosed())
            await session
              .send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Failed" })
              .catch(() => {});
        });
      });
      await session.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
      });

      return page;
    },
  };
}
