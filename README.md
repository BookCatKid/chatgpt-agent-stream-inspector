# ChatGPT Agent Stream Inspector

A power-user userscript that passively taps ChatGPT's browser protocol and reconstructs what the web client is receiving in real time.

It provides two complementary views:

- **Network Chat** — user/assistant messages, work summaries, tool calls/results, image generation, Python output, interruptions, hidden system/context messages, and other browser-received message types.
- **Events** — the underlying SSE and WebSocket traffic, with both a readable **Focused** mode and an **Everything** firehose.

The Network Chat view is built from network traffic. It does **not** scrape ChatGPT's rendered conversation DOM.

> Unofficial project. Not affiliated with or endorsed by OpenAI.

## Install

1. Install a userscript manager such as Tampermonkey or Violentmonkey.
2. Create a new userscript.
3. Copy in [`chatgpt-agent-stream-inspector.user.js`](./chatgpt-agent-stream-inspector.user.js).
4. Save it and fully refresh `https://chatgpt.com/`.
5. Click the **AGT** button in the bottom-right corner.

The script runs at `document-start` so it can install its `fetch` and `WebSocket` taps before a turn starts.

## What v0.4 understands

### Conversation streaming
- `/backend-api/f/conversation` SSE streams
- ChatGPT `v1` delta state
- `add`, `append`, `replace`, `remove`, `truncate`, and `patch`
- shorthand/inherited v1 operations such as `{v: ...}` after an earlier `{o: "patch"}`
- full-message WebSocket reconciliation
- both singular `update_content.message` and plural `update_content.messages[]`
- message markers and completion metadata
- user interruptions via `finish_details.type = "interrupted"` / `reason = "client_stopped"`

### Messages and working state

The chat pane has first-class renderers for:

- user and assistant text
- commentary/work-update messages
- `reasoning_recap`
- structured `thoughts` summaries
- `reasoning_title` status text
- system/rebase/context messages
- `model_editable_context`
- unknown message content, with a structured fallback instead of silently dropping it

**Show internal is off by default.** Enable it when you want protocol messages that ChatGPT marks as hidden from the ordinary conversation UI. Internal does not mean private model chain-of-thought that was never transmitted to the browser.

### Tools and connectors
Tool cards understand substantially more than the generic recipient name:

- `api_tool.call_tool` paths
- connector/app name + action extraction
- `api_tool.list_resources`
- structured arguments and results
- terminal output, exit code, runtime, and chunk IDs
- permission/confirmation payloads
- blocked and error states
- connector attachments
- tool result pairing and approximate latency
- opaque internal tool IDs, while still exposing the raw recipient in metadata

Raw payloads remain expandable, so a prettier renderer does not discard the underlying message.

### Web search

`web.run` gets dedicated parsing instead of generic empty tool cards. The inspector renders captured `search_model_queries`, grouped `search_result_groups`, per-result titles/URLs/snippets/attribution/reference IDs, and the web-result groups attached to `thoughts.metadata.inline_cot_expandable_content`. Final assistant messages also expose structured sources from `content_references`.

Search invocation cards, raw result batches, and user-facing “Searched N websites” summaries are kept distinct so the protocol lifecycle remains inspectable without turning every stage into the same giant result list.

### Conversation scoping

ChatGPT's `conversations` WebSocket is account-global and can deliver async updates for chats other than the one currently open. Every reconstructed message is therefore associated with its observed `conversation_id`; Network Chat and its activity indicator only use the active conversation. Foreign updates remain captured in Events/export data and are labeled as other-chat traffic instead of leaking into the visible chat timeline.

### Image generation

Image generation is reconstructed from both the main stream and async WebSocket updates. Dedicated image cards expose observed fields such as title, intermediate/final state, dimensions, MIME type, byte size, `asset_pointer`, generation ID, orientation, transparency, and parent generation ID.

Some image results include a huge `Model caption:` string. v0.4 preserves it but puts it in a collapsed section instead of letting it dominate the timeline.

If ChatGPT only supplies a `sediment://` asset pointer and no browser-loadable URL, the inspector does not invent a preview URL.

### Activity / stuck indicator

The header separately tracks **activity** (meaningful protocol work) and **net** (any captured network traffic), so keepalives do not look like useful progress while streamed text still resets the activity clock.
Example states:

```text
WORKING · activity now · net now · GitHub · get_profile
WAITING · activity 18s · net 2s · Chat On Steroids Core · exec_command
STALLED? · activity 37s · net 31s
IDLE · activity 2m 4s · net 9s
```


