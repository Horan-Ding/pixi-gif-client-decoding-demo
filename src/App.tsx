import {
  Activity,
  CircuitBoard,
  Cpu,
  Gauge,
  Info,
  MemoryStick,
  Pause,
  Play,
  RotateCcw,
} from 'lucide-react'
import { Application, Sprite, Texture } from 'pixi.js'
import { useEffect, useRef, useState } from 'react'
import './App.css'

type PlaybackStatus = 'loading' | 'playing' | 'paused' | 'error'

interface GifAsset {
  id: string
  label: string
  files: string[]
  sizeLabel: string
}

interface DecoderMetadata {
  bytes: number
  durationMs: number
  fetchMs: number
  frames: number
  hasRestorePrevious: boolean
  height: number
  width: number
}

interface RuntimeMetrics {
  decodeMs: number
  eventLoopLagMs: number
  fps: number
  frame: number
  gpuFrameMs: number | null
  heapLimitMb: number | null
  heapUsedMb: number | null
  mainPressure: number
  memoryEstimateMb: number
}

interface MetricHistory {
  cpu: number[]
  gpu: number[]
  memory: number[]
}

interface WorkerFrameMessage {
  bitmap: ImageBitmap
  decodeMs: number
  delayMs: number
  frame: number
  lateByMs: number
  type: 'frame'
}

type WorkerMessage =
  | ({ type: 'metadata' } & DecoderMetadata)
  | WorkerFrameMessage
  | { message: string; type: 'error' }

interface PerformanceWithMemory extends Performance {
  memory?: {
    jsHeapSizeLimit: number
    usedJSHeapSize: number
  }
}

interface MetricsStore extends RuntimeMetrics {
  decodeSamples: number[]
  eventLoopSamples: number[]
  framesSinceSample: number
  gpuSamples: number[]
  mainWorkMs: number
}

const gifParts = (name: string, count: number) => Array.from(
  { length: count },
  (_, index) => `${import.meta.env.BASE_URL}gifs/${name}.part${index.toString().padStart(2, '0')}`,
)

const GIFS: GifAsset[] = [
  {
    id: 'image31',
    label: 'image31.GIF',
    files: gifParts('image31.GIF', 42),
    sizeLabel: '20.6 MB',
  },
  {
    id: 'image32',
    label: 'image32.GIF',
    files: gifParts('image32.GIF', 18),
    sizeLabel: '8.7 MB',
  },
]

const EMPTY_METADATA: DecoderMetadata = {
  bytes: 0,
  durationMs: 0,
  fetchMs: 0,
  frames: 0,
  hasRestorePrevious: false,
  height: 0,
  width: 0,
}

const EMPTY_METRICS: RuntimeMetrics = {
  decodeMs: 0,
  eventLoopLagMs: 0,
  fps: 0,
  frame: 0,
  gpuFrameMs: null,
  heapLimitMb: null,
  heapUsedMb: null,
  mainPressure: 0,
  memoryEstimateMb: 0,
}

const HISTORY_LENGTH = 44

function clampHistory(values: number[], value: number) {
  return [...values, value].slice(-HISTORY_LENGTH)
}

function percentile(values: number[], quantile: number) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]
}

