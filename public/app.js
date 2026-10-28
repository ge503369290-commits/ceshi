const state = {
  user: null,
  materials: [],
  categories: [],
  tags: [],
  feedbackImages: [],
  feedbackDraft: "",
  compressor: {
    sources: [],
    results: [],
    quality: 72,
    maxWidth: 1600,
    outputType: "image/jpeg",
    status: ""
  },
  selected: null,
  view: "library",
  filters: { q: "", category: "", tag: "" },
  editing: null,
  formDraft: null,
  formImages: [],
  formVideo: null,
  contentBlocks: [],
  mindmap: createDefaultDiagram(),
  diagramSelected: "root",
  diagramChecked: new Set(),
  diagramClipboard: null,
  diagramCutPath: "",
  diagramZoom: 1,
  imagePreview: {
    images: [],
    index: 0,
    zoom: 1,
    panX: 0,
    panY: 0
  },
  noteEditorHtml: "",
  editorSelectionRange: null,
  tagEditorId: "",
  tagDraft: []
};

const app = document.querySelector("#app");
let diagramReflowTimer = null;
const feedbackLimits = {
  maxImages: 6,
  maxImageBytes: 3 * 1024 * 1024,
  maxTotalImageBytes: 4 * 1024 * 1024
};
const materialImageLimits = {
  maxImages: 9,
  maxSourceBytes: 12 * 1024 * 1024,
  targetBytes: 420 * 1024,
  maxWidth: 1600,
  minWidth: 720,
  quality: 0.76,
  minQuality: 0.44
};
const textStyleFontSizes = [14, 16, 18, 20, 22, 24, 28, 32];
const textStyleColors = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#eab308",
  "#84cc16",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#d946ef"
];
const readOnlyDiagramZoom = {
  min: 0.35,
  max: 2.5,
  step: 0.1
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function roleText(role) {
  return role === "admin" ? "管理员" : "员工";
}

function typeText(type) {
  return { text: "文字", image: "图文", video: "视频", mindmap: "思维导图" }[type] || "文字";
}

const diagramTypes = [
  { value: "mindmap", label: "思维导图" },
  { value: "org", label: "组织结构图" },
  { value: "fishbone", label: "鱼骨图" },
  { value: "logic", label: "逻辑图" },
  { value: "timeline", label: "时间轴" },
  { value: "tree", label: "树状图" },
  { value: "flow", label: "流程图" }
];

function diagramTypeText(type) {
  return diagramTypes.find((item) => item.value === type)?.label || "思维导图";
}

function clientId(prefix = "node") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isFiniteDiagramNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function createDiagramNode(text = "新节点", children = []) {
  return { id: clientId(), text, collapsed: false, children, width: 164, height: 56 };
}

function createDefaultDiagram(structure = "mindmap") {
  return {
    version: 2,
    structure,
    root: createDiagramNode("中心主题", [
      createDiagramNode("分支主题 A"),
      createDiagramNode("分支主题 B")
    ])
  };
}

function normalizeDiagram(input) {
  if (!input) return createDefaultDiagram();
  const normalizeNode = (node, fallback = "新节点") => ({
    id: node?.id || clientId(),
    text: String(node?.text || fallback),
    collapsed: Boolean(node?.collapsed),
    manualPosition: Boolean(node?.manualPosition),
    x: isFiniteDiagramNumber(node?.x) ? Number(node.x) : null,
    y: isFiniteDiagramNumber(node?.y) ? Number(node.y) : null,
    width: Math.max(110, isFiniteDiagramNumber(node?.width) ? Number(node.width) : 164),
    height: Math.max(44, isFiniteDiagramNumber(node?.height) ? Number(node.height) : 56),
    children: Array.isArray(node?.children) ? node.children.map((child) => normalizeNode(child)) : []
  });
  if (input.root) {
    return {
      version: 2,
      structure: diagramTypes.some((item) => item.value === input.structure) ? input.structure : "mindmap",
      root: normalizeNode(input.root, "中心主题")
    };
  }
  return {
    version: 2,
    structure: "mindmap",
    root: normalizeNode(input, "中心主题")
  };
}

function cloneDiagramNode(node) {
  return {
    id: clientId(),
    text: node.text,
    collapsed: Boolean(node.collapsed),
    manualPosition: false,
    x: null,
    y: null,
    width: node.width || 164,
    height: node.height || 56,
    children: (node.children || []).map(cloneDiagramNode)
  };
}

function applyCurrentLayoutGeometry(diagram) {
  const normalized = normalizeDiagram(diagram);
  const layout = buildDiagramLayout(normalized);
  const applyNode = (node, path) => {
    const item = layout.nodeByPath[path];
    if (item) {
      node.x = Math.round(item.x);
      node.y = Math.round(item.y);
      node.width = Math.round(item.width);
      node.height = Math.round(item.height);
    }
    (node.children || []).forEach((child, index) => applyNode(child, partsToPath([...pathToParts(path), index])));
  };
  applyNode(normalized.root, "root");
  return normalized;
}

function syncRenderedDiagramGeometry(diagram) {
  const editor = document.querySelector("#mindEditor");
  if (!editor) return diagram;
  editor.querySelectorAll(".map-topic[data-diagram-path]").forEach((topic) => {
    try {
      const node = getDiagramNode(topic.dataset.diagramPath, diagram);
      const left = parseFloat(topic.style.left);
      const top = parseFloat(topic.style.top);
      const width = parseFloat(topic.style.width) || Number(topic.dataset.topicWidth);
      const height = parseFloat(topic.style.height) || Number(topic.dataset.topicHeight);
      if ([left, top, width, height].every(Number.isFinite)) {
        node.x = Math.round(left + width / 2);
        node.y = Math.round(top + height / 2);
        node.width = Math.round(width);
        node.height = Math.round(height);
      }
    } catch {
      // Ignore stale DOM nodes from an editor that has already refreshed.
    }
  });
  return diagram;
}

function serializeDiagram(diagram) {
  return applyCurrentLayoutGeometry(syncRenderedDiagramGeometry(diagram));
}

function normalizeBlockImages(block = {}) {
  const images = Array.isArray(block.images) ? [...block.images] : [];
  if (block.image) images.unshift(block.image);
  const seen = new Set();
  return images.filter((image) => {
    if (!image?.dataUrl) return false;
    const key = `${image.name || ""}:${image.dataUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createContentBlock(type, data = {}) {
  if (type === "document") {
    return {
      id: clientId("block"),
      type: "document",
      body: String(data.body || ""),
      html: String(data.html || ""),
      images: normalizeBlockImages(data).slice(0, 9)
    };
  }
  if (type === "image") {
    const images = normalizeBlockImages(data).slice(0, 9);
    return {
      id: clientId("block"),
      type: "image",
      body: String(data.body || ""),
      image: images[0] || null,
      images,
      richText: normalizeRichTextSegments(data.richText, data.body, data.textStyle)
    };
  }
  if (type === "mindmap") {
    return { id: clientId("block"), type: "mindmap" };
  }
  return {
    id: clientId("block"),
    type: "text",
    body: String(data.body || ""),
    richText: normalizeRichTextSegments(data.richText, data.body, data.textStyle)
  };
}

function normalizeContentBlocks(material = {}) {
  if (Array.isArray(material.blocks) && material.blocks.length) {
    return material.blocks
      .map((block) => {
        if (block.type === "document") return createContentBlock("document", block);
        if (block.type === "image") return createContentBlock("image", { body: block.body || "", image: block.image || null, images: block.images, richText: block.richText, textStyle: block.textStyle });
        if (block.type === "mindmap") return createContentBlock("mindmap");
        return createContentBlock("text", { body: block.body || "", richText: block.richText, textStyle: block.textStyle });
      })
      .filter(Boolean);
  }

  const blocks = [];
  if (material.body) blocks.push(createContentBlock("text", { body: material.body }));
  (material.images || []).forEach((image) => blocks.push(createContentBlock("image", { image })));
  if (material.mindmap) blocks.push(createContentBlock("mindmap"));
  return blocks;
}

function resetMaterialDraft(material = null) {
  state.editing = material;
  state.formDraft = null;
  state.formImages = material?.images || [];
  state.formVideo = material?.video || null;
  state.contentBlocks = normalizeContentBlocks(material || {});
  state.noteEditorHtml = materialToEditorHtml(material || {});
  state.editorSelectionRange = null;
  state.mindmap = normalizeDiagram(material?.mindmap);
  state.diagramSelected = "root";
  state.diagramChecked = new Set();
  state.diagramClipboard = null;
  state.diagramCutPath = "";
}

function serializeContentBlocks() {
  document.querySelectorAll("[data-block-rich]").forEach((editor) => {
    const block = state.contentBlocks[Number(editor.dataset.blockRich)];
    if (block) syncRichTextBlock(block, editor);
  });
  return state.contentBlocks
    .map((block) => {
      if (block.type === "image") {
        syncRichTextBlock(block);
        const images = normalizeBlockImages(block).slice(0, 9);
        return images.length || String(block.body || "").trim()
          ? { type: "image", body: String(block.body || ""), images, richText: normalizeRichTextSegments(block.richText, block.body) }
          : null;
      }
      if (block.type === "mindmap") return { type: "mindmap", mindmap: serializeDiagram(state.mindmap) };
      syncRichTextBlock(block);
      return { type: "text", body: String(block.body || ""), richText: normalizeRichTextSegments(block.richText, block.body) };
    })
    .filter((block) => block && (block.type !== "text" || block.body.trim()));
}

function deriveMaterialType(blocks) {
  if (blocks.some((block) => block.type === "mindmap")) return "mindmap";
  if (blocks.some((block) => block.type === "image")) return "image";
  return "text";
}

function resetEmptyMaterialDraft() {
  resetMaterialDraft({
    body: "",
    images: [],
    video: null,
    mindmap: null,
    blocks: []
  });
  state.editing = null;
  state.formDraft = null;
  state.noteEditorHtml = "";
  state.editorSelectionRange = null;
}

function rememberMaterialForm() {
  const form = document.querySelector("#materialForm");
  if (!form) return;
  const data = new FormData(form);
  state.formDraft = {
    title: String(data.get("title") || "")
  };
}

function pathToParts(path) {
  if (!path || path === "root") return [];
  return path.split(".").filter(Boolean).map(Number);
}

function partsToPath(parts) {
  return parts.length ? parts.join(".") : "root";
}

function getDiagramNode(path, diagram = state.mindmap) {
  const parts = pathToParts(path);
  return parts.reduce((node, index) => node.children[index], diagram.root);
}

function safeDiagramPath(path) {
  try {
    getDiagramNode(path);
    return path;
  } catch {
    return "root";
  }
}

function selectedDiagramNode() {
  state.diagramSelected = safeDiagramPath(state.diagramSelected);
  return getDiagramNode(state.diagramSelected);
}

function getDiagramParent(path, diagram = state.mindmap) {
  const parts = pathToParts(path);
  if (!parts.length) return null;
  const index = parts.at(-1);
  const parent = parts.slice(0, -1).reduce((node, item) => node.children[item], diagram.root);
  return { parent, index, parentPath: partsToPath(parts.slice(0, -1)) };
}

function isDescendantPath(path, maybeParent) {
  return path !== maybeParent && path.startsWith(`${maybeParent}.`);
}

function addDiagramChild(path) {
  const node = getDiagramNode(path);
  node.children ||= [];
  node.children.push(createDiagramNode("新子节点"));
  node.collapsed = false;
  state.diagramSelected = partsToPath([...pathToParts(path), node.children.length - 1]);
}

function addDiagramSibling(path) {
  const ref = getDiagramParent(path);
  if (!ref) return addDiagramChild(path);
  ref.parent.children.splice(ref.index + 1, 0, createDiagramNode("新同级节点"));
  state.diagramSelected = partsToPath([...pathToParts(ref.parentPath), ref.index + 1]);
}

function removeDiagramNode(path) {
  const ref = getDiagramParent(path);
  if (!ref) return;
  ref.parent.children.splice(ref.index, 1);
  state.diagramSelected = ref.parentPath;
  state.diagramChecked.delete(path);
}

function moveDiagramNode(sourcePath, targetPath, mode = "child") {
  if (!sourcePath || sourcePath === "root" || sourcePath === targetPath || isDescendantPath(targetPath, sourcePath)) return false;
  const sourceRef = getDiagramParent(sourcePath);
  if (!sourceRef) return false;
  const [node] = sourceRef.parent.children.splice(sourceRef.index, 1);
  let adjustedTarget = targetPath;
  const sourceParts = pathToParts(sourcePath);
  const targetParts = pathToParts(targetPath);
  if (targetParts.length && sourceParts.length === targetParts.length && sourceParts.slice(0, -1).join(".") === targetParts.slice(0, -1).join(".") && sourceRef.index < targetParts.at(-1)) {
    adjustedTarget = partsToPath([...targetParts.slice(0, -1), targetParts.at(-1) - 1]);
  }
  if (mode === "sibling") {
    const targetRef = getDiagramParent(adjustedTarget);
    if (!targetRef) {
      state.mindmap.root.children.push(node);
      state.diagramSelected = partsToPath([state.mindmap.root.children.length - 1]);
      return true;
    }
    targetRef.parent.children.splice(targetRef.index + 1, 0, node);
    state.diagramSelected = partsToPath([...pathToParts(targetRef.parentPath), targetRef.index + 1]);
    return true;
  }
  const target = getDiagramNode(adjustedTarget);
  target.children ||= [];
  target.children.push(node);
  target.collapsed = false;
  state.diagramSelected = partsToPath([...pathToParts(adjustedTarget), target.children.length - 1]);
  return true;
}

function copyDiagramNode(path, cut = false) {
  const node = getDiagramNode(path);
  state.diagramClipboard = cloneDiagramNode(node);
  state.diagramCutPath = cut && path !== "root" ? path : "";
}

function pasteDiagramNode(path) {
  if (!state.diagramClipboard) return;
  const target = getDiagramNode(path);
  target.children ||= [];
  const pasted = cloneDiagramNode(state.diagramClipboard);
  target.children.push(pasted);
  target.collapsed = false;
  if (state.diagramCutPath) {
    removeDiagramNode(state.diagramCutPath);
    state.diagramCutPath = "";
  }
  state.diagramSelected = partsToPath([...pathToParts(path), target.children.length - 1]);
}

function duplicateDiagramNode(path) {
  const ref = getDiagramParent(path);
  if (!ref) return;
  const duplicated = cloneDiagramNode(getDiagramNode(path));
  ref.parent.children.splice(ref.index + 1, 0, duplicated);
  state.diagramSelected = partsToPath([...pathToParts(ref.parentPath), ref.index + 1]);
}

function moveDiagramSibling(path, direction) {
  const ref = getDiagramParent(path);
  if (!ref) return false;
  const targetIndex = ref.index + direction;
  if (targetIndex < 0 || targetIndex >= ref.parent.children.length) return false;
  const [node] = ref.parent.children.splice(ref.index, 1);
  ref.parent.children.splice(targetIndex, 0, node);
  state.diagramSelected = partsToPath([...pathToParts(ref.parentPath), targetIndex]);
  return true;
}

function promoteDiagramNode(path) {
  const ref = getDiagramParent(path);
  if (!ref || !ref.parentPath || ref.parentPath === "root") return false;
  const grand = getDiagramParent(ref.parentPath);
  if (!grand) return false;
  const [node] = ref.parent.children.splice(ref.index, 1);
  grand.parent.children.splice(grand.index + 1, 0, node);
  state.diagramSelected = partsToPath([...pathToParts(grand.parentPath), grand.index + 1]);
  return true;
}

function flattenDiagramPaths(node = state.mindmap.root, path = "root", result = []) {
  result.push(path);
  if (!node.collapsed) {
    (node.children || []).forEach((child, index) => flattenDiagramPaths(child, partsToPath([...pathToParts(path), index]), result));
  }
  return result;
}

function navigateDiagram(direction) {
  const paths = flattenDiagramPaths();
  const current = Math.max(0, paths.indexOf(state.diagramSelected));
  if (direction === "up") state.diagramSelected = paths[Math.max(0, current - 1)];
  if (direction === "down") state.diagramSelected = paths[Math.min(paths.length - 1, current + 1)];
  if (direction === "left") {
    const node = getDiagramNode(state.diagramSelected);
    if ((node.children || []).length && !node.collapsed) node.collapsed = true;
    else state.diagramSelected = getDiagramParent(state.diagramSelected)?.parentPath || "root";
  }
  if (direction === "right") {
    const node = getDiagramNode(state.diagramSelected);
    if ((node.children || []).length && node.collapsed) node.collapsed = false;
    else if ((node.children || []).length) state.diagramSelected = partsToPath([...pathToParts(state.diagramSelected), 0]);
  }
}

function downloadDiagramJson() {
  const blob = new Blob([JSON.stringify(serializeDiagram(state.mindmap), null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "mindmap.json";
  link.click();
  URL.revokeObjectURL(link.href);
}

function setError(message) {
  const target = document.querySelector("[data-error]");
  if (target) target.innerHTML = message ? `<div class="error">${escapeHtml(message)}</div>` : "";
}

function fileToDataUrl(file, maxBytes, label) {
  return new Promise((resolve, reject) => {
    if (file.size > maxBytes) {
      reject(new Error(`${label}文件过大`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, dataUrl: reader.result });
    reader.onerror = () => reject(new Error(`${label}读取失败`));
    reader.readAsDataURL(file);
  });
}

function formatBytes(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function revokeCompressorUrls(items = []) {
  items.forEach((item) => {
    if (item?.url) URL.revokeObjectURL(item.url);
  });
}

function resetCompressorResults() {
  revokeCompressorUrls(state.compressor.results);
  state.compressor.results = [];
}

function imageTypeExtension(type = "") {
  return { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[type] || "jpg";
}

function compressedFileName(name = "image", type = "image/jpeg") {
  const base = name.replace(/\.[^.]+$/, "") || "image";
  return `${base}-compressed.${imageTypeExtension(type)}`;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片读取失败"));
    image.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("图片压缩失败"))), type, quality);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
}

async function renderCompressedBlob(source, type, quality, widthLimit) {
  const image = await loadImage(source.url);
  const scale = Math.min(1, widthLimit / image.naturalWidth);
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  canvas.width = width;
  canvas.height = height;
  if (type === "image/jpeg") {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(image, 0, 0, width, height);
  const blob = await canvasToBlob(canvas, type, type === "image/png" ? undefined : quality);
  return { blob, width, height };
}

async function compressMaterialImage(file) {
  if (file.size > materialImageLimits.maxSourceBytes) throw new Error("单张原图不能超过 12MB");
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(sourceUrl);
    let widthLimit = Math.min(image.naturalWidth, materialImageLimits.maxWidth);
    let quality = materialImageLimits.quality;
    let compressed = null;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      compressed = await renderCompressedBlob({ url: sourceUrl }, "image/jpeg", quality, widthLimit);
      const canReduceQuality = quality > materialImageLimits.minQuality;
      const canReduceWidth = widthLimit > materialImageLimits.minWidth;
      if (compressed.blob.size <= materialImageLimits.targetBytes || (!canReduceQuality && !canReduceWidth)) break;
      if (canReduceQuality) quality = Math.max(materialImageLimits.minQuality, quality - 0.08);
      else widthLimit = Math.max(materialImageLimits.minWidth, Math.floor(widthLimit * 0.86));
    }

    return {
      name: compressedFileName(file.name, "image/jpeg"),
      dataUrl: await blobToDataUrl(compressed.blob),
      size: compressed.blob.size,
      width: compressed.width,
      height: compressed.height
    };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

async function compressCompressorSource(source) {
  const outputType = state.compressor.outputType;
  const baseQuality = Math.max(35, Math.min(92, Number(state.compressor.quality) || 72)) / 100;
  const sourceWidth = source.width || state.compressor.maxWidth;
  let widthLimit = Math.min(sourceWidth, Math.max(320, Number(state.compressor.maxWidth) || 1600));
  let quality = baseQuality;
  let compressed = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    compressed = await renderCompressedBlob(source, outputType, quality, widthLimit);
    if (compressed.blob.size < source.size || attempt === 4) break;
    quality = Math.max(0.35, quality - 0.15);
    widthLimit = Math.max(320, Math.floor(widthLimit * 0.85));
  }

  const saved = source.size - compressed.blob.size;
  return {
    url: URL.createObjectURL(compressed.blob),
    name: compressedFileName(source.name, outputType),
    size: compressed.blob.size,
    type: outputType,
    width: compressed.width,
    height: compressed.height,
    saved,
    savedPercent: source.size ? Math.max(0, Math.round((saved / source.size) * 100)) : 0
  };
}

async function compressCurrentImages() {
  const sources = state.compressor.sources;
  if (!sources.length) return;
  resetCompressorResults();
  state.compressor.status = `正在压缩 ${sources.length} 张图片...`;
  renderMainView();
  const results = [];
  for (const source of sources) {
    try {
      results.push(await compressCompressorSource(source));
    } catch (error) {
      results.push({ name: source.name, error: error.message || "图片压缩失败" });
    }
  }
  state.compressor.results = results;
  const completed = results.filter((item) => item.url).length;
  const failed = results.length - completed;
  state.compressor.status = failed
    ? `已压缩 ${completed} 张，${failed} 张处理失败。`
    : `${completed} 张图片已全部压缩完成。`;
  renderMainView();
}

async function selectCompressorImages(files) {
  const selectedFiles = Array.from(files || []);
  if (!selectedFiles.length) return;
  const imageFiles = selectedFiles.filter((file) => file.type.startsWith("image/"));
  if (!imageFiles.length) {
    state.compressor.status = "请选择图片文件。";
    renderMainView();
    return;
  }
  revokeCompressorUrls(state.compressor.sources);
  resetCompressorResults();
  state.compressor.sources = [];
  for (const file of imageFiles) {
    const url = URL.createObjectURL(file);
    try {
      const image = await loadImage(url);
      state.compressor.sources.push({
        url,
        name: file.name,
        size: file.size,
        type: file.type,
        width: image.naturalWidth,
        height: image.naturalHeight
      });
    } catch {
      URL.revokeObjectURL(url);
    }
  }
  if (!state.compressor.sources.length) {
    state.compressor.status = "所选图片均无法读取。";
    renderMainView();
    return;
  }
  state.compressor.status = imageFiles.length < selectedFiles.length ? "已忽略非图片文件。" : "";
  await compressCurrentImages();
}

function normalizeTextStyle(style = {}) {
  const fontSize = Number(style?.fontSize);
  const color = String(style?.color || "");
  return {
    fontSize: textStyleFontSizes.includes(fontSize) ? fontSize : "",
    color: textStyleColors.includes(color) ? color : ""
  };
}

function normalizeRichColor(value) {
  const color = String(value || "").trim();
  if (textStyleColors.includes(color)) return color;
  const rgb = color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i);
  if (!rgb) return "";
  const hex = `#${rgb
    .slice(1)
    .map((part) => Number(part).toString(16).padStart(2, "0"))
    .join("")}`;
  return textStyleColors.includes(hex) ? hex : "";
}

function normalizeRichTextSegments(segments, fallbackBody = "", fallbackStyle = {}) {
  const normalized = [];
  if (Array.isArray(segments)) {
    segments.forEach((segment) => {
      const text = String(segment?.text || "");
      if (!text) return;
      const style = normalizeTextStyle(segment);
      normalized.push({ text, ...style });
    });
  }
  if (!normalized.length && String(fallbackBody || "")) {
    normalized.push({ text: String(fallbackBody || ""), ...normalizeTextStyle(fallbackStyle) });
  }
  return mergeRichTextSegments(normalized);
}

function mergeRichTextSegments(segments = []) {
  return segments.reduce((items, segment) => {
    const normalized = { text: String(segment.text || ""), ...normalizeTextStyle(segment) };
    if (!normalized.text) return items;
    const previous = items.at(-1);
    if (previous && previous.fontSize === normalized.fontSize && previous.color === normalized.color) previous.text += normalized.text;
    else items.push(normalized);
    return items;
  }, []);
}

function richTextPlainText(segments = []) {
  return normalizeRichTextSegments(segments).map((segment) => segment.text).join("");
}

function textStyleAttribute(style = {}) {
  const normalized = normalizeTextStyle(style);
  const rules = [];
  if (normalized.fontSize) rules.push(`font-size:${normalized.fontSize}px`);
  if (normalized.color) rules.push(`color:${normalized.color}`);
  return rules.length ? ` style="${rules.join(";")}"` : "";
}

function renderRichTextSegments(segments = [], fallbackBody = "", fallbackStyle = {}) {
  return normalizeRichTextSegments(segments, fallbackBody, fallbackStyle)
    .map((segment) => {
      const content = escapeHtml(segment.text).replaceAll("\n", "<br>");
      const attrs = textStyleAttribute(segment);
      return attrs ? `<span${attrs}>${content}</span>` : content;
    })
    .join("");
}

function renderRichTextControls(index) {
  return `
    <div class="text-style-controls" data-style-controls="${index}">
      <label class="field compact">
        <span>选中文字字号</span>
        <select data-rich-font-size="${index}">
          <option value="">字号</option>
          ${textStyleFontSizes.map((size) => `<option value="${size}">${size}px</option>`).join("")}
        </select>
      </label>
      <div class="color-ring" aria-label="文字颜色">
        <button type="button" class="color-swatch reset" title="默认颜色" data-rich-color="${index}" data-color="">默认</button>
        ${textStyleColors
          .map(
            (color) => `
              <button type="button" class="color-swatch" style="--swatch:${color}" title="${color}" data-rich-color="${index}" data-color="${color}"></button>
            `
          )
          .join("")}
      </div>
      <div class="muted rich-editor-hint">先选中文本，再修改字号或颜色。</div>
    </div>
  `;
}

function renderRichTextEditor(block, index, label, placeholder) {
  return `
    ${renderRichTextControls(index)}
    <label class="field rich-field">
      <span>${label}</span>
      <div class="rich-editor" contenteditable="true" data-block-rich="${index}" data-placeholder="${escapeHtml(placeholder)}">${renderRichTextSegments(block.richText, block.body)}</div>
    </label>
  `;
}

function getRichTextStyleFromElement(element, inherited = {}) {
  const style = {
    fontSize: inherited.fontSize || "",
    color: inherited.color || ""
  };
  if (element?.style?.fontSize) {
    const size = parseInt(element.style.fontSize, 10);
    if (textStyleFontSizes.includes(size)) style.fontSize = size;
  }
  if (element?.style?.color) style.color = normalizeRichColor(element.style.color) || style.color;
  return style;
}

function readRichTextSegments(editor) {
  const segments = [];
  const append = (text, style = {}) => {
    if (!text) return;
    segments.push({ text, ...normalizeTextStyle(style) });
  };
  const walk = (node, inherited = {}) => {
    if (node.nodeType === Node.TEXT_NODE) {
      append(node.textContent, inherited);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toLowerCase();
    if (tag === "br") {
      append("\n", inherited);
      return;
    }
    const nextStyle = getRichTextStyleFromElement(node, inherited);
    node.childNodes.forEach((child) => walk(child, nextStyle));
    if (["div", "p"].includes(tag) && segments.length && !segments.at(-1).text.endsWith("\n")) append("\n", nextStyle);
  };
  editor.childNodes.forEach((node) => walk(node, {}));
  return mergeRichTextSegments(segments).map((segment, index, items) => {
    if (index === items.length - 1) return { ...segment, text: segment.text.replace(/\n+$/, "") };
    return segment;
  }).filter((segment) => segment.text);
}

function syncRichTextBlock(block, editor = null) {
  if (editor) block.richText = readRichTextSegments(editor);
  block.richText = normalizeRichTextSegments(block.richText, block.body);
  block.body = richTextPlainText(block.richText);
}

function applyRichTextStyle(index, patch = {}) {
  const editor = document.querySelector(`[data-block-rich="${index}"]`);
  if (!editor) return;
  editor.focus();
  const selection = window.getSelection();
  if (!selection?.rangeCount) {
    setError("请先选中要修改的文字");
    return;
  }
  const range = selection.getRangeAt(0);
  if (range.collapsed || !editor.contains(range.commonAncestorContainer)) {
    setError("请先选中要修改的文字");
    return;
  }
  setError("");
  const text = range.toString();
  const span = document.createElement("span");
  const style = normalizeTextStyle(patch);
  if (style.fontSize) span.style.fontSize = `${style.fontSize}px`;
  if (style.color) span.style.color = style.color;
  span.textContent = text;
  range.deleteContents();
  range.insertNode(span);
  selection.removeAllRanges();
  const nextRange = document.createRange();
  nextRange.selectNodeContents(span);
  nextRange.collapse(false);
  selection.addRange(nextRange);
  syncRichTextBlock(state.contentBlocks[index], editor);
}

function sanitizeEditorHtml(value = "") {
  const template = document.createElement("template");
  template.innerHTML = String(value || "");
  const allowedTags = new Set(["P", "DIV", "BR", "SPAN", "STRONG", "B", "EM", "I", "U", "H1", "H2", "H3", "UL", "OL", "LI", "BLOCKQUOTE", "A", "IMG", "FONT"]);
  const allowedStyles = new Set(["color", "font-family", "font-size", "text-align"]);
  const cleanNode = (node) => {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === Node.COMMENT_NODE) {
        child.remove();
        return;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      if (!allowedTags.has(child.tagName)) {
        cleanNode(child);
        child.replaceWith(...child.childNodes);
        return;
      }
      const originalStyle = child.getAttribute("style") || "";
      const href = child.tagName === "A" ? String(child.getAttribute("href") || "") : "";
      const source = child.tagName === "IMG" ? String(child.getAttribute("src") || "") : "";
      const imageName = child.tagName === "IMG" ? String(child.getAttribute("alt") || "笔记图片") : "";
      const font = child.tagName === "FONT" ? { color: child.color, face: child.face, size: child.size } : null;
      [...child.attributes].forEach((attribute) => child.removeAttribute(attribute.name));
      if (child.tagName === "A" && /^https?:\/\//i.test(href)) {
        child.setAttribute("href", href);
        child.setAttribute("target", "_blank");
        child.setAttribute("rel", "noreferrer");
      }
      if (child.tagName === "IMG") {
        if (!source.startsWith("data:image/")) {
          child.remove();
          return;
        }
        child.setAttribute("src", source);
        child.setAttribute("alt", imageName);
        child.setAttribute("data-note-image", "true");
      }
      if (font) {
        if (font.color) child.setAttribute("color", font.color);
        if (font.face) child.setAttribute("face", font.face);
        if (font.size) child.setAttribute("size", font.size);
      }
      if (originalStyle) {
        const probe = document.createElement("span");
        probe.setAttribute("style", originalStyle);
        [...probe.style].forEach((property) => {
          if (allowedStyles.has(property)) child.style.setProperty(property, probe.style.getPropertyValue(property));
        });
      }
      cleanNode(child);
    });
  };
  cleanNode(template.content);
  return template.innerHTML;
}

function materialToEditorHtml(material = {}) {
  const blocks = Array.isArray(material.blocks) ? material.blocks : [];
  const documentBlock = blocks.find((block) => block?.type === "document");
  if (documentBlock?.html) return sanitizeEditorHtml(documentBlock.html);
  if (!blocks.length && material.body) return `<p>${escapeHtml(material.body).replaceAll("\n", "<br>")}</p>`;
  return blocks
    .filter((block) => block?.type !== "mindmap")
    .map((block) => {
      const text = renderRichTextSegments(block.richText, block.body, block.textStyle);
      const paragraphs = text ? `<p>${text}</p>` : "";
      if (block.type !== "image") return paragraphs;
      const images = normalizeBlockImages(block).map((image) => `<p class="ynote-image-line"><img src="${image.dataUrl}" alt="${escapeHtml(image.name || "笔记图片")}" data-note-image="true"></p>`).join("");
      return `${paragraphs}${images}`;
    })
    .join("");
}

function noteEditorPlainText(editor) {
  return String(editor?.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
}

function noteEditorImages(editor) {
  return [...(editor?.querySelectorAll("img") || [])]
    .map((image) => ({ name: image.alt || "笔记图片", dataUrl: image.getAttribute("src") || "" }))
    .filter((image) => image.dataUrl.startsWith("data:image/"))
    .slice(0, 9);
}

function saveEditorSelection(editor) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (editor.contains(range.commonAncestorContainer)) state.editorSelectionRange = range.cloneRange();
}

function restoreEditorSelection(editor) {
  editor.focus();
  if (!state.editorSelectionRange || !editor.contains(state.editorSelectionRange.commonAncestorContainer)) return;
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(state.editorSelectionRange);
}

function syncNoteEditor(editor) {
  state.noteEditorHtml = sanitizeEditorHtml(editor.innerHTML);
}

async function insertNoteImages(files, editor) {
  const imageFiles = Array.from(files || []).filter((file) => file.type?.startsWith("image/"));
  if (!imageFiles.length) return;
  const currentCount = noteEditorImages(editor).length;
  if (currentCount + imageFiles.length > 9) throw new Error("一篇笔记最多插入 9 张图片");
  restoreEditorSelection(editor);
  for (const file of imageFiles) {
    const image = await compressMaterialImage(file);
    document.execCommand("insertHTML", false, `<p class="ynote-image-line"><img src="${image.dataUrl}" alt="${escapeHtml(image.name || "笔记图片")}" data-note-image="true"></p><p><br></p>`);
  }
  syncNoteEditor(editor);
}

async function loadBootstrap() {
  const data = await api(`/api/bootstrap?${new URLSearchParams(state.filters)}`);
  state.user = data.user;
  state.materials = data.materials;
  state.categories = data.categories;
  state.tags = data.tags;
}

async function boot() {
  const data = await api("/api/me");
  state.user = data.user;
  if (data.setupRequired) {
    renderSetup();
    return;
  }
  if (!state.user) {
    renderLogin();
    return;
  }
  await loadBootstrap();
  renderShell();
}

function renderSetup() {
  app.innerHTML = `
    <section class="login-page">
      <form class="login-card" id="setupForm">
        <h1>初始化内部培训知识库</h1>
        <p class="muted">这是首次生产部署，请创建管理员密码。完成后初始化入口会自动关闭。</p>
        <div data-error></div>
        <label class="field"><span>管理员名称</span><input name="displayName" value="系统管理员" required /></label>
        <label class="field"><span>管理员密码（至少 12 位）</span><input name="password" type="password" minlength="12" autocomplete="new-password" required /></label>
        <label class="field"><span>确认密码</span><input name="confirmPassword" type="password" minlength="12" autocomplete="new-password" required /></label>
        <button class="btn" type="submit">完成初始化</button>
      </form>
    </section>
  `;
  document.querySelector("#setupForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    if (form.get("password") !== form.get("confirmPassword")) {
      setError("两次输入的密码不一致");
      return;
    }
    try {
      await api("/api/setup", {
        method: "POST",
        body: JSON.stringify({ displayName: form.get("displayName"), password: form.get("password") })
      });
      await loadBootstrap();
      renderShell();
    } catch (error) {
      setError(error.message);
    }
  });
}

function renderLogin() {
  app.innerHTML = `
    <section class="login-page">
      <form class="login-card" id="loginForm">
        <h1>内部培训知识库</h1>
        <p class="muted">请输入管理员创建的账号密码。</p>
        <div data-error></div>
        <label class="field"><span>账号</span><input name="username" autocomplete="username" required /></label>
        <label class="field"><span>密码</span><input name="password" type="password" autocomplete="current-password" required /></label>
        <button class="btn" type="submit">登录</button>
      </form>
    </section>
  `;
  document.querySelector("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = "登录中…";
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/login", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(form))
      });
      await loadBootstrap();
      renderShell();
    } catch (error) {
      setError(error.message);
      button.disabled = false;
      button.textContent = "登录";
    }
  });
}

function renderShell() {
  const editorMode = state.view === "adminEditor";
  const fullWidthMode = editorMode || ["leadGenerator", "merchantData", "compressor"].includes(state.view);
  app.innerHTML = `
    <section class="shell">
      <div class="utility-bar">
        <span>企业学习中心</span>
        <span>资料、图文、视频、在线思维导图</span>
      </div>
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark">TL</span>
          <strong>内部培训知识库</strong>
        </div>
        <div class="userbar">
          <span>${escapeHtml(state.user.displayName)} / ${escapeHtml(state.user.username)}</span>
          <span class="badge">${roleText(state.user.role)}</span>
          <button class="btn secondary" data-action="logout">退出</button>
        </div>
      </header>
      <div class="layout ${fullWidthMode ? "editor-layout" : ""}">
        ${fullWidthMode ? "" : `<aside class="sidebar">${renderFilters()}</aside>`}
        <section class="content">
          ${renderTabs()}
          <div id="mainView"></div>
        </section>
      </div>
    </section>
  `;
  bindShell();
  renderMainView();
}

function renderTabs() {
  const tabs = [
    `<button class="tab ${state.view === "library" ? "active" : ""}" data-view="library">资料库</button>`,
    `<button class="tab ${state.view === "leadGenerator" ? "active" : ""}" data-view="leadGenerator">线索数据生成</button>`,
    `<button class="tab ${state.view === "merchantData" ? "active" : ""}" data-view="merchantData">商户数据</button>`,
    `<button class="tab ${state.view === "compressor" ? "active" : ""}" data-view="compressor">图片压缩</button>`
  ];
  if (state.user.role === "admin") {
    tabs.push(`<button class="tab ${["admin", "adminEditor", "feedbacks"].includes(state.view) ? "active" : ""}" data-view="admin">管理后台</button>`);
    tabs.push(`<button class="tab ${state.view === "users" ? "active" : ""}" data-view="users">账号管理</button>`);
    tabs.push(`<button class="tab ${state.view === "logs" ? "active" : ""}" data-view="logs">操作日志</button>`);
  }
  return `<nav class="tabs">${tabs.join("")}</nav>`;
}

function renderFilters() {
  return `
    <div class="filters">
      <div class="filter-heading">
        <strong>筛选资料</strong>
        <span>${state.materials.length} 项内容</span>
      </div>
      <label class="field"><span>搜索</span><input data-filter="q" value="${escapeHtml(state.filters.q)}" placeholder="标题、正文、标签" /></label>
      <label class="field">
        <span>分类</span>
        <select data-filter="category">
          <option value="">全部分类</option>
          ${state.categories.map((item) => `<option ${item === state.filters.category ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}
        </select>
      </label>
      <label class="field">
        <span>标签</span>
        <select data-filter="tag">
          <option value="">全部标签</option>
          ${state.tags.map((item) => `<option ${item === state.filters.tag ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}
        </select>
      </label>
      <button class="btn" data-action="applyFilters">筛选</button>
      <button class="btn secondary" data-action="clearFilters">清空</button>
      ${renderFeedbackPanel()}
    </div>
  `;
}

function renderFeedbackPanel() {
  if (state.user.role === "admin") {
    return `
      <div class="feedback-panel">
        <div class="filter-heading compact">
          <strong>员工反馈</strong>
          <span>FEEDBACK</span>
        </div>
        <button class="btn secondary" type="button" data-view="feedbacks">查看员工反馈</button>
      </div>
    `;
  }
  return `
    <form class="feedback-panel" id="feedbackForm">
      <div class="filter-heading compact">
        <strong>我要反馈</strong>
        <span>FEEDBACK</span>
      </div>
      <label class="field">
        <span>反馈内容</span>
        <textarea name="body" data-feedback-body placeholder="请输入遇到的问题或建议">${escapeHtml(state.feedbackDraft)}</textarea>
      </label>
      <label class="file-pick">
        <input type="file" data-feedback-images accept="image/*" multiple />
        <span>上传图片</span>
      </label>
      <div class="feedback-preview" data-feedback-preview>
        ${renderFeedbackPreview()}
      </div>
      <button class="btn" type="submit">提交反馈</button>
      <div class="muted feedback-hint">最多 ${feedbackLimits.maxImages} 张图片，单张不超过 3MB。</div>
      <div data-feedback-status></div>
    </form>
  `;
}

function renderFeedbackPreview() {
  if (!state.feedbackImages.length) return `<div class="muted">还没有选择图片。</div>`;
  return state.feedbackImages
    .map(
      (image, index) => `
        <div class="feedback-preview-item">
          <img src="${image.dataUrl}" alt="${escapeHtml(image.name)}" />
          <span>${escapeHtml(image.name)}</span>
          <button type="button" class="icon-btn" title="移除图片" data-remove-feedback-image="${index}">×</button>
        </div>
      `
    )
    .join("");
}

function setFeedbackStatus(message, type = "") {
  const target = document.querySelector("[data-feedback-status]");
  if (!target) return;
  target.innerHTML = message ? `<div class="${type === "error" ? "error" : "success"}">${escapeHtml(message)}</div>` : "";
}

function refreshFeedbackPreview() {
  const target = document.querySelector("[data-feedback-preview]");
  if (target) target.innerHTML = renderFeedbackPreview();
  document.querySelectorAll("[data-remove-feedback-image]").forEach((button) => {
    button.addEventListener("click", () => {
      state.feedbackImages.splice(Number(button.dataset.removeFeedbackImage), 1);
      refreshFeedbackPreview();
    });
  });
}

function bindFeedbackPanel() {
  const form = document.querySelector("#feedbackForm");
  if (!form) return;
  form.querySelector("[data-feedback-body]")?.addEventListener("input", (event) => {
    state.feedbackDraft = event.currentTarget.value;
  });
  form.querySelector("[data-feedback-images]")?.addEventListener("change", async (event) => {
    setFeedbackStatus("");
    try {
      const incoming = Array.from(event.currentTarget.files || []);
      if (state.feedbackImages.length + incoming.length > feedbackLimits.maxImages) {
        throw new Error(`最多只能上传 ${feedbackLimits.maxImages} 张图片`);
      }
      const storedBytes = state.feedbackImages.reduce((sum, item) => sum + (item.size || Math.ceil(String(item.dataUrl || "").length * 0.75)), 0);
      const totalBytes = storedBytes + incoming.reduce((sum, item) => sum + item.size, 0);
      if (totalBytes > feedbackLimits.maxTotalImageBytes) throw new Error("反馈图片总大小不能超过 4MB");
      for (const file of incoming) {
        if (!file.type.startsWith("image/")) throw new Error("只能上传图片");
        const image = await fileToDataUrl(file, feedbackLimits.maxImageBytes, "反馈图片");
        image.size = file.size;
        state.feedbackImages.push(image);
      }
      refreshFeedbackPreview();
    } catch (error) {
      setFeedbackStatus(error.message, "error");
    } finally {
      event.currentTarget.value = "";
    }
  });
  refreshFeedbackPreview();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setFeedbackStatus("");
    const body = String(new FormData(form).get("body") || "").trim();
    if (!body && !state.feedbackImages.length) {
      setFeedbackStatus("请填写反馈内容或上传图片", "error");
      return;
    }
    try {
      await api("/api/feedback", {
        method: "POST",
        body: JSON.stringify({ body, images: state.feedbackImages })
      });
      state.feedbackDraft = "";
      state.feedbackImages = [];
      form.reset();
      refreshFeedbackPreview();
      setFeedbackStatus("反馈已提交，管理员可以在后台查看。");
    } catch (error) {
      setFeedbackStatus(error.message, "error");
    }
  });
}

function bindImageCompressor() {
  document.querySelector("[data-compressor-file]")?.addEventListener("change", async (event) => {
    await selectCompressorImages(event.currentTarget.files);
  });
  document.querySelector("[data-compressor-output]")?.addEventListener("change", async (event) => {
    state.compressor.outputType = event.currentTarget.value;
    await compressCurrentImages();
  });
  document.querySelector("[data-compressor-quality]")?.addEventListener("input", (event) => {
    state.compressor.quality = Number(event.currentTarget.value);
    const label = event.currentTarget.closest(".field")?.querySelector("span");
    if (label) label.textContent = `压缩质量：${state.compressor.quality}%`;
  });
  document.querySelector("[data-compressor-quality]")?.addEventListener("change", async (event) => {
    state.compressor.quality = Number(event.currentTarget.value);
    await compressCurrentImages();
  });
  document.querySelector("[data-compressor-width]")?.addEventListener("change", async (event) => {
    state.compressor.maxWidth = Math.max(320, Math.min(6000, Number(event.currentTarget.value) || 1600));
    await compressCurrentImages();
  });
  document.querySelector("[data-compressor-run]")?.addEventListener("click", compressCurrentImages);
  document.querySelector("[data-compressor-download-all]")?.addEventListener("click", () => {
    state.compressor.results.filter((item) => item.url).forEach((item, index) => {
      window.setTimeout(() => {
        const link = document.createElement("a");
        link.href = item.url;
        link.download = item.name;
        link.click();
      }, index * 150);
    });
  });
  document.querySelector("[data-compressor-clear]")?.addEventListener("click", () => {
    revokeCompressorUrls(state.compressor.sources);
    resetCompressorResults();
    state.compressor.sources = [];
    state.compressor.status = "";
    renderMainView();
  });
}

function bindShell() {
  document.querySelector('[data-action="logout"]').addEventListener("click", async () => {
    await api("/api/logout", { method: "POST", body: "{}" });
    state.user = null;
    renderLogin();
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      state.selected = null;
      renderShell();
    });
  });
  document.querySelector('[data-action="applyFilters"]')?.addEventListener("click", async () => {
    document.querySelectorAll("[data-filter]").forEach((input) => {
      state.filters[input.dataset.filter] = input.value;
    });
    await loadBootstrap();
    renderShell();
  });
  document.querySelector('[data-action="clearFilters"]')?.addEventListener("click", async () => {
    state.filters = { q: "", category: "", tag: "" };
    await loadBootstrap();
    renderShell();
  });
  bindFeedbackPanel();
}

function renderMainView() {
  const target = document.querySelector("#mainView");
  if (state.selected) {
    renderDetail(target);
    return;
  }
  if (state.view === "adminEditor") renderMaterialEditor(target);
  else if (state.view === "leadGenerator") renderLeadGenerator(target);
  else if (state.view === "merchantData") renderMerchantData(target);
  else if (state.view === "compressor") renderImageCompressor(target);
  else if (state.view === "admin") renderAdmin(target);
  else if (state.view === "users") renderUsers(target);
  else if (state.view === "logs") renderLogs(target);
  else if (state.view === "feedbacks") renderFeedbacks(target);
  else renderLibrary(target);
}

function renderLeadGenerator(target) {
  target.innerHTML = `
    <section class="lead-generator-page" aria-label="线索数据生成工具">
      <iframe
        class="lead-generator-frame"
        src="/lead-generator/index.html"
        title="电话线索数据生成软件"
      ></iframe>
    </section>
  `;
}

function renderMerchantData(target) {
  target.innerHTML = `
    <section class="lead-generator-page" aria-label="商户数据管理">
      <iframe class="lead-generator-frame" src="/merchant-data/index.html" title="商户数据管理"></iframe>
    </section>
  `;
}

function renderImageCompressor(target) {
  const { sources, results, quality, maxWidth, outputType, status } = state.compressor;
  const completedResults = results.filter((item) => item.url);
  const originalBytes = sources.reduce((sum, item) => sum + item.size, 0);
  const compressedBytes = completedResults.reduce((sum, item) => sum + item.size, 0);
  const savedBytes = originalBytes - compressedBytes;
  const savedPercent = originalBytes && completedResults.length === sources.length ? Math.max(0, Math.round((savedBytes / originalBytes) * 100)) : 0;
  target.innerHTML = `
    <section class="compressor-page">
      <div class="section-head compact-head">
        <div>
          <h2>图片压缩</h2>
          <p>可同时选择多张本地图片批量压缩，所有处理都在浏览器内完成，不会上传到服务器。</p>
        </div>
      </div>
      <div class="compressor-grid">
        <section class="panel compressor-controls">
          <label class="file-pick compressor-drop">
            <input type="file" accept="image/*" multiple data-compressor-file />
            <span>${sources.length ? "重新选择图片" : "选择多张图片"}</span>
          </label>
          <div class="compressor-options">
            <label class="field">
              <span>输出格式</span>
              <select data-compressor-output>
                <option value="image/jpeg" ${outputType === "image/jpeg" ? "selected" : ""}>JPEG</option>
                <option value="image/webp" ${outputType === "image/webp" ? "selected" : ""}>WebP</option>
                <option value="image/png" ${outputType === "image/png" ? "selected" : ""}>PNG</option>
              </select>
            </label>
            <label class="field">
              <span>压缩质量：${quality}%</span>
              <input type="range" min="35" max="92" step="1" value="${quality}" data-compressor-quality />
            </label>
            <label class="field">
              <span>最大宽度</span>
              <input type="number" min="320" max="6000" step="80" value="${maxWidth}" data-compressor-width />
            </label>
          </div>
          <div class="row">
            <button class="btn" type="button" data-compressor-run ${sources.length ? "" : "disabled"}>全部重新压缩</button>
            <button class="btn secondary" type="button" data-compressor-clear ${sources.length ? "" : "disabled"}>清空</button>
          </div>
          ${status ? `<div class="${completedResults.length ? "success" : status.includes("失败") || status.includes("无法") ? "error" : "notice"}">${escapeHtml(status)}</div>` : ""}
          ${
            sources.length
              ? `<div class="compression-metrics">
                  <div><span>图片数量</span><strong>${sources.length} 张</strong></div>
                  <div><span>原图合计</span><strong>${formatBytes(originalBytes)}</strong></div>
                  <div><span>压缩后合计</span><strong>${completedResults.length ? formatBytes(compressedBytes) : "等待生成"}</strong></div>
                  <div><span>整体缩减</span><strong>${completedResults.length === sources.length ? `${savedPercent}%` : "--"}</strong></div>
                </div>`
              : ""
          }
          ${completedResults.length ? `<button class="btn download-btn" type="button" data-compressor-download-all>全部下载（${completedResults.length} 张）</button>` : ""}
        </section>
        <section class="compressor-preview-panel">
          ${
            sources.length
              ? sources.map((source, index) => {
                  const result = results[index];
                  return `<article class="compressor-batch-item">
                    <div class="compressor-item-head">
                      <div><strong>${escapeHtml(source.name)}</strong><span>${formatBytes(source.size)} · ${source.width} × ${source.height}</span></div>
                      ${result?.url ? `<a class="btn secondary" href="${result.url}" download="${escapeHtml(result.name)}">下载</a>` : ""}
                    </div>
                    <div class="compressor-comparison">
                      <figure class="compressor-preview"><figcaption>原图</figcaption><img src="${source.url}" alt="${escapeHtml(source.name)}" /></figure>
                      ${result?.url
                        ? `<figure class="compressor-preview"><figcaption>压缩后 · ${formatBytes(result.size)} · 缩减 ${result.savedPercent}%</figcaption><img src="${result.url}" alt="${escapeHtml(result.name)}" /></figure>`
                        : `<div class="empty compressor-empty">${result?.error ? escapeHtml(result.error) : "等待压缩"}</div>`}
                    </div>
                  </article>`;
                }).join("")
              : `<div class="empty compressor-empty">选择一张或多张图片后，这里会逐张显示原图和压缩结果。</div>`
          }
        </section>
      </div>
    </section>
  `;
  bindImageCompressor();
}

function getLibraryCategorySections() {
  const categories = [
    ...new Set(
      (state.filters.category
        ? [state.filters.category]
        : [...state.categories, ...state.materials.map((item) => item.category)]
      ).filter(Boolean)
    )
  ];
  if (!state.filters.category && state.materials.some((item) => !item.category)) categories.push("");

  return categories.map((category) => ({
    category,
    materials: state.materials.filter((item) => item.category === category)
  }));
}

function renderMaterialCard(item) {
  return `
    <article class="card">
      <span class="corner-square"></span>
      <div class="meta">
        <span class="chip">${escapeHtml(item.category || "未分类")}</span>
        <span class="chip">${typeText(item.type)}</span>
        ${item.status === "draft" ? '<span class="chip status-draft">草稿</span>' : ""}
      </div>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.body || "暂无文字说明")}</p>
      <div class="meta">${(item.tags || []).map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`).join("")}</div>
      <div class="row card-actions">
        <button class="btn" data-open="${item.id}">查看</button>
        ${
          state.user.role === "admin"
            ? `<button class="btn secondary" data-edit="${item.id}">编辑</button><button class="btn danger" data-delete="${item.id}">删除</button>`
            : ""
        }
      </div>
    </article>
  `;
}

function renderLibraryCategorySection(section) {
  return `
    <section class="category-section">
      <header class="category-section-head">
        <div>
          <span class="eyebrow">CATEGORY</span>
          <h3>${escapeHtml(section.category || "未分类")}</h3>
        </div>
        <span class="category-count">${section.materials.length} 项内容</span>
      </header>
      ${
        section.materials.length
          ? `<div class="grid">${section.materials.map((item) => renderMaterialCard(item)).join("")}</div>`
          : '<div class="empty category-empty">该分类下暂无符合条件的资料。</div>'
      }
    </section>
  `;
}

function renderLibrary(target) {
  const categorySections = getLibraryCategorySections();

  target.innerHTML = `
    <section class="library-hero">
      <div class="hero-copy">
        <span class="eyebrow">TRAINING LIBRARY</span>
        <h1>把内部知识组织成可检索、可学习、可复用的工程化资料库</h1>
        <p>以课程、图文、视频和思维导图为核心，让团队在同一个清晰的学习界面里找到答案。</p>
        <div class="hero-actions">
          <button class="btn" data-action="focusSearch">浏览资料</button>
          ${state.user.role === "admin" ? '<button class="btn outline-on-dark" data-view="admin">进入管理</button>' : ""}
        </div>
      </div>
      <div class="hero-visual" aria-hidden="true">
        <div class="signal-grid">
          <span></span><span></span><span></span><span></span>
          <span></span><span></span><span></span><span></span>
          <span></span><span></span><span></span><span></span>
        </div>
      </div>
    </section>
    <section class="section-head">
      <div>
        <span class="eyebrow">LATEST RESOURCES</span>
        <h2>培训资料</h2>
      </div>
    </section>
    <div class="category-sections">
      ${categorySections.length ? categorySections.map((section) => renderLibraryCategorySection(section)).join("") : ""}
    </div>
    ${state.materials.length || categorySections.length ? "" : '<div class="empty">没有找到符合条件的资料。</div>'}
  `;
  bindMaterialActions();
}

function bindMaterialActions() {
  document.querySelector('[data-action="focusSearch"]')?.addEventListener("click", () => {
    document.querySelector('[data-filter="q"]')?.focus();
  });
  document.querySelectorAll("#mainView [data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      state.selected = null;
      renderShell();
    });
  });
  document.querySelectorAll("[data-open]").forEach((button) => {
    button.addEventListener("click", async () => {
      const data = await api(`/api/materials/${button.dataset.open}`);
      state.selected = data.material;
      renderMainView();
    });
  });
  document.querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", async () => {
      const data = await api(`/api/materials/${button.dataset.edit}`);
      resetMaterialDraft(data.material);
      state.view = "adminEditor";
      state.selected = null;
      renderShell();
    });
  });
  document.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("确定删除这条培训资料吗？")) return;
      await api(`/api/materials/${button.dataset.delete}`, { method: "DELETE", body: "{}" });
      await loadBootstrap();
      renderShell();
    });
  });
}