### Window layout

The inspector window is draggable from non-interactive parts of the header and resizable from its bottom-right corner. The layout responds to the **inspector width**, not just the browser width: split Chat/Events panes stack vertically when the inspector becomes narrow.

The live health/status region has a stable bounded width and ellipsizes long tool labels instead of reflowing the toolbar. Hover it to see the complete status string and pending-work details.

## Focused vs Everything

**Focused** de-emphasizes low-value event-log noise such as handshakes, keepalives, raw patch spam, duplicate input records, resume-token bookkeeping, and markers.

It does not delete those packets. Switch Events to **Everything**, expand raw records, or export the snapshot to inspect them.

The reconstructed chat is intentionally much less lossy: recognized content gets a dedicated renderer and unknown content falls back to structured/raw display.

## Architecture

```text
ChatGPT web app
      |
      +---- fetch/SSE ----> v1 state reducer ----> Events + Network Chat
      |
      +---- WebSocket ----> async/reconciliation -> Events + Network Chat
```

A message can be created empty, filled by later patches, have metadata appended after text starts, and finally be reconciled by a complete WebSocket snapshot.
## Privacy and safety

This is designed as a **local passive inspector**. It does not intentionally send captured traffic anywhere, modify ChatGPT requests, or replace ChatGPT responses. The fetch hook reads a cloned `Response`; the original response is returned to ChatGPT.

The display/export sanitizer redacts common credential shapes such as bearer values, cookies, access/refresh tokens, resume tokens, and verification/signature/auth-like URL parameters. That is defense in depth, not a guarantee: exported inspector JSON can still contain private conversation/account metadata, so treat it like a HAR file.

## What it cannot show

The inspector can only show information that reaches the browser. It can display browser-visible work summaries, reasoning recaps, `thoughts` summaries, status titles, tool activity, and hidden protocol messages. It cannot reveal private model reasoning that the server never transmitted.

## Development

There is no build step. The project is deliberately kept as a single auditable userscript.

```bash
node --check chatgpt-agent-stream-inspector.user.js
git diff --check

# Replay one or more local inspector exports (captures are not committed)
node tests/replay-captures.mjs /path/to/capture.json [/path/to/another.json ...]
```

Captured inspector exports are intentionally excluded from the repository because they may contain private conversations or session/account metadata.

When changing reconstruction logic, test against captures covering ordinary streaming, shorthand v1 patches, a tool-heavy agent turn, image generation with async WebSocket updates, and a user-stopped generation.

## Known limitations
- ChatGPT's private web protocol is undocumented and can change at any time.
- Some rich content-reference/widget types still use generic/raw display rather than recreating ChatGPT's exact UI.
- `truncate` support remains conservative because only limited observed variants have been captured.
- Binary WebSocket frames are shown by type/size rather than decoded.
- A `sediment://` image pointer is not automatically a browser-loadable image URL.
- UI-only errors that never appear in captured traffic cannot be reconstructed from this network inspector alone.

## Version history

### 0.4.2

- Scope reconstructed messages and async WebSocket updates by `conversation_id` to prevent cross-chat image/tool leakage.
- Foreign-conversation WebSocket traffic stays available in Events/export but no longer affects the active chat or health indicator.
- Dedicated `web.run` query/result rendering, including grouped search results and reference IDs.
- Web-result groups attached to browser-visible `thoughts` summaries are parsed.
- Final response `content_references` now produce an expandable structured Sources section.
- Citation pills preserve a compact reference count instead of collapsing every citation to the word `cite`.

### 0.4.1

- Show internal now defaults off.
- Draggable and natively resizable inspector window.
- Container-responsive header and split-pane stacking.
- Stable, ellipsized health/status area so long tool names cannot shove controls around.
- Viewport clamping keeps moved/resized windows reachable.

### 0.4.0

- Major contrast/readability pass.
- Structured work/thinking summaries and reasoning titles.
- Much richer tool and connector parsing.
- Async `messages[]` WebSocket ingestion.
- Dedicated image-generation cards and collapsed model captions.
- User interruption detection.
- Live activity/network age indicator.
- Internal messages can be exposed with Show internal.
- Unknown payloads keep structured/raw fallbacks rather than disappearing.

### 0.3.x

Initial reconstructed Network Chat, stateful v1 patch application, WebSocket full-message reconciliation, and Focused/Everything event views.

## License

MIT — see [`LICENSE`](./LICENSE).
