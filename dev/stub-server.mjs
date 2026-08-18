// Zero-dependency stub of OpenAI-compatible + Anthropic endpoints for local
// development/testing without an API key or network. Deterministic models:
//   stub-echo      -> echoes the prompt
//   stub-uppercase -> uppercases the prompt
//   stub-reverse   -> reverses the prompt
//   stub-fail      -> always returns HTTP 500
//   stub-flaky     -> returns HTTP 503 twice, then behaves like stub-echo
// Run: npm run stub  (default http://localhost:8787/v1, override PORT)
import http from 'node:http'

const PORT = Number(process.env.PORT || 8787)

const MODELS = [
  { id: 'stub-echo', name: 'Stub Echo', context_length: 32768, pricing: { prompt: '0.0000002', completion: '0.0000008' } },
  { id: 'stub-uppercase', name: 'Stub Uppercase', context_length: 32768, pricing: { prompt: '0.0000001', completion: '0.0000004' } },
  { id: 'stub-reverse', name: 'Stub Reverse', context_length: 32768, pricing: { prompt: '0.0000003', completion: '0.0000009' } },
  { id: 'stub-fail', name: 'Stub Always Fails', context_length: 32768, pricing: { prompt: '0.0000001', completion: '0.0000002' } },
  { id: 'stub-flaky', name: 'Stub Flaky (503 twice)', context_length: 32768, pricing: { prompt: '0.0000002', completion: '0.0000008' } },
]

let flakyHits = 0

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function render(modelId, prompt) {
  if (modelId === 'stub-uppercase') return prompt.toUpperCase()
  if (modelId === 'stub-reverse') return [...prompt].reverse().join('')
  return prompt
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS })
  res.end(JSON.stringify(payload))
}

/** OpenAI-compatible SSE streaming, token by token. */
function streamOpenAI(res, body) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...CORS })
  const text = render(String(body?.model || 'stub-echo'), extractPrompt(body, 'openai'))
  const words = text.length ? text.match(/.\s?/g) || [text] : []
  let i = 0
  const timer = setInterval(() => {
    if (i >= words.length) {
      clearInterval(timer)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: text.length, completion_tokens: text.length, total_tokens: text.length * 2 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: words[i] } }] })}\n\n`)
    i++
  }, 12)
}

function extractPrompt(body, kind) {
  if (kind === 'anthropic') {
    return Array.isArray(body?.messages) ? String(body.messages[0]?.content || '') : ''
  }
  return (body?.messages || []).filter(m => m.role === 'user').map(m => Array.isArray(m.content) ? m.content.map(p => p.text || '').join('') : m.content).join('\n')
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    res.end()
    return
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    // Every e2e test starts with "Load models", so this is the per-test-session
    // boundary: reset the flaky counter here so a reused warm server (Playwright
    // reuseExistingServer) cannot leak retry state between tests.
    flakyHits = 0
    json(res, 200, { data: MODELS })
    return
  }

  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/messages')) {
    const isAnthropic = url.pathname === '/v1/messages'
    const body = await readBody(req).catch(() => ({}))
    const model = String(body?.model || 'stub-echo')
    if (!MODELS.some(m => m.id === model)) {
      json(res, 404, { error: { message: `unknown stub model: ${model}` } })
      return
    }
    if (model === 'stub-fail') {
      json(res, 500, { error: { message: 'stub model always fails (as configured)' } })
      return
    }
    if (model === 'stub-flaky') {
      flakyHits++
      if (flakyHits <= 2) {
        json(res, 503, { error: { message: `flaky stub (attempt ${flakyHits})` } })
        return
      }
      // Third try succeeds and falls through to the normal path.
    }

    if (body.stream) {
      streamOpenAI(res, body)
      return
    }

    await new Promise(r => setTimeout(r, 150 + Math.random() * 300))
    const text = render(model, extractPrompt(body, isAnthropic ? 'anthropic' : 'openai'))

    if (isAnthropic) {
      json(res, 200, {
        id: 'msg_stub_1',
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text }],
        usage: { input_tokens: promptLen(body), output_tokens: text.length },
      })
      return
    }
    json(res, 200, {
      id: 'chatcmpl_stub_1',
      object: 'chat.completion',
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: promptLen(body), completion_tokens: text.length, total_tokens: promptLen(body) + text.length },
    })
    return
  }

  json(res, 404, { error: { message: `no stub route for ${req.method} ${url.pathname}` } })
})

function promptLen(body) {
  return String(extractPrompt(body, 'openai')).length
}

server.listen(PORT, () => {
  console.log(`[stub] OpenAI-compatible + Anthropic stub up → http://localhost:${PORT}/v1`)
})