function renderDetail(target) {
  const item = state.selected;
  const blocks = normalizeContentBlocks(item);
  const previewImages = collectContentImages(blocks);
  target.innerHTML = `
    <article class="detail detail-page">
      <section class="detail-hero">
        <button class="btn outline-on-dark" data-action="back">返回列表</button>
        <span class="eyebrow">RESOURCE DETAIL</span>
        <h1>${escapeHtml(item.title)}</h1>
        <div class="meta">
          <span class="chip">${escapeHtml(item.category)}</span>
          <span class="chip">${typeText(item.type)}</span>
          ${(item.tags || []).map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`).join("")}
        </div>
        <p class="muted">更新时间：${formatDate(item.updatedAt)}</p>
      </section>
      <div class="detail-body">
        ${renderContentBlocks(blocks, item)}
        ${renderVideo(item.video)}
      </div>
    </article>
    ${renderImagePreviewOverlay()}
  `;
  fitReadOnlyDiagrams();
  bindReadOnlyDiagrams();
  bindImagePreview(previewImages);
  document.querySelector('[data-action="back"]').addEventListener("click", () => {
    state.selected = null;
    closeImagePreview();
    renderMainView();
  });
}

function renderImagePreviewOverlay() {
  return `
    <div class="image-preview-overlay" data-image-preview role="dialog" aria-modal="true" aria-label="图片预览" hidden>
      <button class="image-preview-close" type="button" data-preview-close aria-label="关闭预览">×</button>
      <button class="image-preview-nav prev" type="button" data-preview-step="-1" aria-label="上一张图片">‹</button>
      <figure class="image-preview-stage">
        <div class="image-preview-canvas" data-preview-canvas>
          <img data-preview-image alt="" draggable="false" />
        </div>
        <figcaption>
          <span data-preview-name></span>
          <span data-preview-count></span>
          <span data-preview-zoom></span>
        </figcaption>
      </figure>
      <button class="image-preview-nav next" type="button" data-preview-step="1" aria-label="下一张图片">›</button>
    </div>
  `;
}

function openImagePreview(images, index = 0) {
  state.imagePreview = {
    images: images.filter((image) => image?.dataUrl),
    index,
    zoom: 1,
    panX: 0,
    panY: 0
  };
  updateImagePreviewOverlay();
}

function closeImagePreview() {
  state.imagePreview.images = [];
  state.imagePreview.index = 0;
  state.imagePreview.zoom = 1;
  state.imagePreview.panX = 0;
  state.imagePreview.panY = 0;
  updateImagePreviewOverlay();
}

function stepImagePreview(direction) {
  const total = state.imagePreview.images.length;
  if (!total) return;
  state.imagePreview.index = (state.imagePreview.index + direction + total) % total;
  state.imagePreview.zoom = 1;
  state.imagePreview.panX = 0;
  state.imagePreview.panY = 0;
  updateImagePreviewOverlay();
}

function clampImagePreviewPan() {
  const canvas = document.querySelector("[data-preview-canvas]");
  const img = document.querySelector("[data-preview-image]");
  if (!canvas || !img || !img.offsetWidth || !img.offsetHeight) return;
  const { zoom } = state.imagePreview;
  const width = img.offsetWidth * zoom;
  const height = img.offsetHeight * zoom;
  const limitX = Math.abs(width - canvas.clientWidth) / 2;
  const limitY = Math.abs(height - canvas.clientHeight) / 2;
  state.imagePreview.panX = Math.max(-limitX, Math.min(limitX, state.imagePreview.panX));
  state.imagePreview.panY = Math.max(-limitY, Math.min(limitY, state.imagePreview.panY));
}

function zoomImagePreview(delta, anchor) {
  if (!state.imagePreview.images.length) return;
  const current = state.imagePreview.zoom;
  const next = Math.round(Math.max(0.5, Math.min(4, current + delta)) * 10) / 10;
  if (next === current) return;
  const canvas = document.querySelector("[data-preview-canvas]");
  if (canvas && anchor) {
    const rect = canvas.getBoundingClientRect();
    const ratio = next / current;
    const x = anchor.x - (rect.left + rect.width / 2);
    const y = anchor.y - (rect.top + rect.height / 2);
    state.imagePreview.panX = x - (x - state.imagePreview.panX) * ratio;
    state.imagePreview.panY = y - (y - state.imagePreview.panY) * ratio;
  }
  state.imagePreview.zoom = next;
  clampImagePreviewPan();
  updateImagePreviewOverlay();
}

function updateImagePreviewOverlay() {
  const overlay = document.querySelector("[data-image-preview]");
  if (!overlay) return;
  const { images, index, zoom, panX, panY } = state.imagePreview;
  const image = images[index];
  overlay.hidden = !image;
  document.body.classList.toggle("preview-open", Boolean(image));
  if (!image) return;
  const img = overlay.querySelector("[data-preview-image]");
  if (img.getAttribute("src") !== image.dataUrl) img.src = image.dataUrl;
  img.alt = image.name || "图片预览";
  img.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  overlay.querySelector("[data-preview-name]").textContent = image.name || "图片预览";
  overlay.querySelector("[data-preview-count]").textContent = `${index + 1} / ${images.length}`;
  overlay.querySelector("[data-preview-zoom]").textContent = `${Math.round(zoom * 100)}%`;
  overlay.querySelectorAll("[data-preview-step]").forEach((button) => {
    button.disabled = images.length < 2;
  });
}

function handleImagePreviewKeydown(event) {
  if (!state.imagePreview.images.length) return;
  if (["Escape", "ArrowLeft", "ArrowRight"].includes(event.key)) event.preventDefault();
  if (event.key === "Escape") closeImagePreview();
  if (event.key === "ArrowLeft") stepImagePreview(-1);
  if (event.key === "ArrowRight") stepImagePreview(1);
}

function bindImagePreview(images) {
  document.querySelectorAll("[data-preview-index]").forEach((trigger) => {
    const open = () => openImagePreview(images, Number(trigger.dataset.previewIndex));
    trigger.addEventListener("click", open);
    trigger.addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      open();
    });
  });
  document.querySelector("[data-preview-close]")?.addEventListener("click", closeImagePreview);
  document.querySelector("[data-image-preview]")?.addEventListener("click", (event) => {
    if (event.target.matches("[data-image-preview]")) closeImagePreview();
  });
  const previewImage = document.querySelector("[data-preview-image]");
  let drag = null;
  previewImage?.addEventListener("load", () => {
    clampImagePreviewPan();
    updateImagePreviewOverlay();
  });
  previewImage?.addEventListener("dragstart", (event) => event.preventDefault());
  previewImage?.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      panX: state.imagePreview.panX,
      panY: state.imagePreview.panY
    };
    previewImage.setPointerCapture(event.pointerId);
    previewImage.classList.add("is-dragging");
  });
  previewImage?.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    state.imagePreview.panX = drag.panX + event.clientX - drag.x;
    state.imagePreview.panY = drag.panY + event.clientY - drag.y;
    clampImagePreviewPan();
    updateImagePreviewOverlay();
  });
  const stopImageDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (previewImage.hasPointerCapture(event.pointerId)) previewImage.releasePointerCapture(event.pointerId);
    previewImage.classList.remove("is-dragging");
    drag = null;
  };
  previewImage?.addEventListener("pointerup", stopImageDrag);
  previewImage?.addEventListener("pointercancel", stopImageDrag);
  document.querySelector("[data-preview-canvas]")?.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      zoomImagePreview(event.deltaY < 0 ? 0.2 : -0.2, { x: event.clientX, y: event.clientY });
    },
    { passive: false }
  );
  document.querySelectorAll("[data-preview-step]").forEach((button) => {
    button.addEventListener("click", () => stepImagePreview(Number(button.dataset.previewStep)));
  });
  document.removeEventListener("keydown", handleImagePreviewKeydown);
  document.addEventListener("keydown", handleImagePreviewKeydown);
}

function fitReadOnlyDiagrams() {
  document.querySelectorAll(".diagram-view:not(.editable)").forEach((view) => {
    if (view.dataset.userZoom === "true") return;
    setReadOnlyDiagramZoom(view, getReadOnlyDiagramFitZoom(view), { preserveScroll: false });
  });
}

function clampReadOnlyZoom(value) {
  return Math.min(readOnlyDiagramZoom.max, Math.max(readOnlyDiagramZoom.min, Number(value) || 1));
}

function getReadOnlyDiagramFitZoom(view) {
    const canvas = view.querySelector(".diagram-canvas");
  const viewport = view.querySelector(".diagram-pan-viewport") || view;
  if (!canvas || !viewport) return 1;
    const layoutWidth = Number(canvas.dataset.layoutWidth);
  if (!layoutWidth) return 1;
  const availableWidth = Math.max(320, viewport.clientWidth - 24);
  return clampReadOnlyZoom(Math.min(1, availableWidth / layoutWidth));
}

function setReadOnlyDiagramZoom(view, nextZoom, options = {}) {
  const canvas = view.querySelector(".diagram-canvas");
  const scaled = view.querySelector(".diagram-scaled");
  const viewport = view.querySelector(".diagram-pan-viewport") || view;
  if (!canvas || !scaled || !viewport) return;
  const layoutWidth = Number(canvas.dataset.layoutWidth);
  const layoutHeight = Number(canvas.dataset.layoutHeight);
  if (!layoutWidth || !layoutHeight) return;
  const previousZoom = Number(view.dataset.zoom) || 1;
  const zoom = Math.round(clampReadOnlyZoom(nextZoom) * 100) / 100;
  const rect = viewport.getBoundingClientRect();
  const anchorX = options.anchor ? options.anchor.x - rect.left : viewport.clientWidth / 2;
  const anchorY = options.anchor ? options.anchor.y - rect.top : viewport.clientHeight / 2;
  const contentX = (viewport.scrollLeft + anchorX) / previousZoom;
  const contentY = (viewport.scrollTop + anchorY) / previousZoom;
  view.dataset.zoom = String(zoom);
  scaled.style.transform = `scale(${zoom})`;
  canvas.style.width = `${layoutWidth * zoom}px`;
  canvas.style.height = `${layoutHeight * zoom}px`;
  view.querySelector("[data-diagram-zoom-input]")?.setAttribute("value", String(Math.round(zoom * 100)));
  const input = view.querySelector("[data-diagram-zoom-input]");
  if (input) input.value = String(Math.round(zoom * 100));
  if (options.preserveScroll !== false) {
    viewport.scrollLeft = Math.max(0, contentX * zoom - anchorX);
    viewport.scrollTop = Math.max(0, contentY * zoom - anchorY);
  }
}

function bindReadOnlyDiagrams() {
  document.querySelectorAll("[data-readonly-diagram]").forEach((view) => {
    const viewport = view.querySelector(".diagram-pan-viewport");
    if (!viewport || view.dataset.bound === "true") return;
    view.dataset.bound = "true";
    view.querySelectorAll("[data-diagram-view-zoom]").forEach((button) => {
      button.addEventListener("click", () => {
        const current = Number(view.dataset.zoom) || getReadOnlyDiagramFitZoom(view);
        view.dataset.userZoom = button.dataset.diagramViewZoom === "fit" ? "false" : "true";
        if (button.dataset.diagramViewZoom === "in") setReadOnlyDiagramZoom(view, current + readOnlyDiagramZoom.step);
        if (button.dataset.diagramViewZoom === "out") setReadOnlyDiagramZoom(view, current - readOnlyDiagramZoom.step);
        if (button.dataset.diagramViewZoom === "reset") setReadOnlyDiagramZoom(view, 1);
        if (button.dataset.diagramViewZoom === "fit") setReadOnlyDiagramZoom(view, getReadOnlyDiagramFitZoom(view), { preserveScroll: false });
      });
    });
    view.querySelector("[data-diagram-zoom-input]")?.addEventListener("change", (event) => {
      view.dataset.userZoom = "true";
      setReadOnlyDiagramZoom(view, Number(event.currentTarget.value) / 100);
    });
    viewport.addEventListener(
      "wheel",
      (event) => {
        if (!event.altKey) return;
        event.preventDefault();
        view.dataset.userZoom = "true";
        const current = Number(view.dataset.zoom) || getReadOnlyDiagramFitZoom(view);
        const direction = event.deltaY > 0 ? -1 : 1;
        setReadOnlyDiagramZoom(view, current + direction * readOnlyDiagramZoom.step, { anchor: { x: event.clientX, y: event.clientY } });
      },
      { passive: false }
    );
    viewport.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || event.target.closest("button, input, select, textarea, a")) return;
      event.preventDefault();
      const start = {
        x: event.clientX,
        y: event.clientY,
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop
      };
      view.classList.add("is-panning");
      const move = (moveEvent) => {
        viewport.scrollLeft = start.scrollLeft - (moveEvent.clientX - start.x);
        viewport.scrollTop = start.scrollTop - (moveEvent.clientY - start.y);
      };
      const up = () => {
        view.classList.remove("is-panning");
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  });
}

function renderImages(images = []) {
  if (!images.length) return "";
  return `<div class="media-list">${images.map((img) => `<img src="${img.dataUrl}" alt="${escapeHtml(img.name || "图片")}" />`).join("")}</div>`;
}

function collectContentImages(blocks = []) {
  return blocks
    .flatMap((block) => {
      if (block.type === "document") return collectDocumentImages(block);
      if (block.type === "image") return normalizeBlockImages(block);
      return [];
    })
    .filter((image) => image?.dataUrl);
}

function collectDocumentImages(block = {}) {
  const template = document.createElement("template");
  template.innerHTML = sanitizeEditorHtml(block.html || "");
  const storedImages = normalizeBlockImages(block);
  return [...template.content.querySelectorAll("img")].map((image, index) => ({
    dataUrl: image.getAttribute("src") || "",
    name: image.getAttribute("alt") || storedImages[index]?.name || `笔记图片 ${index + 1}`
  }));
}

function renderDocumentHtmlWithPreview(block = {}, startIndex = 0) {
  const template = document.createElement("template");
  template.innerHTML = sanitizeEditorHtml(block.html || "");
  template.content.querySelectorAll("img").forEach((image, index) => {
    const name = image.getAttribute("alt") || `笔记图片 ${index + 1}`;
    image.setAttribute("data-preview-index", String(startIndex + index));
    image.setAttribute("role", "button");
    image.setAttribute("tabindex", "0");
    image.setAttribute("aria-label", `预览图片：${name}`);
  });
  return template.innerHTML;
}

function renderContentImageGrid(images = [], startIndex = 0) {
  const items = images.filter((image) => image?.dataUrl);
  if (!items.length) return "";
  return `
    <div class="content-image-grid ${items.length === 1 ? "single" : ""}">
      ${items
        .map(
          (image, index) => `
            <button class="image-preview-trigger" type="button" data-preview-index="${startIndex + index}" aria-label="预览图片：${escapeHtml(image.name || "图片")}">
              <img src="${image.dataUrl}" alt="${escapeHtml(image.name || "图片")}" />
            </button>
          `
        )
        .join("")}
    </div>
  `;
}

function renderContentBlocks(blocks = [], material = {}) {
  let previewIndex = 0;
  return blocks
    .map((block) => {
      if (block.type === "document") {
        const documentImages = collectDocumentImages(block);
        const html = renderDocumentHtmlWithPreview(block, previewIndex);
        previewIndex += documentImages.length;
        return `<div class="body-text note-document-view">${html}</div>`;
      }
      if (block.type === "image") {
        const images = normalizeBlockImages(block);
        const caption = renderRichTextSegments(block.richText, block.body, block.textStyle);
        if (!images.length) return caption ? `<div class="body-text">${caption}</div>` : "";
        const startIndex = previewIndex;
        previewIndex += images.length;
        return `<figure class="content-image">${renderContentImageGrid(images, startIndex)}${caption ? `<figcaption>${caption}</figcaption>` : ""}</figure>`;
      }
      if (block.type === "mindmap") {
        const diagram = block.mindmap ? normalizeDiagram(block.mindmap) : normalizeDiagram(material.mindmap);
        return `<section class="content-diagram"><h2>${diagramTypeText(diagram.structure)}</h2>${renderDiagram(diagram)}</section>`;
      }
      const content = renderRichTextSegments(block.richText, block.body, block.textStyle);
      return content ? `<div class="body-text">${content}</div>` : "";
    })
    .join("");
}

function renderVideo(video) {
  if (!video?.mode) return "";
  if (video.mode === "upload" && video.dataUrl) {
    return `<h2>视频</h2><video class="video" controls src="${video.dataUrl}"></video>`;
  }
  if (video.url) {
    return `<h2>视频</h2><p><a class="btn" href="${escapeHtml(video.url)}" target="_blank" rel="noreferrer">打开外链视频</a></p>`;
  }
  return "";
}

const diagramMetrics = {
  nodeWidth: 164,
  nodeHeight: 56,
  minNodeWidth: 110,
  minNodeHeight: 44,
  horizontalGap: 112,
  verticalGap: 24,
  padding: 88
};

function visibleDiagramChildren(node) {
  return node.collapsed ? [] : node.children || [];
}

function diagramNodeWidth(node) {
  return Math.max(diagramMetrics.minNodeWidth, Number(node.width) || diagramMetrics.nodeWidth);
}

function diagramNodeHeight(node) {
  const width = diagramNodeWidth(node);
  const text = String(node.text || "");
  const lines = text.split(/\r?\n/).reduce((sum, line) => {
    const charsPerLine = Math.max(6, Math.floor(width / 13));
    return sum + Math.max(1, Math.ceil(line.length / charsPerLine));
  }, 0);
  const estimatedHeight = Math.min(360, Math.max(diagramMetrics.nodeHeight, lines * 19 + 18));
  return Math.max(diagramMetrics.minNodeHeight, Number(node.height) || diagramMetrics.nodeHeight, estimatedHeight);
}

function diagramLayoutBounds(nodes) {
  return {
    minX: Math.min(...nodes.map((item) => item.x - item.width / 2)),
    maxX: Math.max(...nodes.map((item) => item.x + item.width / 2)),
    minY: Math.min(...nodes.map((item) => item.y - item.height / 2)),
    maxY: Math.max(...nodes.map((item) => item.y + item.height / 2))
  };
}

function branchHeight(node) {
  const children = visibleDiagramChildren(node);
  const ownHeight = diagramNodeHeight(node);
  if (!children.length) return ownHeight;
  return Math.max(
    ownHeight,
    children.reduce((sum, child) => sum + branchHeight(child), 0) + diagramMetrics.verticalGap * (children.length - 1)
  );
}

function branchWidth(node) {
  const children = visibleDiagramChildren(node);
  const ownWidth = diagramNodeWidth(node);
  if (!children.length) return ownWidth;
  return Math.max(
    ownWidth,
    children.reduce((sum, child) => sum + branchWidth(child), 0) + diagramMetrics.horizontalGap * (children.length - 1)
  );
}

function layoutHorizontalNode(node, path, depth, yStart, side, nodes, links, parentPath = "") {
  const height = branchHeight(node);
  const width = diagramNodeWidth(node);
  const nodeHeight = diagramNodeHeight(node);
  const x = side * depth * (diagramMetrics.nodeWidth + diagramMetrics.horizontalGap);
  const y = yStart + height / 2;
  nodes.push({ node, path, x, y, width, height: nodeHeight, depth });
  if (parentPath) links.push({ from: parentPath, to: path });
  const children = visibleDiagramChildren(node);
  const total = children.reduce((sum, child) => sum + branchHeight(child), 0) + diagramMetrics.verticalGap * Math.max(0, children.length - 1);
  let cursor = yStart + (height - total) / 2;
  children.forEach((child, index) => {
    const childPath = partsToPath([...pathToParts(path), index]);
    layoutHorizontalNode(child, childPath, depth + 1, cursor, side, nodes, links, path);
    cursor += branchHeight(child) + diagramMetrics.verticalGap;
  });
}

function layoutVerticalNode(node, path, depth, xStart, nodes, links, parentPath = "") {
  const width = branchWidth(node);
  const nodeWidth = diagramNodeWidth(node);
  const nodeHeight = diagramNodeHeight(node);
  const x = xStart + width / 2;
  const y = depth * (diagramMetrics.nodeHeight + 76);
  nodes.push({ node, path, x, y, width: nodeWidth, height: nodeHeight, depth });
  if (parentPath) links.push({ from: parentPath, to: path });
  const children = visibleDiagramChildren(node);
  let cursor = xStart;
  children.forEach((child, index) => {
    const childPath = partsToPath([...pathToParts(path), index]);
    layoutVerticalNode(child, childPath, depth + 1, cursor, nodes, links, path);
    cursor += branchWidth(child) + diagramMetrics.horizontalGap;
  });
}

function buildDiagramLayout(diagram) {
  const nodes = [];
  const links = [];
  const structure = diagram.structure || "mindmap";
  const mode = ["org", "tree", "flow"].includes(structure) ? "vertical" : "horizontal";

  if (mode === "vertical") {
    layoutVerticalNode(diagram.root, "root", 0, 0, nodes, links);
  } else {
    nodes.push({ node: diagram.root, path: "root", x: 0, y: 0, width: diagramNodeWidth(diagram.root), height: diagramNodeHeight(diagram.root), depth: 0 });
    const children = visibleDiagramChildren(diagram.root);
    const right = structure === "logic" ? children : children.filter((_, index) => index % 2 === 0);
    const left = structure === "logic" ? [] : children.filter((_, index) => index % 2 === 1);
    const layoutSide = (items, side) => {
      const total = items.reduce((sum, child) => sum + branchHeight(child), 0) + diagramMetrics.verticalGap * Math.max(0, items.length - 1);
      let cursor = -total / 2;
      items.forEach((child) => {
        const index = children.indexOf(child);
        layoutHorizontalNode(child, partsToPath([index]), 1, cursor, side, nodes, links, "root");
        cursor += branchHeight(child) + diagramMetrics.verticalGap;
      });
    };
    layoutSide(right, 1);
    layoutSide(left, -1);
  }

  const { minX, maxX, minY, maxY } = diagramLayoutBounds(nodes);
  const offsetX = diagramMetrics.padding - minX;
  const offsetY = diagramMetrics.padding - minY;
  nodes.forEach((item) => {
    item.x += offsetX;
    item.y += offsetY;
    if (item.node.manualPosition && isFiniteDiagramNumber(item.node.x) && isFiniteDiagramNumber(item.node.y)) {
      item.x = Number(item.node.x);
      item.y = Number(item.node.y);
    }
  });
  let finalBounds = diagramLayoutBounds(nodes);
  const shiftX = finalBounds.minX < diagramMetrics.padding ? diagramMetrics.padding - finalBounds.minX : 0;
  const shiftY = finalBounds.minY < diagramMetrics.padding ? diagramMetrics.padding - finalBounds.minY : 0;
  if (shiftX || shiftY) {
    nodes.forEach((item) => {
      item.x += shiftX;
      item.y += shiftY;
    });
    finalBounds = diagramLayoutBounds(nodes);
  }
  const nodeByPath = Object.fromEntries(nodes.map((item) => [item.path, item]));
  return {
    nodes,
    links,
    nodeByPath,
    mode,
    width: Math.max(finalBounds.maxX + diagramMetrics.padding, maxX - minX + diagramMetrics.padding * 2),
    height: Math.max(finalBounds.maxY + diagramMetrics.padding, maxY - minY + diagramMetrics.padding * 2)
  };
}

function renderDiagramLink(link, layout) {
  const from = layout.nodeByPath[link.from];
  const to = layout.nodeByPath[link.to];
  if (!from || !to) return "";
  if (layout.mode === "vertical") {
    const y1 = from.y + from.height / 2;
    const y2 = to.y - to.height / 2;
    const mid = (y1 + y2) / 2;
    return `<path d="M ${from.x} ${y1} C ${from.x} ${mid}, ${to.x} ${mid}, ${to.x} ${y2}" />`;
  }
  const side = to.x >= from.x ? 1 : -1;
  const x1 = from.x + side * from.width / 2;
  const x2 = to.x - side * to.width / 2;
  const mid = (x1 + x2) / 2;
  return `<path d="M ${x1} ${from.y} C ${mid} ${from.y}, ${mid} ${to.y}, ${x2} ${to.y}" />`;
}

function renderDiagramNodeTopic(item, layout, editable = false) {
  const selected = editable && item.path === state.diagramSelected;
  const checked = editable && state.diagramChecked.has(item.path);
  const children = item.node.children || [];
  const collapsed = item.node.collapsed && children.length;
  const style = `left:${item.x - item.width / 2}px;top:${item.y - item.height / 2}px;width:${item.width}px;height:${item.height}px;`;
  const tone = item.depth % 5;
  if (!editable) {
    return `
      <div class="map-topic map-tone-${tone} ${item.path === "root" ? "root" : ""}" style="${style}">
        <strong>${escapeHtml(item.node.text)}</strong>
        ${collapsed ? `<span class="mini-badge">${children.length}</span>` : ""}
      </div>
    `;
  }
  return `
    <div class="map-topic map-tone-${tone} ${item.path === "root" ? "root" : ""} ${selected ? "selected" : ""}" style="${style}" data-diagram-path="${item.path}" data-diagram-select="${item.path}" data-topic-x="${item.x}" data-topic-y="${item.y}" data-topic-width="${item.width}" data-topic-height="${item.height}">
      <label class="topic-check" title="多选"><input type="checkbox" ${checked ? "checked" : ""} ${item.path === "root" ? "disabled" : ""} data-diagram-check="${item.path}" /></label>
      <button type="button" class="topic-move" title="拖拽移动位置" data-topic-move="${item.path}"></button>
      <textarea data-mind-text="${item.path}" aria-label="节点文字">${escapeHtml(item.node.text)}</textarea>
      ${children.length ? `<button type="button" class="topic-fold" title="${collapsed ? "展开" : "折叠"}" data-mind-toggle="${item.path}">${collapsed ? children.length : "−"}</button>` : ""}
      <button type="button" class="topic-resize" title="拖拽调整宽高" data-topic-resize="${item.path}"></button>
      ${selected ? `
        <div class="topic-quick">
          <button type="button" title="添加子节点 Tab" data-mind-add="${item.path}">+</button>
          <button type="button" title="添加同级 Enter" data-mind-sibling="${item.path}">↵</button>
        </div>
      ` : ""}
    </div>
  `;
}

function renderDiagram(diagram, options = {}) {
  const layout = buildDiagramLayout(diagram);
  const zoom = options.editable ? state.diagramZoom : 1;
  if (!options.editable) {
    return `
      <div class="diagram-view diagram-${escapeHtml(diagram.structure)}" data-readonly-diagram>
        <div class="diagram-viewer-tools" aria-label="导图查看工具">
          <button type="button" class="tool-btn" title="缩小" data-diagram-view-zoom="out">−</button>
          <label class="diagram-zoom-field" title="自定义缩放百分比">
            <input type="number" min="${Math.round(readOnlyDiagramZoom.min * 100)}" max="${Math.round(readOnlyDiagramZoom.max * 100)}" step="5" value="100" data-diagram-zoom-input />
            <span>%</span>
          </label>
          <button type="button" class="tool-btn" title="放大" data-diagram-view-zoom="in">+</button>
          <button type="button" class="tool-btn wide" title="适配宽度" data-diagram-view-zoom="fit">适配</button>
          <button type="button" class="tool-btn wide" title="重置为 100%" data-diagram-view-zoom="reset">100%</button>
        </div>
        <div class="diagram-pan-viewport" tabindex="0">
          <div class="diagram-canvas" data-layout-width="${layout.width}" data-layout-height="${layout.height}" style="width:${layout.width}px;height:${layout.height}px;">
            <div class="diagram-scaled" style="width:${layout.width}px;height:${layout.height}px;transform:scale(1);">
              <svg class="diagram-links" viewBox="0 0 ${layout.width} ${layout.height}" aria-hidden="true">
                ${layout.links.map((link) => renderDiagramLink(link, layout)).join("")}
              </svg>
              ${layout.nodes.map((item) => renderDiagramNodeTopic(item, layout, false)).join("")}
            </div>
          </div>
        </div>
      </div>
    `;
  }
  return `
    <div class="diagram-view diagram-${escapeHtml(diagram.structure)} ${options.editable ? "editable" : ""}">
      <div class="diagram-canvas" data-layout-width="${layout.width}" data-layout-height="${layout.height}" style="width:${layout.width * zoom}px;height:${layout.height * zoom}px;">
        <div class="diagram-scaled" style="width:${layout.width}px;height:${layout.height}px;transform:scale(${zoom});">
          <svg class="diagram-links" viewBox="0 0 ${layout.width} ${layout.height}" aria-hidden="true">
            ${layout.links.map((link) => renderDiagramLink(link, layout)).join("")}
          </svg>
          ${layout.nodes.map((item) => renderDiagramNodeTopic(item, layout, Boolean(options.editable))).join("")}
        </div>
      </div>
    </div>
  `;
}

function renderAdmin(target) {
  const categoryNames = [...new Set([...state.categories, ...state.materials.map((item) => item.category?.trim() || "未分类")])]
    .filter((category) => state.materials.some((item) => (item.category?.trim() || "未分类") === category));
  target.innerHTML = `
    <div class="admin-dashboard">
      <section class="panel dashboard-head">
        <div>
          <h2>资料管理</h2>
          <p class="muted">新增资料会进入独立编辑页面，适合编辑大型思维导图和多模块内容。</p>
        </div>
        <button class="btn" type="button" data-action="createMaterial">新增资料</button>
      </section>
      <div class="admin-grid">
        <section class="panel">
          <h2>分类和标签</h2>
          <form id="taxonomyForm">
            <label class="field"><span>分类，每行一个</span><textarea name="categories">${escapeHtml(state.categories.join("\n"))}</textarea></label>
            <label class="field"><span>标签，每行一个</span><textarea name="tags">${escapeHtml(state.tags.join("\n"))}</textarea></label>
            <button class="btn" type="submit">保存分类标签</button>
          </form>
        </section>
        <section class="panel">
          <h2>资料列表</h2>
          <table class="table">
            <thead><tr><th>排序</th><th>标题</th><th>标签</th><th>状态</th><th>操作</th></tr></thead>
            ${categoryNames.map((category) => `
              <tbody>
                <tr class="material-category-heading"><th colspan="5" scope="rowgroup">${escapeHtml(category)} <span>${state.materials.filter((item) => (item.category?.trim() || "未分类") === category).length} 项</span></th></tr>
              ${state.materials.filter((item) => (item.category?.trim() || "未分类") === category)
                .map(
                  (item) => `
                    <tr draggable="${state.tagEditorId === item.id ? "false" : "true"}" data-material-row="${item.id}" data-material-category="${escapeHtml(category)}">
                      <td><span class="drag-handle" title="拖动排序">↕</span></td>
                      <td>${escapeHtml(item.title)}</td>
                      <td class="material-tags-cell">
                        <div class="tag-chip-list">
                          ${(item.tags || []).length ? (item.tags || []).map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join("") : '<span class="muted">未设置</span>'}
                        </div>
                        ${state.tagEditorId === item.id ? `
                          <div class="tag-editor" data-tag-editor="${item.id}">
                            <div class="tag-chip-list editable">
                              ${state.tagDraft.map((tag, index) => `<button type="button" class="tag-chip removable" data-remove-tag="${index}" title="删除标签">${escapeHtml(tag)} ×</button>`).join("")}
                            </div>
                            <div class="tag-editor-row">
                              <input type="text" data-tag-input="${item.id}" placeholder="输入标签，按回车添加" />
                              <button class="btn secondary" type="button" data-add-tag="${item.id}">添加</button>
                              <button class="btn" type="button" data-save-tags="${item.id}">保存标签</button>
                              <button class="btn secondary" type="button" data-cancel-tags>取消</button>
                            </div>
                          </div>
                        ` : `<button class="tag-edit-link" type="button" data-edit-tags="${item.id}">编辑标签</button>`}
                      </td>
                      <td>${item.status === "draft" ? "草稿" : "发布"}</td>
                      <td><button class="btn secondary" data-edit="${item.id}">编辑</button></td>
                    </tr>
                  `
                )
                .join("")}
              </tbody>
            `).join("")}
          </table>
        </section>
      </div>
    </div>
  `;
  bindAdminDashboard();
  bindMaterialActions();
}

function renderMaterialEditor(target) {
  const material = state.editing || {};
  const draft = state.formDraft || {};
  target.innerHTML = `
    <form class="material-editor-page ynote-editor-shell" id="materialForm">
      <div class="ynote-editor-topbar">
        <button class="ynote-back" type="button" data-action="backAdmin" aria-label="返回后台">‹</button>
        <div class="ynote-document-state">
          <strong>${state.editing ? "编辑笔记" : "新建笔记"}</strong>
          <span>保存后立即发布到资料库</span>
        </div>
        <div class="ynote-editor-actions">
          <button class="btn secondary" type="button" data-action="newMaterial">新建空白</button>
          <button class="btn ynote-publish" type="submit">保存并发布</button>
        </div>
      </div>
      <div data-error></div>
      <div class="ynote-paper">
        <input class="ynote-title" name="title" value="${escapeHtml(draft.title ?? material.title ?? "")}" placeholder="请输入标题" autocomplete="off" required />
        ${renderYnoteToolbar()}
        <div class="ynote-drop-zone">
          <div class="ynote-editor" contenteditable="true" role="textbox" aria-multiline="true" data-note-editor data-placeholder="开始记录你的想法…">${sanitizeEditorHtml(state.noteEditorHtml)}</div>
          <div class="ynote-drop-hint">松开鼠标，将图片插入笔记</div>
        </div>
        <input class="visually-hidden" type="file" accept="image/*" multiple data-note-image-input />
      </div>
    </form>
  `;
  bindYnoteMaterialEditor();
}

function renderYnoteToolbar() {
  return `
    <div class="ynote-toolbar" role="toolbar" aria-label="笔记格式工具栏">
      <div class="ynote-tool-group">
        <button type="button" class="ynote-tool" data-editor-command="undo" title="撤销 Ctrl+Z">↶</button>
        <button type="button" class="ynote-tool" data-editor-command="redo" title="重做 Ctrl+Y">↷</button>
      </div>
      <span class="ynote-tool-divider"></span>
      <select class="ynote-tool-select font" data-editor-font title="字体">
        <option value="">字体</option><option value="Arial">Arial</option><option value="Microsoft YaHei">微软雅黑</option><option value="SimSun">宋体</option><option value="KaiTi">楷体</option>
      </select>
      <select class="ynote-tool-select" data-editor-size title="字号">
        <option value="">字号</option>
        <option value="12">12px</option><option value="14">14px</option><option value="16">16px</option><option value="18">18px</option>
        <option value="20">20px</option><option value="24">24px</option><option value="28">28px</option><option value="32">32px</option>
        <option value="36">36px</option><option value="48">48px</option><option value="60">60px</option><option value="72">72px</option>
      </select>
      <select class="ynote-tool-select heading" data-editor-block title="段落样式">
        <option value="p">正文</option><option value="h1">标题 1</option><option value="h2">标题 2</option><option value="h3">标题 3</option>
      </select>
      <span class="ynote-tool-divider"></span>
      <div class="ynote-tool-group">
        <button type="button" class="ynote-tool strong" data-editor-command="bold" title="加粗 Ctrl+B">B</button>
        <button type="button" class="ynote-tool italic" data-editor-command="italic" title="斜体 Ctrl+I">I</button>
        <button type="button" class="ynote-tool underline" data-editor-command="underline" title="下划线 Ctrl+U">U</button>
        <label class="ynote-color-tool" title="文字颜色"><span>A</span><input type="color" value="#222222" data-editor-color /></label>
      </div>
      <span class="ynote-tool-divider"></span>
      <div class="ynote-tool-group">
        <button type="button" class="ynote-tool" data-editor-command="insertUnorderedList" title="项目符号列表">•≡</button>
        <button type="button" class="ynote-tool" data-editor-command="insertOrderedList" title="编号列表">1≡</button>
        <button type="button" class="ynote-tool" data-editor-command="justifyLeft" title="左对齐">≡</button>
        <button type="button" class="ynote-tool center" data-editor-command="justifyCenter" title="居中对齐">≡</button>
        <button type="button" class="ynote-tool right" data-editor-command="justifyRight" title="右对齐">≡</button>
        <button type="button" class="ynote-tool quote" data-editor-quote title="引用">❝</button>
        <button type="button" class="ynote-tool" data-editor-link title="插入链接">🔗</button>
        <button type="button" class="ynote-tool image" data-editor-image title="插入图片">▧</button>
      </div>
    </div>
  `;
}

function renderContentBlockEditor() {
  return `
    <section class="content-builder">
      <div class="builder-head">
        <h3>资料内容</h3>
        <div class="row">
          <button class="btn secondary" type="button" data-add-block="text">纯文字</button>
          <button class="btn secondary" type="button" data-add-block="image">文字加图片</button>
          <button class="btn secondary" type="button" data-add-block="mindmap">思维导图</button>
        </div>
      </div>
      <div class="builder-blocks">
        ${state.contentBlocks.length ? state.contentBlocks.map((block, index) => renderContentBlockEditorItem(block, index)).join("") : '<div class="empty">请选择要添加的资料模块。</div>'}
      </div>
    </section>
  `;
}

function renderBlockImageEditorPreview(block, blockIndex) {
  const images = normalizeBlockImages(block);
  if (!images.length) return "";
  return `
    <div class="content-image editor-image-list">
      ${images
        .map(
          (image, imageIndex) => `
            <figure class="editor-image-item">
              <img src="${image.dataUrl}" alt="${escapeHtml(image.name || "图片")}" />
              <figcaption>${escapeHtml(image.name || "图片")}</figcaption>
              <button type="button" class="btn secondary" data-clear-block-image="${blockIndex}" data-image-index="${imageIndex}">移除图片</button>
            </figure>
          `
        )
        .join("")}
    </div>
  `;
}

function renderContentBlockEditorItem(block, index) {
  const controls = `
    <div class="block-controls">
      <span class="badge">${index + 1}</span>
      <button class="btn secondary" type="button" data-move-block="${index}" data-direction="-1" ${index === 0 ? "disabled" : ""}>上移</button>
      <button class="btn secondary" type="button" data-move-block="${index}" data-direction="1" ${index === state.contentBlocks.length - 1 ? "disabled" : ""}>下移</button>
      <button class="btn danger" type="button" data-remove-block="${index}" ${state.contentBlocks.length === 1 ? "disabled" : ""}>删除</button>
    </div>
  `;

  if (block.type === "image") {
    return `
      <div class="builder-block">
        ${controls}
        ${renderRichTextEditor(block, index, "图片上方或下方的文字", "这里可以写图片说明，也可以留空")}
        <label class="field"><span>图片，可多选，最多 9 张，保存时会自动压缩</span><input type="file" accept="image/*" multiple data-block-image="${index}" /></label>
        ${renderBlockImageEditorPreview(block, index)}
      </div>
    `;
  }

  if (block.type === "mindmap") {
    return `
      <div class="builder-block">
        ${controls}
        <div id="mindEditor"></div>
      </div>
    `;
  }

  return `
    <div class="builder-block">
      ${controls}
      ${renderRichTextEditor(block, index, "文字内容", "请输入文字内容")}
    </div>
  `;
}

function renderMindEditor() {
  const target = document.querySelector("#mindEditor");
  if (!target) return;
  const selected = selectedDiagramNode();
  target.innerHTML = `
    <div class="mind-editor-shell" tabindex="0">
      <div class="mind-menubar">
        <select id="diagramStructure" title="导图结构">
          ${diagramTypes.map((item) => `<option value="${item.value}" ${state.mindmap.structure === item.value ? "selected" : ""}>${item.label}</option>`).join("")}
        </select>
        <div class="mind-toolbar" role="toolbar" aria-label="思维导图工具栏">
          <button type="button" class="tool-btn" title="添加子节点 Tab" data-diagram-action="addChild">+</button>
          <button type="button" class="tool-btn" title="添加同级节点 Enter" data-diagram-action="addSibling">↵</button>
          <button type="button" class="tool-btn" title="删除 Delete" data-diagram-action="remove">⌫</button>
          <span class="tool-separator"></span>
          <button type="button" class="tool-btn" title="复制 Ctrl+C" data-diagram-action="copy">C</button>
          <button type="button" class="tool-btn" title="剪切 Ctrl+X" data-diagram-action="cut">X</button>
          <button type="button" class="tool-btn" title="粘贴 Ctrl+V" data-diagram-action="paste">V</button>
          <button type="button" class="tool-btn" title="复制节点 Ctrl+D" data-diagram-action="duplicate">D</button>
          <span class="tool-separator"></span>
          <button type="button" class="tool-btn" title="折叠/展开 Space" data-diagram-action="toggle">−</button>
          <button type="button" class="tool-btn" title="上移 Ctrl+↑" data-diagram-action="moveUp">↑</button>
          <button type="button" class="tool-btn" title="下移 Ctrl+↓" data-diagram-action="moveDown">↓</button>
          <button type="button" class="tool-btn" title="提升层级 Shift+Tab" data-diagram-action="promote">⇤</button>
          <button type="button" class="tool-btn wide" title="把勾选节点移动到当前节点下" data-diagram-action="batchMove">多选移动</button>
          <span class="tool-separator"></span>
          <button type="button" class="tool-btn" title="缩小 Ctrl+-" data-diagram-action="zoomOut">−</button>
          <span class="zoom-readout">${Math.round(state.diagramZoom * 100)}%</span>
          <button type="button" class="tool-btn" title="放大 Ctrl+=" data-diagram-action="zoomIn">+</button>
          <button type="button" class="tool-btn" title="重置缩放 Ctrl+0" data-diagram-action="zoomReset">1:1</button>
          <span class="tool-separator"></span>
          <button type="button" class="tool-btn wide" title="导出 JSON" data-diagram-action="export">导出</button>
          <label class="tool-btn wide import-btn" title="导入 JSON">导入<input type="file" accept="application/json,.json" data-diagram-import /></label>
        </div>
      </div>
      <div class="mind-workbench">
        <div class="mind-canvas-wrap">
          ${renderDiagram(state.mindmap, { editable: true })}
        </div>
        <aside class="mind-side">
          <section class="mind-inspector">
            <h3>属性</h3>
            <label class="field compact"><span>当前节点</span><input value="${escapeHtml(selected.text)}" data-selected-title /></label>
            <div class="inspector-grid">
              <label class="field compact"><span>宽度</span><input type="number" min="110" max="600" value="${Math.round(diagramNodeWidth(selected))}" data-node-width /></label>
              <label class="field compact"><span>高度</span><input type="number" min="44" max="360" value="${Math.round(diagramNodeHeight(selected))}" data-node-height /></label>
            </div>
            <div class="row">
              <button type="button" class="btn secondary" data-diagram-action="addChild">子节点</button>
              <button type="button" class="btn secondary" data-diagram-action="addSibling">同级</button>
              <button type="button" class="btn danger" data-diagram-action="remove" ${state.diagramSelected === "root" ? "disabled" : ""}>删除</button>
            </div>
          </section>
          <section class="mind-outline">
            <h3>大纲</h3>
            <div class="outline-list">${renderMindOutlineNode(state.mindmap.root, "root")}</div>
          </section>
        </aside>
      </div>
    </div>
  `;
}

function renderMindOutlineNode(node, path) {
  const selected = path === state.diagramSelected;
  const checked = state.diagramChecked.has(path);
  const canCheck = path !== "root";
  return `
    <div class="diagram-edit-node ${selected ? "selected" : ""}" draggable="${path !== "root"}" data-diagram-path="${path}" data-diagram-drop="${path}">
      <div class="diagram-edit-row" style="--depth:${pathToParts(path).length}">
        <input type="checkbox" ${checked ? "checked" : ""} ${canCheck ? "" : "disabled"} data-diagram-check="${path}" />
        <button type="button" class="outline-title" data-diagram-select="${path}">${escapeHtml(node.text)}</button>
        ${(node.children || []).length ? `<button type="button" class="outline-fold" data-mind-toggle="${path}">${node.collapsed ? "+" : "−"}</button>` : ""}
      </div>
      <div class="mind-children ${node.collapsed ? "collapsed" : ""}">
        ${node.collapsed ? "" : (node.children || []).map((child, index) => renderMindOutlineNode(child, partsToPath([...pathToParts(path), index]))).join("")}
      </div>
    </div>
  `;
}

function bindMindEditor() {
  const refresh = () => {
    renderMindEditor();
    bindMindEditor();
  };
  const findTextInput = (path) => [...document.querySelectorAll("[data-mind-text]")].find((input) => input.dataset.mindText === path);
  const refreshAndRestoreTextInput = (path, selectionStart, selectionEnd) => {
    refresh();
    const nextInput = findTextInput(path);
    if (!nextInput) return;
    nextInput.focus();
    const cursorStart = Math.min(selectionStart ?? nextInput.value.length, nextInput.value.length);
    const cursorEnd = Math.min(selectionEnd ?? cursorStart, nextInput.value.length);
    nextInput.setSelectionRange(cursorStart, cursorEnd);
  };
  const scheduleDiagramReflow = (input) => {
    const path = input.dataset.mindText;
    const selectionStart = input.selectionStart;
    const selectionEnd = input.selectionEnd;
    clearTimeout(diagramReflowTimer);
    diagramReflowTimer = setTimeout(() => refreshAndRestoreTextInput(path, selectionStart, selectionEnd), 60);
  };
  const isComposingText = (event, input) => event?.isComposing || input.dataset.composing === "true";
  const syncTopicText = (input, event) => {
    getDiagramNode(input.dataset.mindText).text = input.value;
    const heightChanged = fitTopicToText(input);
    const inspector = document.querySelector("[data-selected-title]");
    if (inspector && input.dataset.mindText === state.diagramSelected) inspector.value = input.value;
    if (heightChanged && !isComposingText(event, input)) scheduleDiagramReflow(input);
  };
  const syncInspectorText = (input, event) => {
    selectedDiagramNode().text = input.value;
    const canvasInput = document.querySelector(`.map-topic.selected [data-mind-text]`);
    if (canvasInput) {
      canvasInput.value = input.value;
      const heightChanged = fitTopicToText(canvasInput);
      if (heightChanged && !isComposingText(event, input)) scheduleDiagramReflow(canvasInput);
    }
    const outlineTitle = document.querySelector(`.diagram-edit-node.selected .outline-title`);
    if (outlineTitle) outlineTitle.textContent = input.value;
  };
  const runAction = (action) => {
    state.diagramSelected = safeDiagramPath(state.diagramSelected);
    if (action === "addChild") addDiagramChild(state.diagramSelected);
    if (action === "addSibling") addDiagramSibling(state.diagramSelected);
    if (action === "toggle") {
      const node = getDiagramNode(state.diagramSelected);
      if ((node.children || []).length) node.collapsed = !node.collapsed;
    }
    if (action === "copy") copyDiagramNode(state.diagramSelected);
    if (action === "cut") copyDiagramNode(state.diagramSelected, true);
    if (action === "paste") pasteDiagramNode(state.diagramSelected);
    if (action === "duplicate") duplicateDiagramNode(state.diagramSelected);
    if (action === "remove") removeDiagramNode(state.diagramSelected);
    if (action === "moveUp") moveDiagramSibling(state.diagramSelected, -1);
    if (action === "moveDown") moveDiagramSibling(state.diagramSelected, 1);
    if (action === "promote") promoteDiagramNode(state.diagramSelected);
    if (action === "zoomIn") state.diagramZoom = Math.min(1.8, Math.round((state.diagramZoom + 0.1) * 10) / 10);
    if (action === "zoomOut") state.diagramZoom = Math.max(0.5, Math.round((state.diagramZoom - 0.1) * 10) / 10);
    if (action === "zoomReset") state.diagramZoom = 1;
    if (action === "export") downloadDiagramJson();
    if (action === "batchMove") {
      [...state.diagramChecked].sort((a, b) => pathToParts(b).length - pathToParts(a).length).forEach((path) => {
        if (path !== state.diagramSelected && !isDescendantPath(state.diagramSelected, path)) moveDiagramNode(path, state.diagramSelected);
      });
      state.diagramChecked = new Set();
    }
    refresh();
  };
  document.querySelector("#diagramStructure")?.addEventListener("change", (event) => {
    state.mindmap.structure = event.target.value;
    refresh();
  });
  document.querySelectorAll("[data-diagram-action]").forEach((button) => {
    button.addEventListener("click", () => runAction(button.dataset.diagramAction));
  });
  document.querySelectorAll("[data-diagram-select]").forEach((button) => {
    button.addEventListener("click", () => {
      state.diagramSelected = button.dataset.diagramSelect;
      refresh();
    });
  });
  document.querySelectorAll("[data-diagram-check]").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) state.diagramChecked.add(input.dataset.diagramCheck);
      else state.diagramChecked.delete(input.dataset.diagramCheck);
    });
  });
  document.querySelectorAll("[data-mind-text]").forEach((input) => {
    input.addEventListener("focus", () => {
      state.diagramSelected = input.dataset.mindText;
      document.querySelectorAll(".map-topic.selected").forEach((item) => item.classList.remove("selected"));
      input.closest(".map-topic")?.classList.add("selected");
    });
    input.addEventListener("compositionstart", () => {
      input.dataset.composing = "true";
      clearTimeout(diagramReflowTimer);
    });
    input.addEventListener("compositionend", (event) => {
      delete input.dataset.composing;
      syncTopicText(input, event);
    });
    input.addEventListener("input", (event) => {
      syncTopicText(input, event);
    });
    input.addEventListener("blur", refresh);
  });
  const selectedTitleInput = document.querySelector("[data-selected-title]");
  selectedTitleInput?.addEventListener("compositionstart", () => {
    selectedTitleInput.dataset.composing = "true";
    clearTimeout(diagramReflowTimer);
  });
  selectedTitleInput?.addEventListener("compositionend", (event) => {
    delete selectedTitleInput.dataset.composing;
    syncInspectorText(selectedTitleInput, event);
  });
  selectedTitleInput?.addEventListener("input", (event) => syncInspectorText(event.target, event));
  document.querySelector("[data-node-width]")?.addEventListener("change", (event) => {
    selectedDiagramNode().width = Math.max(diagramMetrics.minNodeWidth, Math.min(600, Number(event.target.value) || diagramMetrics.nodeWidth));
    refresh();
  });
  document.querySelector("[data-node-height]")?.addEventListener("change", (event) => {
    selectedDiagramNode().height = Math.max(diagramMetrics.minNodeHeight, Math.min(360, Number(event.target.value) || diagramMetrics.nodeHeight));
    refresh();
  });
  document.querySelectorAll("[data-mind-add]").forEach((button) => {
    button.addEventListener("click", () => {
      addDiagramChild(button.dataset.mindAdd);
      refresh();
    });
  });
  document.querySelectorAll("[data-mind-sibling]").forEach((button) => {
    button.addEventListener("click", () => {
      addDiagramSibling(button.dataset.mindSibling);
      refresh();
    });
  });
  document.querySelectorAll("[data-mind-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const node = getDiagramNode(button.dataset.mindToggle);
      node.collapsed = !node.collapsed;
      refresh();
    });
  });
  document.querySelectorAll("[data-mind-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      removeDiagramNode(button.dataset.mindRemove);
      refresh();
    });
  });
  document.querySelector("[data-diagram-import]")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      state.mindmap = normalizeDiagram(JSON.parse(await file.text()));
      state.diagramSelected = "root";
      state.diagramChecked = new Set();
      refresh();
    } catch {
      setError("导入失败，请选择正确的导图 JSON 文件");
    }
  });
  document.querySelectorAll("[data-diagram-path]").forEach((node) => {
    node.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", node.dataset.diagramPath);
    });
  });
  document.querySelectorAll("[data-diagram-drop]").forEach((zone) => {
    zone.addEventListener("dragover", (event) => event.preventDefault());
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      const source = event.dataTransfer.getData("text/plain");
      if (moveDiagramNode(source, zone.dataset.diagramDrop)) refresh();
    });
  });
  bindTopicGeometry(refresh);
  document.removeEventListener("keydown", handleDiagramShortcut);
  document.addEventListener("keydown", handleDiagramShortcut);
}

function fitTopicToText(input) {
  const topic = input.closest(".map-topic");
  if (!topic) return false;
  const node = getDiagramNode(input.dataset.mindText);
  const currentHeight = Number(topic.dataset.topicHeight) || diagramNodeHeight(node);
  const previousHeight = input.style.height;
  input.style.height = "auto";
  const measuredHeight = input.scrollHeight;
  input.style.height = previousHeight;
  const neededHeight = Math.min(360, Math.max(diagramMetrics.minNodeHeight, measuredHeight + 18));
  if (Math.abs(neededHeight - currentHeight) <= 1) return false;
  const currentY = Number(topic.dataset.topicY) || node.y || 0;
  node.height = neededHeight;
  if (node.manualPosition) node.y = currentY + (neededHeight - currentHeight) / 2;
  topic.dataset.topicHeight = String(neededHeight);
  if (node.manualPosition) topic.dataset.topicY = String(node.y);
  topic.style.height = `${neededHeight}px`;
  if (node.manualPosition) topic.style.top = `${node.y - neededHeight / 2}px`;
  const inspectorHeight = document.querySelector("[data-node-height]");
  if (inspectorHeight && input.dataset.mindText === state.diagramSelected) inspectorHeight.value = Math.round(neededHeight);
  return true;
}

function bindTopicGeometry(refresh) {
  const startTopicMove = (event, topic, path) => {
    event.preventDefault();
    const node = getDiagramNode(path);
    state.diagramSelected = path;
    const zoom = state.diagramZoom || 1;
    const start = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      x: Number(topic.dataset.topicX),
      y: Number(topic.dataset.topicY),
      width: Number(topic.dataset.topicWidth),
      height: Number(topic.dataset.topicHeight)
    };
    const move = (moveEvent) => {
      const nextX = start.x + (moveEvent.clientX - start.pointerX) / zoom;
      const nextY = start.y + (moveEvent.clientY - start.pointerY) / zoom;
      node.manualPosition = true;
      node.x = Math.max(start.width / 2 + 8, nextX);
      node.y = Math.max(start.height / 2 + 8, nextY);
      topic.style.left = `${node.x - start.width / 2}px`;
      topic.style.top = `${node.y - start.height / 2}px`;
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      refresh();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  document.querySelectorAll(".map-topic[data-diagram-path]").forEach((topic) => {
    topic.addEventListener("mousedown", (event) => {
      if (event.target.closest("textarea, input, button, label, .topic-resize")) return;
      startTopicMove(event, topic, topic.dataset.diagramPath);
    });
  });

  document.querySelectorAll("[data-topic-move]").forEach((handle) => {
    handle.addEventListener("mousedown", (event) => {
      event.stopPropagation();
      startTopicMove(event, handle.closest(".map-topic"), handle.dataset.topicMove);
    });
  });

  document.querySelectorAll("[data-topic-resize]").forEach((handle) => {
    handle.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const topic = handle.closest(".map-topic");
      const node = getDiagramNode(handle.dataset.topicResize);
      state.diagramSelected = handle.dataset.topicResize;
      const zoom = state.diagramZoom || 1;
      const start = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        x: Number(topic.dataset.topicX),
        y: Number(topic.dataset.topicY),
        width: Number(topic.dataset.topicWidth),
        height: Number(topic.dataset.topicHeight)
      };
      const move = (moveEvent) => {
        node.width = Math.max(diagramMetrics.minNodeWidth, Math.min(600, start.width + (moveEvent.clientX - start.pointerX) / zoom));
        node.height = Math.max(diagramMetrics.minNodeHeight, Math.min(360, start.height + (moveEvent.clientY - start.pointerY) / zoom));
        const visualX = start.x + (node.width - start.width) / 2;
        const visualY = start.y + (node.height - start.height) / 2;
        if (node.manualPosition) {
          node.x = visualX;
          node.y = visualY;
        }
        topic.style.width = `${node.width}px`;
        topic.style.height = `${node.height}px`;
        topic.style.left = `${visualX - node.width / 2}px`;
        topic.style.top = `${visualY - node.height / 2}px`;
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        refresh();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  });
}

function handleDiagramShortcut(event) {
  const editor = document.querySelector("#mindEditor");
  if (!editor) return;
  if (event.isComposing || event.key === "Process") return;
  const active = document.activeElement;
  if (active?.closest("#materialForm") && !active.closest("#mindEditor")) return;
  const isNodeText = active?.matches?.("[data-mind-text], [data-selected-title]");
  const ctrl = event.ctrlKey || event.metaKey;
  const rerender = () => {
    renderMindEditor();
    bindMindEditor();
  };
  const selected = safeDiagramPath(state.diagramSelected);
  state.diagramSelected = selected;

  if (event.key === "Tab") {
    event.preventDefault();
    if (event.shiftKey) promoteDiagramNode(selected);
    else addDiagramChild(selected);
    rerender();
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    addDiagramSibling(selected);
    rerender();
    return;
  }
  if ((event.key === "Delete" || event.key === "Backspace") && !isNodeText) {
    event.preventDefault();
    removeDiagramNode(selected);
    rerender();
    return;
  }
  if (event.key === " " && !isNodeText) {
    event.preventDefault();
    const node = getDiagramNode(selected);
    if ((node.children || []).length) node.collapsed = !node.collapsed;
    rerender();
    return;
  }
  if (ctrl && event.key.toLowerCase() === "c") {
    if (isNodeText) return;
    copyDiagramNode(selected);
    return;
  }
  if (ctrl && event.key.toLowerCase() === "x") {
    if (isNodeText) return;
    event.preventDefault();
    copyDiagramNode(selected, true);
    rerender();
    return;
  }
  if (ctrl && event.key.toLowerCase() === "v") {
    if (isNodeText) return;
    event.preventDefault();
    pasteDiagramNode(selected);
    rerender();
    return;
  }
  if (ctrl && event.key.toLowerCase() === "d") {
    event.preventDefault();
    duplicateDiagramNode(selected);
    rerender();
    return;
  }
  if (ctrl && event.key === "ArrowUp") {
    event.preventDefault();
    moveDiagramSibling(selected, -1);
    rerender();
    return;
  }
  if (ctrl && event.key === "ArrowDown") {
    event.preventDefault();
    moveDiagramSibling(selected, 1);
    rerender();
    return;
  }
  if (!isNodeText && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
    event.preventDefault();
    navigateDiagram(event.key.replace("Arrow", "").toLowerCase());
    rerender();
    return;
  }
  if (ctrl && ["=", "+", "-"].includes(event.key)) {
    event.preventDefault();
    state.diagramZoom = event.key === "-" ? Math.max(0.5, state.diagramZoom - 0.1) : Math.min(1.8, state.diagramZoom + 0.1);
    state.diagramZoom = Math.round(state.diagramZoom * 10) / 10;
    rerender();
    return;
  }
  if (ctrl && event.key === "0") {
    event.preventDefault();
    state.diagramZoom = 1;
    rerender();
  }
}

function bindAdminDashboard() {
  document.querySelectorAll("#taxonomyForm textarea").forEach((textarea) => {
    const fitContent = () => {
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight + 2}px`;
    };
    textarea.addEventListener("input", fitContent);
    fitContent();
  });
  document.querySelector('[data-action="createMaterial"]').addEventListener("click", () => {
    resetEmptyMaterialDraft();
    state.view = "adminEditor";
    state.selected = null;
    renderShell();
  });
  document.querySelector("#taxonomyForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api("/api/taxonomy", {
      method: "PUT",
      body: JSON.stringify({
        categories: String(form.get("categories")).split("\n"),
        tags: String(form.get("tags")).split("\n")
      })
    });
    await loadBootstrap();
    renderShell();
  });
  document.querySelectorAll("[data-edit-tags]").forEach((button) => {
    button.addEventListener("click", () => {
      const material = state.materials.find((item) => item.id === button.dataset.editTags);
      state.tagEditorId = button.dataset.editTags;
      state.tagDraft = [...new Set((material?.tags || []).map((tag) => String(tag).trim()).filter(Boolean))];
      renderMainView();
    });
  });
  document.querySelectorAll("[data-remove-tag]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tagDraft.splice(Number(button.dataset.removeTag), 1);
      renderMainView();
    });
  });
  const addTag = (id) => {
    const input = document.querySelector(`[data-tag-input="${id}"]`);
    const incoming = String(input?.value || "").split(/[，,]/).map((tag) => tag.trim()).filter(Boolean);
    if (!incoming.length) return;
    state.tagDraft = [...new Set([...state.tagDraft, ...incoming])];
    renderMainView();
  };
  document.querySelectorAll("[data-add-tag]").forEach((button) => button.addEventListener("click", () => addTag(button.dataset.addTag)));
  document.querySelectorAll("[data-tag-input]").forEach((input) => input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addTag(input.dataset.tagInput);
  }));
  document.querySelectorAll("[data-cancel-tags]").forEach((button) => button.addEventListener("click", () => {
    state.tagEditorId = "";
    state.tagDraft = [];
    renderMainView();
  }));
  document.querySelectorAll("[data-save-tags]").forEach((button) => button.addEventListener("click", async () => {
    setError("");
    try {
      const data = await api(`/api/materials/${button.dataset.saveTags}`);
      await api(`/api/materials/${button.dataset.saveTags}`, {
        method: "PUT",
        body: JSON.stringify({ ...data.material, tags: state.tagDraft })
      });
      state.tagEditorId = "";
      state.tagDraft = [];
      await loadBootstrap();
      renderShell();
    } catch (error) {
      setError(error.message);
    }
  }));
  bindMaterialRanking();
}

