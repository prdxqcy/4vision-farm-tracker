import { createWorker } from "tesseract.js";

const AUTO_CAPTURE_STORAGE_KEY = "farmtracks.auto-capture.v1";
const NARWASHI_PROFILE_ID = "narwashi-v1";
const TEMPLATE_SIZE = 28;
const TEMPLATE_INSET = 4;
const MATCH_SAMPLE_STEP = 2;
const SCAN_STEP = 2;
const SCALES = [0.88, 0.94, 1, 1.06, 1.12];
const MAX_MATCHES_PER_ITEM = 24;
const BASE_MATCH_THRESHOLD = 0.22;
const DUPLICATE_DISTANCE = 20;
const MAX_SLOT_COUNT = 199;
let ocrWorkerPromise = null;

export const NARWASHI_AUTO_CAPTURE_ITEMS = [
  { id: "crystals", name: "Crystal", shortName: "Crystal" },
  { id: "arcanes", name: "Arcane", shortName: "Arcane" },
  { id: "speed-potions", name: "Speed Potion", shortName: "Speed" }
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function createOffscreenCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function loadImage(dataUrl) {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  return image;
}

async function createCanvasFromImage(dataUrl) {
  const image = await loadImage(dataUrl);
  const canvas = createOffscreenCanvas(image.width, image.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  return canvas;
}

function getStoredProfiles() {
  try {
    const raw = window.localStorage.getItem(AUTO_CAPTURE_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function setStoredProfiles(profiles) {
  window.localStorage.setItem(AUTO_CAPTURE_STORAGE_KEY, JSON.stringify(profiles));
}

function cropTemplateCanvas(sourceCanvas, centerX, centerY) {
  const cropSize = TEMPLATE_SIZE;
  const half = cropSize / 2;
  const startX = clamp(Math.round(centerX - half), 0, Math.max(0, sourceCanvas.width - cropSize));
  const startY = clamp(Math.round(centerY - half), 0, Math.max(0, sourceCanvas.height - cropSize));
  const cropCanvas = createOffscreenCanvas(cropSize, cropSize);
  const cropContext = cropCanvas.getContext("2d", { willReadFrequently: true });
  cropContext.drawImage(sourceCanvas, startX, startY, cropSize, cropSize, 0, 0, cropSize, cropSize);
  return {
    canvas: cropCanvas,
    x: startX,
    y: startY,
    width: cropSize,
    height: cropSize
  };
}

function buildTemplateData(templateCanvas) {
  const context = templateCanvas.getContext("2d", { willReadFrequently: true });
  const imageData = context.getImageData(
    TEMPLATE_INSET,
    TEMPLATE_INSET,
    templateCanvas.width - (TEMPLATE_INSET * 2),
    templateCanvas.height - (TEMPLATE_INSET * 2)
  );

  return {
    width: imageData.width,
    height: imageData.height,
    data: imageData.data,
    dataUrl: templateCanvas.toDataURL("image/png")
  };
}

function normalizeMatchScore(score, sampleCount) {
  if (sampleCount === 0) {
    return 1;
  }

  return score / (sampleCount * 3 * 255);
}

function scoreTemplateAtPosition(screenData, screenWidth, template, originX, originY) {
  let score = 0;
  let sampleCount = 0;

  for (let y = 0; y < template.height; y += MATCH_SAMPLE_STEP) {
    for (let x = 0; x < template.width; x += MATCH_SAMPLE_STEP) {
      const screenIndex = ((originY + y) * screenWidth + (originX + x)) * 4;
      const templateIndex = (y * template.width + x) * 4;

      score += Math.abs(screenData[screenIndex] - template.data[templateIndex]);
      score += Math.abs(screenData[screenIndex + 1] - template.data[templateIndex + 1]);
      score += Math.abs(screenData[screenIndex + 2] - template.data[templateIndex + 2]);
      sampleCount += 1;
    }
  }

  return normalizeMatchScore(score, sampleCount);
}

function dedupeMatches(matches) {
  const sorted = [...matches].sort((left, right) => left.score - right.score);
  const kept = [];

  for (const match of sorted) {
    const duplicate = kept.some((candidate) => {
      const dx = candidate.x - match.x;
      const dy = candidate.y - match.y;
      return Math.sqrt((dx * dx) + (dy * dy)) < DUPLICATE_DISTANCE;
    });

    if (!duplicate) {
      kept.push(match);
    }
  }

  return kept;
}

function resizeCanvas(sourceCanvas, width, height) {
  const resizedCanvas = createOffscreenCanvas(width, height);
  const context = resizedCanvas.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.drawImage(sourceCanvas, 0, 0, width, height);
  return resizedCanvas;
}

function preprocessDigits(slotCanvas, variant) {
  const sourceWidth = slotCanvas.width;
  const sourceHeight = slotCanvas.height;
  const digitCanvas = createOffscreenCanvas(sourceWidth * variant.scale, Math.max(20, sourceHeight * 3));
  const context = digitCanvas.getContext("2d", { willReadFrequently: true });
  const cropY = Math.floor(sourceHeight * variant.cropTop);
  const cropHeight = Math.ceil(sourceHeight * variant.cropHeight);

  context.imageSmoothingEnabled = false;
  context.drawImage(slotCanvas, 0, cropY, sourceWidth, cropHeight, 0, 0, digitCanvas.width, digitCanvas.height);

  const imageData = context.getImageData(0, 0, digitCanvas.width, digitCanvas.height);
  const { data } = imageData;

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const highlight = (red * 0.45) + (green * 0.45) - (blue * 0.2);
    const isDigit = highlight > variant.threshold && red > variant.minRed && green > variant.minGreen;
    const nextValue = isDigit ? 255 : 0;

    data[index] = nextValue;
    data[index + 1] = nextValue;
    data[index + 2] = nextValue;
    data[index + 3] = 255;
  }

  context.putImageData(imageData, 0, 0);
  return digitCanvas;
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const worker = await createWorker("eng");
      await worker.setParameters({
        tessedit_pageseg_mode: "8",
        tessedit_char_whitelist: "0123456789"
      });
      return worker;
    })();
  }

  return ocrWorkerPromise;
}

async function extractCountFromSlot(screenCanvas, match) {
  const slotCanvas = createOffscreenCanvas(match.slotSize, match.slotSize);
  const slotContext = slotCanvas.getContext("2d", { willReadFrequently: true });
  slotContext.drawImage(
    screenCanvas,
    match.slotX,
    match.slotY,
    match.slotSize,
    match.slotSize,
    0,
    0,
    match.slotSize,
    match.slotSize
  );

  const worker = await getOcrWorker();
  const variants = [
    { cropTop: 0.42, cropHeight: 0.5, scale: 6, threshold: 78, minRed: 58, minGreen: 46 },
    { cropTop: 0.42, cropHeight: 0.5, scale: 6, threshold: 92, minRed: 68, minGreen: 52 },
    { cropTop: 0.46, cropHeight: 0.46, scale: 7, threshold: 82, minRed: 58, minGreen: 46 },
    { cropTop: 0.36, cropHeight: 0.58, scale: 7, threshold: 105, minRed: 70, minGreen: 58 }
  ];
  const candidates = [];

  for (const variant of variants) {
    const digitCanvas = preprocessDigits(slotCanvas, variant);
    const result = await worker.recognize(digitCanvas.toDataURL("image/png"));
    const rawResult = String(result?.data?.text ?? "").replace(/\s+/g, "");
    const digits = rawResult.replace(/\D/g, "");

    if (!digits) {
      continue;
    }

    const value = Number.parseInt(digits, 10);

    if (Number.isFinite(value) && value > 0 && value <= MAX_SLOT_COUNT) {
      candidates.push({
        value,
        confidence: Number(result?.data?.confidence ?? 0)
      });
    }
  }

  if (candidates.length === 0) {
    return 1;
  }

  candidates.sort((left, right) => {
    if (Math.abs(right.confidence - left.confidence) <= 6) {
      return right.value - left.value;
    }

    return right.confidence - left.confidence;
  });

  return candidates[0].value;
}

async function loadTemplateProfile(profileItem) {
  const baseCanvas = await createCanvasFromImage(profileItem.templateDataUrl);
  return {
    ...profileItem,
    canvas: baseCanvas
  };
}

async function findTemplateMatches(screenCanvas, profileItem) {
  const templateCanvas = await loadTemplateProfile(profileItem);
  const matches = [];
  const screenContext = screenCanvas.getContext("2d", { willReadFrequently: true });
  const screenImage = screenContext.getImageData(0, 0, screenCanvas.width, screenCanvas.height);

  for (const scale of SCALES) {
    const scaledWidth = Math.max(12, Math.round(templateCanvas.canvas.width * scale));
    const scaledHeight = Math.max(12, Math.round(templateCanvas.canvas.height * scale));
    const scaledCanvas = resizeCanvas(templateCanvas.canvas, scaledWidth, scaledHeight);
    const scaledContext = scaledCanvas.getContext("2d", { willReadFrequently: true });
    const imageData = scaledContext.getImageData(
      TEMPLATE_INSET,
      TEMPLATE_INSET,
      scaledWidth - (TEMPLATE_INSET * 2),
      scaledHeight - (TEMPLATE_INSET * 2)
    );

    const template = {
      width: imageData.width,
      height: imageData.height,
      data: imageData.data
    };

    const threshold = BASE_MATCH_THRESHOLD + Math.abs(1 - scale) * 0.05;

    for (let y = 0; y <= screenCanvas.height - template.height; y += SCAN_STEP) {
      for (let x = 0; x <= screenCanvas.width - template.width; x += SCAN_STEP) {
        const score = scoreTemplateAtPosition(screenImage.data, screenCanvas.width, template, x, y);

        if (score <= threshold) {
          matches.push({
            itemId: profileItem.itemId,
            x,
            y,
            score,
            scale,
            slotX: Math.max(0, Math.round(x - (TEMPLATE_INSET * scale))),
            slotY: Math.max(0, Math.round(y - (TEMPLATE_INSET * scale))),
            slotSize: Math.round(TEMPLATE_SIZE * scale)
          });
        }
      }
    }
  }

  return dedupeMatches(matches).slice(0, MAX_MATCHES_PER_ITEM);
}

export function loadNarwashiAutoCaptureProfile() {
  return getStoredProfiles()[NARWASHI_PROFILE_ID] ?? null;
}

export function clearNarwashiAutoCaptureProfile() {
  const profiles = getStoredProfiles();
  delete profiles[NARWASHI_PROFILE_ID];
  setStoredProfiles(profiles);
}

export async function createNarwashiAutoCaptureProfile({ screenshotDataUrl, selections }) {
  const sourceCanvas = await createCanvasFromImage(screenshotDataUrl);
  const items = [];

  for (const selection of selections) {
    const crop = cropTemplateCanvas(sourceCanvas, selection.x, selection.y);
    const templateData = buildTemplateData(crop.canvas);

    items.push({
      itemId: selection.itemId,
      templateDataUrl: templateData.dataUrl,
      width: crop.width,
      height: crop.height
    });
  }

  const profile = {
    id: NARWASHI_PROFILE_ID,
    createdAt: new Date().toISOString(),
    items
  };

  const profiles = getStoredProfiles();
  profiles[NARWASHI_PROFILE_ID] = profile;
  setStoredProfiles(profiles);

  return profile;
}

export async function captureDesktopScreenshot(options = {}) {
  if (!window.farmtracksDesktop?.captureScreen) {
    throw new Error("Desktop screenshot capture is only available in the Windows app.");
  }

  return window.farmtracksDesktop.captureScreen(options);
}

export async function scanNarwashiScreen(profile, options = {}) {
  if (!profile?.items?.length) {
    throw new Error("Complete auto-capture calibration before scanning.");
  }

  const screenshotDataUrl = await captureDesktopScreenshot(options);
  const screenCanvas = await createCanvasFromImage(screenshotDataUrl);
  const allMatches = [];

  for (const item of profile.items) {
    const matches = await findTemplateMatches(screenCanvas, item);
    allMatches.push(...matches);
  }

  const snapshot = {
    crystals: 0,
    arcanes: 0,
    "speed-potions": 0
  };

  const detailedMatches = await Promise.all(allMatches.map(async (match) => {
    const count = await extractCountFromSlot(screenCanvas, match);
    snapshot[match.itemId] += count;
    return { ...match, count };
  }));

  return {
    screenshotDataUrl,
    matches: detailedMatches,
    snapshot
  };
}
