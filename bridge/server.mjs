#!/usr/bin/env node
/**
 * workbuddy -> Codex Responses API bridge.
 *
 * Codex (>=0.141) only speaks the OpenAI Responses API, while the workbuddy
 * gateway (http://100.104.227.113:7863/v1) only serves chat completions.
 * This server accepts POST /v1/responses from Codex, translates it to
 * /v1/chat/completions upstream, and translates the streamed result back
 * into Responses API SSE events.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.BRIDGE_PORT || 8799);
const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const UPSTREAM = (process.env.WORKBUDDY_BASE_URL || 'http://100.104.227.113:7863/v1').replace(/\/+$/, '');
const FALLBACK_KEY = process.env.WORKBUDDY_API_KEY || '';
const DEBUG = process.env.BRIDGE_DEBUG === '1';

const log = (...a) => { if (DEBUG) console.error(new Date().toISOString(), ...a); };

function parseUpstream(url) {
  const u = new URL(url);
  return { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), protocol: u.protocol, path: u.pathname.replace(/\/+$/, '') };
}

function upstreamRequest(pathname, { method = 'POST', headers = {}, body }) {
  const u = parseUpstream(UPSTREAM);
  const mod = u.protocol === 'https:' ? http : http;
  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: u.hostname, port: u.port, path: u.path + pathname, method,
      headers: Object.assign({ 'content-type': 'application/json' }, headers),
    }, (res) => resolve(res));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function textFromContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  const parts = [];
  for (const p of content) {
    if (typeof p === 'string') { parts.push(p); continue; }
    if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text' || p.type === 'summary_text') {
      parts.push(p.text || '');
    }
  }
  return parts.join('');
}

function contentToChat(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  const parts = [];
  for (const p of content) {
    if (typeof p === 'string') { parts.push({ type: 'text', text: p }); continue; }
    if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') parts.push({ type: 'text', text: p.text || '' });
    else if (p.type === 'input_image') {
      const url = p.image_url || p.url;
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  if (parts.length === 0) return '';
  if (parts.every((p) => p.type === 'text')) {
    const joined = parts.map((p) => p.text).join('');
    return joined;
  }
  return parts;
}

function outputToString(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map((o) => (typeof o === 'string' ? o : o.text || JSON.stringify(o))).join('');
  return JSON.stringify(output);
}

function buildMessages(body) {
  const msgs = [];
  if (body.instructions) msgs.push({ role: 'system', content: String(body.instructions) });
  let input = body.input;
  if (typeof input === 'string') input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input }] }];
  if (!Array.isArray(input)) input = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const type = item.type || (item.role ? 'message' : null);
    if (type === 'message') {
      const role = item.role === 'developer' ? 'system' : (item.role || 'user');
      msgs.push({ role, content: contentToChat(item.content) });
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      const args = type === 'custom_tool_call'
        ? JSON.stringify({ input: item.input ?? '' })
        : (typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}));
      msgs.push({
        role: 'assistant', content: null,
        tool_calls: [{ id: item.call_id || item.id || randomUUID(), type: 'function', function: { name: item.name, arguments: args } }],
      });
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      msgs.push({ role: 'tool', tool_call_id: item.call_id || item.id || '', content: outputToString(item.output) });
    }
    // reasoning / local_shell_call / web_search_call and friends are dropped on purpose
  }
  return msgs;
}

function buildTools(tools) {
  const out = [];
  const custom = new Set();
  for (const t of tools || []) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'function') {
      out.push({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } });
    } else if (t.type === 'custom') {
      custom.add(t.name);
      out.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: {
            type: 'object',
            properties: { input: { type: 'string', description: 'Raw tool input, passed through verbatim.' } },
            required: ['input'],
            additionalProperties: false,
          },
        },
      });
    }
  }
  return { tools: out, custom };
}

function buildChatBody(body, customTools) {
  const chat = {
    model: body.model,
    messages: buildMessages(body),
    stream: body.stream !== false,
  };
  const { tools } = buildTools(body.tools);
  if (tools.length) chat.tools = tools;
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (typeof tc === 'string') chat.tool_choice = tc;
    else if (tc && tc.type === 'function') chat.tool_choice = { type: 'function', function: { name: tc.name } };
    else if (tc && tc.type === 'custom') chat.tool_choice = { type: 'function', function: { name: tc.name } };
  }
  if (chat.tools && body.parallel_tool_calls !== undefined) chat.parallel_tool_calls = !!body.parallel_tool_calls;
  if (body.max_output_tokens) chat.max_tokens = body.max_output_tokens;
  if (body.reasoning && body.reasoning.effort) chat.reasoning_effort = body.reasoning.effort;
  if (chat.stream) chat.stream_options = { include_usage: true };
  for (const dead of ['store', 'previous_response_id', 'include', 'prompt_cache_key', 'text', 'truncation', 'metadata', 'safety_identifier']) {
    delete chat[dead];
  }
  return chat;
}

function newResponse(body, status) {
  return {
    id: 'resp_' + randomUUID().replace(/-/g, '').slice(0, 24),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    background: false,
    error: null,
    incomplete_details: null,
    instructions: body.instructions ?? null,
    max_output_tokens: body.max_output_tokens ?? null,
    model: body.model,
    output: [],
    parallel_tool_calls: body.parallel_tool_calls !== false,
    previous_response_id: null,
    reasoning: body.reasoning ?? null,
    store: false,
    temperature: body.temperature ?? null,
    text: body.text ?? { format: { type: 'text' } },
    tool_choice: body.tool_choice ?? 'auto',
    tools: (body.tools || []).map((t) => (t.type === 'custom' ? { type: 'function', name: t.name, description: t.description || '', parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } } : t)),
    top_p: body.top_p ?? null,
    truncation: 'disabled',
    usage: null,
    user: null,
    metadata: {},
  };
}

const sse = (res, event, data) => {
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify(data) + '\n\n');
};

async function handleResponses(req, res, raw) {
  const body = JSON.parse(raw);
  const wantStream = body.stream !== false;
  const { custom } = buildTools(body.tools);
  const chat = buildChatBody(body, custom);
  log('chat request', JSON.stringify(chat).slice(0, 4000));

  if (DEBUG) {
    try { (await import('node:fs')).appendFileSync('/tmp/bridge-debug.jsonl', JSON.stringify({ at: Date.now(), body }) + '\n'); } catch {}
  }

  const auth = req.headers['authorization'] || (FALLBACK_KEY ? 'Bearer ' + FALLBACK_KEY : '');
  const upstream = await upstreamRequest('/chat/completions', {
    headers: auth ? { authorization: auth } : {},
    body: JSON.stringify(chat),
  });

  if (upstream.statusCode >= 400) {
    const text = await new Promise((resolve) => { const c = []; upstream.on('data', (d) => c.push(d)); upstream.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); });
    log('upstream error', upstream.statusCode, text);
    const response = newResponse(body, 'failed');
    response.error = { code: 'upstream_error', message: 'upstream ' + upstream.statusCode + ': ' + text.slice(0, 2000) };
    if (!wantStream) { res.writeHead(upstream.statusCode, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: response.error })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    sse(res, 'response.created', { type: 'response.created', response });
    sse(res, 'response.failed', { type: 'response.failed', response });
    res.end();
    return;
  }

  if (!wantStream) {
    const text = await new Promise((resolve) => { const c = []; upstream.on('data', (d) => c.push(d)); upstream.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); });
    const out = JSON.parse(text);
    const msg = out.choices?.[0]?.message || {};
    const items = [];
    if (msg.content) items.push({ id: 'msg_' + randomUUID().replace(/-/g, '').slice(0, 20), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: msg.content, annotations: [] }] });
    for (const tc of msg.tool_calls || []) {
      let args = tc.function?.arguments || '{}';
      if (custom.has(tc.function?.name)) {
        let input = ''; try { input = JSON.parse(args).input || ''; } catch { input = args; }
        items.push({ id: 'ctc_' + randomUUID().replace(/-/g, '').slice(0, 20), type: 'custom_tool_call', status: 'completed', call_id: tc.id, name: tc.function.name, input });
      } else {
        items.push({ id: 'fc_' + randomUUID().replace(/-/g, '').slice(0, 20), type: 'function_call', status: 'completed', call_id: tc.id, name: tc.function.name, arguments: args });
      }
    }
    const response = newResponse(body, 'completed');
    response.output = items;
    response.usage = usageOf(out.usage);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const response = newResponse(body, 'in_progress');
  sse(res, 'response.created', { type: 'response.created', response: { ...response } });

  const output = [];
  let textItem = null;
  let textBuf = '';
  const callItems = new Map(); // index -> item
  let seq = 0;
  const nextIndex = (item) => { item.output_index = output.length; output.push(item); return item; };

  const flushTextItem = () => {
    if (!textItem) return;
    textItem.status = 'completed';
    textItem.content[0].text = textBuf;
    sse(res, 'response.output_text.done', { type: 'response.output_text.done', item_id: textItem.id, output_index: textItem.output_index, content_index: 0, text: textBuf });
    sse(res, 'response.content_part.done', { type: 'response.content_part.done', item_id: textItem.id, output_index: textItem.output_index, content_index: 0, part: textItem.content[0] });
    sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: textItem.output_index, item: textItem });
    textItem = null; textBuf = '';
  };

  let usage = null;
  let buffer = '';
  let pending = '';
  upstream.setEncoding('utf8');
  upstream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let chunkObj;
      try { chunkObj = JSON.parse(payload); } catch { continue; }
      if (chunkObj.usage) usage = chunkObj.usage;
      const choice = chunkObj.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};

      if (delta.content) {
        if (!textItem) {
          textItem = { id: 'msg_' + randomUUID().replace(/-/g, '').slice(0, 20), type: 'message', status: 'in_progress', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] };
          nextIndex(textItem);
          sse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: textItem.output_index, item: { ...textItem, content: [] } });
          sse(res, 'response.content_part.added', { type: 'response.content_part.added', item_id: textItem.id, output_index: textItem.output_index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        }
        textBuf += delta.content;
        sse(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: textItem.id, output_index: textItem.output_index, content_index: 0, delta: delta.content });
      }

      for (const tc of delta.tool_calls || []) {
        const idx = tc.index ?? 0;
        let item = callItems.get(idx);
        if (!item) {
          const isCustom = custom.has(tc.function?.name || '');
          item = {
            id: (isCustom ? 'ctc_' : 'fc_') + randomUUID().replace(/-/g, '').slice(0, 20),
            type: isCustom ? 'custom_tool_call' : 'function_call',
            status: 'in_progress',
            call_id: tc.id || 'call_' + randomUUID().replace(/-/g, '').slice(0, 20),
            name: tc.function?.name || '',
            ...(isCustom ? { input: '' } : { arguments: '' }),
          };
          if (textItem) flushTextItem();
          nextIndex(item);
          callItems.set(idx, item);
          const { output_index, ...rest } = item;
          sse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index, item: { ...rest, [isCustom ? 'input' : 'arguments']: '' } });
        }
        const frag = tc.function?.arguments;
        if (frag) {
          if (item.type === 'custom_tool_call') {
            if (tc.function?.name) item.name = tc.function.name;
            item.input += frag;
            sse(res, 'response.custom_tool_call_input.delta', { type: 'response.custom_tool_call_input.delta', item_id: item.id, output_index: item.output_index, delta: frag });
          } else {
            if (tc.function?.name && !item.name) item.name = tc.function.name;
            item.arguments += frag;
            sse(res, 'response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: item.output_index, delta: frag });
          }
        }
      }
    }
  });

  await new Promise((resolve) => {
    upstream.on('end', resolve);
    upstream.on('error', (e) => { log('stream error', e.message); resolve(); });
  });
  flushTextItem();
  for (const item of callItems.values()) {
    item.status = 'completed';
    if (item.type === 'custom_tool_call') {
      let input = item.input;
      try { const parsed = JSON.parse(input); if (parsed && typeof parsed.input === 'string') input = parsed.input; } catch {}
      item.input = input;
      sse(res, 'response.custom_tool_call_input.done', { type: 'response.custom_tool_call_input.done', item_id: item.id, output_index: item.output_index, input });
    } else {
      sse(res, 'response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: item.id, output_index: item.output_index, arguments: item.arguments });
    }
    sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: item.output_index, item });
  }

  response.status = 'completed';
  response.output = output;
  response.usage = usageOf(usage);
  sse(res, 'response.completed', { type: 'response.completed', response });
  res.end();
}

function usageOf(u) {
  const input = u?.prompt_tokens ?? 0;
  const output = u?.completion_tokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: u?.prompt_tokens_details?.cached_tokens ?? u?.cache_read_input_tokens ?? 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: u?.completion_tokens_details?.reasoning_tokens ?? u?.completion_thinking_tokens ?? 0 },
    total_tokens: u?.total_tokens ?? (input + output),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, upstream: UPSTREAM }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      const auth = req.headers['authorization'] || (FALLBACK_KEY ? 'Bearer ' + FALLBACK_KEY : '');
      const upstream = await upstreamRequest('/models', { method: 'GET', headers: auth ? { authorization: auth } : {} });
      const text = await new Promise((resolve) => { const c = []; upstream.on('data', (d) => c.push(d)); upstream.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); });
      res.writeHead(upstream.statusCode, { 'content-type': 'application/json' });
      res.end(text);
      return;
    }
    if (req.method === 'POST' && (req.url === '/v1/responses' || req.url === '/responses')) {
      const raw = await readBody(req);
      await handleResponses(req, res, raw);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found: ' + req.method + ' ' + req.url } }));
  } catch (e) {
    log('handler error', e.stack || e.message);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    try { res.end(JSON.stringify({ error: { message: String(e && e.message || e) } })); } catch {}
  }
});

server.listen(PORT, HOST, () => {
  console.log('codex-workbuddy-bridge listening on http://' + HOST + ':' + PORT + ' -> ' + UPSTREAM);
});
