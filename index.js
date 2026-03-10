const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js')
const { Pool } = require('pg')
const { z } = require('zod')
const http = require('http')

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})
const transports = {}

function makeServer() {
  const server = new McpServer({ name: 'open-brain', version: '2.0.0' })

  server.tool('search_memory', {
    query: z.string(),
    limit: z.number().optional(),
  }, async ({ query, limit = 6 }) => {
    const embRes = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: query })
    })
    const embedding = (await embRes.json()).data[0].embedding
    const { rows } = await db.query(
      `SELECT content, metadata, created_at, confidence,
              1 - (embedding <=> $1::vector) AS similarity
       FROM memories
       WHERE confidence > 0.4 AND tier = 'working'
       ORDER BY similarity DESC LIMIT $2`,
      [JSON.stringify(embedding), limit]
    )
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] }
  })

  server.tool('list_recent', {
    limit: z.number().optional()
  }, async ({ limit = 10 }) => {
    const { rows } = await db.query(
      `SELECT content, metadata, created_at, confidence
       FROM memories WHERE tier = 'working'
       ORDER BY created_at DESC LIMIT $1`, [limit]
    )
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] }
  })

  server.tool('get_stats', {}, async () => {
    const { rows } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE tier='working') AS working_count,
        COUNT(*) FILTER (WHERE tier='archive') AS archive_count,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS last_7_days,
        ROUND(AVG(confidence)::numeric, 2) AS avg_confidence
      FROM memories
    `)
    return { content: [{ type: 'text', text: JSON.stringify(rows[0], null, 2) }] }
  })

  server.tool('get_review_queue', {
    limit: z.number().optional()
  }, async ({ limit = 5 }) => {
    const { rows } = await db.query(
      `SELECT content, metadata, confidence, created_at
       FROM memories WHERE confidence < 0.6
       ORDER BY created_at DESC LIMIT $1`, [limit]
    )
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] }
  })

  return server
}

const httpServer = http.createServer(async (req, res) => {
  console.log(req.method + ' ' + req.url)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  if (req.url === '/health') {
    res.writeHead(200)
    res.end('ok')
    return
  }

  if (req.method === 'GET' && req.url.startsWith('/search')) {
    const url = new URL(req.url, 'http://localhost')
    const query = url.searchParams.get('q')
    if (!query) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ memories: [] }))
      return
    }
    try {
      const { rows } = await db.query(
        'SELECT content, metadata, confidence FROM memories ORDER BY created_at DESC LIMIT 1000'
      )
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ memories: rows.map(r => ({
        content: r.content,
        metadata: r.metadata,
        confidence: r.confidence
      }))}))
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ memories: [], error: e.message }))
    }
    return
  }

  if (req.method === 'GET' && req.url === '/sse') {
    console.log('New SSE connection')
    try {
      const server = makeServer()
      const transport = new SSEServerTransport('/messages', res)
      transports[transport.sessionId] = transport
      res.on('close', () => {
        console.log('SSE closed: ' + transport.sessionId)
        delete transports[transport.sessionId]
      })
      await server.connect(transport)
      console.log('SSE connected: ' + transport.sessionId)
    } catch (e) {
      console.error('SSE error: ' + e.message)
    }
    return
  }

  if (req.method === 'POST' && req.url.startsWith('/messages')) {
    const url = new URL(req.url, 'http://localhost')
    const sessionId = url.searchParams.get('sessionId')
    const transport = transports[sessionId]
    if (!transport) {
      res.writeHead(404)
      res.end('Session not found')
      return
    }
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', async () => {
      try {
        await transport.handlePostMessage(req, res, JSON.parse(body))
      } catch (e) {
        console.error('Message error: ' + e.message)
        res.writeHead(500)
        res.end('Error')
      }
    })
    return
  }

  res.writeHead(404)
  res.end('not found')
})

const PORT = process.env.PORT || 3000
httpServer.listen(PORT, () => console.log('Open Brain MCP server running on port ' + PORT))