function formatDuration(milliseconds: number) {
  const seconds = Math.round(milliseconds / 1000)
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${minutes}:${remainder.toString().padStart(2, '0')}`
}

function formatNumber(value: number, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : '--'
}

function estimateWorkingSet(metadata: DecoderMetadata) {
  if (!metadata.width || !metadata.height) return 0
  const pixelSurface = metadata.width * metadata.height * 4
  const surfaceCount = metadata.hasRestorePrevious ? 6 : 5
  return (metadata.bytes + pixelSurface * surfaceCount) / 1024 / 1024
}

function Sparkline({ color, values }: { color: string; values: number[] }) {
  const width = 220
  const height = 44
  const max = Math.max(...values, 1)
  const points = values
    .map((value, index) => {
      const x = values.length === 1 ? width : (index / (values.length - 1)) * width
      const y = height - (value / max) * (height - 4) - 2
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1={height - 1} x2={width} y2={height - 1} className="sparkline-base" />
      <polyline points={points} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function createGpuTimer(app: Application, onSample: (milliseconds: number) => void) {
  const renderer = app.renderer as unknown as { gl?: WebGL2RenderingContext }
  const gl = renderer.gl
  const extension = gl?.getExtension('EXT_disjoint_timer_query_webgl2') as
    | { GPU_DISJOINT_EXT: number; TIME_ELAPSED_EXT: number }
    | null
    | undefined
  const pending: WebGLQuery[] = []
  let pollHandle = 0
  let destroyed = false

  const poll = () => {
    if (!gl || !extension || destroyed) return
    while (pending.length) {
      const query = pending[0]
      const available = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) as boolean
      if (!available) break
      pending.shift()
      const disjoint = gl.getParameter(extension.GPU_DISJOINT_EXT) as boolean
      if (!disjoint) {
        const nanoseconds = gl.getQueryParameter(query, gl.QUERY_RESULT) as number
        onSample(nanoseconds / 1_000_000)
      }
      gl.deleteQuery(query)
    }
    if (pending.length) pollHandle = requestAnimationFrame(poll)
  }

  return {
    available: Boolean(gl && extension),
    render() {
      if (!gl || !extension) {
        app.render()
        return
      }
      const query = gl.createQuery()
      if (!query) {
        app.render()
        return
      }
      gl.beginQuery(extension.TIME_ELAPSED_EXT, query)
      app.render()
      gl.endQuery(extension.TIME_ELAPSED_EXT)
      pending.push(query)
      cancelAnimationFrame(pollHandle)
      pollHandle = requestAnimationFrame(poll)
    },
    destroy() {
      destroyed = true
      cancelAnimationFrame(pollHandle)
      if (gl) pending.forEach((query) => gl.deleteQuery(query))
      pending.length = 0
    },
  }
}

function App() {
  const [selectedId, setSelectedId] = useState(GIFS[0].id)
  const [status, setStatus] = useState<PlaybackStatus>('loading')
  const [metadata, setMetadata] = useState<DecoderMetadata>(EMPTY_METADATA)
  const [metrics, setMetrics] = useState<RuntimeMetrics>(EMPTY_METRICS)
  const [history, setHistory] = useState<MetricHistory>({ cpu: [0], gpu: [0], memory: [0] })
  const [gpuTimerAvailable, setGpuTimerAvailable] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const mountRef = useRef<HTMLDivElement>(null)
  const workerRef = useRef<Worker | null>(null)
  const selectedRef = useRef(GIFS[0])
  const metadataRef = useRef(EMPTY_METADATA)
  const metricsRef = useRef<MetricsStore>({
    ...EMPTY_METRICS,
    decodeSamples: [],
    eventLoopSamples: [],
    framesSinceSample: 0,
    gpuSamples: [],
    mainWorkMs: 0,
  })

  useEffect(() => {
    let disposed = false
    let resizeObserver: ResizeObserver | null = null
    let sampleTimer = 0
    let lagTimer = 0
    let app: Application | null = null
    let texture: Texture | null = null
    let sprite: Sprite | null = null
    let sourceCanvas: HTMLCanvasElement | null = null
    let sourceContext: CanvasRenderingContext2D | null = null
    let gpuTimer: ReturnType<typeof createGpuTimer> | null = null
    let appInitialized = false

    const resetMetrics = () => {
      metricsRef.current = {
        ...EMPTY_METRICS,
        decodeSamples: [],
        eventLoopSamples: [],
        framesSinceSample: 0,
        gpuSamples: [],
        mainWorkMs: 0,
      }
      setMetrics(EMPTY_METRICS)
      setHistory({ cpu: [0], gpu: [0], memory: [0] })
    }

    const fitSprite = () => {
      if (!app || !sprite || !metadataRef.current.width) return
      const screenWidth = app.renderer.screen.width
      const screenHeight = app.renderer.screen.height
      const scale = Math.min(
        screenWidth / metadataRef.current.width,
        screenHeight / metadataRef.current.height,
      )
      sprite.scale.set(scale)
      sprite.position.set(
        (screenWidth - metadataRef.current.width * scale) / 2,
        (screenHeight - metadataRef.current.height * scale) / 2,
      )
      gpuTimer?.render()
    }

    const prepareTexture = (nextMetadata: DecoderMetadata) => {
      if (!app) return
      sprite?.destroy()
      texture?.destroy(true)
      sourceCanvas = document.createElement('canvas')
      sourceCanvas.width = nextMetadata.width
      sourceCanvas.height = nextMetadata.height
      sourceContext = sourceCanvas.getContext('2d', { alpha: true, desynchronized: true })
      texture = Texture.from(sourceCanvas)
      sprite = new Sprite(texture)
      app.stage.addChild(sprite)
      fitSprite()
    }

    const handleFrame = (message: WorkerFrameMessage) => {
      if (!app || !sourceCanvas || !sourceContext || !texture || disposed) {
        message.bitmap.close()
        return
      }
      const startedAt = performance.now()
      sourceContext.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height)
      sourceContext.drawImage(message.bitmap, 0, 0)
      message.bitmap.close()
      texture.source.update()
      gpuTimer?.render()
      const store = metricsRef.current
      store.frame = message.frame + 1
      store.framesSinceSample += 1
      store.mainWorkMs += performance.now() - startedAt
      store.decodeMs = message.decodeMs
      store.decodeSamples.push(message.decodeMs)
      store.decodeSamples = store.decodeSamples.slice(-120)
    }

    const initialize = async () => {
      const mount = mountRef.current
      if (!mount) return
      app = new Application()
      await app.init({
        antialias: true,
        autoDensity: true,
        autoStart: false,
        background: '#111516',
        preference: 'webgl',
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        width: mount.clientWidth,
        height: mount.clientHeight,
      })
      appInitialized = true
      if (disposed) {
        app.destroy(true)
        return
      }
      app.canvas.className = 'pixi-canvas'
      mount.appendChild(app.canvas)
      gpuTimer = createGpuTimer(app, (milliseconds) => {
        const store = metricsRef.current
        store.gpuFrameMs = milliseconds
        store.gpuSamples.push(milliseconds)
        store.gpuSamples = store.gpuSamples.slice(-120)
      })
      setGpuTimerAvailable(gpuTimer.available)

      resizeObserver = new ResizeObserver(() => {
        if (!app || !mount.clientWidth || !mount.clientHeight) return
        app.renderer.resize(mount.clientWidth, mount.clientHeight)
        fitSprite()
      })
      resizeObserver.observe(mount)

      const worker = new Worker(new URL('./gifDecoder.worker.ts', import.meta.url), { type: 'module' })
      workerRef.current = worker
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const message = event.data
        if (message.type === 'metadata') {
          metadataRef.current = message
          metricsRef.current.memoryEstimateMb = estimateWorkingSet(message)
          setMetadata(message)
          prepareTexture(message)
          return
        }
        if (message.type === 'frame') {
          setStatus('playing')
          handleFrame(message)
          return
        }
        setStatus('error')
        setErrorMessage(message.message)
      }
      worker.onerror = (event) => {
        setStatus('error')
        setErrorMessage(event.message || 'Worker runtime error')
      }
      worker.postMessage({ type: 'load', urls: selectedRef.current.files })

      let expectedLagTick = performance.now() + 250
      lagTimer = window.setInterval(() => {
        const now = performance.now()
        const lag = Math.max(0, now - expectedLagTick)
        expectedLagTick = now + 250
        const store = metricsRef.current
        store.eventLoopSamples.push(lag)
        store.eventLoopSamples = store.eventLoopSamples.slice(-120)
      }, 250)

      let lastSampleAt = performance.now()
      sampleTimer = window.setInterval(() => {
        const now = performance.now()
        const elapsed = Math.max(1, now - lastSampleAt)
        lastSampleAt = now
        const store = metricsRef.current
        const memory = (performance as PerformanceWithMemory).memory
        const pressure = Math.min(100, ((store.mainWorkMs + percentile(store.eventLoopSamples, 0.95)) / elapsed) * 100)
        store.fps = (store.framesSinceSample * 1000) / elapsed
        store.mainPressure = pressure
        store.eventLoopLagMs = percentile(store.eventLoopSamples, 0.95)
        store.heapUsedMb = memory ? memory.usedJSHeapSize / 1024 / 1024 : null
        store.heapLimitMb = memory ? memory.jsHeapSizeLimit / 1024 / 1024 : null
        store.decodeMs = percentile(store.decodeSamples, 0.95)
        store.gpuFrameMs = store.gpuSamples.length ? percentile(store.gpuSamples, 0.95) : null
        store.memoryEstimateMb = estimateWorkingSet(metadataRef.current)
        const snapshot: RuntimeMetrics = {
          decodeMs: store.decodeMs,
          eventLoopLagMs: store.eventLoopLagMs,
          fps: store.fps,
          frame: store.frame,
          gpuFrameMs: store.gpuFrameMs,
          heapLimitMb: store.heapLimitMb,
          heapUsedMb: store.heapUsedMb,
          mainPressure: store.mainPressure,
          memoryEstimateMb: store.memoryEstimateMb,
        }
        setMetrics(snapshot)
        setHistory((current) => ({
          cpu: clampHistory(current.cpu, snapshot.mainPressure),
          gpu: clampHistory(current.gpu, snapshot.gpuFrameMs ?? 0),
          memory: clampHistory(current.memory, snapshot.heapUsedMb ?? snapshot.memoryEstimateMb),
        }))
        store.framesSinceSample = 0
        store.mainWorkMs = 0
        store.eventLoopSamples = []
      }, 1000)
    }

    resetMetrics()
    void initialize()

    return () => {
      disposed = true
      window.clearInterval(sampleTimer)
      window.clearInterval(lagTimer)
      resizeObserver?.disconnect()
      workerRef.current?.terminate()
      workerRef.current = null
      gpuTimer?.destroy()
      sprite?.destroy()
      texture?.destroy(true)
      if (appInitialized) app?.destroy(true)
    }
  }, [])

  const selectGif = (gif: GifAsset) => {
    if (gif.id === selectedId) return
    selectedRef.current = gif
    setSelectedId(gif.id)
    setStatus('loading')
    setErrorMessage('')
    setMetadata(EMPTY_METADATA)
    metadataRef.current = EMPTY_METADATA
    metricsRef.current = {
      ...EMPTY_METRICS,
      decodeSamples: [],
      eventLoopSamples: [],
      framesSinceSample: 0,
      gpuSamples: [],
      mainWorkMs: 0,
    }
    workerRef.current?.postMessage({ type: 'load', urls: gif.files })
  }

  const togglePlayback = () => {
    const nextStatus = status === 'playing' ? 'paused' : 'playing'
    setStatus(nextStatus)
    workerRef.current?.postMessage({ type: nextStatus === 'playing' ? 'play' : 'pause' })
  }

  const restart = () => {
    setStatus('playing')
    metricsRef.current.frame = 0
    workerRef.current?.postMessage({ type: 'restart' })
  }

  const selected = GIFS.find((gif) => gif.id === selectedId) ?? GIFS[0]
  const progress = metadata.frames ? (metrics.frame / metadata.frames) * 100 : 0
  const gpuBudget = metrics.gpuFrameMs === null ? null : (metrics.gpuFrameMs / 16.67) * 100

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="product-mark"><span aria-hidden="true" /> PIXI GIF Runtime Lab</div>
          <p>Worker decode / single mutable texture / WebGL 2</p>
        </div>
        <div className={`status-pill status-${status}`}>
          <span aria-hidden="true" />
          {status === 'loading' ? '正在载入' : status === 'playing' ? '播放中' : status === 'paused' ? '已暂停' : '载入失败'}
        </div>
      </header>

      <section className="workspace">
        <div className="player-column">
          <div className="control-strip" aria-label="播放控制">
            <div className="segmented-control" aria-label="GIF 文件">
              {GIFS.map((gif) => (
                <button
                  type="button"
                  key={gif.id}
                  className={gif.id === selectedId ? 'active' : ''}
                  onClick={() => selectGif(gif)}
                >
                  <span>{gif.label}</span>
                  <small>{gif.sizeLabel}</small>
                </button>
              ))}
            </div>
            <div className="transport-controls">
              <button
                type="button"
                className="icon-button"
                onClick={togglePlayback}
                disabled={status === 'loading' || status === 'error'}
                aria-label={status === 'playing' ? '暂停' : '播放'}
                title={status === 'playing' ? '暂停' : '播放'}
              >
                {status === 'playing' ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={restart}
                disabled={status === 'loading' || status === 'error'}
                aria-label="重新播放"
                title="重新播放"
              >
                <RotateCcw size={18} />
              </button>
            </div>
          </div>

          <div className="viewport-shell">
            <div className="viewport-badges">
              <span>WEBGL 2</span>
              <span>WORKER</span>
            </div>
            <div ref={mountRef} className="pixi-mount" data-testid="pixi-mount" />
            {status === 'loading' && <div className="viewport-state"><Activity className="spinner" size={24} />正在下载并解析 {selected.label}</div>}
            {status === 'error' && <div className="viewport-state error-state">{errorMessage || 'GIF 加载失败'}</div>}
          </div>

          <div className="timeline">
            <div className="timeline-track"><span style={{ width: `${Math.min(progress, 100)}%` }} /></div>
            <div className="timeline-labels">
              <span>帧 {metrics.frame || 0} / {metadata.frames || '--'}</span>
              <span>{metadata.durationMs ? formatDuration(metadata.durationMs) : '--:--'}</span>
            </div>
          </div>

          <div className="asset-facts">
            <div><span>画布</span><strong>{metadata.width ? `${metadata.width} x ${metadata.height}` : '--'}</strong></div>
            <div><span>下载</span><strong>{metadata.fetchMs ? `${formatNumber(metadata.fetchMs, 0)} ms` : '--'}</strong></div>
            <div><span>压缩体积</span><strong>{metadata.bytes ? `${formatNumber(metadata.bytes / 1024 / 1024)} MB` : selected.sizeLabel}</strong></div>
            <div><span>纹理实例</span><strong>1</strong></div>
          </div>
        </div>

        <aside className="telemetry-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">LIVE TELEMETRY</span>
              <h1>运行时性能</h1>
            </div>
            <Activity size={20} aria-hidden="true" />
          </div>

          <div className="metric-grid">
            <div className="metric-cell">
              <div className="metric-label"><Gauge size={15} />播放帧率</div>
              <strong>{formatNumber(metrics.fps)}</strong><span>fps</span>
            </div>
            <div className="metric-cell">
              <div className="metric-label"><Activity size={15} />Worker 解码 P95</div>
              <strong>{formatNumber(metrics.decodeMs)}</strong><span>ms</span>
            </div>
            <div className="metric-cell">
              <div className="metric-label">
                <Cpu size={15} />主线程压力
                <span className="info-tip" title="帧处理时间与事件循环延迟形成的代理指标，并非系统 CPU 利用率">
                  <Info size={13} />
                </span>
              </div>
              <strong>{formatNumber(metrics.mainPressure)}</strong><span>%</span>
            </div>
            <div className="metric-cell">
              <div className="metric-label"><Activity size={15} />事件循环延迟 P95</div>
              <strong>{formatNumber(metrics.eventLoopLagMs)}</strong><span>ms</span>
            </div>
            <div className="metric-cell">
              <div className="metric-label">
                <CircuitBoard size={15} />GPU 单帧 P95
                <span className="info-tip" title="来自 EXT_disjoint_timer_query_webgl2，表示 GPU 帧耗时，并非系统 GPU 利用率">
                  <Info size={13} />
                </span>
              </div>
              <strong>{metrics.gpuFrameMs === null ? '--' : formatNumber(metrics.gpuFrameMs, 2)}</strong><span>ms</span>
            </div>
            <div className="metric-cell">
              <div className="metric-label"><Gauge size={15} />GPU 帧预算</div>
              <strong>{gpuBudget === null ? '--' : formatNumber(gpuBudget)}</strong><span>% @ 60Hz</span>
            </div>
            <div className="metric-cell">
              <div className="metric-label">
                <MemoryStick size={15} />JS Heap
                <span className="info-tip" title="performance.memory 仅在 Chromium 浏览器中提供">
                  <Info size={13} />
                </span>
              </div>
              <strong>{metrics.heapUsedMb === null ? '--' : formatNumber(metrics.heapUsedMb, 0)}</strong><span>MB</span>
            </div>
            <div className="metric-cell">
              <div className="metric-label">
                <MemoryStick size={15} />工作集估算
                <span className="info-tip" title="压缩 GIF 加解码缓冲、Canvas、传输帧与 GPU RGBA 纹理的保守估算">
                  <Info size={13} />
                </span>
              </div>
              <strong>{formatNumber(metrics.memoryEstimateMb, 0)}</strong><span>MB</span>
            </div>
          </div>

          <div className="chart-stack">
            <div className="chart-row">
              <div><span>MAIN PRESSURE</span><strong>{formatNumber(metrics.mainPressure)}%</strong></div>
              <Sparkline values={history.cpu} color="#d94b3d" />
            </div>
            <div className="chart-row">
              <div><span>GPU FRAME</span><strong>{metrics.gpuFrameMs === null ? 'N/A' : `${formatNumber(metrics.gpuFrameMs, 2)} ms`}</strong></div>
              <Sparkline values={history.gpu} color="#20a4a6" />
            </div>
            <div className="chart-row">
              <div><span>MEMORY</span><strong>{metrics.heapUsedMb === null ? 'EST.' : 'HEAP'}</strong></div>
              <Sparkline values={history.memory} color="#d38a24" />
            </div>
          </div>

          <div className="runtime-footer">
            <span><i className={gpuTimerAvailable ? 'ok' : 'muted'} />GPU timer {gpuTimerAvailable ? 'available' : 'unavailable'}</span>
            <span>PIXI.js 8.19 / omggif 1.0</span>
          </div>
        </aside>
      </section>
    </main>
  )
}

export default App