function bindMaterialRanking() {
  const rows = [...document.querySelectorAll("[data-material-row]")];
  rows.forEach((row) => {
    row.addEventListener("dragstart", (event) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", row.dataset.materialRow);
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", (event) => {
      if (rows.find((item) => item.classList.contains("dragging"))?.dataset.materialCategory !== row.dataset.materialCategory) return;
      event.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", async (event) => {
      event.preventDefault();
      row.classList.remove("drag-over");
      const sourceId = event.dataTransfer.getData("text/plain");
      const targetId = row.dataset.materialRow;
      if (!sourceId || sourceId === targetId) return;
      const from = state.materials.findIndex((item) => item.id === sourceId);
      const to = state.materials.findIndex((item) => item.id === targetId);
      if (from < 0 || to < 0) return;
      if ((state.materials[from].category?.trim() || "未分类") !== (state.materials[to].category?.trim() || "未分类")) return;
      const [moved] = state.materials.splice(from, 1);
      state.materials.splice(to, 0, moved);
      await api("/api/materials/reorder", {
        method: "PUT",
        body: JSON.stringify({ ids: state.materials.map((item) => item.id) })
      });
      await loadBootstrap();
      renderShell();
    });
  });
}

function bindYnoteMaterialEditor() {
  const formElement = document.querySelector("#materialForm");
  const editor = document.querySelector("[data-note-editor]");
  const imageInput = document.querySelector("[data-note-image-input]");
  const dropZone = document.querySelector(".ynote-drop-zone");
  document.querySelector('[data-action="backAdmin"]').addEventListener("click", () => {
    state.view = "admin";
    state.editing = null;
    state.formDraft = null;
    state.contentBlocks = [];
    state.noteEditorHtml = "";
    renderShell();
  });
  document.querySelector('[data-action="newMaterial"]').addEventListener("click", () => {
    resetEmptyMaterialDraft();
    state.view = "adminEditor";
    renderShell();
  });
  const runCommand = (command, value = null) => {
    restoreEditorSelection(editor);
    document.execCommand(command, false, value);
    syncNoteEditor(editor);
    saveEditorSelection(editor);
  };
  const applyFontSize = (size) => {
    const pixelSize = Number(size);
    if (!pixelSize) return;
    restoreEditorSelection(editor);
    document.execCommand("styleWithCSS", false, false);
    document.execCommand("fontSize", false, "7");
    editor.querySelectorAll('font[size="7"]').forEach((font) => {
      font.removeAttribute("size");
      font.style.fontSize = `${pixelSize}px`;
    });
    syncNoteEditor(editor);
    saveEditorSelection(editor);
  };
  editor.addEventListener("input", () => syncNoteEditor(editor));
  editor.addEventListener("mouseup", () => saveEditorSelection(editor));
  editor.addEventListener("keyup", () => saveEditorSelection(editor));
  editor.addEventListener("click", (event) => {
    editor.querySelectorAll("img.selected").forEach((image) => image.classList.remove("selected"));
    if (event.target.matches("img")) event.target.classList.add("selected");
  });
  editor.addEventListener("keydown", (event) => {
    if (!["Backspace", "Delete"].includes(event.key)) return;
    const selectedImage = editor.querySelector("img.selected");
    if (!selectedImage) return;
    event.preventDefault();
    const imageLine = selectedImage.closest(".ynote-image-line");
    if (imageLine) imageLine.remove();
    else selectedImage.remove();
    syncNoteEditor(editor);
  });
  editor.addEventListener("paste", async (event) => {
    const files = [...(event.clipboardData?.items || [])]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    try {
      await insertNoteImages(files, editor);
    } catch (error) {
      setError(error.message);
    }
  });
  ["dragenter", "dragover"].forEach((name) => dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    dropZone.classList.add("drag-active");
  }));
  ["dragleave", "drop"].forEach((name) => dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    dropZone.classList.remove("drag-active");
  }));
  dropZone.addEventListener("drop", async (event) => {
    try {
      await insertNoteImages(event.dataTransfer?.files, editor);
    } catch (error) {
      setError(error.message);
    }
  });
  document.querySelectorAll("[data-editor-command]").forEach((button) => button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    runCommand(button.dataset.editorCommand);
  }));
  document.querySelector("[data-editor-font]").addEventListener("change", (event) => {
    runCommand("fontName", event.target.value);
    event.target.value = "";
  });
  document.querySelector("[data-editor-size]").addEventListener("change", (event) => {
    applyFontSize(event.target.value);
    event.target.value = "";
  });
  document.querySelector("[data-editor-block]").addEventListener("change", (event) => runCommand("formatBlock", event.target.value));
  document.querySelector("[data-editor-color]").addEventListener("input", (event) => runCommand("foreColor", event.target.value));
  document.querySelector("[data-editor-quote]").addEventListener("mousedown", (event) => {
    event.preventDefault();
    runCommand("formatBlock", "blockquote");
  });
  document.querySelector("[data-editor-link]").addEventListener("mousedown", (event) => {
    event.preventDefault();
    const url = prompt("请输入链接地址（以 http:// 或 https:// 开头）");
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      setError("链接必须以 http:// 或 https:// 开头");
      return;
    }
    runCommand("createLink", url);
  });
  document.querySelector("[data-editor-image]").addEventListener("mousedown", (event) => {
    event.preventDefault();
    saveEditorSelection(editor);
    imageInput.click();
  });
  imageInput.addEventListener("change", async () => {
    try {
      await insertNoteImages(imageInput.files, editor);
    } catch (error) {
      setError(error.message);
    } finally {
      imageInput.value = "";
    }
  });
  formElement.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    syncNoteEditor(editor);
    const body = noteEditorPlainText(editor);
    const images = noteEditorImages(editor);
    const title = String(form.get("title") || "").trim();
    if (!title) {
      setError("请输入笔记标题");
      return;
    }
    if (!body && !images.length) {
      setError("请输入笔记内容或插入图片");
      return;
    }
    const legacyMindmapBlocks = state.contentBlocks
      .filter((block) => block.type === "mindmap")
      .map((block) => ({ type: "mindmap", mindmap: block.mindmap || state.mindmap }));
    const blocks = [{ type: "document", body, html: state.noteEditorHtml, images }, ...legacyMindmapBlocks];
    const payload = {
      title,
      category: state.editing?.category || "",
      tags: state.editing?.tags || [],
      type: images.length ? "image" : "text",
      status: "published",
      body,
      images,
      video: state.formVideo,
      mindmap: legacyMindmapBlocks[0]?.mindmap || null,
      blocks
    };
    try {
      const path = state.editing ? `/api/materials/${state.editing.id}` : "/api/materials";
      const method = state.editing ? "PUT" : "POST";
      await api(path, { method, body: JSON.stringify(payload) });
      resetEmptyMaterialDraft();
      await loadBootstrap();
      state.view = "admin";
      renderShell();
    } catch (error) {
      setError(error.message);
    }
  });
}

