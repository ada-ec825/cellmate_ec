// Model clients for the evaluation harness.
//
// Model resolution is deliberately split from client construction. Runners
// resolve every spec before freezing their input manifest, record only the
// non-secret descriptor, and pass the private resolution back when the client
// is eventually constructed. This binds the actual endpoint used without
// ever serialising an API key.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalObject(value) {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
  );
}

function generationPayload(model, prompt, { temperature = 0.7, seed, think, numPredict } = {}) {
  return {
    model,
    prompt,
    stream: false,
    ...(think !== undefined ? { think } : {}),
    options: {
      temperature,
      ...(seed !== undefined ? { seed } : {}),
      ...(numPredict !== undefined ? { num_predict: numPredict } : {}),
    },
  };
}

function openAIChatPayload(model, prompt, { temperature = 0.7, seed, numPredict } = {}) {
  return {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature,
    stream: false,
    store: false,
    ...(seed !== undefined ? { seed } : {}),
    ...(numPredict !== undefined ? { max_tokens: numPredict } : {}),
  };
}

function openAIResponsesPayload(model, prompt, { temperature = 0.7, numPredict } = {}) {
  return {
    model,
    input: prompt,
    temperature,
    store: false,
    ...(numPredict !== undefined ? { max_output_tokens: numPredict } : {}),
  };
}

function responseMetadata(value = {}) {
  return {
    promptTokens: value.prompt_eval_count ?? value.usage?.prompt_tokens ?? 'unknown/not captured',
    completionTokens:
      value.eval_count ?? value.usage?.completion_tokens ?? 'unknown/not captured',
    backendModel: value.model ?? 'unknown/not captured',
    systemFingerprint: value.system_fingerprint ?? 'unknown/not captured',
    finishReason: value.choices?.[0]?.finish_reason ?? 'unknown/not captured',
  };
}

/** Normalise the Ollama/OpenWebUI response while retaining available counts. */
function parseGenerationResponse(data) {
  if (data && typeof data === 'object' && !Buffer.isBuffer(data)) {
    const text = data.response ?? data.choices?.[0]?.message?.content;
    if (typeof text === 'string') return { text, metadata: responseMetadata(data) };
  }

  let text = '';
  let metadata = responseMetadata();
  for (const line of String(data ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (typeof item.response === 'string') text += item.response;
      const next = responseMetadata(item);
      if (next.promptTokens !== 'unknown/not captured') metadata.promptTokens = next.promptTokens;
      if (next.completionTokens !== 'unknown/not captured') metadata.completionTokens = next.completionTokens;
      if (next.backendModel !== 'unknown/not captured') metadata.backendModel = next.backendModel;
    } catch {
      // Non-JSON transport material is not a model reply.
    }
  }
  return { text, metadata };
}

