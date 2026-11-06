export function upload(send, payload) {
  const attempts = 3
  return retry(attempts, () => send("upload", payload))
}

export function download(send, id) {
  const attempts = 3
  return retry(attempts, () => send("download", id))
}

export function sync(send) {
  const attempts = 3
  return retry(attempts, () => send("sync"))
}

function retry(attempts, action) {
  for (let attempt = 1; attempt < attempts; attempt++) {
    try {
      return action()
    } catch {
      continue
    }
  }
  return action()
}
