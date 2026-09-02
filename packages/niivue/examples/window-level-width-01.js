import NiiVue, { SHOW_RENDER } from '../src/index.ts'
import { runDcm2niix } from '@niivue/nv-ext-dcm2niix'

// Diagnostic: show script is running
console.log('Window/Level demo script loaded')
console.log('Available packages:', typeof NiiVue, typeof runDcm2niix)

let gMin = 0
let gMax = 1
let windowUpdatePending = false

function dataRange(v) {
  let lo = v.globalMin ?? v.global_min
  let hi = v.globalMax ?? v.global_max
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) {
    const img = v.img
    const slope = v.hdr?.scl_slope || 1
    const inter = v.hdr?.scl_inter || 0
    lo = Infinity
    hi = -Infinity
    const stride = Math.max(1, Math.floor(img.length / 1e6))
    for (let i = 0; i < img.length; i += stride) {
      const x = img[i] * slope + inter
      if (x < lo) lo = x
      if (x > hi) hi = x
    }
  }
  return [lo, hi]
}

function initSliders(v) {
  ;[gMin, gMax] = dataRange(v)
  const span = gMax - gMin || 1

  // Set slider ranges with padding
  const padding = span * 0.5
  levelSlider.min = Math.floor(gMin - padding)
  levelSlider.max = Math.ceil(gMax + padding)

  const currentLevel = (v.calMin + v.calMax) / 2
  const currentWidth = v.calMax - v.calMin

  levelSlider.value = Math.round(currentLevel)
  widthSlider.min = 1
  widthSlider.max = Math.ceil(span * 2)
  widthSlider.value = Math.round(currentWidth)

  updateSliderValues()

  levelSlider.disabled = false
  widthSlider.disabled = false
  autoBtn.disabled = false
  resetBtn.disabled = false
}

function updateSliderValues() {
  levelValue.textContent = Math.round(parseFloat(levelSlider.value))
  widthValue.textContent = Math.round(parseFloat(widthSlider.value))
}

function applyWindow() {
  if (nv1.volumes.length < 1) return
  const v = nv1.volumes[0]
  const level = parseFloat(levelSlider.value)
  const width = parseFloat(widthSlider.value)
  const calMin = level - width / 2
  const calMax = level + width / 2
  v.calMin = calMin
  v.calMax = calMax

  // Coalesce rapid slider events into one GPU update per animation frame.
  // Calling async setVolume() for every input event can queue many expensive
  // updates and make the image appear to refresh only after dragging stops.
  if (!windowUpdatePending) {
    windowUpdatePending = true
    requestAnimationFrame(async () => {
      windowUpdatePending = false
      await nv1.updateGLVolume()
    })
  }
}

function handleLocationChange(data) {
  document.getElementById('location').innerHTML = `&nbsp;&nbsp;${data.string}`
}

function setLoading(loading, text = 'Loading...') {
  loadingEl.style.display = loading ? 'flex' : 'none'
  loadingTextEl.textContent = text
}

// UI elements
const dicomInput = document.getElementById('dicomInput')
const levelSlider = document.getElementById('levelSlider')
const widthSlider = document.getElementById('widthSlider')
const levelValue = document.getElementById('levelValue')
const widthValue = document.getElementById('widthValue')
const autoBtn = document.getElementById('autoBtn')
const resetBtn = document.getElementById('resetBtn')
const statusEl = document.getElementById('status')
const loadingEl = document.getElementById('loading')
const loadingTextEl = document.getElementById('loadingText')
const canvasContainer = document.getElementById('canvas-container')

// Diagnostic: check all UI elements
console.log('UI elements check:', {
  dicomInput: !!dicomInput,
  levelSlider: !!levelSlider,
  widthSlider: !!widthSlider,
  canvasContainer: !!canvasContainer,
  statusEl: !!statusEl,
})

// Initialize NiiVue
const nv1 = new NiiVue({
  isColorbarVisible: true,
  backgroundColor: [0.1, 0.1, 0.1, 1],
  showRender: SHOW_RENDER.ALWAYS,
})

nv1.addEventListener('locationChange', (e) => handleLocationChange(e.detail))

// Listen for volume loaded events for better status updates
nv1.addEventListener('volumeLoaded', (e) => {
  console.log('Volume loaded event:', e.detail)
  const volume = e.detail.volume
  statusEl.textContent = `Loaded: ${volume.name}`
  initSliders(volume)
  setLoading(false)
})

nv1.addEventListener('volumeLoadedFailed', (e) => {
  console.error('Volume loading failed:', e.detail)
  statusEl.textContent = 'Failed: ' + e.detail.message
  setLoading(false)
  alert('Failed to load volume: ' + e.detail.message)
})

const canvasEl = document.getElementById('gl')
if (!canvasEl) {
  console.error('Canvas element not found')
  statusEl.textContent = 'Error: Canvas not found'
} else {
  try {
    await nv1.attachToCanvas(canvasEl)
    // Enable DICOM input after attach succeeds
    dicomInput.disabled = false
    statusEl.textContent = 'Ready - Select DICOM folder'
  } catch (err) {
    console.error('Failed to attach to canvas:', err)
    statusEl.textContent = 'Error: Failed to initialize viewer'
  }
}

