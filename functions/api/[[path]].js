import { handleMerchantAction, emptyMerchantDb } from "../../merchant-core.mjs";

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
const DB_KEY = "db";
const MERCHANT_DB_KEY = "merchant-data";

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

async function readDb(env) {
  if (!env.TRAINING_DB) {
    throw Object.assign(new Error("缺少 Cloudflare KV 绑定 TRAINING_DB"), { status: 500 });
  }
  const db = await env.TRAINING_DB.get(DB_KEY, "json");
  if (db) return db;
  const seeded = await seedDb(env);
  await env.TRAINING_DB.put(DB_KEY, JSON.stringify(seeded));
  return seeded;
}

async function writeDb(env, db) {
  await env.TRAINING_DB.put(DB_KEY, JSON.stringify(db));
}

async function readMerchantDb(env) {
  return (await env.TRAINING_DB.get(MERCHANT_DB_KEY, "json")) || emptyMerchantDb();
}

async function writeMerchantDb(env, db) {
  await env.TRAINING_DB.put(MERCHANT_DB_KEY, JSON.stringify(db));
}

function ensureFeedbacks(db) {
  if (!Array.isArray(db.feedbacks)) db.feedbacks = [];
  return db.feedbacks;
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

async function getSessionUser(req, env, db) {
  const session = await readSession(cookieMap(req).session, env);
  if (!session) return null;
  return db.users.find((item) => item.id === session.userId && item.active) || null;
}

async function requireUser(req, env, db) {
  const user = await getSessionUser(req, env, db);
  if (!user) throw Object.assign(new Error("请先登录"), { status: 401 });
  return user;
}

async function requireAdmin(req, env, db) {
  const user = await requireUser(req, env, db);
  if (user.role !== "admin") throw Object.assign(new Error("只有管理员可以执行该操作"), { status: 403 });
  return user;
}

function audit(db, user, action, target, detail = "") {
  db.auditLogs.unshift({
    id: uid("log"),
    userId: user.id,
    username: user.username,
    action,
    target,
    detail,
    createdAt: now()
  });
  db.auditLogs = db.auditLogs.slice(0, 300);
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

function filterMaterials(db, user, query) {
  const q = String(query.get("q") || "").toLowerCase();
  const category = String(query.get("category") || "");
  const tag = String(query.get("tag") || "");
  return db.materials
    .filter((item) => user.role === "admin" || item.status === "published")
    .filter((item) => !category || item.category === category)
    .filter((item) => !tag || item.tags.includes(tag))
    .filter((item) => {
      if (!q) return true;
      return [item.title, item.category, item.body, ...(item.tags || [])].join(" ").toLowerCase().includes(q);
    });
}

async function route(req, env) {
  const db = await readDb(env);
  ensureFeedbacks(db);
  const url = new URL(req.url);
  const method = req.method;
  const pathname = url.pathname;

  if (pathname === "/api/setup" && method === "POST") {
    if (!db.setupRequired) return json({ error: "Setup has already been completed" }, 409);
    const body = await readJson(req);
    const password = String(body.password || "");
    if (password.length < 12) throw new Error("Password must be at least 12 characters");
    const admin = db.users.find((item) => item.username === "admin" || item.role === "admin");
    if (!admin) throw new Error("Admin account is missing");
    admin.passwordHash = await hashPassword(password);
    admin.active = true;
    db.setupRequired = false;
    audit(db, admin, "initial_setup", admin.id, "Completed initial admin setup");
    await writeDb(env, db);
    return json(
      { user: publicUser(admin), setupRequired: false },
      200,
      { "Set-Cookie": `session=${await makeSession(admin.id, env)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` }
    );
  }

  if (pathname === "/api/login" && method === "POST") {
    const body = await readJson(req);
    const user = db.users.find((item) => item.username === String(body.username || "").trim());
    if (!user || !user.active || !(await verifyPassword(String(body.password || ""), user.passwordHash))) {
      return json({ error: "账号或密码错误" }, 401);
    }
    audit(db, user, "login", "session", "用户登录");
    await writeDb(env, db);
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
    return json({ user: publicUser(await getSessionUser(req, env, db)), setupRequired: Boolean(db.setupRequired) });
  }

  const user = await requireUser(req, env, db);

  if (pathname.startsWith("/api/merchant/")) {
    const merchantDb = await readMerchantDb(env);
    const result = handleMerchantAction(merchantDb, {
      path: pathname, method,
      body: ["POST", "PUT"].includes(method) ? await readJson(req) : {},
      user, uid, now
    });
    if (result.changed) {
      await writeMerchantDb(env, merchantDb);
      if (result.audit) {
        audit(db, user, result.audit.action, result.audit.target, result.audit.detail);
        await writeDb(env, db);
      }
    }
    return json(result.data, result.status || 200);
  }

  if (pathname === "/api/bootstrap" && method === "GET") {
    return json({
      user: publicUser(user),
      categories: db.categories,
      tags: db.tags,
      materials: filterMaterials(db, user, url.searchParams).map((item) => ({
        ...item,
        body: item.body.length > 220 ? `${item.body.slice(0, 220)}...` : item.body
      }))
    });
  }

  if (pathname === "/api/materials" && method === "GET") {
    return json({ materials: filterMaterials(db, user, url.searchParams) });
  }

  if (pathname === "/api/feedback" && method === "POST") {
    const feedback = normalizeFeedback(await readJson(req), user);
    db.feedbacks.unshift(feedback);
    db.feedbacks = db.feedbacks.slice(0, 500);
    audit(db, user, "create_feedback", feedback.id, feedback.body.slice(0, 80));
    await writeDb(env, db);
    return json({ feedback }, 201);
  }

  if (pathname === "/api/feedback" && method === "GET") {
    await requireAdmin(req, env, db);
    return json({ feedbacks: ensureFeedbacks(db).slice(0, 300) });
  }

  if (pathname === "/api/materials/reorder" && method === "PUT") {
    const admin = await requireAdmin(req, env, db);
    const body = await readJson(req);
    const orderedIds = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const byId = new Map(db.materials.map((item) => [item.id, item]));
    const ordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
    const orderedSet = new Set(ordered.map((item) => item.id));
    db.materials = [...ordered, ...db.materials.filter((item) => !orderedSet.has(item.id))];
    audit(db, admin, "reorder_materials", "materials", "更新资料排序");
    await writeDb(env, db);
    return json({ materials: db.materials });
  }

  const materialMatch = pathname.match(/^\/api\/materials\/([^/]+)$/);
  if (materialMatch && method === "GET") {
    const material = db.materials.find((item) => item.id === materialMatch[1]);
    if (!material || (user.role !== "admin" && material.status !== "published")) return json({ error: "资料不存在" }, 404);
    return json({ material });
  }

  if (pathname === "/api/materials" && method === "POST") {
    const admin = await requireAdmin(req, env, db);
    const material = normalizeMaterial(await readJson(req), { id: uid("mat"), createdAt: now() });
    db.materials.unshift(material);
    for (const tag of material.tags) if (!db.tags.includes(tag)) db.tags.push(tag);
    if (!db.categories.includes(material.category)) db.categories.push(material.category);
    audit(db, admin, "create_material", material.id, material.title);
    await writeDb(env, db);
    return json({ material }, 201);
  }

  if (materialMatch && method === "PUT") {
    const admin = await requireAdmin(req, env, db);
    const index = db.materials.findIndex((item) => item.id === materialMatch[1]);
    if (index === -1) return json({ error: "资料不存在" }, 404);
    db.materials[index] = normalizeMaterial(await readJson(req), db.materials[index]);
    for (const tag of db.materials[index].tags) if (!db.tags.includes(tag)) db.tags.push(tag);
    if (!db.categories.includes(db.materials[index].category)) db.categories.push(db.materials[index].category);
    audit(db, admin, "update_material", db.materials[index].id, db.materials[index].title);
    await writeDb(env, db);
    return json({ material: db.materials[index] });
  }

  if (materialMatch && method === "DELETE") {
    const admin = await requireAdmin(req, env, db);
    const index = db.materials.findIndex((item) => item.id === materialMatch[1]);
    if (index === -1) return json({ error: "资料不存在" }, 404);
    const [removed] = db.materials.splice(index, 1);
    audit(db, admin, "delete_material", removed.id, removed.title);
    await writeDb(env, db);
    return json({ ok: true });
  }

  if (pathname === "/api/taxonomy" && method === "PUT") {
    const admin = await requireAdmin(req, env, db);
    const body = await readJson(req);
    db.categories = Array.from(new Set((body.categories || []).map((item) => String(item).trim()).filter(Boolean)));
    db.tags = Array.from(new Set((body.tags || []).map((item) => String(item).trim()).filter(Boolean)));
    audit(db, admin, "update_taxonomy", "taxonomy", "更新分类和标签");
    await writeDb(env, db);
    return json({ categories: db.categories, tags: db.tags });
  }

  if (pathname === "/api/users" && method === "GET") {
    await requireAdmin(req, env, db);
    return json({ users: db.users.map(publicUser) });
  }

  if (pathname === "/api/users" && method === "POST") {
    const admin = await requireAdmin(req, env, db);
    const body = await readJson(req);
    const username = String(body.username || "").trim();
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) throw new Error("账号需为 3-32 位字母、数字或符号 ._-");
    if (db.users.some((item) => item.username === username)) throw new Error("账号已存在");
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
    db.users.push(created);
    audit(db, admin, "create_user", created.id, created.username);
    await writeDb(env, db);
    return json({ user: publicUser(created) }, 201);
  }

  const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && method === "PUT") {
    const admin = await requireAdmin(req, env, db);
    const target = db.users.find((item) => item.id === userMatch[1]);
    if (!target) return json({ error: "账号不存在" }, 404);
    const body = await readJson(req);
    target.displayName = String(body.displayName || target.displayName).trim();
    target.role = body.role === "admin" ? "admin" : "employee";
    target.active = Boolean(body.active);
    if (body.password) {
      if (String(body.password).length < 6) throw new Error("密码至少 6 位");
      target.passwordHash = await hashPassword(String(body.password));
    }
    audit(db, admin, "update_user", target.id, target.username);
    await writeDb(env, db);
    return json({ user: publicUser(target) });
  }

  if (userMatch && method === "DELETE") {
    const admin = await requireAdmin(req, env, db);
    const index = db.users.findIndex((item) => item.id === userMatch[1]);
    if (index === -1) return json({ error: "账号不存在" }, 404);
    const target = db.users[index];
    if (target.id === admin.id) throw new Error("不能删除当前登录账号");
    const activeAdmins = db.users.filter((item) => item.role === "admin" && item.active);
    if (target.role === "admin" && target.active && activeAdmins.length <= 1) {
      throw new Error("至少需要保留一个启用的管理员账号");
    }
    db.users.splice(index, 1);
    audit(db, admin, "delete_user", target.id, target.username);
    await writeDb(env, db);
    return json({ ok: true });
  }

  if (pathname === "/api/audit-logs" && method === "GET") {
    await requireAdmin(req, env, db);
    return json({ auditLogs: db.auditLogs.slice(0, 100) });
  }

  return json({ error: "接口不存在" }, 404);
}

export async function onRequest(context) {
  try {
    return await route(context.request, context.env);
  } catch (error) {
    return json({ error: error.message || "请求失败" }, error.status || 400);
  }
}