function parseOpenAIResponsesResponse(data) {
  if (!data || typeof data !== 'object' || Buffer.isBuffer(data)) {
    return { text: '', metadata: responseMetadata() };
  }
  const text = typeof data.output_text === 'string'
    ? data.output_text
    : (Array.isArray(data.output) ? data.output : [])
      .filter((item) => item?.type === 'message' && Array.isArray(item.content))
      .flatMap((item) => item.content)
      .filter((item) => item?.type === 'output_text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('');
  return {
    text,
    metadata: {
      promptTokens: data.usage?.input_tokens ?? 'unknown/not captured',
      completionTokens: data.usage?.output_tokens ?? 'unknown/not captured',
      backendModel: data.model ?? 'unknown/not captured',
      systemFingerprint: 'unknown/not captured',
      finishReason: data.status === 'incomplete'
        ? data.incomplete_details?.reason ?? 'incomplete'
        : data.status ?? 'unknown/not captured',
      responseId: data.id ?? 'unknown/not captured',
    },
  };
}

function openWebUISettings() {
  const settingsPath = path.resolve(__dirname, '..', '..', '.vscode', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  return {
    endpoint: settings['CellMate.apiUrl'],
    apiKey: settings['CellMate.apiKey'],
    defaultModel: settings['CellMate.modelName'],
  };
}

function descriptorFor({ backend, model, endpoint, credentialReferenceName }) {
  const transportPayloadSemantics = backend === 'openai-responses'
    ? 'POST input to the OpenAI Responses API with explicit temperature, max_output_tokens and store=false; the API exposes no sampling seed field'
    : backend === 'openai'
    ? 'POST one user message to the OpenAI Chat Completions API with explicit temperature, seed, max_tokens, stream=false and store=false'
    : 'POST an Ollama-compatible generate payload with explicit decoding options; optional think and num_predict are recorded by each run';
  const responseSemantics = backend === 'openai-responses'
    ? 'output_text content plus whitelisted model, input/output token counts, status, response-id and request-id metadata'
    : backend === 'openai'
    ? 'choices[0].message.content plus whitelisted model, token-count, finish-reason, system-fingerprint and request-id metadata'
    : 'response text plus prompt_eval_count/eval_count when supplied; absent metadata is unknown/not captured';
  const descriptor = {
    backend,
    identifier: model,
    endpointSha256: sha256(endpoint),
    credentialReferenceName,
    transportPayloadSemantics,
    responseSemantics,
  };
  return {
    ...descriptor,
    nonSecretConfigSha256: sha256(canonicalObject(descriptor)),
  };
}

function validateModelResolution(resolution) {
  if (!resolution || typeof resolution.spec !== 'string' || !resolution.descriptor || !resolution.connection) {
    throw new Error('invalid frozen model resolution');
  }
  const descriptor = resolution.descriptor;
  const connection = resolution.connection;
  if (!['ollama', 'openwebui', 'openai', 'openai-responses'].includes(connection.backend)) {
    throw new Error(`unsupported frozen model backend ${String(connection.backend)}`);
  }
  const expectedBackend = resolution.spec.startsWith('openwebui:')
    ? 'openwebui'
    : resolution.spec.startsWith('openai-responses:')
      ? 'openai-responses'
    : resolution.spec.startsWith('openai:')
      ? 'openai'
      : 'ollama';
  const expectedModel = resolution.spec.startsWith(`${expectedBackend}:`)
    ? resolution.spec.slice(`${expectedBackend}:`.length)
    : resolution.spec;
  if (
    connection.backend !== expectedBackend ||
    descriptor.backend !== connection.backend ||
    descriptor.identifier !== connection.model ||
    connection.model !== expectedModel
  ) {
    throw new Error(`frozen model resolution backend/model mismatch for ${resolution.spec}`);
  }
  if (typeof connection.endpoint !== 'string') throw new Error('frozen model endpoint is missing');
  const endpoint = new URL(connection.endpoint);
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('frozen model endpoint must be credential-free HTTP(S) configuration');
  }
  if (descriptor.endpointSha256 !== sha256(connection.endpoint)) {
    throw new Error(`frozen model endpoint hash mismatch for ${resolution.spec}`);
  }
  const { nonSecretConfigSha256, ...descriptorPayload } = descriptor;
  if (nonSecretConfigSha256 !== sha256(canonicalObject(descriptorPayload))) {
    throw new Error(`frozen model non-secret descriptor hash mismatch for ${resolution.spec}`);
  }
  if (['openwebui', 'openai', 'openai-responses'].includes(connection.backend)) {
    if (
      typeof connection.apiKey !== 'string' ||
      connection.apiKey.length === 0 ||
      typeof descriptor.credentialReferenceName !== 'string' ||
      descriptor.credentialReferenceName.length === 0 ||
      descriptor.credentialReferenceName === 'none'
    ) {
      throw new Error(`${connection.backend} resolution must have a private key and non-secret credential reference`);
    }
    if (['openai', 'openai-responses'].includes(connection.backend) && descriptor.credentialReferenceName !== 'env:OPENAI_API_KEY') {
      throw new Error('OpenAI resolution must reference the process environment credential');
    }
  } else if (
    (connection.apiKey !== null && connection.apiKey !== undefined) ||
    descriptor.credentialReferenceName !== 'none'
  ) {
    throw new Error('Ollama resolution must be credential-free');
  }
  const expectedDescriptor = descriptorFor({
    backend: connection.backend,
    model: connection.model,
    endpoint: connection.endpoint,
    credentialReferenceName: descriptor.credentialReferenceName,
  });
  if (canonicalObject(descriptor) !== canonicalObject(expectedDescriptor)) {
    throw new Error(`frozen model descriptor contains unbound or altered fields for ${resolution.spec}`);
  }
  return resolution;
}

/**
 * Resolve one explicit model spec. `descriptor` is safe for a manifest;
 * `connection` is private runtime state and must never be serialised.
 */
function resolveModelSpec(spec, options = {}) {
  if (typeof spec !== 'string' || spec.length === 0) throw new Error('model spec must be non-empty');
  if (spec.startsWith('openwebui:')) {
    const model = spec.slice('openwebui:'.length);
    const settings = options.openWebUISettings ?? openWebUISettings();
    if (!settings.endpoint || !settings.apiKey || !model) throw new Error('CellMate api settings missing');
    return {
      spec,
      descriptor: descriptorFor({
        backend: 'openwebui',
        model,
        endpoint: settings.endpoint,
        credentialReferenceName: '.vscode/settings.json:CellMate.apiKey',
      }),
      connection: { backend: 'openwebui', model, endpoint: settings.endpoint, apiKey: settings.apiKey },
    };
  }

  if (spec.startsWith('openai:')) {
    const model = spec.slice('openai:'.length);
    const apiKey = options.openAIApiKey ?? process.env.OPENAI_API_KEY;
    const baseUrl = options.openAIBaseUrl ?? DEFAULT_OPENAI_BASE_URL;
    if (!model) throw new Error('openai model spec must name a model');
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      throw new Error('OPENAI_API_KEY is unavailable in this process');
    }
    const endpoint = `${String(baseUrl).replace(/\/$/, '')}/chat/completions`;
    return {
      spec,
      descriptor: descriptorFor({
        backend: 'openai',
        model,
        endpoint,
        credentialReferenceName: 'env:OPENAI_API_KEY',
      }),
      connection: { backend: 'openai', model, endpoint, apiKey },
    };
  }

  if (spec.startsWith('openai-responses:')) {
    const model = spec.slice('openai-responses:'.length);
    const apiKey = options.openAIApiKey ?? process.env.OPENAI_API_KEY;
    const baseUrl = options.openAIBaseUrl ?? DEFAULT_OPENAI_BASE_URL;
    if (!model) throw new Error('openai responses model spec must name a model');
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      throw new Error('OPENAI_API_KEY is unavailable in this process');
    }
    const endpoint = `${String(baseUrl).replace(/\/$/, '')}/responses`;
    return {
      spec,
      descriptor: descriptorFor({
        backend: 'openai-responses',
        model,
        endpoint,
        credentialReferenceName: 'env:OPENAI_API_KEY',
      }),
      connection: { backend: 'openai-responses', model, endpoint, apiKey },
    };
  }

  const model = spec.startsWith('ollama:') ? spec.slice('ollama:'.length) : spec;
  if (!model) throw new Error('ollama model spec must name a model');
  const root = options.ollamaUrl ?? process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL;
  const endpoint = `${String(root).replace(/\/$/, '')}/api/generate`;
  return {
    spec,
    descriptor: descriptorFor({
      backend: 'ollama',
      model,
      endpoint,
      credentialReferenceName: 'none',
    }),
    connection: { backend: 'ollama', model, endpoint, apiKey: null },
  };
}

