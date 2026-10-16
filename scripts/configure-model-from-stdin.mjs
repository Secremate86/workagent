import { stdin, stdout, stderr } from 'node:process';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_INPUT_BYTES = 64 * 1024;

function safeText(value, apiKey = '') {
  let text = String(value ?? '');
  if (apiKey) text = text.split(apiKey).join('[redacted]');
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240);
}

function validateHttpUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a complete HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be an HTTP(S) URL without credentials, query, or fragment`);
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

async function fetchJson(url, options, apiKey = '') {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error('request timed out after 30 seconds');
    }
    throw new Error(`request failed: ${safeText(error?.message, apiKey)}`);
  }
  if (!response.ok) throw new Error(`request failed with HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error('server returned invalid JSON');
  }
}

async function readInputLine() {
  if (stdin.isTTY) {
    stdin.setRawMode(true);
    stdout.write('Ready for model configuration JSON on stdin (input is hidden).\n');
  }
  stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of stdin) {
    input += chunk;
    if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) throw new Error('stdin JSON is too large');
    const newline = input.search(/[\r\n]/);
    if (newline >= 0) {
      if (stdin.isTTY) stdin.setRawMode(false);
      return input.slice(0, newline).trim();
    }
  }
  return input.trim();
}

function getModelId(model) {
  return model && typeof model === 'object' && typeof model.id === 'string' ? model.id.trim() : '';
}

function chooseModel(models, modelMatch, apiKey) {
  if (!Array.isArray(models)) throw new Error('upstream /models response has no data array');
  const extra = typeof modelMatch === 'string' ? modelMatch.trim().toLowerCase() : '';
  const matches = models.filter(model => {
    const id = getModelId(model);
    if (!id) return false;
    const searchable = `${id} ${typeof model.name === 'string' ? model.name : ''}`.toLowerCase();
    const required = ['deepseek', 'v4.1', 'flash'].every(term => searchable.includes(term));
    return required && (!extra || searchable.includes(extra));
  });

  if (matches.length === 0) throw new Error('no model matched deepseek + v4.1 + flash');
  if (matches.length > 1) {
    const ids = matches.map(getModelId).map(id => safeText(id, apiKey));
    throw new Error(`multiple matching model IDs; set modelMatch to narrow the selection: ${ids.join(', ')}`);
  }
  return getModelId(matches[0]);
}

let secretForRedaction = '';

async function main() {
  const line = await readInputLine();
  if (!line) throw new Error('stdin must contain one JSON line');
  let input;
  try {
    input = JSON.parse(line);
  } catch {
    throw new Error('stdin line is not valid JSON');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('stdin JSON must be an object');

  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!apiKey || /[\r\n\0]/.test(apiKey)) throw new Error('apiKey is missing or invalid');
  secretForRedaction = apiKey;
  const upstreamBase = validateHttpUrl(input.baseUrl, 'baseUrl');
  const workagentBase = validateHttpUrl(input.workagentUrl || 'http://127.0.0.1:30141', 'workagentUrl');
  const modelsUrl = new URL(`${upstreamBase.href.replace(/\/$/, '')}/models`);

  const modelsResponse = await fetchJson(modelsUrl, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  }, apiKey);
  const modelId = chooseModel(modelsResponse?.data, input.modelMatch, apiKey);
  stdout.write(`Matched model ID: ${safeText(modelId, apiKey)}\n`);

  const completionUrl = new URL(`${upstreamBase.href.replace(/\/$/, '')}/chat/completions`);
  const startedAt = Date.now();
  const completion = await fetchJson(completionUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: 'Reply with exactly: connected' }],
      max_tokens: 64,
      stream: false,
    }),
  }, apiKey);
  const latencyMs = Date.now() - startedAt;
  const responseText = completion?.choices?.[0]?.message?.content;
  if (typeof responseText !== 'string' || !responseText.trim()) {
    throw new Error('upstream returned no text for the connectivity prompt');
  }

  const configUrl = new URL('/api/workagent/model', workagentBase);
  await fetchJson(configUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      baseUrl: upstreamBase.href.replace(/\/$/, ''),
      apiKey,
      modelId,
      api: 'openai-completions',
    }),
  }, apiKey);

  stdout.write(`${JSON.stringify({
    success: true,
    latencyMs,
    modelId: safeText(modelId, apiKey),
    responseText: safeText(responseText, apiKey),
  })}\n`);
}

main().catch(error => {
  stderr.write(`Error: ${safeText(error?.message || 'configuration failed', secretForRedaction)}\n`);
  process.exitCode = 1;
});