function bindMaterialEditor() {
  bindMindEditor();
  document.querySelector('[data-action="backAdmin"]').addEventListener("click", () => {
    state.view = "admin";
    state.editing = null;
    state.formDraft = null;
    state.contentBlocks = [];
    renderShell();
  });
  document.querySelector('[data-action="newMaterial"]').addEventListener("click", () => {
    resetEmptyMaterialDraft();
    state.view = "adminEditor";
    renderShell();
  });
  document.querySelectorAll("[data-add-block]").forEach((button) => {
    button.addEventListener("click", () => {
      rememberMaterialForm();
      if (button.dataset.addBlock === "mindmap" && state.contentBlocks.some((block) => block.type === "mindmap")) {
        setError("一份资料暂时只需要添加一个思维导图模块");
        return;
      }
      state.contentBlocks.push(createContentBlock(button.dataset.addBlock));
      renderMainView();
    });
  });
  document.querySelectorAll("[data-block-rich]").forEach((editor) => {
    const index = Number(editor.dataset.blockRich);
    editor.addEventListener("input", () => {
      syncRichTextBlock(state.contentBlocks[index], editor);
    });
    editor.addEventListener("paste", (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") || "";
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (!editor.contains(range.commonAncestorContainer)) return;
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      selection.removeAllRanges();
      selection.addRange(range);
      syncRichTextBlock(state.contentBlocks[index], editor);
    });
  });
  document.querySelectorAll("[data-rich-font-size]").forEach((select) => {
    select.addEventListener("change", () => {
      applyRichTextStyle(Number(select.dataset.richFontSize), { fontSize: select.value });
      select.value = "";
    });
  });
  document.querySelectorAll("[data-rich-color]").forEach((button) => {
    button.addEventListener("click", () => {
      applyRichTextStyle(Number(button.dataset.richColor), { color: button.dataset.color });
    });
  });
  document.querySelectorAll("[data-block-image]").forEach((input) => {
    input.addEventListener("change", async () => {
      setError("");
      const files = Array.from(input.files || []);
      if (!files.length) return;
      try {
        if (files.length > 9) throw new Error("一次最多选择 9 张图片");
        const block = state.contentBlocks[Number(input.dataset.blockImage)];
        const images = normalizeBlockImages(block);
        if (images.length + files.length > 9) throw new Error("一个图文模块最多上传 9 张图片");
        for (const file of files) {
          if (!file.type.startsWith("image/")) throw new Error("只能上传图片");
          images.push(await compressMaterialImage(file));
        }
        block.images = images;
        block.image = images[0] || null;
        rememberMaterialForm();
        renderMainView();
      } catch (error) {
        setError(error.message);
      } finally {
        input.value = "";
      }
    });
  });
  document.querySelectorAll("[data-clear-block-image]").forEach((button) => {
    button.addEventListener("click", () => {
      rememberMaterialForm();
      const block = state.contentBlocks[Number(button.dataset.clearBlockImage)];
      const images = normalizeBlockImages(block);
      images.splice(Number(button.dataset.imageIndex), 1);
      block.images = images;
      block.image = images[0] || null;
      renderMainView();
    });
  });
  document.querySelectorAll("[data-remove-block]").forEach((button) => {
    button.addEventListener("click", () => {
      rememberMaterialForm();
      state.contentBlocks.splice(Number(button.dataset.removeBlock), 1);
      renderMainView();
    });
  });
  document.querySelectorAll("[data-move-block]").forEach((button) => {
    button.addEventListener("click", () => {
      rememberMaterialForm();
      const from = Number(button.dataset.moveBlock);
      const to = from + Number(button.dataset.direction);
      if (to < 0 || to >= state.contentBlocks.length) return;
      const [block] = state.contentBlocks.splice(from, 1);
      state.contentBlocks.splice(to, 0, block);
      renderMainView();
    });
  });
  document.querySelector("#materialForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const blocks = serializeContentBlocks();
    if (!blocks.length) {
      setError("请至少添加一个资料模块");
      return;
    }
    const body = blocks
      .filter((block) => block.type === "text" || block.type === "image")
      .map((block) => block.body || "")
      .filter(Boolean)
      .join("\n\n");
    const images = [];
    const mindmapBlock = blocks.find((block) => block.type === "mindmap");
    const payload = {
      title: form.get("title"),
      category: form.get("category"),
      tags: String(form.get("tags") || "").split(/[，,]/),
      type: deriveMaterialType(blocks),
      status: form.get("status"),
      body,
      images,
      video: state.formVideo,
      mindmap: mindmapBlock?.mindmap || null,
      blocks
    };
    try {
      const path = state.editing ? `/api/materials/${state.editing.id}` : "/api/materials";
      const method = state.editing ? "PUT" : "POST";
      await api(path, { method, body: JSON.stringify(payload) });
      resetEmptyMaterialDraft();
      await loadBootstrap();
      state.view = "admin";
      renderShell();
    } catch (error) {
      setError(error.message);
    }
  });
}

