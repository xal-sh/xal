import { readFile, stat } from "node:fs/promises"
import { pathExists } from "../../lib/fs"
import type { ImageInput } from "../../providers/types"
import type { ToolResult } from "../../tools/types"

export const MAX_IMAGE_BYTES = 3_932_160
const MAX_IMAGE_SIDE = 8000

interface ImageSize {
  width: number
  height: number
}

function pngSize(bytes: Buffer): ImageSize | undefined {
  if (bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR") return undefined
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function jpegSize(bytes: Buffer): ImageSize | undefined {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined
    const marker = bytes[offset + 1]!
    if (marker === 0xff) {
      offset++
      continue
    }
    const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (frame) return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
    offset += 2 + bytes.readUInt16BE(offset + 2)
  }
  return undefined
}

function imageOf(bytes: Buffer): { mediaType: ImageInput["mediaType"]; size: ImageSize | undefined } | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mediaType: "image/png", size: pngSize(bytes) }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mediaType: "image/jpeg", size: jpegSize(bytes) }
  }
  return undefined
}

export async function readImage(path: string, shown: string): Promise<ToolResult | undefined> {
  if (!(await pathExists(path))) return undefined
  const info = await stat(path)
  if (!info.isFile()) return undefined
  if (info.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `${shown} is ${(info.size / 1024 / 1024).toFixed(1)} MB; images over ${MAX_IMAGE_BYTES / 1024 / 1024} MB cannot be attached. Resize or compress it first.`,
    )
  }
  const bytes = await readFile(path)
  const image = imageOf(bytes)
  if (!image) return undefined
  if (!image.size || image.size.width === 0 || image.size.height === 0) {
    throw new Error(`Cannot read image ${shown}: its dimensions could not be determined`)
  }
  const { width, height } = image.size
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) {
    throw new Error(
      `${shown} is ${width}×${height} pixels; images wider or taller than ${MAX_IMAGE_SIDE} pixels cannot be attached. Resize or crop it first.`,
    )
  }
  return {
    output: `Image ${shown}: ${image.mediaType}, ${width}×${height} pixels, ${Math.ceil(info.size / 1024)} KB`,
    images: [{ mediaType: image.mediaType, data: bytes.toString("base64") }],
  }
}
