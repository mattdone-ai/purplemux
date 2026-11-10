# Browser evidence: screenshots, console and network

An agent that must prove a page works needs a screenshot, the console and the network log. This page states what
purplemux gives for that, and where it does not.

## What the harness offers

A `web-browser` tab is an Electron webview. Five CLI commands read it:

| Command | Route | Answer |
| --- | --- | --- |
| `purplemux tab browser url -w WS TAB_ID` | `GET /api/cli/tabs/{tabId}/browser/url` | `{ tabId, url, title }` |
| `purplemux tab browser screenshot -w WS TAB_ID [-o FILE] [--full]` | `GET …/browser/screenshot` | a PNG in `FILE`, else `{ base64 }` |
| `purplemux tab browser console -w WS TAB_ID [--since MS] [--level LEVEL]` | `GET …/browser/console` | the last 500 console entries and exceptions |
| `purplemux tab browser network -w WS TAB_ID [--since MS] [--method M] [--url SUBSTR] [--status CODE] [--request ID]` | `GET …/browser/network` | the last 500 requests, or one response body with `--request` |
| `purplemux tab browser eval -w WS TAB_ID EXPR` | `POST …/browser/eval` | `{ tabId, value }` (CDP `Runtime.evaluate`, 10 s timeout) |

The api-guide (`purplemux api-guide`, section "Web-browser tabs") holds the full request and response shapes.

## The routes need the Electron app

Every route reads the browser bridge. Only the Electron main process makes it: `electron/browser-bridge.ts:322` sets
`globalThis.__ptBrowserBridge`. A server that runs without Electron has no bridge. Examples are `pnpm start`,
`purplemux start` and the live service on host-a.

For a `web-browser` tab, every route answers 503 `Browser bridge unavailable (Electron-only feature)` on a headless
server. A retry does not help: no bridge appears until the Electron app runs the server.

`withBrowserTab` (`src/lib/cli-utils.ts`) checks a request in this order, and the first failed check answers:

1. The caller may not read the workspace: 403 `forbidden` (CLI exit 3).
2. The tab does not exist: 404 `tab-not-found` (CLI exit 4).
3. The tab is not a `web-browser` tab: 400 `Tab is not a web-browser panel` (CLI exit 1).
4. No browser bridge: 503 (CLI exit 1).

When the Electron app runs, a webview that has not attached yet (no `dom-ready` event) answers 409
`Browser tab not attached yet` (CLI exit 1). Wait, then retry. The 400, 409 and 503 bodies carry no `code`, so the CLI
exits 1 for each (ADR-0016).

## Collect evidence when the Electron app runs

1. Make the tab: `purplemux tab create -w WS -t web-browser -n evidence`. The command prints the new tab as JSON, with its id.
2. Open the page. Type the URL in the tab's address bar, or run
   `purplemux tab browser eval -w WS TAB_ID "location.assign('http://localhost:3000/path')"`. Navigation through
   `eval` is not yet run on the Electron app: if `url` in step 3 does not name the new page, use the address bar.
3. Make sure that the page loaded: `purplemux tab browser url -w WS TAB_ID` names the URL and the title.
4. Take the screenshot: `purplemux tab browser screenshot -w WS TAB_ID -o shot.png --full`.
5. Read the console: `purplemux tab browser console -w WS TAB_ID --level error`. Use `--since MS` to read only the
   entries after a step.
6. Read the network: `purplemux tab browser network -w WS TAB_ID --status 500`. Get one response body with
   `--request REQUEST_ID`.

Each command prints JSON. Keep the JSON and the PNG as the evidence.

## On a headless host

Do not install or start a host-wide Chrome for evidence. Use the crawl container of the repository under test, on the
port that repository assigns.

A host-wide Chrome listens on `localhost:9222` by default, and the crawl containers use the same port. The two collide,
and one crawl reads the other's browser. On 2026-10-26 a repository had to move its `.mcp.json` browser port to 9333
because of this collision.