function clientFromResolution(
  resolution,
  { temperature = 0.7, seed, think, numPredict, timeoutMs = 300_000 } = {}
) {
  validateModelResolution(resolution);
  const { backend, model, endpoint, apiKey } = resolution.connection;
  const askDetailed = async (prompt) => {
    try {
      const response = await axios.post(
        endpoint,
        backend === 'openai-responses'
          ? openAIResponsesPayload(model, prompt, { temperature, numPredict })
          : backend === 'openai'
          ? openAIChatPayload(model, prompt, { temperature, seed, numPredict })
          : generationPayload(model, prompt, { temperature, seed, think, numPredict }),
        {
          ...(['openwebui', 'openai', 'openai-responses'].includes(backend)
            ? { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` } }
            : {}),
          timeout: timeoutMs,
        }
      );
      const parsed = backend === 'openai-responses'
        ? parseOpenAIResponsesResponse(response.data)
        : parseGenerationResponse(response.data);
      if (['openai', 'openai-responses'].includes(backend)) {
        parsed.metadata.requestId = response.headers?.['x-request-id'] ?? 'unknown/not captured';
      }
      return parsed;
    } catch (error) {
      const status = Number.isInteger(error?.response?.status) ? error.response.status : null;
      const code = typeof error?.code === 'string' ? error.code : null;
      const requestId = error?.response?.headers?.['x-request-id'] ?? null;
      const retryAfterSeconds = Number.parseFloat(error?.response?.headers?.['retry-after']);
      const safe = new Error([
        `${backend} model request failed`,
        status === null ? null : `status=${status}`,
        code === null ? null : `code=${code}`,
        requestId === null ? null : `request_id=${requestId}`,
      ].filter(Boolean).join(' '));
      safe.name = 'ModelTransportError';
      safe.status = status;
      safe.code = code;
      safe.requestId = requestId;
      safe.retryAfterMilliseconds = Number.isFinite(retryAfterSeconds)
        ? Math.max(1_000, Math.ceil(retryAfterSeconds * 1000))
        : null;
      safe.safeForLog = true;
      throw safe;
    }
  };
  return {
    id: `${backend}:${model}`,
    askDetailed,
    ask: async (prompt) => (await askDetailed(prompt)).text,
  };
}

async function inspectResolvedModel(resolution, { timeoutMs = 5000 } = {}) {
  validateModelResolution(resolution);
  const { backend, model, endpoint, apiKey } = resolution.connection;
  try {
    if (['openai', 'openai-responses'].includes(backend)) {
      const endpointUrl = new URL(endpoint);
      endpointUrl.pathname = endpointUrl.pathname.replace(
        /\/(?:chat\/completions|responses)\/?$/,
        `/models/${encodeURIComponent(model)}`,
      );
      const response = await axios.get(endpointUrl.toString(), {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: timeoutMs,
      });
      return {
        backend,
        id: response.data?.id ?? null,
        object: response.data?.object ?? null,
        created: response.data?.created ?? null,
        ownedBy: response.data?.owned_by ?? null,
        requestId: response.headers?.['x-request-id'] ?? 'unknown/not captured',
      };
    }

    const origin = new URL(endpoint).origin;
    const response = await axios.get(`${origin}/api/tags`, {
      ...(backend === 'openwebui' ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
      timeout: timeoutMs,
    });
    return (response.data?.models ?? []).find((item) => item.name === model || item.model === model) ?? null;
  } catch (error) {
    const status = Number.isInteger(error?.response?.status) ? error.response.status : null;
    const code = typeof error?.code === 'string' ? error.code : null;
    const requestId = error?.response?.headers?.['x-request-id'] ?? null;
    const safe = new Error([
      `${backend} model identity check failed`,
      status === null ? null : `status=${status}`,
      code === null ? null : `code=${code}`,
      requestId === null ? null : `request_id=${requestId}`,
    ].filter(Boolean).join(' '));
    safe.name = 'ModelTransportError';
    safe.status = status;
    safe.code = code;
    safe.requestId = requestId;
    safe.safeForLog = true;
    throw safe;
  }
}

/** A local Ollama model. `options` maps to Ollama's sampling settings. */
function ollamaClient(model, opts = {}) {
  return clientFromResolution(resolveModelSpec(`ollama:${model}`), opts);
}

/** The departmental Open WebUI service, configured like the extension itself. */
function openWebUIClient(modelOverride, opts = {}) {
  const settings = openWebUISettings();
  const model = modelOverride || settings.defaultModel;
  return clientFromResolution(
    resolveModelSpec(`openwebui:${model}`, { openWebUISettings: settings }),
    opts
  );
}

/** Explicit backend prefix, or bare name -> Ollama. */
function clientFromSpec(spec, opts, frozenResolution = null) {
  const resolution = frozenResolution ?? resolveModelSpec(spec);
  if (resolution.spec !== spec) throw new Error(`frozen model resolution mismatch for ${spec}`);
  return clientFromResolution(resolution, opts);
}

/** Which local models are actually pulled (empty if Ollama is not running). */
async function listOllamaModels() {
  try {
    const root = String(process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
    const response = await axios.get(`${root}/api/tags`, { timeout: 3000 });
    return (response.data?.models ?? []).map((model) => model.name);
  } catch {
    return [];
  }
}

module.exports = {
  clientFromResolution,
  clientFromSpec,
  generationPayload,
  inspectResolvedModel,
  listOllamaModels,
  ollamaClient,
  openAIChatPayload,
  openAIResponsesPayload,
  openWebUIClient,
  parseGenerationResponse,
  parseOpenAIResponsesResponse,
  resolveModelSpec,
  validateModelResolution,
};