// Load DICOM files
dicomInput.addEventListener('change', async () => {
  const files = Array.from(dicomInput.files)
  if (files.length === 0) {
    console.warn('No files selected')
    return
  }

  console.log(`Selected ${files.length} DICOM files`)

  try {
    setLoading(true, 'Converting DICOM to NIfTI...')
    statusEl.textContent = 'Converting DICOM...'

    console.time('dcm2niix')
    // Convert DICOM to NIfTI
    const niftiFiles = await runDcm2niix(files)
    console.timeEnd('dcm2niix')
    console.log('Generated NIfTI files:', niftiFiles.map(f => f.name))

    if (niftiFiles.length === 0) {
      throw new Error('No NIfTI files generated from DICOM')
    }

    setLoading(true, 'Loading volume...')
    statusEl.textContent = 'Loading volume...'

    // Load into NiiVue
    console.time('loadVolumes')
    const loadResult = await nv1.loadVolumes([{ url: niftiFiles[0] }])
    console.timeEnd('loadVolumes')
    console.log('Load volumes result:', loadResult)

    // Note: The canvas size warning you see is normal - NiiVue adapts canvas to image dimensions
    // You should be able to see the rendered volume now
  } catch (err) {
    console.error('DICOM loading error:', err)
    setLoading(false)
    statusEl.textContent = 'Error: ' + err.message
    alert('Failed to load DICOM: ' + err.message)
  }
})

// Slider events
levelSlider.addEventListener('input', () => {
  updateSliderValues()
  applyWindow()
})

widthSlider.addEventListener('input', () => {
  updateSliderValues()
  applyWindow()
})

// Auto window (Otsu threshold + 99.5th percentile)
autoBtn.addEventListener('click', async () => {
  if (nv1.volumes.length < 1) return
  const v = nv1.volumes[0]
  const img = v.img
  const slope = v.hdr?.scl_slope || 1
  const inter = v.hdr?.scl_inter || 0
  const BINS = 256
  const h = new Float64Array(BINS)
  const scale = (BINS - 1) / (gMax - gMin || 1)
  const stride = Math.max(1, Math.floor(img.length / 2e6))
  let n = 0
  for (let i = 0; i < img.length; i += stride) {
    const x = img[i] * slope + inter
    const b = Math.min(BINS - 1, Math.max(0, ((x - gMin) * scale) | 0))
    h[b]++
    n++
  }

  let sumAll = 0
  for (let i = 0; i < BINS; i++) sumAll += i * h[i]
  let sumB = 0
  let wB = 0
  let best = 0
  let bestVar = -1
  for (let t = 0; t < BINS; t++) {
    wB += h[t]
    if (wB === 0) continue
    const wF = n - wB
    if (wF === 0) break
    sumB += t * h[t]
    const mB = sumB / wB
    const mF = (sumAll - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > bestVar) {
      bestVar = between
      best = t
    }
  }

  let acc = 0
  let p995 = BINS - 1
  for (let i = 0; i < BINS; i++) {
    acc += h[i]
    if (acc >= n * 0.995) {
      p995 = i
      break
    }
  }

  const calMin = gMin + (best / (BINS - 1)) * (gMax - gMin)
  const calMax = gMin + (p995 / (BINS - 1)) * (gMax - gMin)

  nv1.setVolume(0, { calMin, calMax })

  // Update sliders to match
  const level = (calMin + calMax) / 2
  const width = calMax - calMin
  levelSlider.value = Math.round(level)
  widthSlider.value = Math.round(width)
  updateSliderValues()
})

// Reset to full range
resetBtn.addEventListener('click', () => {
  if (nv1.volumes.length < 1) return
  nv1.setVolume(0, { calMin: gMin, calMax: gMax })

  // Update sliders
  levelSlider.value = Math.round((gMin + gMax) / 2)
  widthSlider.value = Math.round(gMax - gMin)
  updateSliderValues()
})

// Drag and drop support (fallback)
canvasContainer.addEventListener('dragover', (e) => {
  e.preventDefault()
  canvasContainer.style.borderColor = '#4caf50'
})

canvasContainer.addEventListener('dragleave', (e) => {
  e.preventDefault()
  canvasContainer.style.borderColor = ''
})

canvasContainer.addEventListener('drop', async (e) => {
  e.preventDefault()
  canvasContainer.style.borderColor = ''

  const files = []
  if (e.dataTransfer && e.dataTransfer.items) {
    try {
      const { traverseDataTransferItems } = await import('@niivue/nv-ext-dcm2niix')
      const droppedFiles = await traverseDataTransferItems(e.dataTransfer.items)
      files.push(...droppedFiles)
    } catch {
      if (e.dataTransfer && e.dataTransfer.files) {
        files.push(...Array.from(e.dataTransfer.files))
      }
    }
  }

  if (files.length === 0) {
    console.warn('No files dropped')
    statusEl.textContent = 'No files dropped'
    return
  }

  console.log(`Dropped ${files.length} files`)
  // Reuse the same logic
  dicomInput.files = files.length > 0 ? createFileList(files) : dicomInput.files
  dicomInput.dispatchEvent(new Event('change'))
})

// Helper to create a FileList-like object
function createFileList(files) {
  const dataTransfer = new DataTransfer()
  files.forEach(file => dataTransfer.items.add(file))
  return dataTransfer.files
}
