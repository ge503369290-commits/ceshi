const state = {
  user: null,
  materials: [],
  categories: [],
  tags: [],
  feedbackImages: [],
  feedbackDraft: "",
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
  diagramZoom: 1
};

const app = document.querySelector("#app");
let diagramReflowTimer = null;
const feedbackLimits = {
  maxImages: 6,
  maxImageBytes: 3 * 1024 * 1024,
  maxTotalImageBytes: 4 * 1024 * 1024
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

function createContentBlock(type, data = {}) {
  if (type === "image") {
    return { id: clientId("block"), type: "image", body: String(data.body || ""), image: data.image || null };
  }
  if (type === "mindmap") {
    return { id: clientId("block"), type: "mindmap" };
  }
  return { id: clientId("block"), type: "text", body: String(data.body || "") };
}

function normalizeContentBlocks(material = {}) {
  if (Array.isArray(material.blocks) && material.blocks.length) {
    return material.blocks
      .map((block) => {
        if (block.type === "image") return createContentBlock("image", { body: block.body || "", image: block.image || null });
        if (block.type === "mindmap") return createContentBlock("mindmap");
        return createContentBlock("text", { body: block.body || "" });
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
  state.mindmap = normalizeDiagram(material?.mindmap);
  state.diagramSelected = "root";
  state.diagramChecked = new Set();
  state.diagramClipboard = null;
  state.diagramCutPath = "";
}

function serializeContentBlocks() {
  return state.contentBlocks
    .map((block) => {
      if (block.type === "image") return block.image || String(block.body || "").trim() ? { type: "image", body: String(block.body || ""), image: block.image || null } : null;
      if (block.type === "mindmap") return { type: "mindmap", mindmap: serializeDiagram(state.mindmap) };
      return { type: "text", body: String(block.body || "") };
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
}

function rememberMaterialForm() {
  const form = document.querySelector("#materialForm");
  if (!form) return;
  const data = new FormData(form);
  state.formDraft = {
    title: String(data.get("title") || ""),
    category: String(data.get("category") || ""),
    tags: String(data.get("tags") || ""),
    status: String(data.get("status") || "published")
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
        <h1>初始化内部培训资料库</h1>
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
        <h1>内部培训资料库</h1>
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
    }
  });
}

function renderShell() {
  const editorMode = state.view === "adminEditor";
  app.innerHTML = `
    <section class="shell">
      <div class="utility-bar">
        <span>企业学习中心</span>
        <span>资料、图文、视频、在线思维导图</span>
      </div>
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark">TL</span>
          <strong>内部培训资料库</strong>
        </div>
        <div class="navlinks">
          <span>资料</span>
          <span>方案</span>
          <span>团队</span>
          <span>支持</span>
        </div>
        <div class="userbar">
          <span>${escapeHtml(state.user.displayName)} / ${escapeHtml(state.user.username)}</span>
          <span class="badge">${roleText(state.user.role)}</span>
          <button class="btn secondary" data-action="logout">退出</button>
        </div>
      </header>
      <div class="layout ${editorMode ? "editor-layout" : ""}">
        ${editorMode ? "" : `<aside class="sidebar">${renderFilters()}</aside>`}
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
  const tabs = [`<button class="tab ${state.view === "library" ? "active" : ""}" data-view="library">资料库</button>`];
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
      <div class="notice">普通员工只能看到已发布资料。</div>
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
  else if (state.view === "admin") renderAdmin(target);
  else if (state.view === "users") renderUsers(target);
  else if (state.view === "logs") renderLogs(target);
  else if (state.view === "feedbacks") renderFeedbacks(target);
  else renderLibrary(target);
}

function renderLibrary(target) {
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
      <p>按分类和标签快速定位内容，管理员可直接编辑、删除或发布新资料。</p>
    </section>
    <div class="grid">
      ${state.materials
        .map(
          (item) => `
            <article class="card">
              <span class="corner-square"></span>
              <div class="meta">
                <span class="chip">${escapeHtml(item.category)}</span>
                <span class="chip">${typeText(item.type)}</span>
                ${item.status === "draft" ? '<span class="chip status-draft">草稿</span>' : ""}
              </div>
              <h3>${escapeHtml(item.title)}</h3>
              <p>${escapeHtml(item.body || "暂无文字说明")}</p>
              <div class="meta">${(item.tags || []).map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`).join("")}</div>
              <div class="row">
                <button class="btn" data-open="${item.id}">查看</button>
                ${
                  state.user.role === "admin"
                    ? `<button class="btn secondary" data-edit="${item.id}">编辑</button><button class="btn danger" data-delete="${item.id}">删除</button>`
                    : ""
                }
              </div>
            </article>
          `
        )
        .join("")}
    </div>
    ${state.materials.length ? "" : '<div class="empty">没有找到符合条件的资料。</div>'}
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
  `;
  fitReadOnlyDiagrams();
  document.querySelector('[data-action="back"]').addEventListener("click", () => {
    state.selected = null;
    renderMainView();
  });
}

function fitReadOnlyDiagrams() {
  document.querySelectorAll(".diagram-view:not(.editable)").forEach((view) => {
    const canvas = view.querySelector(".diagram-canvas");
    const scaled = view.querySelector(".diagram-scaled");
    if (!canvas || !scaled) return;
    const layoutWidth = Number(canvas.dataset.layoutWidth);
    const layoutHeight = Number(canvas.dataset.layoutHeight);
    if (!layoutWidth || !layoutHeight) return;
    const availableWidth = Math.max(320, view.clientWidth - 4);
    const scale = Math.min(1, Math.max(0.25, availableWidth / layoutWidth));
    scaled.style.transform = `scale(${scale})`;
    canvas.style.width = `${layoutWidth * scale}px`;
    canvas.style.height = `${layoutHeight * scale}px`;
  });
}

function renderImages(images = []) {
  if (!images.length) return "";
  return `<div class="media-list">${images.map((img) => `<img src="${img.dataUrl}" alt="${escapeHtml(img.name || "图片")}" />`).join("")}</div>`;
}

function renderContentBlocks(blocks = [], material = {}) {
  return blocks
    .map((block) => {
      if (block.type === "image" && block.image?.dataUrl) {
        return `<figure class="content-image"><img src="${block.image.dataUrl}" alt="${escapeHtml(block.image.name || "图片")}" />${block.body ? `<figcaption>${escapeHtml(block.body).replaceAll("\n", "<br>")}</figcaption>` : ""}</figure>`;
      }
      if (block.type === "mindmap") {
        const diagram = block.mindmap ? normalizeDiagram(block.mindmap) : normalizeDiagram(material.mindmap);
        return `<section class="content-diagram"><h2>${diagramTypeText(diagram.structure)}</h2>${renderDiagram(diagram)}</section>`;
      }
      return block.body ? `<div class="body-text">${escapeHtml(block.body).replaceAll("\n", "<br>")}</div>` : "";
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
            <thead><tr><th>排序</th><th>标题</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              ${state.materials
                .map(
                  (item) => `
                    <tr draggable="true" data-material-row="${item.id}">
                      <td><span class="drag-handle" title="拖动排序">↕</span></td>
                      <td>${escapeHtml(item.title)}</td>
                      <td>${item.status === "draft" ? "草稿" : "发布"}</td>
                      <td><button class="btn secondary" data-edit="${item.id}">编辑</button></td>
                    </tr>
                  `
                )
                .join("")}
            </tbody>
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
  if (state.editing && !state.contentBlocks.length) state.contentBlocks = normalizeContentBlocks(material);
  target.innerHTML = `
    <form class="panel material-editor-page" id="materialForm">
      <div class="editor-page-head">
        <div>
          <h2>${state.editing ? "编辑资料" : "新增资料"}</h2>
          <p class="muted">当前页面专用于内容编辑，导图画布会占用完整宽度。</p>
        </div>
        <button class="btn secondary" type="button" data-action="backAdmin">返回后台</button>
      </div>
        <div data-error></div>
        <label class="field"><span>标题</span><input name="title" value="${escapeHtml(draft.title ?? material.title ?? "")}" required /></label>
        <label class="field"><span>分类</span><input name="category" list="categoryList" value="${escapeHtml(draft.category ?? material.category ?? state.categories[0] ?? "")}" required /></label>
        <datalist id="categoryList">${state.categories.map((item) => `<option>${escapeHtml(item)}</option>`).join("")}</datalist>
        <label class="field"><span>标签，用逗号分隔</span><input name="tags" value="${escapeHtml(draft.tags ?? (material.tags || []).join(", "))}" /></label>
        <label class="field"><span>状态</span><select name="status"><option value="published" ${(draft.status ?? material.status) !== "draft" ? "selected" : ""}>发布</option><option value="draft" ${(draft.status ?? material.status) === "draft" ? "selected" : ""}>草稿</option></select></label>
        ${renderContentBlockEditor()}
        <div class="row">
          <button class="btn" type="submit">${state.editing ? "保存修改" : "发布资料"}</button>
          <button class="btn secondary" type="button" data-action="newMaterial">新建空白</button>
        </div>
    </form>
  `;
  if (state.contentBlocks.some((block) => block.type === "mindmap")) renderMindEditor();
  bindMaterialEditor();
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
        <label class="field"><span>图片上方或下方的文字</span><textarea data-block-body="${index}" placeholder="这里可以写图片说明，也可以留空">${escapeHtml(block.body || "")}</textarea></label>
        <label class="field"><span>图片，单张不超过 3MB</span><input type="file" accept="image/*" data-block-image="${index}" /></label>
        ${block.image?.dataUrl ? `<figure class="content-image"><img src="${block.image.dataUrl}" alt="${escapeHtml(block.image.name || "图片")}" /><button type="button" class="btn secondary" data-clear-block-image="${index}">移除图片</button></figure>` : ""}
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
      <label class="field"><span>文字内容</span><textarea data-block-body="${index}">${escapeHtml(block.body || "")}</textarea></label>
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
  document.querySelectorAll("[data-block-body]").forEach((input) => {
    input.addEventListener("input", () => {
      state.contentBlocks[Number(input.dataset.blockBody)].body = input.value;
    });
  });
  document.querySelectorAll("[data-block-image]").forEach((input) => {
    input.addEventListener("change", async () => {
      setError("");
      const file = input.files?.[0];
      if (!file) return;
      try {
        state.contentBlocks[Number(input.dataset.blockImage)].image = await fileToDataUrl(file, 3 * 1024 * 1024, "图片");
        rememberMaterialForm();
        renderMainView();
      } catch (error) {
        setError(error.message);
      }
    });
  });
  document.querySelectorAll("[data-clear-block-image]").forEach((button) => {
    button.addEventListener("click", () => {
      rememberMaterialForm();
      state.contentBlocks[Number(button.dataset.clearBlockImage)].image = null;
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
    const images = blocks.filter((block) => block.type === "image" && block.image).map((block) => block.image);
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
              (log) => `<tr><td>${formatDate(log.createdAt)}</td><td>${escapeHtml(log.username)}</td><td>${escapeHtml(log.action)}</td><td>${escapeHtml(log.target)}</td><td>${escapeHtml(log.detail)}</td></tr>`
            )
            .join("")}
        </tbody>
      </table>
    </section>
  `;
}

window.addEventListener("resize", fitReadOnlyDiagrams);

boot().catch(() => renderLogin());
