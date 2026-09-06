# dsh-open-external

Opens external web links from the DeepSeek Harness UI in the **system browser**.

The Harness UI runs inside a loopback iframe in the desktop shell. Rendered
content marks external links with `target="_blank"`, which a WKWebView cannot
honour on its own — so clicking such a link does nothing. This plugin, running
inside that iframe (whose origin already holds the `opener` capability),
intercepts left-clicks on external `http(s)` anchors and opens the URL through
`tauri-plugin-opener`. Same-origin links keep their in-app behaviour;
⌘/Ctrl/middle clicks are left untouched.

Client-only: `src/client.tsx` installs the interceptor; `src/index.mjs` is an
empty Host half kept only for the standard bundle shape.

## License

MIT
