// @ts-check

import { runDcm2niix, traverseDataTransferItems } from '@niivue/nv-ext-dcm2niix'

const WINDOW_UPDATE_DELAY_MS = 8

let gMin = 0
let gMax = 1
let hasVolume = false
let windowUpdateTimer = null
let windowUpdateInFlight = false
let pendingWindow = null
let renderWorker = null
let mainThreadNv = null
let rendererMode = 'none'
let resizeObserver = null
let nextWorkerRequestId = 1
const workerRequests = new Map()
let windowUpdateStats = createWindowUpdateStats()

const dicomInput = document.getElementById('dicomInput')
const levelSlider = document.getElementById('levelSlider')
const widthSlider = document.getElementById('widthSlider')
const levelValue = document.getElementById('levelValue')
const widthValue = document.getElementById('widthValue')
const resetBtn = document.getElementById('resetBtn')
const statusEl = document.getElementById('status')
const loadingEl = document.getElementById('loading')
const loadingTextEl = document.getElementById('loadingText')
const canvasContainer = document.getElementById('canvas-container')
let canvasEl = document.getElementById('gl')

function createWindowUpdateStats() {
  return {
    startedAt: performance.now(),
    count: 0,
    roundTripTotalMs: 0,
    workerCpuTotalMs: 0,
    renderCpuTotalMs: 0,
    maxRoundTripMs: 0,
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function setLoading(loading, text = 'Loading...') {
  loadingEl.style.display = loading ? 'flex' : 'none'
  loadingTextEl.textContent = text
}

function updateSliderValues() {
  levelValue.textContent = Math.round(Number(levelSlider.value))
  widthValue.textContent = Math.round(Number(widthSlider.value))
}

function initSliders(volume) {
  gMin = volume.globalMin
  gMax = volume.globalMax
  const span = gMax - gMin || 1
  const padding = span * 0.5

  levelSlider.min = Math.floor(gMin - padding)
  levelSlider.max = Math.ceil(gMax + padding)
  levelSlider.value = Math.round((volume.calMin + volume.calMax) / 2)
  widthSlider.min = 1
  widthSlider.max = Math.ceil(span * 2)
  widthSlider.value = Math.round(volume.calMax - volume.calMin)
  updateSliderValues()

  hasVolume = true
  windowUpdateStats = createWindowUpdateStats()
  levelSlider.disabled = false
  widthSlider.disabled = false
  resetBtn.disabled = false
}

function dataRange(volume) {
  let lo = volume.globalMin ?? volume.global_min
  let hi = volume.globalMax ?? volume.global_max
  if (Number.isFinite(lo) && Number.isFinite(hi) && lo !== hi) return [lo, hi]

  const image = volume.img
  const slope = volume.hdr?.scl_slope || 1
  const intercept = volume.hdr?.scl_inter || 0
  lo = Infinity
  hi = -Infinity
  const stride = Math.max(1, Math.floor(image.length / 1e6))
  for (let i = 0; i < image.length; i += stride) {
    const value = image[i] * slope + intercept
    if (value < lo) lo = value
    if (value > hi) hi = value
  }
  return [lo, hi]
}

function summarizeMainThreadVolume(volume) {
  const [globalMin, globalMax] = dataRange(volume)
  return {
    name: volume.name,
    globalMin,
    globalMax,
    calMin: volume.calMin,
    calMax: volume.calMax,
  }
}

function workerRequest(type, payload = {}, transfer = []) {
  if (!renderWorker)
    return Promise.reject(new Error('Render worker is not ready'))
  const id = nextWorkerRequestId
  nextWorkerRequestId += 1
  return new Promise((resolve, reject) => {
    workerRequests.set(id, { resolve, reject })
    renderWorker.postMessage({ id, type, ...payload }, transfer)
  })
}

function rejectWorkerRequests(error) {
  for (const request of workerRequests.values()) request.reject(error)
  workerRequests.clear()
}

function handleWorkerMessage(event) {
  const message = event.data
  if (message.type === 'windowUpdated') {
    recordWindowUpdate(performance.now() - message.sentAt, message.result)
    return
  }
  if (message.type === 'windowError') {
    console.error('Window update failed:', message.error)
    return
  }
  if (message.type === 'location') {
    document.getElementById('location').innerHTML =
      `&nbsp;&nbsp;${message.value}`
    return
  }
  const request = workerRequests.get(message.id)
  if (!request) return
  workerRequests.delete(message.id)
  if (message.ok) request.resolve(message.result)
  else request.reject(new Error(message.error))
}

function canvasPixelSize(canvas) {
  const rect = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  return {
    width: Math.max(1, Math.round(rect.width * dpr)),
    height: Math.max(1, Math.round(rect.height * dpr)),
  }
}

function observeWorkerCanvasSize() {
  if (!renderWorker || !canvasEl) return
  resizeObserver?.disconnect()
  resizeObserver = new ResizeObserver(() => {
    if (!renderWorker || !canvasEl) return
    const size = canvasPixelSize(canvasEl)
    renderWorker.postMessage({ type: 'resize', ...size })
  })
  resizeObserver.observe(canvasEl)
}

async function initializeRenderWorker(canvas) {
  const size = canvasPixelSize(canvas)
  canvas.width = size.width
  canvas.height = size.height

  const worker = new Worker(
    new URL('./window-level-width-03.worker.js', import.meta.url),
    { type: 'module' },
  )
  renderWorker = worker
  worker.addEventListener('message', handleWorkerMessage)
  worker.addEventListener('error', (event) => {
    rejectWorkerRequests(new Error(event.message || 'Render worker failed'))
  })

  const offscreenCanvas = canvas.transferControlToOffscreen()
  const result = await workerRequest(
    'initialize',
    { canvas: offscreenCanvas, baseUrl: document.baseURI, ...size },
    [offscreenCanvas],
  )
  rendererMode = 'worker'
  observeWorkerCanvasSize()
  console.log('Renderer initialized in worker:', result)
}

function replaceTransferredCanvas() {
  const replacement = document.createElement('canvas')
  replacement.id = 'gl'
  canvasEl.replaceWith(replacement)
  canvasEl = replacement
  return replacement
}

async function initializeMainThreadRenderer(canvas) {
  const { default: NiiVue, SHOW_RENDER } = await import('../src/index.ts')
  const nv = new NiiVue({
    isColorbarVisible: true,
    backgroundColor: [0.1, 0.1, 0.1, 1],
    showRender: SHOW_RENDER.NEVER,
  })
  nv.addEventListener('locationChange', (event) => {
    document.getElementById('location').innerHTML =
      `&nbsp;&nbsp;${event.detail.string}`
  })
  await nv.attachToCanvas(canvas)
  mainThreadNv = nv
  rendererMode = 'main-thread'
  console.log('Renderer initialized on main thread:', { backend: nv.backend })
}

async function initializeRenderer() {
  if (!canvasEl) throw new Error('Canvas element not found')
  const supportsWorkerRendering =
    typeof Worker !== 'undefined' &&
    typeof canvasEl.transferControlToOffscreen === 'function'

  if (supportsWorkerRendering) {
    try {
      await initializeRenderWorker(canvasEl)
      return
    } catch (error) {
      console.warn(
        'OffscreenCanvas render worker failed; falling back to the main thread:',
        error,
      )
      renderWorker?.terminate()
      renderWorker = null
      rejectWorkerRequests(error)
      const replacement = replaceTransferredCanvas()
      await initializeMainThreadRenderer(replacement)
      return
    }
  }

  console.warn('OffscreenCanvas is unavailable; using the main-thread renderer')
  await initializeMainThreadRenderer(canvasEl)
}

function applyWindow() {
  if (!hasVolume) return
  const level = Number(levelSlider.value)
  const width = Number(widthSlider.value)
  pendingWindow = {
    calMin: level - width / 2,
    calMax: level + width / 2,
  }
  scheduleWindowUpdate()
}

function scheduleWindowUpdate() {
  // The worker keeps only the latest pending value while a frame is running.
  // Sending a new value does not wait for the previous frame's reply.
  if (rendererMode === 'worker' && renderWorker && pendingWindow !== null) {
    renderWorker.postMessage({
      type: 'windowLatest',
      window: pendingWindow,
      sentAt: performance.now(),
    })
    pendingWindow = null
    return
  }
  if (windowUpdateTimer !== null || windowUpdateInFlight) return
  windowUpdateTimer = window.setTimeout(() => {
    windowUpdateTimer = null
    void flushWindowUpdate()
  }, WINDOW_UPDATE_DELAY_MS)
}

function recordWindowUpdate(roundTripMs, result) {
  const workerCpuMs = result?.workerCpuMs ?? roundTripMs
  const renderCpuMs = result?.renderCpuMs ?? 0
  windowUpdateStats.count += 1
  windowUpdateStats.roundTripTotalMs += roundTripMs
  windowUpdateStats.workerCpuTotalMs += workerCpuMs
  windowUpdateStats.renderCpuTotalMs += renderCpuMs
  windowUpdateStats.maxRoundTripMs = Math.max(
    windowUpdateStats.maxRoundTripMs,
    roundTripMs,
  )

  const elapsedMs = performance.now() - windowUpdateStats.startedAt
  if (elapsedMs < 1000) return
  const count = windowUpdateStats.count
  console.log('Window update performance:', {
    rendererMode,
    updatesPerSecond: Math.round((count * 1000) / elapsedMs),
    averageRoundTripMs: Number(
      (windowUpdateStats.roundTripTotalMs / count).toFixed(2),
    ),
    averageWorkerCpuMs: Number(
      (windowUpdateStats.workerCpuTotalMs / count).toFixed(2),
    ),
    averageRenderCpuMs: Number(
      (windowUpdateStats.renderCpuTotalMs / count).toFixed(2),
    ),
    maxRoundTripMs: Number(windowUpdateStats.maxRoundTripMs.toFixed(2)),
    backend: result?.backend ?? mainThreadNv?.backend,
  })
  windowUpdateStats = createWindowUpdateStats()
}

async function flushWindowUpdate() {
  if (pendingWindow === null || !hasVolume) return
  const nextWindow = pendingWindow
  pendingWindow = null
  windowUpdateInFlight = true
  const startedAt = performance.now()
  try {
    let result = null
    if (rendererMode === 'worker') {
      result = await workerRequest('setWindow', { window: nextWindow })
    } else if (mainThreadNv) {
      await mainThreadNv.setVolume(0, nextWindow)
    }
    recordWindowUpdate(performance.now() - startedAt, result)
  } catch (error) {
    console.error('Window update failed:', error)
  } finally {
    windowUpdateInFlight = false
    if (pendingWindow !== null) scheduleWindowUpdate()
  }
}

async function loadNiftiVolume(file) {
  if (rendererMode === 'worker') {
    return workerRequest('loadVolume', { file })
  }
  if (!mainThreadNv) throw new Error('Renderer is not initialized')
  await mainThreadNv.loadVolumes([{ url: file }])
  return summarizeMainThreadVolume(mainThreadNv.volumes[0])
}

async function loadSampleFromQuery() {
  const sampleUrl = new URLSearchParams(window.location.search).get('sample')
  if (!sampleUrl) return false
  setLoading(true, 'Loading test volume in render worker...')
  statusEl.textContent = 'Loading test volume...'
  const volume = await loadNiftiVolume(sampleUrl)
  initSliders(volume)
  statusEl.textContent = `Loaded: ${volume.name} (${rendererMode})`
  setLoading(false)
  return true
}

async function processDicomFiles(files) {
  if (files.length === 0) return
  console.log(`Selected ${files.length} DICOM files`)
  try {
    setLoading(true, 'Converting DICOM to NIfTI...')
    statusEl.textContent = 'Converting DICOM...'
    const conversionStartedAt = performance.now()
    const niftiFiles = await runDcm2niix(files)
    console.log('DICOM conversion:', {
      milliseconds: Number(
        (performance.now() - conversionStartedAt).toFixed(2),
      ),
      files: niftiFiles.map((file) => file.name),
    })
    if (niftiFiles.length === 0) throw new Error('No NIfTI files generated')

    setLoading(true, 'Loading volume in render worker...')
    statusEl.textContent = 'Loading volume...'
    const loadStartedAt = performance.now()
    const volume = await loadNiftiVolume(niftiFiles[0])
    console.log('Volume loading:', {
      milliseconds: Number((performance.now() - loadStartedAt).toFixed(2)),
      rendererMode,
    })
    initSliders(volume)
    statusEl.textContent = `Loaded: ${volume.name} (${rendererMode})`
    setLoading(false)
  } catch (error) {
    console.error('DICOM loading error:', error)
    setLoading(false)
    statusEl.textContent = `Error: ${errorMessage(error)}`
    alert(`Failed to load DICOM: ${errorMessage(error)}`)
  }
}

levelSlider.addEventListener('input', () => {
  updateSliderValues()
  applyWindow()
})

widthSlider.addEventListener('input', () => {
  updateSliderValues()
  applyWindow()
})

resetBtn.addEventListener('click', () => {
  if (!hasVolume) return
  pendingWindow = null
  if (windowUpdateTimer !== null) {
    clearTimeout(windowUpdateTimer)
    windowUpdateTimer = null
  }
  levelSlider.value = Math.round((gMin + gMax) / 2)
  widthSlider.value = Math.round(gMax - gMin)
  updateSliderValues()
  pendingWindow = { calMin: gMin, calMax: gMax }
  scheduleWindowUpdate()
})

dicomInput.addEventListener('change', () => {
  void processDicomFiles(Array.from(dicomInput.files))
})

canvasContainer.addEventListener('dragover', (event) => {
  event.preventDefault()
  canvasContainer.style.borderColor = '#4caf50'
})

canvasContainer.addEventListener('dragleave', (event) => {
  event.preventDefault()
  canvasContainer.style.borderColor = ''
})

canvasContainer.addEventListener('drop', (event) => {
  event.preventDefault()
  canvasContainer.style.borderColor = ''
  void (async () => {
    const files = event.dataTransfer?.items
      ? await traverseDataTransferItems(event.dataTransfer.items)
      : Array.from(event.dataTransfer?.files ?? [])
    await processDicomFiles(files)
  })()
})

try {
  await initializeRenderer()
  dicomInput.disabled = false
  if (!(await loadSampleFromQuery())) {
    statusEl.textContent = `Ready - ${rendererMode}`
  }
} catch (error) {
  console.error('Failed to initialize renderer:', error)
  statusEl.textContent = `Error: ${errorMessage(error)}`
}
