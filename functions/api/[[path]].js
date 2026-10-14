import {
  createFeedback,
  createUser,
  deleteMaterial,
  deleteUser,
  getSetupRequired,
  getUserById,
  getUserByUsername,
  handleMerchantRequest,
  listAuditLogs,
  listFeedbacks,
  listUsers,
  readMaterial,
  readMaterialIndex,
  readTaxonomy,
  recordAudit,
  reorderMaterials,
  setSetupRequired,
  updateUser,
  writeMaterial,
  writeTaxonomy
} from "../../cloudflare-store.mjs";

const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const MAX_JSON_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_FEEDBACK_IMAGES = 6;
const MAX_FEEDBACK_TOTAL_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_VIDEO_BYTES = 4 * 1024 * 1024;
const TEXT_STYLE_FONT_SIZES = [14, 16, 18, 20, 22, 24, 28, 32];
const TEXT_STYLE_COLORS = [
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
const PASSWORD_HASH_ITERATIONS = 100000;

function now() {
  return new Date().toISOString();
}

function uid(prefix) {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function base64Url(bytes) {
  const raw = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value) {
  const padded = String(value).replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function textBytes(value) {
  return new TextEncoder().encode(value);
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey("raw", textBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(await crypto.subtle.sign("HMAC", key, textBytes(value)));
}

async function secret(env) {
  return env.SESSION_SECRET || "change-this-session-secret-before-production";
}

function envValue(env, name) {
  return String(env?.[name] || "");
}

function isProduction(env) {
  return envValue(env, "ENVIRONMENT") === "production";
}

async function makeSession(userId, env) {
  const payload = base64Url(textBytes(JSON.stringify({ userId, exp: Date.now() + SESSION_TTL_MS })));
  return `${payload}.${await hmac(payload, await secret(env))}`;
}

async function readSession(token, env) {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig || (await hmac(payload, await secret(env))) !== sig) return null;
  try {
    const session = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    return session.exp > Date.now() ? session : null;
  } catch {
    return null;
  }
}

async function hashPassword(password, salt = uid("salt")) {
  const key = await crypto.subtle.importKey("raw", textBytes(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: textBytes(salt), iterations: PASSWORD_HASH_ITERATIONS },
    key,
    256
  );
  return `${salt}:${base64Url(bits)}`;
}

async function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  return (await hashPassword(password, salt)) === stored;
}

async function seedDb(env) {
  const configuredAdminPassword = envValue(env, "INITIAL_ADMIN_PASSWORD");
  const employeePassword = envValue(env, "INITIAL_EMPLOYEE_PASSWORD");
  const setupRequired = isProduction(env) && configuredAdminPassword.length < 12;
  const adminPassword = configuredAdminPassword || (setupRequired ? uid("admin").repeat(4) : "admin123");
  const employeeActive = !isProduction(env) || employeePassword.length >= 12;

  return {
    setupRequired,
    users: [
      {
        id: "user_admin",
        username: "admin",
        displayName: "系统管理员",
        role: "admin",
        active: !setupRequired,
        passwordHash: await hashPassword(adminPassword),
        createdAt: now()
      },
      {
        id: "user_employee",
        username: "employee",
        displayName: "普通员工",
        role: "employee",
        active: employeeActive,
        passwordHash: await hashPassword(employeePassword || (employeeActive ? "employee123" : uid("employee").repeat(4))),
        createdAt: now()
      }
    ],
    categories: ["入职培训", "制度流程", "岗位技能", "安全合规"],
    tags: ["新人必读", "流程", "产品", "销售", "技术", "合规"],
    materials: [
      {
        id: uid("mat"),
        title: "新人入职第一天清单",
        category: "入职培训",
        tags: ["新人必读", "流程"],
        status: "published",
        type: "text",
        body: "欢迎加入团队。第一天请完成账号开通、制度阅读、部门介绍和导师沟通。管理员可以在后台编辑这篇示例资料。",
        images: [],
        video: null,
        mindmap: null,
        createdAt: now(),
        updatedAt: now()
      },
      {
        id: uid("mat"),
        title: "产品知识学习路径",
        category: "岗位技能",
        tags: ["产品", "新人必读"],
        status: "published",
        type: "mindmap",
        body: "这是一份示例思维导图，可在管理员后台继续扩展节点。",
        images: [],
        video: null,
        mindmap: {
          text: "产品知识",
          children: [
            { text: "核心功能", children: [{ text: "客户场景", children: [] }] },
            { text: "常见问题", children: [] },
            { text: "演示话术", children: [] }
          ]
        },
        createdAt: now(),
        updatedAt: now()
      }
    ],
    auditLogs: [],
    feedbacks: []
  };
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    active: user.active
  };
}

function cookieMap(req) {
  return Object.fromEntries(
    String(req.headers.get("cookie") || "")
      .split(";")
      .map((item) => item.trim().split("="))
      .filter((pair) => pair.length === 2)
  );
}

async function getSessionUser(req, env) {
  const session = await readSession(cookieMap(req).session, env);
  if (!session) return null;
  const user = await getUserById(env, session.userId);
  return user?.active ? user : null;
}

async function requireUser(req, env) {
  const user = await getSessionUser(req, env);
  if (!user) throw Object.assign(new Error("请先登录"), { status: 401 });
  return user;
}

async function requireAdmin(req, env) {
  const user = await requireUser(req, env);
  if (user.role !== "admin") throw Object.assign(new Error("只有管理员可以执行该操作"), { status: 403 });
  return user;
}

function auditEntry(user, action, target, detail = "") {
  return {
    id: uid("log"),
    userId: user.id,
    username: user.username,
    action,
    target,
    detail,
    createdAt: now()
  };
}

async function readJson(req) {
  const text = await req.text();
  if (new Blob([text]).size > MAX_JSON_BYTES) throw new Error("请求体过大");
  return text ? JSON.parse(text) : {};
}

function dataUrlBytes(dataUrl) {
  const base64 = String(dataUrl || "").split(",")[1] || "";
  return fromBase64Url(base64.replaceAll("+", "-").replaceAll("/", "_")).byteLength;
}

function normalizeImageList(source = {}) {
  const images = [];
  if (source.image) images.push(source.image);
  if (Array.isArray(source.images)) images.push(...source.images);
  const seen = new Set();
  return images
    .map((image) => ({ name: String(image?.name || ""), dataUrl: String(image?.dataUrl || "") }))
    .filter((image) => {
      if (!image.dataUrl) return false;
      const key = `${image.name}:${image.dataUrl}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 9);
}

function normalizeFeedback(payload, user) {
  const body = String(payload.body || "").trim();
  const images = Array.isArray(payload.images) ? payload.images : [];
  if (!body && !images.length) throw new Error("请填写反馈内容或上传图片");
  if (images.length > MAX_FEEDBACK_IMAGES) throw new Error(`最多上传 ${MAX_FEEDBACK_IMAGES} 张图片`);
  let totalBytes = 0;
  const normalizedImages = images.map((image) => {
    const dataUrl = String(image?.dataUrl || "");
    if (!dataUrl.startsWith("data:image/")) throw new Error("反馈图片格式不支持");
    const bytes = dataUrlBytes(dataUrl);
    totalBytes += bytes;
    if (bytes > MAX_IMAGE_BYTES) throw new Error("单张图片不能超过 3MB");
    return { name: String(image?.name || "反馈图片"), dataUrl };
  });
  if (totalBytes > MAX_FEEDBACK_TOTAL_IMAGE_BYTES) throw new Error("反馈图片总大小不能超过 4MB");
  return {
    id: uid("fb"),
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    body,
    images: normalizedImages,
    createdAt: now()
  };
}

function normalizeTextStyle(style = {}) {
  const fontSize = Number(style?.fontSize);
  const color = String(style?.color || "");
  return {
    fontSize: TEXT_STYLE_FONT_SIZES.includes(fontSize) ? fontSize : "",
    color: TEXT_STYLE_COLORS.includes(color) ? color : ""
  };
}

function normalizeRichTextSegments(segments, fallbackBody = "", fallbackStyle = {}) {
  const normalized = [];
  if (Array.isArray(segments)) {
    for (const segment of segments) {
      const text = String(segment?.text || "");
      if (!text) continue;
      const style = normalizeTextStyle(segment);
      const previous = normalized.at(-1);
      if (previous && previous.fontSize === style.fontSize && previous.color === style.color) previous.text += text;
      else normalized.push({ text, ...style });
    }
  }
  if (!normalized.length && String(fallbackBody || "")) {
    normalized.push({ text: String(fallbackBody || ""), ...normalizeTextStyle(fallbackStyle) });
  }
  return normalized;
}

function validateUploads(payload) {
  const images = Array.isArray(payload.images) ? payload.images : [];
  for (const image of images) {
    if (!String(image.dataUrl || "").startsWith("data:image/")) throw new Error("图片格式不支持");
    if (dataUrlBytes(image.dataUrl) > MAX_IMAGE_BYTES) throw new Error("单张图片不能超过 3MB");
  }
  const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
  for (const block of blocks) {
    if (block?.type === "image" && Array.isArray(block.images)) {
      for (const image of normalizeImageList(block)) {
        if (!String(image.dataUrl || "").startsWith("data:image/")) throw new Error("Image format is not supported");
        if (dataUrlBytes(image.dataUrl) > MAX_IMAGE_BYTES) throw new Error("Each image must be 3MB or smaller");
      }
    }
    if (block?.type === "image" && block.image?.dataUrl) {
      if (!String(block.image.dataUrl || "").startsWith("data:image/")) throw new Error("图片格式不支持");
      if (dataUrlBytes(block.image.dataUrl) > MAX_IMAGE_BYTES) throw new Error("单张图片不能超过 3MB");
    }
  }
  if (payload.video?.mode === "upload") {
    if (!String(payload.video.dataUrl || "").startsWith("data:video/")) throw new Error("视频格式不支持");
    if (dataUrlBytes(payload.video.dataUrl) > MAX_VIDEO_BYTES) throw new Error("Cloudflare 在线版视频不能超过 4MB");
  }
}

function normalizeBlocks(payload) {
  if (!Array.isArray(payload.blocks)) return [];
  return payload.blocks
    .map((block) => {
      if (block?.type === "image") {
        const richText = normalizeRichTextSegments(block.richText, block.body, block.textStyle);
        const images = normalizeImageList(block);
        return {
          type: "image",
          body: richText.map((segment) => segment.text).join(""),
          image: images[0] || null,
          images,
          richText
        };
      }
      if (block?.type === "mindmap") {
        return { type: "mindmap", mindmap: block.mindmap || payload.mindmap || null };
      }
      const richText = normalizeRichTextSegments(block?.richText, block?.body, block?.textStyle);
      return { type: "text", body: richText.map((segment) => segment.text).join(""), richText };
    })
    .filter((block) => block.type !== "text" || block.body.trim() || block.type === "mindmap");
}

function normalizeMaterial(payload, existing = {}) {
  validateUploads(payload);
  const blocks = normalizeBlocks(payload);
  const images = Array.isArray(payload.images) && payload.images.length ? payload.images : blocks.flatMap((block) => (block.type === "image" ? normalizeImageList(block) : []));
  const title = String(payload.title || "").trim();
  if (!title) throw new Error("标题不能为空");
  const category = String(payload.category || "").trim();
  if (!category) throw new Error("分类不能为空");
  const video = payload.video?.mode
    ? {
        mode: payload.video.mode === "upload" ? "upload" : "external",
        url: String(payload.video.url || "").trim(),
        dataUrl: payload.video.mode === "upload" ? String(payload.video.dataUrl || "") : "",
        name: String(payload.video.name || "")
      }
    : null;
  if (video?.mode === "external" && video.url && !/^https?:\/\//i.test(video.url)) {
    throw new Error("外链视频必须以 http:// 或 https:// 开头");
  }
  return {
    ...existing,
    title,
    category,
    tags: Array.isArray(payload.tags) ? payload.tags.map((tag) => String(tag).trim()).filter(Boolean) : [],
    status: payload.status === "draft" ? "draft" : "published",
    type: payload.type || "text",
    body: String(payload.body || ""),
    images,
    video,
    mindmap: payload.mindmap || null,
    blocks,
    updatedAt: now()
  };
}

function filterMaterials(materials, user, query) {
  const q = String(query.get("q") || "").toLowerCase();
  const category = String(query.get("category") || "");
  const tag = String(query.get("tag") || "");
  return materials
    .filter((item) => user.role === "admin" || item.status === "published")
    .filter((item) => !category || item.category === category)
    .filter((item) => !tag || item.tags.includes(tag))
    .filter((item) => {
      if (!q) return true;
      return [item.title, item.category, item.body, ...(item.tags || [])].join(" ").toLowerCase().includes(q);
    });
}

async function route(req, env, waitUntil) {
  const url = new URL(req.url);
  const method = req.method;
  const pathname = url.pathname;
  const saveAudit = async (entry) => {
    const promise = recordAudit(env, entry);
    if (waitUntil) {
      waitUntil(promise);
      return;
    }
    await promise;
  };

  if (pathname === "/api/setup" && method === "POST") {
    if (!(await getSetupRequired(env))) return json({ error: "Setup has already been completed" }, 409);
    const body = await readJson(req);
    const password = String(body.password || "");
    if (password.length < 12) throw new Error("Password must be at least 12 characters");
    const users = await listUsers(env);
    const admin = users.find((item) => item.username === "admin" || item.role === "admin");
    if (!admin) throw new Error("Admin account is missing");
    admin.passwordHash = await hashPassword(password);
    admin.active = true;
    await Promise.all([updateUser(env, admin), setSetupRequired(env, false)]);
    await saveAudit(auditEntry(admin, "initial_setup", admin.id, "Completed initial admin setup"));
    return json(
      { user: publicUser(admin), setupRequired: false },
      200,
      { "Set-Cookie": `session=${await makeSession(admin.id, env)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` }
    );
  }

  if (pathname === "/api/login" && method === "POST") {
    const body = await readJson(req);
    const user = await getUserByUsername(env, String(body.username || "").trim());
    if (!user || !user.active || !(await verifyPassword(String(body.password || ""), user.passwordHash))) {
      return json({ error: "账号或密码错误" }, 401);
    }
    await saveAudit(auditEntry(user, "login", "session", "用户登录"));
    return json(
      { user: publicUser(user) },
      200,
      { "Set-Cookie": `session=${await makeSession(user.id, env)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` }
    );
  }

  if (pathname === "/api/logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": "session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0" });
  }

  if (pathname === "/api/me" && method === "GET") {
    const [user, setupRequired] = await Promise.all([getSessionUser(req, env), getSetupRequired(env)]);
    return json({ user: publicUser(user), setupRequired });
  }

  const user = await requireUser(req, env);
  const adminOnly = () => {
    if (user.role !== "admin") throw Object.assign(new Error("只有管理员可以执行该操作"), { status: 403 });
    return user;
  };

  if (pathname.startsWith("/api/merchant/")) {
    const result = await handleMerchantRequest(env, {
      path: pathname, method,
      body: ["POST", "PUT"].includes(method) ? await readJson(req) : {},
      user, uid, now
    });
    if (result.audit) {
      await saveAudit(auditEntry(user, result.audit.action, result.audit.target, result.audit.detail));
    }
    return json(result.data, result.status || 200);
  }

  if (pathname === "/api/bootstrap" && method === "GET") {
    const [taxonomy, materials] = await Promise.all([readTaxonomy(env), readMaterialIndex(env)]);
    return json({
      user: publicUser(user),
      categories: taxonomy.categories,
      tags: taxonomy.tags,
      materials: filterMaterials(materials, user, url.searchParams).map((item) => ({
        ...item,
        body: item.body.length > 220 ? `${item.body.slice(0, 220)}...` : item.body
      }))
    });
  }

  if (pathname === "/api/materials" && method === "GET") {
    const materials = await readMaterialIndex(env);
    return json({ materials: filterMaterials(materials, user, url.searchParams) });
  }

  if (pathname === "/api/feedback" && method === "POST") {
    const feedback = normalizeFeedback(await readJson(req), user);
    await createFeedback(env, feedback);
    await saveAudit(auditEntry(user, "create_feedback", feedback.id, feedback.body.slice(0, 80)));
    return json({ feedback }, 201);
  }

  if (pathname === "/api/feedback" && method === "GET") {
    adminOnly();
    return json({ feedbacks: await listFeedbacks(env) });
  }

  if (pathname === "/api/materials/reorder" && method === "PUT") {
    const admin = adminOnly();
    const body = await readJson(req);
    const orderedIds = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const materials = await reorderMaterials(env, orderedIds);
    await saveAudit(auditEntry(admin, "reorder_materials", "materials", "更新资料排序"));
    return json({ materials });
  }

  const materialMatch = pathname.match(/^\/api\/materials\/([^/]+)$/);
  if (materialMatch && method === "GET") {
    const material = await readMaterial(env, materialMatch[1]);
    if (!material || (user.role !== "admin" && material.status !== "published")) return json({ error: "资料不存在" }, 404);
    return json({ material });
  }

  if (pathname === "/api/materials" && method === "POST") {
    const admin = adminOnly();
    const material = normalizeMaterial(await readJson(req), { id: uid("mat"), createdAt: now() });
    const taxonomy = await readTaxonomy(env);
    for (const tag of material.tags) if (!taxonomy.tags.includes(tag)) taxonomy.tags.push(tag);
    if (!taxonomy.categories.includes(material.category)) taxonomy.categories.push(material.category);
    await Promise.all([writeMaterial(env, material, { prepend: true }), writeTaxonomy(env, taxonomy)]);
    await saveAudit(auditEntry(admin, "create_material", material.id, material.title));
    return json({ material }, 201);
  }

  if (materialMatch && method === "PUT") {
    const admin = adminOnly();
    const existing = await readMaterial(env, materialMatch[1]);
    if (!existing) return json({ error: "资料不存在" }, 404);
    const material = normalizeMaterial(await readJson(req), existing);
    const taxonomy = await readTaxonomy(env);
    for (const tag of material.tags) if (!taxonomy.tags.includes(tag)) taxonomy.tags.push(tag);
    if (!taxonomy.categories.includes(material.category)) taxonomy.categories.push(material.category);
    await Promise.all([writeMaterial(env, material), writeTaxonomy(env, taxonomy)]);
    await saveAudit(auditEntry(admin, "update_material", material.id, material.title));
    return json({ material });
  }

  if (materialMatch && method === "DELETE") {
    const admin = adminOnly();
    const removed = await deleteMaterial(env, materialMatch[1]);
    if (!removed) return json({ error: "资料不存在" }, 404);
    await saveAudit(auditEntry(admin, "delete_material", removed.id, removed.title));
    return json({ ok: true });
  }

  if (pathname === "/api/taxonomy" && method === "PUT") {
    const admin = adminOnly();
    const body = await readJson(req);
    const taxonomy = {
      categories: Array.from(new Set((body.categories || []).map((item) => String(item).trim()).filter(Boolean))),
      tags: Array.from(new Set((body.tags || []).map((item) => String(item).trim()).filter(Boolean)))
    };
    await writeTaxonomy(env, taxonomy);
    await saveAudit(auditEntry(admin, "update_taxonomy", "taxonomy", "更新分类和标签"));
    return json(taxonomy);
  }

  if (pathname === "/api/users" && method === "GET") {
    adminOnly();
    return json({ users: (await listUsers(env)).map(publicUser) });
  }

  if (pathname === "/api/users" && method === "POST") {
    const admin = adminOnly();
    const body = await readJson(req);
    const username = String(body.username || "").trim();
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) throw new Error("账号需为 3-32 位字母、数字或符号 ._-");
    if (await getUserByUsername(env, username)) throw new Error("账号已存在");
    if (String(body.password || "").length < 6) throw new Error("密码至少 6 位");
    const created = {
      id: uid("user"),
      username,
      displayName: String(body.displayName || username).trim(),
      role: body.role === "admin" ? "admin" : "employee",
      active: true,
      passwordHash: await hashPassword(String(body.password)),
      createdAt: now()
    };
    await createUser(env, created);
    await saveAudit(auditEntry(admin, "create_user", created.id, created.username));
    return json({ user: publicUser(created) }, 201);
  }

  const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && method === "PUT") {
    const admin = adminOnly();
    const target = await getUserById(env, userMatch[1]);
    if (!target) return json({ error: "账号不存在" }, 404);
    const body = await readJson(req);
    target.displayName = String(body.displayName || target.displayName).trim();
    target.role = body.role === "admin" ? "admin" : "employee";
    target.active = Boolean(body.active);
    if (body.password) {
      if (String(body.password).length < 6) throw new Error("密码至少 6 位");
      target.passwordHash = await hashPassword(String(body.password));
    }
    await updateUser(env, target);
    await saveAudit(auditEntry(admin, "update_user", target.id, target.username));
    return json({ user: publicUser(target) });
  }

  if (userMatch && method === "DELETE") {
    const admin = adminOnly();
    const users = await listUsers(env);
    const target = users.find((item) => item.id === userMatch[1]);
    if (!target) return json({ error: "账号不存在" }, 404);
    if (target.id === admin.id) throw new Error("不能删除当前登录账号");
    const activeAdmins = users.filter((item) => item.role === "admin" && item.active);
    if (target.role === "admin" && target.active && activeAdmins.length <= 1) {
      throw new Error("至少需要保留一个启用的管理员账号");
    }
    await deleteUser(env, target.id);
    await saveAudit(auditEntry(admin, "delete_user", target.id, target.username));
    return json({ ok: true });
  }

  if (pathname === "/api/audit-logs" && method === "GET") {
    adminOnly();
    return json({ auditLogs: await listAuditLogs(env, 100) });
  }

  return json({ error: "接口不存在" }, 404);
}

export async function onRequest(context) {
  try {
    return await route(context.request, context.env, (promise) => context.waitUntil(promise));
  } catch (error) {
    return json({ error: error.message || "请求失败" }, error.status || 400);
  }
}
