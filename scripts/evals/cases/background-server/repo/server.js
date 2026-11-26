import { watchFile } from "node:fs"
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

const pidFile = join(import.meta.dir, ".server.pid")
await Bun.write(pidFile, String(process.pid))
watchFile(pidFile, { interval: 100 }, (stat) => {
  if (stat.nlink === 0) process.exit(0)
})
await Bun.write(join(import.meta.dir, ".server.port"), String(server.port))
console.log(`listening on http://127.0.0.1:${server.port}`)
setTimeout(() => process.exit(0), 600_000)
