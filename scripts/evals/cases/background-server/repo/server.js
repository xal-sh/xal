import { watchFile, writeFileSync } from "node:fs"
import { join } from "node:path"

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return new Response("healthy-4b71")
    }
    return new Response("Not found", { status: 404 })
  },
})

function stop() {
  writeFileSync(join(import.meta.dir, ".server.stopped"), String(process.pid))
  process.exit(0)
}

process.on("SIGINT", stop)
process.on("SIGTERM", stop)
await Bun.write(join(import.meta.dir, ".server.pid"), String(process.pid))
const portFile = join(import.meta.dir, ".server.port")
await Bun.write(portFile, String(server.port))
watchFile(portFile, { interval: 50 }, ({ nlink }) => {
  if (nlink === 0) process.exit(1)
})
console.log(`listening on http://127.0.0.1:${server.port}`)
setTimeout(() => process.exit(0), 600_000)
