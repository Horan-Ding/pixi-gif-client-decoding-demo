/// <reference lib="webworker" />

import { GifReader } from 'omggif'

interface LoadMessage {
  type: 'load'
  urls: string[]
}

interface ControlMessage {
  type: 'pause' | 'play' | 'restart'
}

type IncomingMessage = LoadMessage | ControlMessage

const scope = self as unknown as DedicatedWorkerGlobalScope

let reader: GifReader | null = null
let canvas: OffscreenCanvas | null = null
let context: OffscreenCanvasRenderingContext2D | null = null
let compositedPixels: Uint8ClampedArray<ArrayBuffer> | null = null
let restorePixels: Uint8ClampedArray<ArrayBuffer> | null = null
let compressedBytes = 0
let nextFrame = 0
let previousFrame = -1
let playing = false
let generation = 0

function clearFrameRect(pixels: Uint8ClampedArray, width: number, frameIndex: number) {
  if (!reader) return
  const frame = reader.frameInfo(frameIndex)
  for (let row = frame.y; row < frame.y + frame.height; row += 1) {
    const start = (row * width + frame.x) * 4
    pixels.fill(0, start, start + frame.width * 4)
  }
}

function resetComposition() {
  if (!reader) return
  compositedPixels = new Uint8ClampedArray(reader.width * reader.height * 4)
  restorePixels = null
  nextFrame = 0
  previousFrame = -1
}

function decodeFrame(frameIndex: number) {
  if (!reader || !canvas || !context || !compositedPixels) return null
  if (previousFrame >= 0) {
    const previous = reader.frameInfo(previousFrame)
    if (previous.disposal === 2) clearFrameRect(compositedPixels, reader.width, previousFrame)
    if (previous.disposal === 3 && restorePixels) compositedPixels.set(restorePixels)
  }

  const frame = reader.frameInfo(frameIndex)
  restorePixels = frame.disposal === 3 ? compositedPixels.slice() : null
  const decodeStartedAt = performance.now()
  reader.decodeAndBlitFrameRGBA(frameIndex, compositedPixels)
  const imageData = new ImageData(compositedPixels, reader.width, reader.height)
  context.putImageData(imageData, 0, 0)
  const bitmap = canvas.transferToImageBitmap()
  const decodeMs = performance.now() - decodeStartedAt
  previousFrame = frameIndex
  return {
    bitmap,
    decodeMs,
    delayMs: Math.max(20, frame.delay * 10 || 100),
  }
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

async function playbackLoop(loopGeneration: number) {
  if (!reader) return
  let targetTime = performance.now()
  while (playing && loopGeneration === generation && reader) {
    const decoded = decodeFrame(nextFrame)
    if (!decoded) return
    const waitMs = Math.max(0, targetTime - performance.now())
    if (waitMs) await wait(waitMs)
    if (!playing || loopGeneration !== generation) {
      decoded.bitmap.close()
      return
    }
    const displayTime = performance.now()
    scope.postMessage(
      {
        type: 'frame',
        bitmap: decoded.bitmap,
        decodeMs: decoded.decodeMs,
        delayMs: decoded.delayMs,
        frame: nextFrame,
        lateByMs: Math.max(0, displayTime - targetTime),
      },
      [decoded.bitmap],
    )
    targetTime = Math.max(targetTime + decoded.delayMs, displayTime)
    nextFrame += 1
    if (nextFrame >= reader.numFrames()) resetComposition()
  }
}

function startPlayback() {
  if (!reader || playing) return
  playing = true
  generation += 1
  void playbackLoop(generation)
}

function pausePlayback() {
  playing = false
  generation += 1
}

async function loadGif(urls: string[]) {
  pausePlayback()
  const loadGeneration = generation
  try {
    const fetchStartedAt = performance.now()
    const responses = await Promise.all(urls.map((url) => fetch(url)))
    const failedResponse = responses.find((response) => !response.ok)
    if (failedResponse) throw new Error(`HTTP ${failedResponse.status}`)
    const buffers = await Promise.all(responses.map((response) => response.arrayBuffer()))
    if (loadGeneration !== generation) return
    const fetchMs = performance.now() - fetchStartedAt
    compressedBytes = buffers.reduce((total, buffer) => total + buffer.byteLength, 0)
    const gifBytes = new Uint8Array(compressedBytes)
    let writeOffset = 0
    for (const buffer of buffers) {
      gifBytes.set(new Uint8Array(buffer), writeOffset)
      writeOffset += buffer.byteLength
    }
    reader = new GifReader(gifBytes)
    canvas = new OffscreenCanvas(reader.width, reader.height)
    context = canvas.getContext('2d', { alpha: true })
    if (!context) throw new Error('OffscreenCanvas 2D context is unavailable')
    resetComposition()

    let durationMs = 0
    let hasRestorePrevious = false
    for (let index = 0; index < reader.numFrames(); index += 1) {
      const info = reader.frameInfo(index)
      durationMs += Math.max(20, info.delay * 10 || 100)
      hasRestorePrevious ||= info.disposal === 3
    }
    scope.postMessage({
      type: 'metadata',
      bytes: compressedBytes,
      durationMs,
      fetchMs,
      frames: reader.numFrames(),
      hasRestorePrevious,
      height: reader.height,
      width: reader.width,
    })
    startPlayback()
  } catch (error) {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Unknown decoder error',
    })
  }
}

scope.onmessage = (event: MessageEvent<IncomingMessage>) => {
  const message = event.data
  if (message.type === 'load') {
    void loadGif(message.urls)
    return
  }
  if (message.type === 'pause') {
    pausePlayback()
    return
  }
  if (message.type === 'restart') {
    pausePlayback()
    resetComposition()
    startPlayback()
    return
  }
  startPlayback()
}

export {}
