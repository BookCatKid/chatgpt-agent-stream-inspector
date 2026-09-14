import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sourcePath = path.join(repo, 'chatgpt-agent-stream-inspector.user.js');
let source = fs.readFileSync(sourcePath, 'utf8');

const marker = /^  console\.info\('\[ChatGPT Agent Stream Inspector\].*$/m;
assert(marker.test(source), 'test hook marker not found');
source = source.replace(marker, `  globalThis.__ASI_TEST__ = {
    S, processProtocolData, processWebSocketProtocol,
    describeToolMessage, messageText, findImagePointers
  };`);

function makeRuntime() {
  const sandbox = {
    console,
    structuredClone,
    TextDecoder,
    URL,
    Blob,
    setInterval: () => 1,
    clearInterval: () => {},
    requestAnimationFrame: fn => fn(),
  };
  sandbox.window = { fetch: async () => ({}), WebSocket: undefined };
  sandbox.document = { documentElement: null };
  sandbox.location = { href: 'https://chatgpt.com/', hostname: 'chatgpt.com' };
  sandbox.MutationObserver = class { observe() {} disconnect() {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: sourcePath });
  return sandbox.__ASI_TEST__;
}

function replay(file) {
  const capture = JSON.parse(fs.readFileSync(file, 'utf8'));
  const api = makeRuntime();

  for (const event of capture.events || []) {
    const at = event.at || new Date().toISOString();
    const raw = event.raw;
    if (raw?.data !== undefined && String(raw.url || '').includes('/backend-api/f/conversation')) {
      api.processProtocolData(raw.data, at);
    }
    if (String(event.kind || '').startsWith('WS:')) {
      api.processWebSocketProtocol(raw, at);
    }
  }

  return { capture, api };
}
function stats(api) {
  const messages = [...api.S.messages.values()].map(x => x.message);
  const interrupted = messages.filter(m =>
    m?.metadata?.finish_details?.type === 'interrupted' ||
    m?.metadata?.finish_details?.reason === 'client_stopped'
  ).length;
  const images = messages.filter(m => api.findImagePointers(m).length).length;
  const thoughts = messages.filter(m => m?.content?.content_type === 'thoughts').length;
  const calls = messages.filter(m => m?.author?.role === 'assistant' && m?.recipient && m.recipient !== 'all');
  const decodedCalls = calls.filter(m => {
    const info = api.describeToolMessage(m);
    return info.action && info.action !== 'call_tool' && info.label !== 'api_tool.call_tool';
  }).length;
  return { messages, interrupted, images, thoughts, calls: calls.length, decodedCalls };
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node tests/replay-captures.mjs <capture.json> [...]');
  process.exit(2);
}

let failed = false;
for (const file of files) {
  try {
    const { capture, api } = replay(file);
    const s = stats(api);
    assert(s.messages.length > 0, 'no messages reconstructed');

    const rawText = fs.readFileSync(file, 'utf8');
    if (rawText.includes('client_stopped')) assert(s.interrupted > 0, 'interruption was not reconstructed');
    if (rawText.includes('image_asset_pointer')) assert(s.images > 0, 'image result was not reconstructed');
    if (rawText.includes('"content_type": "thoughts"')) assert(s.thoughts > 0, 'thought summaries were not reconstructed');
    if (rawText.includes('api_tool.call_tool')) assert(s.decodedCalls > 0, 'tool calls remained entirely generic');

    const previous = capture.reconstructedMessages?.length || 0;
    if (previous) assert(s.messages.length >= previous, `replay lost messages (${s.messages.length} < ${previous})`);

    console.log(`PASS ${path.basename(file)} :: messages=${s.messages.length} tools=${s.calls}/${s.decodedCalls} images=${s.images} thoughts=${s.thoughts} interrupted=${s.interrupted}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${file}`);
    console.error(error.stack || error);
  }
}

if (failed) process.exit(1);
