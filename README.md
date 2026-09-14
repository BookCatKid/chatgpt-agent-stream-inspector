# ChatGPT Agent Stream Inspector

A power-user userscript that passively inspects ChatGPT's live browser protocol and reconstructs what the client is receiving into two views:

- **Network Chat** — user messages, assistant messages, reasoning recaps, tool calls/results, Python output, image results, and hidden/internal protocol messages.
- **Events** — the underlying SSE/WebSocket traffic, with a focused mode that hides transport noise by default.

The inspector does **not** scrape ChatGPT's rendered DOM to build the chat view. It reconstructs the conversation from the same network stream the web client receives.

> Unofficial project. Not affiliated with or endorsed by OpenAI.

## Features

- Passive `fetch()` interception using `Response.clone()`; ChatGPT receives the untouched original response.
- SSE parsing for `/backend-api/f/conversation` and observed secondary streams.
- ChatGPT `v1` delta reconstruction, including `add`, `append`, `replace`, `remove`, `truncate`, patch batches, and inherited/shorthand patch frames.
- WebSocket inspection and reconciliation from full conversation-update snapshots.
- Tool-call and tool-result cards for built-in tools, MCP/connectors, and plugins.
- Reasoning recap/status cards when the server actually sends them to the browser.
- Python/data-analysis and generated-image result handling.
- **Show internal is enabled by default**, exposing hidden system/context/tool-plumbing messages that the normal UI suppresses.
- Focused vs. Everything event modes.
- Split / Chat-only / Events-only layouts.
- Expandable sanitized raw payloads.
- JSON export for protocol research.
- Redaction of obvious bearer tokens, cookies, resume tokens, signed/verification query parameters, and similar credentials from displayed/exported payloads.

## Install

1. Install a userscript manager such as Tampermonkey or Violentmonkey.
2. Create a new userscript.
3. Replace its contents with [`chatgpt-agent-stream-inspector.user.js`](./chatgpt-agent-stream-inspector.user.js).
4. Save it and fully refresh `https://chatgpt.com/`.
5. Click the **AGT** button in the bottom-right corner.

The script runs at `document-start` so it can hook `fetch` and `WebSocket` before ChatGPT begins a turn.

## Views

### Network Chat

This is a reconstructed developer-oriented version of the conversation. It can show things the normal ChatGPT UI intentionally hides, including internal system/context messages and tool plumbing.

**Show internal is on by default.** Turn it off if you want the reconstructed pane to look closer to the normal user-visible conversation.

“Internal” does **not** mean private model chain-of-thought. The inspector can only display information that was actually transmitted to the browser.

### Events

**Focused** hides low-value transport clutter such as handshakes, resume tokens, markers, duplicate input records, and raw token patch spam while keeping messages, thinking summaries, tools, Python/image results, and errors.

**Everything** exposes the full captured firehose.

## How it works

```text
ChatGPT web app
      |
      | fetch('/backend-api/f/conversation')
      v
userscript fetch hook
      |
      +---- original Response ----------------> ChatGPT
      |
      +---- response.clone()
                |
                v
          SSE v1 decoder
                |
                +---- event log
                |
                +---- reconstructed message state
                            |
                            v
                       Network Chat

WebSocket traffic ----------------------------> inspector
                |
                +---- full-message reconciliation
```

A key detail is that ChatGPT's stream is not just token text. Later packets can patch previously created message objects and metadata, and some `v1` packets inherit the previous operation instead of repeating it. The inspector maintains message state rather than treating each frame independently.

## Privacy and safety

This script is designed as a **local passive inspector**. It does not intentionally send captured traffic anywhere.

Still, network payloads can contain sensitive conversation data and account/session metadata. Treat exported inspector JSON like a HAR file: review it before sharing publicly.

The built-in sanitizer redacts obvious credential fields, but no generic redactor can guarantee that every future secret shape will be recognized.

## Known limitations

- ChatGPT's private web protocol is undocumented and can change without notice.
- Some rich UI types are displayed generically rather than perfectly recreating ChatGPT's own renderer.
- `truncate` support is conservative because only limited observed shapes have been captured so far.
- Binary WebSocket frames are reported by type/size rather than decoded.
- The inspector cannot reveal information that never reaches the browser.

## Development

There is no build step. The project is intentionally a single userscript so it is easy to audit and install.

Syntax check:

```bash
node --check chatgpt-agent-stream-inspector.user.js
```

When changing protocol reconstruction, the safest workflow is to replay sanitized exported captures and verify that the reconstructed final message matches the authoritative completed message received by ChatGPT.

## License

MIT — see [`LICENSE`](./LICENSE).
