// ==UserScript==
// @name         ChatGPT Agent Stream Inspector
// @namespace    https://chatgpt.com/
// @version      0.3.3
// @description  Passive ChatGPT network inspector with a reconstructed chat/tool timeline.
// @match        https://chatgpt.com/*
// @run-at       document-start
// @inject-into  page
// @sandbox      raw
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG = {
    maxEvents: 2500,
    maxRenderedEvents: 700,
    maxString: 200000,
    // These are the response streams we know are useful from the HAR.
    exactSSEPaths: new Set([
      '/backend-api/f/conversation',
      '/backend-api/search/product_update',
      '/backend-api/sidebar/product/conversation/cache',
    ]),
  };

  const S = {
    seq: 0,
    paused: false,
    mode: 'focused',       // focused | all
    showInternal: true,    // hidden system/context messages in reconstructed chat
    view: 'split',         // split | chat | events
    filter: '',
    events: [],
    expandedEvents: new Set(),

    // Reconstructed protocol state
    messages: new Map(),   // id -> {message, firstSeen, lastSeen, order}
    messageOrder: [],
    messageOrderCounter: 0,
    currentRoot: null,     // current v1 root (usually {message,...})
    lastDeltaTemplate: null,
    markers: new Map(),    // message id -> marker records
    streamMeta: {},

    // UI refs
    root: null,
    panel: null,
    eventList: null,
    chatList: null,
    counts: null,
    renderScheduled: false,
  };

  // ============================================================
  // Event capture + reconstructed protocol state
  // ============================================================

  function emit(kind, summary, raw, css = '', meta = {}) {
    if (S.paused) return;

    const ev = {
      id: ++S.seq,
      at: new Date().toISOString(),
      kind,
      summary: sanitize(String(summary ?? '')),
      css,
      raw: sanitize(raw),
      meta: sanitize(meta),
    };

    S.events.push(ev);
    if (S.events.length > CONFIG.maxEvents) {
      S.events.splice(0, S.events.length - CONFIG.maxEvents);
    }

    scheduleRender();
  }

  function processProtocolData(data, at) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;

    // Explicit duplicated input message. Dedupe happens by id.
    if (data.type === 'input_message' && isObj(data.input_message)) {
      upsertMessage(data.input_message, at);
      return;
    }

    // Markers are useful for power-user timing, but don't belong as chat bubbles.
    if (data.type === 'message_marker' && data.message_id) {
      const list = S.markers.get(data.message_id) || [];
      list.push({
        marker: data.marker,
        event: data.event,
        at,
      });
      S.markers.set(data.message_id, list);
      return;
    }

    if (data.type === 'server_ste_metadata' && isObj(data.metadata)) {
      Object.assign(S.streamMeta, data.metadata);
      return;
    }

    // Full v1 object/root. In the captures, c changes when a new message root arrives.
    if (isObj(data.v) && isObj(data.v.message)) {
      S.currentRoot = deepClone(data.v);
      S.lastDeltaTemplate = null;
      upsertMessage(S.currentRoot.message, at);
      return;
    }

    // Normal v1 operation. Remember *every* operation, including `patch`.
    // ChatGPT commonly sends one full `{o:"patch", v:[...]}` packet and then
    // follows it with shorthand `{v:[...]}` packets that inherit `o:"patch"`.
    if (typeof data.o === 'string') {
      S.lastDeltaTemplate = {
        p: data.p ?? '',
        o: data.o,
      };

      applyToCurrentRoot(data, at);
      return;
    }

    // v1 shorthand: later frames can contain only "v" and reuse the last p/o.
    if (
      Object.prototype.hasOwnProperty.call(data, 'v') &&
      !Object.prototype.hasOwnProperty.call(data, 'c') &&
      S.lastDeltaTemplate &&
      S.currentRoot
    ) {
      applyToCurrentRoot({
        p: S.lastDeltaTemplate.p,
        o: S.lastDeltaTemplate.o,
        v: data.v,
      }, at);
    }
  }

  function applyToCurrentRoot(operation, at) {
    if (!S.currentRoot) return;

    try {
      S.currentRoot = applyDeltaOperation(S.currentRoot, operation);
      if (isObj(S.currentRoot) && isObj(S.currentRoot.message)) {
        upsertMessage(S.currentRoot.message, at);
      }
    } catch (err) {
      emit(
        'RECON:ERROR',
        `Could not apply ${operation?.o || 'delta'}: ${err?.message || err}`,
        { operation, error: String(err) },
        'error'
      );
    }
  }

  function upsertMessage(message, at) {
    if (!isObj(message) || !message.id) return;

    const id = message.id;
    const existing = S.messages.get(id);

    if (!existing) {
      S.messages.set(id, {
        message: deepClone(message),
        firstSeen: at || new Date().toISOString(),
        lastSeen: at || new Date().toISOString(),
        order: ++S.messageOrderCounter,
      });
      S.messageOrder.push(id);
    } else {
      existing.message = deepClone(message);
      existing.lastSeen = at || new Date().toISOString();
    }
  }

  // ============================================================
  // JSON-pointer-ish v1 delta application
  // ============================================================

  function applyDeltaOperation(root, op) {
    if (!isObj(op)) return root;

    if (op.o === 'patch' && Array.isArray(op.v)) {
      let next = root;
      for (const sub of op.v) next = applyDeltaOperation(next, sub);
      return next;
    }

    const path = typeof op.p === 'string' ? op.p : '';
    const parts = pointerParts(path);

    // Root operation.
    if (!parts.length) {
      if (op.o === 'add' || op.o === 'replace') return deepClone(op.v);
      if (op.o === 'append') return appendValue(root, op.v);
      if (op.o === 'remove') return null;
      if (op.o === 'truncate') return truncateValue(root, op.v);
      return root;
    }

    const { parent, key } = resolvePointerParent(
      root,
      parts,
      ['add', 'replace', 'append'].includes(op.o)
    );

    if (Array.isArray(parent)) {
      const index = key === '-' ? parent.length : Number(key);
      if (!Number.isInteger(index) || index < 0) return root;

      switch (op.o) {
        case 'add':
          if (index >= parent.length) parent.push(deepClone(op.v));
          else parent.splice(index, 0, deepClone(op.v));
          break;
        case 'replace':
          parent[index] = deepClone(op.v);
          break;
        case 'append':
          parent[index] = appendValue(parent[index], op.v);
          break;
        case 'remove':
          if (index < parent.length) parent.splice(index, 1);
          break;
        case 'truncate':
          parent[index] = truncateValue(parent[index], op.v);
          break;
      }
      return root;
    }

    switch (op.o) {
      case 'add':
      case 'replace':
        parent[key] = deepClone(op.v);
        break;
      case 'append':
        parent[key] = appendValue(parent[key], op.v);
        break;
      case 'remove':
        delete parent[key];
        break;
      case 'truncate':
        parent[key] = truncateValue(parent[key], op.v);
        break;
    }

    return root;
  }

  function appendValue(oldValue, incoming) {
    if (typeof oldValue === 'string' && typeof incoming === 'string') {
      return oldValue + incoming;
    }
    if (Array.isArray(oldValue)) {
      oldValue.push(...(Array.isArray(incoming) ? deepClone(incoming) : [deepClone(incoming)]));
      return oldValue;
    }
    if (isObj(oldValue) && isObj(incoming)) {
      Object.assign(oldValue, deepClone(incoming));
      return oldValue;
    }
    if (oldValue == null) return deepClone(incoming);
    return typeof incoming === 'string'
      ? String(oldValue) + incoming
      : deepClone(incoming);
  }

  function truncateValue(value, amount) {
    // Observed protocol has a truncate op; this conservative implementation handles
    // the common length-style form while preserving unknown forms.
    const n = Number(amount);
    if (!Number.isFinite(n)) return value;
    if (typeof value === 'string') return value.slice(0, Math.max(0, n));
    if (Array.isArray(value)) return value.slice(0, Math.max(0, n));
    return value;
  }

  function pointerParts(path) {
    if (!path) return [];
    return path
      .replace(/^\//, '')
      .split('/')
      .map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
  }

  function resolvePointerParent(root, parts, create) {
    let current = root;

    for (const part of parts.slice(0, -1)) {
      if (Array.isArray(current)) {
        const index = Number(part);
        if (!Number.isInteger(index) || index < 0) throw new Error(`Invalid array path: ${part}`);
        if (create) {
          while (current.length <= index) current.push({});
        }
        current = current[index];
      } else {
        if (!isObj(current)) throw new Error(`Cannot descend through ${typeof current}`);
        if (!(part in current) && create) current[part] = {};
        current = current[part];
      }
      if (current == null) throw new Error(`Missing path component: ${part}`);
    }

    return { parent: current, key: parts.at(-1) };
  }

  // ============================================================
  // Passive fetch tap
  // ============================================================

  const nativeFetch = window.fetch.bind(window);

  window.fetch = async function (...args) {
    const response = await nativeFetch(...args);

    try {
      const url = requestURL(args[0]);
      const parsed = safeURL(url);
      const path = parsed?.pathname || '';
      const contentType = response.headers.get('content-type') || '';
      const isSSE = contentType.toLowerCase().includes('text/event-stream');

      // Important: do NOT treat ordinary /conversation JSON as SSE.
      // We only consume actual SSE responses.
      if (isSSE) {
        const clone = response.clone();

        emit(
          'FETCH',
          `${response.status} ${shortURL(url)} ${contentType}`,
          { url: redactURL(url), status: response.status, contentType },
          'transport',
          { transport: true }
        );

        consumeSSE(clone.body, url).catch(err => {
          // Abort after ChatGPT deliberately closes a cloned stream isn't useful noise.
          if (!/aborted|aborterror/i.test(String(err?.message || err))) {
            emit(
              'ERROR',
              `Stream tap failed: ${err?.message || err}`,
              { message: String(err) },
              'error'
            );
          }
        });
      } else if (CONFIG.exactSSEPaths.has(path)) {
        // Unexpected response from an endpoint we expected to stream.
        emit(
          'HTTP',
          `${response.status} ${shortURL(url)} ${contentType || '(no content-type)'}`,
          { url: redactURL(url), status: response.status, contentType },
          'transport',
          { transport: true }
        );
      }
    } catch (err) {
      emit('ERROR', `fetch hook error: ${err?.message || err}`, { message: String(err) }, 'error');
    }

    // ChatGPT always gets its original Response.
    return response;
  };

  async function consumeSSE(stream, url) {
    if (!stream) return;

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match) break;

        const i = match.index;
        const block = buffer.slice(0, i);
        buffer = buffer.slice(i + match[0].length);

        handleSSEBlock(block, url);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) handleSSEBlock(buffer, url);
  }

  function handleSSEBlock(block, url) {
    if (!block.trim()) return;

    let eventName = 'message';
    let eventID = null;
    const dataLines = [];

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('id:')) eventID = line.slice(3).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }

    const text = dataLines.join('\n');

    if (!text) {
      emit(
        'SSE',
        `${eventName} (no data)`,
        { eventName, eventID, url: redactURL(url) },
        'transport',
        { transport: true, empty: true }
      );
      return;
    }

    if (text === '[DONE]') {
      emit('DONE', `${shortURL(url)} [DONE]`, { eventName, eventID }, 'done');
      return;
    }

    let data = text;
    try { data = JSON.parse(text); } catch {}

    processProtocolData(data, new Date().toISOString());

    const c = classify(data, text);
    emit(
      c.kind,
      c.summary,
      { eventName, eventID, url: redactURL(url), data },
      c.css,
      c.meta || {}
    );
  }

  // ============================================================
  // WebSocket tap
  // ============================================================

  const NativeWebSocket = window.WebSocket;

  if (typeof NativeWebSocket === 'function') {
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(Target, args, NewTarget) {
        const ws = Reflect.construct(Target, args, NewTarget);
        const url = String(args[0] || '');

        emit('WS:OPENING', shortURL(url), { url: redactURL(url) }, 'transport', { transport: true });

        ws.addEventListener('open', () => {
          emit('WS:OPEN', shortURL(url), { url: redactURL(url) }, 'transport', { transport: true });
        });

        ws.addEventListener('message', e => {
          const payload = decodeWS(e.data);

          // Some completed/async turns are later echoed as a full
          // `conversation-update` message over WebSocket. Treat that as an
          // authoritative reconciliation snapshot for the same message id.
          processWebSocketProtocol(payload, new Date().toISOString());

          const transportOnly = isWSHandshake(payload);
          emit(
            'WS:IN',
            `${shortURL(url)} ${summarize(payload)}`,
            payload,
            'ws',
            { transport: transportOnly }
          );
        });

        ws.addEventListener('close', e => {
          emit(
            'WS:CLOSE',
            `${shortURL(url)} code=${e.code}`,
            { code: e.code, reason: e.reason, wasClean: e.wasClean },
            'transport',
            { transport: true }
          );
        });

        ws.addEventListener('error', () => {
          emit('WS:ERROR', shortURL(url), { url: redactURL(url) }, 'error');
        });

        const send = ws.send;
        ws.send = function (payload) {
          const decoded = decodeWS(payload);
          emit(
            'WS:OUT',
            `${shortURL(url)} ${summarize(decoded)}`,
            decoded,
            'transport',
            { transport: isWSHandshake(decoded) }
          );
          return send.call(this, payload);
        };

        return ws;
      },
    });
  }


  function processWebSocketProtocol(payload, at) {
    const visit = value => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (!isObj(value)) return;

      if (value.type === 'conversation-update') {
        const message = value.payload?.update_content?.message;
        if (isObj(message) && message.id) {
          upsertMessage(message, at);
        }
      }

      // WebSocket envelopes can wrap the interesting payload one level down.
      if (value.payload && value.type !== 'conversation-update') {
        visit(value.payload);
      }
    };

    visit(payload);
  }

  function isWSHandshake(payload) {
    const strings = collectStrings(payload, 5000).join(' ');
    return /\b(connect|subscribe|presence|recovered)\b/.test(strings);
  }

  // ============================================================
  // Event classification
  // ============================================================

  function classify(data, rawText) {
    if (typeof data === 'string') {
      if (data === 'v1' || data === '"v1"') {
        return {
          kind: 'ENCODING',
          summary: 'ChatGPT delta encoding v1',
          css: 'transport',
          meta: { transport: true },
        };
      }
      return { kind: 'TEXT', summary: clip(data), css: '' };
    }

    if (!isObj(data)) return { kind: 'SSE', summary: clip(rawText), css: '' };

    if (typeof data.o === 'string') {
      if (data.o === 'patch' && Array.isArray(data.v)) {
        const descriptions = data.v.map(x => `${x.o || '?'} ${x.p || ''}`).join(', ');
        return {
          kind: 'PATCH',
          summary: descriptions || 'patch batch',
          css: 'patch',
          meta: { streamPatch: true },
        };
      }

      const path = data.p || '';
      return {
        kind: `PATCH:${data.o}`,
        summary: `${data.o} ${path} ${summarize(data.v)}`.trim(),
        css: 'patch',
        meta: { streamPatch: true },
      };
    }

    const type = data.type;

    if (type === 'message_marker') {
      return {
        kind: 'MARKER',
        summary: `${data.marker || 'marker'}${data.event ? ` · ${data.event}` : ''}`,
        css: 'marker',
        meta: { marker: true },
      };
    }

    if (type === 'resume_conversation_token') {
      return {
        kind: 'CONTROL',
        summary: 'resume token',
        css: 'transport',
        meta: { transport: true, secretish: true },
      };
    }

    if (type === 'input_message') {
      const role = data.input_message?.author?.role || 'message';
      return {
        kind: 'INPUT',
        summary: `${role}: ${clip(messageText(data.input_message), 180)}`,
        css: 'message',
        meta: { duplicateInput: true },
      };
    }

    if (type === 'title_generation') {
      return {
        kind: 'TITLE',
        summary: data.title || 'title generated',
        css: 'control',
        meta: { auxiliary: true },
      };
    }

    if (type === 'server_ste_metadata' || type === 'conversation_detail_metadata') {
      return {
        kind: 'METADATA',
        summary: type,
        css: 'transport',
        meta: { transport: true },
      };
    }

    if (type === 'message_stream_complete') {
      return {
        kind: 'COMPLETE',
        summary: 'message stream complete',
        css: 'done',
        meta: { auxiliary: true },
      };
    }

    const message = data.v?.message;
    if (isObj(message)) {
      return classifyMessage(message);
    }

    const richType = findRichType(data);
    if (richType) {
      return {
        kind: 'RICH',
        summary: `${richType}: ${summarize(data)}`,
        css: 'rich',
      };
    }

    return { kind: 'SSE', summary: summarize(data) || clip(rawText), css: '' };
  }

  function classifyMessage(m) {
    const role = m.author?.role || 'unknown';
    const ct = m.content?.content_type || 'unknown';
    const hidden = !!m.metadata?.is_visually_hidden_from_conversation;

    if (role === 'system') {
      return {
        kind: 'SYSTEM',
        summary: `${hidden ? 'hidden ' : ''}system · ${ct}`,
        css: 'internal',
        meta: { internal: true, messageId: m.id },
      };
    }

    if (ct === 'model_editable_context') {
      return {
        kind: 'CONTEXT',
        summary: 'model editable context',
        css: 'internal',
        meta: { internal: true, messageId: m.id },
      };
    }

    if (ct === 'reasoning_recap') {
      return {
        kind: 'THINKING',
        summary: messageText(m) || `reasoning ${m.metadata?.reasoning_status || ''}`,
        css: 'thinking',
        meta: { messageId: m.id },
      };
    }

    if (ct === 'execution_output') {
      return {
        kind: 'PYTHON',
        summary: summarizeMessage(m),
        css: 'python',
        meta: { messageId: m.id },
      };
    }

    if (ct === 'multimodal_text' || collectStrings(m.content, 5000).includes('image_asset_pointer')) {
      return {
        kind: 'IMAGE',
        summary: summarizeMessage(m),
        css: 'image',
        meta: { messageId: m.id },
      };
    }

    if (isToolMessage(m)) {
      return {
        kind: role === 'tool' ? 'TOOL:RESULT' : 'TOOL:CALL',
        summary: toolLabel(m),
        css: 'tool',
        meta: { messageId: m.id },
      };
    }

    return {
      kind: 'MESSAGE',
      summary: `${role} · ${ct} · ${clip(messageText(m), 180)}`,
      css: 'message',
      meta: {
        messageId: m.id,
        internal: hidden,
      },
    };
  }

  // ============================================================
  // "Focused" event filtering
  // ============================================================

  function eventVisible(ev) {
    if (S.mode === 'all') return true;

    if (ev.kind === 'ERROR' || ev.kind === 'RECON:ERROR') return true;
    if (ev.css === 'tool' || ev.css === 'python' || ev.css === 'image' || ev.css === 'rich') return true;
    if (ev.kind === 'THINKING') return true;

    if (ev.meta?.internal && !S.showInternal) return false;
    if (ev.meta?.transport) return false;
    if (ev.meta?.duplicateInput) return false;
    if (ev.meta?.streamPatch) return false;
    if (ev.meta?.marker) return false;
    if (ev.meta?.auxiliary) return false;

    // Generic message creation is useful; protocol/control clutter isn't.
    if (['MESSAGE', 'INPUT', 'SYSTEM', 'CONTEXT'].includes(ev.kind)) return true;

    return false;
  }

  // ============================================================
  // Reconstructed chat
  // ============================================================

  function chatRecords() {
    const records = [];

    for (const id of S.messageOrder) {
      const rec = S.messages.get(id);
      if (!rec) continue;

      const m = rec.message;
      const role = m.author?.role || 'unknown';
      const ct = m.content?.content_type || 'unknown';
      const hidden = !!m.metadata?.is_visually_hidden_from_conversation;

      const internal =
        role === 'system' ||
        ct === 'model_editable_context' ||
        hidden;

      if (internal && !S.showInternal) continue;

      records.push(rec);
    }

    records.sort((a, b) => a.order - b.order);
    return records;
  }

  function renderChatCard(rec) {
    const m = rec.message;
    const role = m.author?.role || 'unknown';
    const ct = m.content?.content_type || 'unknown';
    const status = m.status || '';
    const text = messageText(m);
    const model = m.metadata?.resolved_model_slug || m.metadata?.model_slug || '';
    const effort = m.metadata?.thinking_effort || '';

    const card = document.createElement('article');

    if (ct === 'reasoning_recap') {
      card.className = 'chat-card thinking-card';
      const seconds = m.metadata?.finished_duration_sec;
      card.innerHTML = `
        <div class="card-head">
          <span class="role-chip thinking-chip">THINKING</span>
          ${seconds != null ? `<span class="dim">${escapeHTML(String(seconds))}s</span>` : ''}
          <span class="spacer"></span>
          ${model ? `<span class="dim">${escapeHTML(model)}</span>` : ''}
        </div>
        <div class="thinking-body">${escapeHTML(text || 'Reasoning completed')}</div>
        ${rawDetails(m)}
      `;
      return card;
    }

    if (isToolMessage(m)) {
      const isResult = role === 'tool';
      card.className = `chat-card tool-card ${isResult ? 'tool-result' : 'tool-call'}`;

      const label = toolLabel(m);
      const body = text || summarize(m.content);
      const latency = toolLatencyHint(rec);

      card.innerHTML = `
        <div class="card-head">
          <span class="role-chip tool-chip">${isResult ? 'TOOL RESULT' : 'TOOL CALL'}</span>
          <strong class="tool-name">${escapeHTML(label)}</strong>
          <span class="spacer"></span>
          ${latency ? `<span class="dim">${escapeHTML(latency)}</span>` : ''}
          ${status ? `<span class="status ${status === 'in_progress' ? 'live' : ''}">${escapeHTML(status)}</span>` : ''}
        </div>
        <div class="tool-body">${renderText(body || '(no textual payload)')}</div>
        <div class="tool-meta">
          ${m.recipient && m.recipient !== 'all' ? `<span>recipient: <code>${escapeHTML(m.recipient)}</code></span>` : ''}
          <span>content: <code>${escapeHTML(ct)}</code></span>
          <span>id: <code>${escapeHTML(shortID(m.id))}</code></span>
        </div>
        ${rawDetails(m)}
      `;
      return card;
    }

    if (ct === 'execution_output') {
      card.className = 'chat-card tool-card python-card';
      card.innerHTML = `
        <div class="card-head">
          <span class="role-chip python-chip">PYTHON</span>
          <strong>Execution output</strong>
          <span class="spacer"></span>
          <span class="status">${escapeHTML(status)}</span>
        </div>
        <div class="tool-body">${renderText(text || summarize(m.content) || '(output in metadata)')}</div>
        ${rawDetails(m)}
      `;
      return card;
    }

    if (ct === 'multimodal_text' || hasImagePointer(m)) {
      card.className = 'chat-card tool-card image-card';
      const asset = findImagePointer(m);
      card.innerHTML = `
        <div class="card-head">
          <span class="role-chip image-chip">IMAGE</span>
          <strong>Generated / multimodal asset</strong>
          <span class="spacer"></span>
          <span class="status">${escapeHTML(status)}</span>
        </div>
        <div class="asset-box">
          ${asset?.asset_pointer ? `<code>${escapeHTML(asset.asset_pointer)}</code>` : ''}
          ${asset?.width && asset?.height ? `<span>${asset.width}×${asset.height}</span>` : ''}
          ${asset?.metadata?.mime_type ? `<span>${escapeHTML(asset.metadata.mime_type)}</span>` : ''}
        </div>
        ${text ? `<div class="tool-body">${renderText(text)}</div>` : ''}
        ${rawDetails(m)}
      `;
      return card;
    }

    const internal = role === 'system' || ct === 'model_editable_context' || m.metadata?.is_visually_hidden_from_conversation;

    if (internal) {
      card.className = 'chat-card internal-card';
      card.innerHTML = `
        <div class="card-head">
          <span class="role-chip internal-chip">INTERNAL</span>
          <strong>${escapeHTML(role)} · ${escapeHTML(ct)}</strong>
          <span class="spacer"></span>
          <span class="status">${escapeHTML(status)}</span>
        </div>
        <div class="internal-body">${renderText(text || '(empty hidden message)')}</div>
        ${rawDetails(m)}
      `;
      return card;
    }

    card.className = `chat-card ${role === 'user' ? 'user-card' : 'assistant-card'}`;

    const label = role === 'user' ? 'YOU' : role.toUpperCase();
    card.innerHTML = `
      <div class="card-head">
        <span class="role-chip ${role === 'user' ? 'user-chip' : 'assistant-chip'}">${escapeHTML(label)}</span>
        ${model ? `<span class="model">${escapeHTML(model)}</span>` : ''}
        ${effort ? `<span class="dim">${escapeHTML(effort)}</span>` : ''}
        <span class="spacer"></span>
        ${status === 'in_progress' ? '<span class="live-dot"></span>' : ''}
        ${status ? `<span class="status ${status === 'in_progress' ? 'live' : ''}">${escapeHTML(status)}</span>` : ''}
      </div>
      <div class="message-body">${renderText(text || (status === 'in_progress' ? '…' : '(empty message)'))}</div>
      <div class="message-meta">
        <span>${formatTime(rec.firstSeen)}</span>
        <span>id <code>${escapeHTML(shortID(m.id))}</code></span>
        ${m.channel ? `<span>channel <code>${escapeHTML(m.channel)}</code></span>` : ''}
      </div>
      ${rawDetails(m)}
    `;

    return card;
  }

  function rawDetails(obj) {
    return `
      <details class="raw-details">
        <summary>Raw reconstructed message</summary>
        <pre>${escapeHTML(safeStringify(sanitize(obj), 2))}</pre>
      </details>
    `;
  }

  function isToolMessage(m) {
    const role = m?.author?.role;
    const recipient = m?.recipient;
    const ct = m?.content?.content_type || '';

    if (role === 'tool') return true;
    if (recipient && recipient !== 'all') return true;

    return ['code', 'computer_output'].includes(ct) && role === 'assistant';
  }

  function toolLabel(m) {
    const candidates = [
      m?.recipient && m.recipient !== 'all' ? m.recipient : null,
      m?.author?.name,
      m?.metadata?.tool_name,
      m?.metadata?.connector_name,
      m?.metadata?.command,
    ].filter(Boolean);

    if (candidates.length) return String(candidates[0]);

    const body = messageText(m);
    const first = body.match(/^\s*([A-Za-z0-9_.:-]+)\s*\(/)?.[1];
    return first || 'tool';
  }

  function toolLatencyHint(rec) {
    const parent = rec.message?.metadata?.parent_id;
    if (!parent) return '';
    const p = S.messages.get(parent);
    if (!p) return '';

    const start = Date.parse(p.firstSeen);
    const end = Date.parse(rec.firstSeen);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';

    const ms = end - start;
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
  }

  function messageText(m) {
    if (!isObj(m)) return '';
    const c = m.content;
    if (!isObj(c)) return '';

    if (Array.isArray(c.parts)) {
      return c.parts
        .map(part => {
          if (typeof part === 'string') return part;
          if (part?.content_type === 'image_asset_pointer') return '';
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }

    if (typeof c.text === 'string') return c.text;
    if (typeof c.content === 'string') return c.content;
    if (typeof c.result === 'string') return c.result;

    return '';
  }

  function summarizeMessage(m) {
    return [
      m.author?.role,
      m.content?.content_type,
      m.status,
      clip(messageText(m), 160),
    ].filter(Boolean).join(' · ');
  }

  function hasImagePointer(m) {
    return !!findImagePointer(m);
  }

  function findImagePointer(value) {
    let found = null;
    walk(value, x => {
      if (isObj(x) && x.content_type === 'image_asset_pointer') {
        found = x;
        return false;
      }
      return true;
    });
    return found;
  }

  // ============================================================
  // UI
  // ============================================================

  function installUI() {
    if (document.getElementById('__cgpt_stream_inspector_host')) return;
    if (!document.documentElement) return;

    const host = document.createElement('div');
    host.id = '__cgpt_stream_inspector_host';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;right:0;';
    document.documentElement.appendChild(host);

    const root = host.attachShadow({ mode: 'open' });
    S.root = root;

    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        button, input, select { font: inherit; }
        code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }

        .launcher {
          position:fixed; right:16px; bottom:16px; width:52px; height:52px;
          z-index:2147483647; border-radius:999px; border:1px solid #ffffff26;
          background:#111e; color:#fff; cursor:pointer; box-shadow:0 10px 36px #0007;
          font:700 11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
          backdrop-filter:blur(20px);
        }
        .launcher:hover { background:#242424; }

        .panel {
          position:fixed; right:12px; top:12px;
          width:min(1180px,calc(100vw - 24px)); height:min(88vh,940px);
          display:none; grid-template-rows:auto 1fr;
          color:#ececec; background:#111111f4; border:1px solid #ffffff1c;
          border-radius:16px; overflow:hidden; box-shadow:0 24px 90px #000a;
          backdrop-filter:blur(28px);
          font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        }
        .panel.open { display:grid; }

        .topbar {
          min-height:52px; display:flex; gap:8px; align-items:center; padding:9px 11px;
          border-bottom:1px solid #ffffff12; background:#151515e8;
        }
        .brand { display:flex; flex-direction:column; min-width:190px; }
        .brand strong { font-size:13px; }
        .brand small { color:#888; font-size:10px; }
        .spacer { flex:1; }

        .ctl {
          color:#e8e8e8; background:#232323; border:1px solid #ffffff17;
          border-radius:8px; padding:6px 8px; cursor:pointer;
        }
        .ctl:hover { background:#2e2e2e; }
        select.ctl { cursor:pointer; }
        .toggle { display:flex; align-items:center; gap:5px; color:#aaa; white-space:nowrap; }
        .toggle input { accent-color:#8ab4ff; }

        .body { min-height:0; display:grid; grid-template-columns:minmax(390px,1.08fr) minmax(340px,.92fr); }
        .body.chat-only { grid-template-columns:1fr; }
        .body.chat-only .events-pane { display:none; }
        .body.events-only { grid-template-columns:1fr; }
        .body.events-only .chat-pane { display:none; }

        .pane { min-width:0; min-height:0; display:grid; grid-template-rows:auto 1fr; }
        .chat-pane { border-right:1px solid #ffffff12; }
        .pane-head {
          height:44px; display:flex; align-items:center; gap:8px; padding:8px 10px;
          border-bottom:1px solid #ffffff10; background:#141414;
        }
        .pane-title { font-weight:650; }
        .pane-sub { color:#777; font-size:10px; }
        .count { margin-left:auto; color:#777; font:10px ui-monospace,SFMono-Regular,monospace; }

        .chat-list, .event-list { overflow:auto; min-height:0; }
        .chat-list { padding:14px 14px 28px; background:linear-gradient(#101010,#0e0e0e); }
        .event-list { padding:6px 8px 24px; font:11px/1.38 ui-monospace,SFMono-Regular,Menlo,monospace; }

        .empty {
          margin:28px auto; max-width:380px; padding:18px; text-align:center;
          color:#777; border:1px dashed #ffffff17; border-radius:12px;
        }

        /* Reconstructed chat */
        .chat-card {
          margin:0 0 12px; border:1px solid #ffffff12; border-radius:13px;
          background:#171717; overflow:hidden; box-shadow:0 5px 18px #0002;
        }
        .user-card { margin-left:12%; background:#1e2937; border-color:#7fb0ff2a; }
        .assistant-card { margin-right:5%; }
        .card-head {
          min-height:36px; display:flex; align-items:center; gap:7px; padding:7px 10px;
          border-bottom:1px solid #ffffff0d; background:#ffffff03;
        }
        .role-chip {
          font:700 9px ui-monospace,SFMono-Regular,monospace; letter-spacing:.07em;
          padding:3px 5px; border-radius:5px; border:1px solid #ffffff14;
        }
        .user-chip { color:#b9d5ff; background:#183452; }
        .assistant-chip { color:#c8c8c8; background:#2b2b2b; }
        .tool-chip { color:#9ef1b3; background:#153820; }
        .thinking-chip { color:#d6b6ff; background:#382151; }
        .python-chip { color:#9bdcff; background:#183a4a; }
        .image-chip { color:#ffd09e; background:#49311f; }
        .internal-chip { color:#aaa; background:#2a2a2a; }
        .model, .dim, .status { color:#7f7f7f; font-size:10px; }
        .status.live { color:#9fd1ff; }
        .live-dot { width:7px; height:7px; background:#78b9ff; border-radius:50%; box-shadow:0 0 0 4px #78b9ff16; }

        .message-body, .tool-body, .thinking-body, .internal-body {
          padding:11px 12px; white-space:normal; overflow-wrap:anywhere; color:#e6e6e6;
        }
        .message-body { font-size:13px; line-height:1.55; }
        .message-body p, .tool-body p { margin:0 0 8px; }
        .message-body p:last-child, .tool-body p:last-child { margin-bottom:0; }
        .message-body pre, .tool-body pre {
          margin:8px 0; padding:9px; overflow:auto; border-radius:8px;
          background:#090909; border:1px solid #ffffff12;
        }
        .message-body code, .tool-body code {
          padding:1px 4px; border-radius:4px; background:#ffffff0d;
        }
        .message-meta, .tool-meta {
          display:flex; flex-wrap:wrap; gap:9px; padding:0 11px 8px; color:#666; font-size:9px;
        }

        .thinking-card {
          margin-left:6%; margin-right:12%; border-style:dashed; border-color:#b886ff28;
          background:#17131d;
        }
        .thinking-body { color:#bdaec8; font-size:11px; }

        .tool-card {
          margin-left:4%; margin-right:4%; border-color:#5ce97b24; background:#111a13;
        }
        .tool-result { background:#111815; }
        .tool-name { font:600 11px ui-monospace,SFMono-Regular,monospace; color:#cef4d7; }
        .tool-body { max-height:220px; overflow:auto; color:#c7d8ca; font:11px/1.45 ui-monospace,SFMono-Regular,monospace; }
        .python-card { border-color:#60c8ff28; background:#11181c; }
        .image-card { border-color:#ffbd7028; background:#1b1611; }
        .asset-box { display:flex; flex-wrap:wrap; gap:8px; padding:10px 11px; color:#bca98f; }

        .internal-card { border-style:dashed; opacity:.78; background:#131313; }
        .internal-body { color:#999; font:10px/1.4 ui-monospace,SFMono-Regular,monospace; }

        .raw-details { border-top:1px solid #ffffff0b; }
        .raw-details summary { cursor:pointer; color:#666; padding:6px 10px; font-size:9px; }
        .raw-details pre {
          margin:0; padding:9px; max-height:300px; overflow:auto;
          color:#aaa; background:#080808; font-size:9px; white-space:pre-wrap;
        }

        .ref-pill {
          display:inline-block; vertical-align:baseline; margin:0 2px; padding:1px 5px;
          border-radius:999px; background:#5a43a433; color:#cdbfff;
          font:9px ui-monospace,SFMono-Regular,monospace;
        }

        /* Raw events */
        .events-tools { display:flex; align-items:center; gap:6px; width:100%; }
        .events-tools input {
          min-width:0; flex:1; color:#ddd; background:#202020; border:1px solid #ffffff12;
          border-radius:7px; padding:5px 7px; font-size:11px;
        }

        .event {
          display:grid; grid-template-columns:36px 88px minmax(0,1fr); gap:6px;
          padding:6px 4px; border-bottom:1px solid #ffffff09; align-items:start;
        }
        .event:hover { background:#ffffff04; }
        .event-id { color:#555; text-align:right; }
        .event-kind {
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:center;
          padding:2px 4px; border-radius:5px; color:#ccc; background:#292929;
        }
        .event-summary { min-width:0; color:#bbb; white-space:pre-wrap; overflow-wrap:anywhere; cursor:pointer; }
        .event-raw {
          display:none; grid-column:2 / 4; margin:4px 0 0; padding:8px; max-height:320px;
          overflow:auto; border-radius:7px; background:#080808; color:#aaa; white-space:pre-wrap;
        }
        .event.expanded .event-raw { display:block; }
        .event.tool .event-kind { background:#173b20; color:#a3f2b7; }
        .event.message .event-kind { background:#18354c; color:#a8d7ff; }
        .event.thinking .event-kind { background:#3a2250; color:#d9b7ff; }
        .event.patch .event-kind { background:#403719; color:#ffe58a; }
        .event.error .event-kind { background:#501919; color:#ff9a9a; }
        .event.image .event-kind { background:#4a321e; color:#ffd09c; }
        .event.python .event-kind { background:#183a49; color:#9edfff; }
        .event.rich .event-kind { background:#33254e; color:#d2bcff; }
        .event.internal .event-kind { background:#262626; color:#8d8d8d; }
        .event.done .event-kind { background:#333; color:#aaa; }
        .event.transport .event-kind { background:#202020; color:#676767; }

        @media (max-width: 850px) {
          .panel { width:calc(100vw - 12px); right:6px; top:6px; height:calc(100vh - 12px); }
          .body { grid-template-columns:1fr; }
          .body:not(.events-only) .events-pane { display:none; }
          .topbar { overflow-x:auto; }
          .brand { min-width:155px; }
        }
      </style>

      <button class="launcher" title="Agent Stream Inspector">AGT</button>

      <section class="panel">
        <header class="topbar">
          <div class="brand">
            <strong>Agent Stream Inspector</strong>
            <small>passive · reconstructed from network only</small>
          </div>

          <label class="toggle">
            Events
            <select class="ctl mode">
              <option value="focused">Focused</option>
              <option value="all">Everything</option>
            </select>
          </label>

          <label class="toggle" title="Show protocol messages ChatGPT marks as visually hidden/internal (system/rebase/context scaffolding).">
            <input type="checkbox" class="internal-toggle" checked>
            Show internal
          </label>

          <label class="toggle">
            View
            <select class="ctl view">
              <option value="split">Split</option>
              <option value="chat">Chat</option>
              <option value="events">Events</option>
            </select>
          </label>

          <span class="spacer"></span>
          <button class="ctl pause">Pause</button>
          <button class="ctl clear">Clear</button>
          <button class="ctl export">Export</button>
          <button class="ctl close">×</button>
        </header>

        <main class="body">
          <section class="pane chat-pane">
            <div class="pane-head">
              <span class="pane-title">Network Chat</span>
              <span class="pane-sub">messages + thinking summaries + tools</span>
              <span class="count chat-count"></span>
            </div>
            <div class="chat-list"></div>
          </section>

          <section class="pane events-pane">
            <div class="pane-head">
              <div class="events-tools">
                <span class="pane-title">Events</span>
                <input class="filter" placeholder="filter events…" />
                <span class="count event-count"></span>
              </div>
            </div>
            <div class="event-list"></div>
          </section>
        </main>
      </section>
    `;

    const $ = q => root.querySelector(q);

    S.panel = $('.panel');
    S.eventList = $('.event-list');
    S.chatList = $('.chat-list');
    S.counts = {
      events: $('.event-count'),
      chat: $('.chat-count'),
    };

    $('.launcher').onclick = () => S.panel.classList.toggle('open');
    $('.close').onclick = () => S.panel.classList.remove('open');

    $('.pause').onclick = e => {
      S.paused = !S.paused;
      e.currentTarget.textContent = S.paused ? 'Resume' : 'Pause';
    };

    $('.clear').onclick = () => {
      S.events = [];
      S.expandedEvents.clear();
      S.messages.clear();
      S.messageOrder = [];
      S.messageOrderCounter = 0;
      S.currentRoot = null;
      S.lastDeltaTemplate = null;
      S.markers.clear();
      S.streamMeta = {};
      scheduleRender();
    };

    $('.mode').onchange = e => {
      S.mode = e.target.value;
      scheduleRender();
    };

    $('.internal-toggle').onchange = e => {
      S.showInternal = e.target.checked;
      scheduleRender();
    };

    $('.view').onchange = e => {
      S.view = e.target.value;
      updateViewClass();
    };

    $('.filter').oninput = e => {
      S.filter = e.target.value.toLowerCase();
      scheduleRender();
    };

    $('.export').onclick = exportSnapshot;

    updateViewClass();
    scheduleRender();
  }

  function updateViewClass() {
    if (!S.panel) return;
    const body = S.root.querySelector('.body');
    body.classList.remove('chat-only', 'events-only');
    if (S.view === 'chat') body.classList.add('chat-only');
    if (S.view === 'events') body.classList.add('events-only');
  }

  function scheduleRender() {
    if (S.renderScheduled) return;
    S.renderScheduled = true;
    requestAnimationFrame(() => {
      S.renderScheduled = false;
      render();
    });
  }

  function render() {
    if (!S.eventList || !S.chatList) return;
    renderEvents();
    renderChat();
  }

  function renderEvents() {
    let visible = S.events.filter(eventVisible);

    if (S.filter) {
      visible = visible.filter(ev => {
        const haystack = `${ev.kind} ${ev.summary} ${safeStringify(ev.raw)}`.toLowerCase();
        return haystack.includes(S.filter);
      });
    }

    S.counts.events.textContent =
      S.mode === 'focused'
        ? `${visible.length} useful · ${S.events.length} captured`
        : `${visible.length} events`;

    visible = visible.slice(-CONFIG.maxRenderedEvents);

    const frag = document.createDocumentFragment();

    for (const ev of visible) {
      const row = document.createElement('div');
      row.className = `event ${ev.css || ''} ${S.expandedEvents.has(ev.id) ? 'expanded' : ''}`;

      row.innerHTML = `
        <div class="event-id">${ev.id}</div>
        <div class="event-kind">${escapeHTML(ev.kind)}</div>
        <div class="event-summary">${escapeHTML(ev.summary)}</div>
        <pre class="event-raw">${escapeHTML(safeStringify(ev.raw, 2))}</pre>
      `;

      row.querySelector('.event-summary').onclick = () => {
        if (S.expandedEvents.has(ev.id)) S.expandedEvents.delete(ev.id);
        else S.expandedEvents.add(ev.id);
        row.classList.toggle('expanded');
      };

      frag.appendChild(row);
    }

    S.eventList.replaceChildren(frag);
    S.eventList.scrollTop = S.eventList.scrollHeight;
  }

  function renderChat() {
    const records = chatRecords();
    S.counts.chat.textContent = `${records.length} items`;

    if (!records.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = `
        <strong>No reconstructed messages yet.</strong><br>
        Send a message in ChatGPT and this pane will rebuild the turn purely from the streamed network protocol.
      `;
      S.chatList.replaceChildren(empty);
      return;
    }

    const nearBottom =
      S.chatList.scrollHeight - S.chatList.scrollTop - S.chatList.clientHeight < 80;

    const frag = document.createDocumentFragment();
    for (const rec of records) frag.appendChild(renderChatCard(rec));
    S.chatList.replaceChildren(frag);

    if (nearBottom) S.chatList.scrollTop = S.chatList.scrollHeight;
  }

  function exportSnapshot() {
    const snapshot = {
      exportedAt: new Date().toISOString(),
      streamMeta: sanitize(S.streamMeta),
      events: S.events,
      reconstructedMessages: S.messageOrder
        .map(id => S.messages.get(id))
        .filter(Boolean)
        .map(rec => ({
          ...rec,
          message: sanitize(rec.message),
        })),
      markers: Object.fromEntries(S.markers),
    };

    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `chatgpt-agent-inspector-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ============================================================
  // Safe lightweight text rendering
  // ============================================================

  function renderText(input) {
    const text = String(input ?? '');
    const chunks = text.split(/(```[\s\S]*?```)/g);

    return chunks.map(chunk => {
      if (chunk.startsWith('```') && chunk.endsWith('```')) {
        const inner = chunk.slice(3, -3);
        const firstNL = inner.indexOf('\n');
        const code = firstNL >= 0 ? inner.slice(firstNL + 1) : inner;
        return `<pre><code>${escapeHTML(code)}</code></pre>`;
      }

      let s = escapeHTML(chunk);

      // Rich reference tokens: show compact pills rather than enormous control glyphs.
      s = s.replace(
        /([a-zA-Z_]+)[\s\S]*?/g,
        (_, type) => `<span class="ref-pill">${escapeHTML(type)}</span>`
      );

      s = s
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\n{2,}/g, '</p><p>')
        .replace(/\n/g, '<br>');

      return `<p>${s}</p>`;
    }).join('');
  }

  // ============================================================
  // Rich type detection
  // ============================================================

  const RICH_TYPES = new Set([
    'grouped_webpages',
    'url',
    'nav_list',
    'image_group',
    'dil',
    'products',
    'entity',
    'client_defined_widget',
    'sources_footnote',
    'product_entity',
    'product_rationale',
    'product_reviews',
  ]);

  function findRichType(value) {
    let found = null;

    walk(value, x => {
      if (isObj(x) && typeof x.type === 'string' && RICH_TYPES.has(x.type)) {
        found = x.type;
        return false;
      }
      return true;
    });

    return found;
  }

  // ============================================================
  // Helpers / redaction
  // ============================================================

  function sanitize(value, depth = 0, seen = new WeakSet()) {
    if (depth > 12) return '[depth limit]';

    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;

    if (typeof value === 'string') {
      let s = value;
      s = s.replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [REDACTED]');
      s = s.replace(
        /([?&](?:token|verify|sig|signature|auth|key|jwt|access_token|resume_token)=)[^&#\s]+/gi,
        '$1[REDACTED]'
      );
      return s.length > CONFIG.maxString ? `${s.slice(0, CONFIG.maxString)}…[truncated]` : s;
    }

    if (Array.isArray(value)) return value.map(x => sanitize(x, depth + 1, seen));

    if (typeof value === 'object') {
      if (seen.has(value)) return '[circular]';
      seen.add(value);

      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (/^(authorization|cookie|set-cookie|access_token|refresh_token|jwt|api_key|token|verify)$/i.test(k)) {
          out[k] = '[REDACTED]';
        } else {
          out[k] = sanitize(v, depth + 1, seen);
        }
      }
      return out;
    }

    return String(value);
  }

  function decodeWS(data) {
    if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return sanitize(data); }
    }
    if (data instanceof ArrayBuffer) return { binary: 'ArrayBuffer', bytes: data.byteLength };
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      return { binary: 'Blob', bytes: data.size, type: data.type };
    }
    return String(data);
  }

  function requestURL(req) {
    if (typeof req === 'string') return req;
    if (req instanceof URL) return req.href;
    return req?.url || '';
  }

  function safeURL(url) {
    try { return new URL(url, location.href); } catch { return null; }
  }

  function redactURL(url) {
    const u = safeURL(url);
    if (!u) return sanitize(String(url));

    for (const key of [...u.searchParams.keys()]) {
      if (/token|verify|sig|signature|auth|key|jwt/i.test(key)) {
        u.searchParams.set(key, '[REDACTED]');
      }
    }
    return u.href;
  }

  function shortURL(url) {
    const u = safeURL(redactURL(url));
    if (!u) return clip(String(url), 150);
    return `${u.pathname}${u.search ? u.search.slice(0, 100) : ''}`;
  }

  function summarize(value) {
    if (value == null) return '';
    if (typeof value === 'string') return clip(value);

    const interesting = ['text', 'name', 'type', 'content_type', 'status', 'recipient', 'message', 'title'];
    const out = [];

    for (const key of interesting) {
      const v = deepFind(value, key);
      if (typeof v === 'string' && v.trim()) out.push(v.trim());
    }

    if (out.length) return clip([...new Set(out)].slice(0, 6).join(' · '));
    return clip(safeStringify(value));
  }

  function collectStrings(value, maxChars = 10000) {
    const out = [];
    let count = 0;
    const seen = new WeakSet();

    (function visit(x, depth) {
      if (depth > 10 || count >= maxChars || x == null) return;
      if (typeof x === 'string') {
        out.push(x);
        count += x.length;
        return;
      }
      if (typeof x !== 'object' || seen.has(x)) return;
      seen.add(x);

      if (Array.isArray(x)) {
        for (const item of x) visit(item, depth + 1);
      } else {
        for (const [k, v] of Object.entries(x)) {
          out.push(k);
          count += k.length;
          visit(v, depth + 1);
        }
      }
    })(value, 0);

    return out;
  }

  function deepFind(value, key) {
    let found;
    walk(value, x => {
      if (isObj(x) && Object.prototype.hasOwnProperty.call(x, key)) {
        found = x[key];
        return false;
      }
      return true;
    });
    return found;
  }

  function walk(value, callback) {
    const seen = new WeakSet();

    function visit(x, depth) {
      if (depth > 12 || x == null || typeof x !== 'object') return true;
      if (seen.has(x)) return true;
      seen.add(x);

      if (callback(x) === false) return false;

      for (const child of Object.values(x)) {
        if (visit(child, depth + 1) === false) return false;
      }
      return true;
    }

    visit(value, 0);
  }

  function isObj(x) {
    return x !== null && typeof x === 'object' && !Array.isArray(x);
  }

  function deepClone(x) {
    if (typeof structuredClone === 'function') return structuredClone(x);
    return JSON.parse(JSON.stringify(x));
  }

  function safeStringify(value, spaces = 0) {
    try { return JSON.stringify(value, null, spaces); }
    catch { return String(value); }
  }

  function clip(value, max = 240) {
    const s = String(value ?? '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }

  function escapeHTML(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function shortID(id) {
    const s = String(id || '');
    return s.length > 12 ? `${s.slice(0, 8)}…` : s;
  }

  function formatTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
      });
    } catch {
      return '';
    }
  }

  // ============================================================
  // Boot
  // ============================================================

  if (document.documentElement) {
    installUI();
  } else {
    const observer = new MutationObserver(() => {
      if (document.documentElement) {
        observer.disconnect();
        installUI();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  }

  console.info('[ChatGPT Agent Stream Inspector] v0.3.3 installed');
})();
