import { join } from "node:path"

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return new Response("healthy-4b71", {
        headers: { "x-eval-server": `${process.pid}:${encodeURIComponent(import.meta.dir)}` },
      })
    }
    return new Response("Not found", { status: 404 })
  },
})

await Bun.write(join(import.meta.dir, ".server.pid"), String(process.pid))
await Bun.write(join(import.meta.dir, ".server.port"), String(server.port))
console.log(`listening on http://127.0.0.1:${server.port}`)
setTimeout(() => process.exit(0), 600_000)