async function renderUsers(target) {
  const data = await api("/api/users");
  target.innerHTML = `
    <div class="admin-grid">
      <form class="panel" id="userForm">
        <h2>新增账号</h2>
        <div data-error></div>
        <label class="field"><span>账号</span><input name="username" required /></label>
        <label class="field"><span>显示名称</span><input name="displayName" /></label>
        <label class="field"><span>密码</span><input name="password" type="password" required minlength="6" /></label>
        <label class="field"><span>角色</span><select name="role"><option value="employee">员工</option><option value="admin">管理员</option></select></label>
        <button class="btn" type="submit">创建账号</button>
      </form>
      <section class="panel">
        <h2>账号列表</h2>
        <table class="table">
          <thead><tr><th>账号</th><th>名称</th><th>角色</th><th>状态</th><th>重置密码</th><th>操作</th></tr></thead>
          <tbody>
            ${data.users
              .map(
                (user) => `
                  <tr>
                    <td>${escapeHtml(user.username)}</td>
                    <td><input value="${escapeHtml(user.displayName)}" data-user-name="${user.id}" /></td>
                    <td><select data-user-role="${user.id}"><option value="employee" ${user.role === "employee" ? "selected" : ""}>员工</option><option value="admin" ${user.role === "admin" ? "selected" : ""}>管理员</option></select></td>
                    <td><select data-user-active="${user.id}"><option value="true" ${user.active ? "selected" : ""}>启用</option><option value="false" ${!user.active ? "selected" : ""}>停用</option></select></td>
                    <td><input type="password" minlength="6" placeholder="留空不修改" data-user-password="${user.id}" /></td>
                    <td class="row"><button class="btn secondary" data-save-user="${user.id}">保存</button><button class="btn danger" data-delete-user="${user.id}" ${user.id === state.user.id ? "disabled" : ""}>删除</button></td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </section>
    </div>
  `;
  document.querySelector("#userForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    setError("");
    try {
      await api("/api/users", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      renderUsers(target);
    } catch (error) {
      setError(error.message);
    }
  });
  document.querySelectorAll("[data-save-user]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.saveUser;
      await api(`/api/users/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          displayName: document.querySelector(`[data-user-name="${id}"]`).value,
          role: document.querySelector(`[data-user-role="${id}"]`).value,
          active: document.querySelector(`[data-user-active="${id}"]`).value === "true",
          password: document.querySelector(`[data-user-password="${id}"]`).value
        })
      });
      renderUsers(target);
    });
  });
  document.querySelectorAll("[data-delete-user]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("确定删除这个账号吗？该操作不可恢复。")) return;
      try {
        await api(`/api/users/${button.dataset.deleteUser}`, { method: "DELETE", body: "{}" });
        renderUsers(target);
      } catch (error) {
        setError(error.message);
      }
    });
  });
}

