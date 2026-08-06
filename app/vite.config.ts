import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
// SQLite integrado de Node (>= 22.5) — sin dependencias nativas
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { exec } from 'node:child_process'

// ---------------------------------------------------------------------------
// Ledger: persistencia REAL en disco (alecaframe-api/ledger.db) para el
// historial de flips y los cost basis. El frontend usa localStorage como
// cache viva y espeja acá; si limpiás el navegador, esto lo restaura.
// ---------------------------------------------------------------------------
function ledgerPlugin(): Plugin {
  return {
    name: 'ledger',
    configureServer(server) {
      const dbPath = fileURLToPath(new URL('../ledger.db', import.meta.url))
      const db = new DatabaseSync(dbPath)
      db.exec(`
        CREATE TABLE IF NOT EXISTS flips (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item TEXT NOT NULL,
          buy REAL NOT NULL,
          sell REAL NOT NULL,
          ts INTEGER NOT NULL,
          UNIQUE(item, ts)
        );
        CREATE TABLE IF NOT EXISTS cost_basis (
          order_id TEXT PRIMARY KEY,
          cost REAL NOT NULL,
          item TEXT NOT NULL,
          ts INTEGER NOT NULL
        );
      `)

      const readBody = (req: import('http').IncomingMessage): Promise<unknown> =>
        new Promise(resolve => {
          let raw = ''
          req.on('data', c => { raw += c })
          req.on('end', () => {
            try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) }
          })
        })

      server.middlewares.use('/ledger', (req, res) => {
        void (async () => {
          const url = req.url ?? '/'
          const send = (code: number, body: unknown) => {
            res.statusCode = code
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(body))
          }
          try {
            if (req.method === 'GET' && url.startsWith('/all')) {
              const flips = db.prepare('SELECT item, buy, sell, ts FROM flips ORDER BY ts').all()
              const basisRows = db.prepare('SELECT order_id, cost, item, ts FROM cost_basis').all() as
                { order_id: string; cost: number; item: string; ts: number }[]
              const basis: Record<string, { cost: number; item: string; ts: number }> = {}
              for (const b of basisRows) basis[b.order_id] = { cost: b.cost, item: b.item, ts: b.ts }
              return send(200, { flips, basis })
            }
            if (req.method === 'POST' && url.startsWith('/flip')) {
              const f = await readBody(req) as { item?: string; buy?: number; sell?: number; ts?: number }
              if (!f.item || f.buy == null || f.sell == null || !f.ts) return send(400, { error: 'bad flip' })
              db.prepare('INSERT OR IGNORE INTO flips (item, buy, sell, ts) VALUES (?, ?, ?, ?)')
                .run(f.item, f.buy, f.sell, f.ts)
              return send(200, { ok: true })
            }
            if (req.method === 'POST' && url.startsWith('/basis')) {
              const b = await readBody(req) as { orderId?: string; cost?: number; item?: string; ts?: number }
              if (!b.orderId || b.cost == null) return send(400, { error: 'bad basis' })
              db.prepare('INSERT OR REPLACE INTO cost_basis (order_id, cost, item, ts) VALUES (?, ?, ?, ?)')
                .run(b.orderId, b.cost, b.item ?? '', b.ts ?? Date.now())
              return send(200, { ok: true })
            }
            if (req.method === 'DELETE' && url.startsWith('/basis/')) {
              db.prepare('DELETE FROM cost_basis WHERE order_id = ?').run(url.slice('/basis/'.length))
              return send(200, { ok: true })
            }
            send(404, { error: 'not found' })
          } catch (e) {
            send(500, { error: String(e) })
          }
        })()
      })
    },
  }
}

// ---------------------------------------------------------------------------
// ¿Warframe abierto? Solo mira la lista de procesos de Windows (tasklist) —
// nada de leer memoria del juego ni sus archivos internos. Lo usa el
// frontend para decidir cuándo pedirle a warframe.market "estoy in game".
// ---------------------------------------------------------------------------
function gameStatusPlugin(): Plugin {
  return {
    name: 'game-status',
    configureServer(server) {
      server.middlewares.use('/game/status', (_req, res) => {
        exec('tasklist /FI "IMAGENAME eq Warframe.x64.exe" /NH', (_err, stdout = '') => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ running: stdout.toLowerCase().includes('warframe.x64.exe') }))
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), ledgerPlugin(), gameStatusPlugin()],
  server: {
    proxy: {
      // La API de warframe.market no manda CORS: la proxeamos same-origin.
      '/wfm': {
        target: 'https://api.warframe.market',
        changeOrigin: true,
        rewrite: p => p.replace(/^\/wfm/, ''),
      },
    },
  },
})