async function renderFeedbacks(target) {
  const data = await api("/api/feedback");
  target.innerHTML = `
    <section class="panel">
      <div class="dashboard-head">
        <div>
          <h2>员工反馈</h2>
          <p class="muted">员工提交的文字和图片反馈会按时间倒序展示。</p>
        </div>
      </div>
      <div class="feedback-list">
        ${
          data.feedbacks.length
            ? data.feedbacks
                .map(
                  (item) => `
                    <article class="feedback-card">
                      <div class="feedback-meta">
                        <strong>${escapeHtml(item.displayName || item.username)}</strong>
                        <span>${escapeHtml(item.username)}</span>
                        <span>${formatDate(item.createdAt)}</span>
                      </div>
                      ${item.body ? `<p>${escapeHtml(item.body).replaceAll("\n", "<br>")}</p>` : ""}
                      ${
                        item.images?.length
                          ? `<div class="feedback-images">${item.images
                              .map((image) => `<a href="${image.dataUrl}" target="_blank" rel="noreferrer"><img src="${image.dataUrl}" alt="${escapeHtml(image.name)}" /></a>`)
                              .join("")}</div>`
                          : ""
                      }
                    </article>
                  `
                )
                .join("")
            : `<div class="empty">还没有员工反馈。</div>`
        }
      </div>
    </section>
  `;
}

async function renderLogs(target) {
  const data = await api("/api/audit-logs");
  target.innerHTML = `
    <section class="panel">
      <h2>操作日志</h2>
      <table class="table">
        <thead><tr><th>时间</th><th>账号</th><th>动作</th><th>对象</th><th>说明</th></tr></thead>
        <tbody>
          ${data.auditLogs
            .map(
              (log) => `<tr><td>${formatDate(log.createdAt)}</td><td>${escapeHtml(log.username)}</td><td>${escapeHtml({ merchant_export: "导出商户数据", merchant_import: "导入商户数据", merchant_delete_import: "删除导入记录", merchant_add_industry: "添加行业", merchant_update_industry: "修改行业", merchant_delete_industry: "删除行业" }[log.action] || log.action)}</td><td>${escapeHtml(log.target)}</td><td>${escapeHtml(log.detail)}</td></tr>`
            )
            .join("")}
        </tbody>
      </table>
    </section>
  `;
}

window.addEventListener("resize", fitReadOnlyDiagrams);

boot().catch(() => renderLogin());
