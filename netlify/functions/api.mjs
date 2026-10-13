import crypto from "node:crypto";
import { getDeployStore, getStore } from "@netlify/blobs";
import { handleMerchantAction, emptyMerchantDb } from "../../merchant-core.mjs";

const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const MAX_JSON_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_VIDEO_BYTES = 4 * 1024 * 1024;
const DB_KEY = "db.json";
const MERCHANT_DB_KEY = "merchant-data.json";

function now() {
  return new Date().toISOString();
}

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function env(name) {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || "";
}

function deployContext() {
  return globalThis.Netlify?.context?.deploy?.context || process.env.CONTEXT || "dev";
}

function isProduction() {
  return deployContext() === "production";
}

function secureCookieAttribute() {
  return deployContext() === "dev" ? "" : "; Secure";
}

function sessionSecret(db) {
  const configured = env("SESSION_SECRET");
  if (configured.length >= 32) return configured;
  const adminHash = db.users.find((user) => user.role === "admin")?.passwordHash || DB_KEY;
  return crypto.createHash("sha256").update(`${adminHash}:session`).digest("hex");
}

function sign(value, db) {
  return crypto.createHmac("sha256", sessionSecret(db)).update(value).digest("base64url");
}

function makeSession(userId, db) {
  const payload = Buffer.from(JSON.stringify({ userId, exp: Date.now() + SESSION_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload, db)}`;
}

function readSession(token, db) {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig || sign(payload, db) !== sig) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return session.exp > Date.now() ? session : null;
  } catch {
    return null;
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const test = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  const storedBuffer = Buffer.from(hash, "hex");
  const testBuffer = Buffer.from(test, "hex");
  return storedBuffer.length === testBuffer.length && crypto.timingSafeEqual(storedBuffer, testBuffer);
}

function seedDb() {
  const configuredAdminPassword = env("INITIAL_ADMIN_PASSWORD");
  const employeePassword = env("INITIAL_EMPLOYEE_PASSWORD");
  const setupRequired = isProduction() && configuredAdminPassword.length < 12;
  const adminPassword = configuredAdminPassword || (setupRequired ? crypto.randomBytes(32).toString("hex") : "admin123");
  const employeeActive = !isProduction() || employeePassword.length >= 12;

  return {
    setupRequired,
    users: [
      {
        id: "user_admin",
        username: "admin",
        displayName: "系统管理员",
        role: "admin",
        active: !setupRequired,
        passwordHash: hashPassword(adminPassword),
        createdAt: now()
      },
      {
        id: "user_employee",
        username: "employee",
        displayName: "普通员工",
        role: "employee",
        active: employeeActive,
        passwordHash: hashPassword(employeePassword || (employeeActive ? "employee123" : crypto.randomBytes(32).toString("hex"))),
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
    auditLogs: []
  };
}

function store() {
  if (isProduction()) {
    return getStore("training-library", { consistency: "strong" });
  }
  return getDeployStore({ name: "training-library", consistency: "strong" });
}

async function readDb() {
  const dbStore = store();
  const db = await dbStore.get(DB_KEY, { type: "json" });
  if (db) return db;
  const seeded = seedDb();
  await dbStore.setJSON(DB_KEY, seeded);
  return seeded;
}

async function writeDb(db) {
  const dbStore = store();
  await dbStore.setJSON(DB_KEY, db);
}

async function readMerchantDb() {
  return (await store().get(MERCHANT_DB_KEY, { type: "json" })) || emptyMerchantDb();
}

async function writeMerchantDb(db) {
  await store().setJSON(MERCHANT_DB_KEY, db);
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

function getSessionUser(req, db) {
  const session = readSession(cookieMap(req).session, db);
  if (!session) return null;
  return db.users.find((item) => item.id === session.userId && item.active) || null;
}

function requireUser(req, db) {
  const user = getSessionUser(req, db);
  if (!user) throw Object.assign(new Error("请先登录"), { status: 401 });
  return user;
}

function requireAdmin(req, db) {
  const user = requireUser(req, db);
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
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new Error("请求体过大");
  return text ? JSON.parse(text) : {};
}

function dataUrlBytes(dataUrl) {
  const base64 = String(dataUrl || "").split(",")[1] || "";
  return Buffer.byteLength(base64, "base64");
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

function validateUploads(payload) {
  const images = Array.isArray(payload.images) ? payload.images : [];
  for (const image of images) {
    if (!String(image.dataUrl || "").startsWith("data:image/")) throw new Error("图片格式不支持");
    if (dataUrlBytes(image.dataUrl) > MAX_IMAGE_BYTES) throw new Error("单张图片不能超过 3MB");
  }
  const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
  for (const block of blocks) {
    if (block?.type === "image") {
      for (const image of normalizeImageList(block)) {
        if (!String(image.dataUrl || "").startsWith("data:image/")) throw new Error("图片格式不支持");
        if (dataUrlBytes(image.dataUrl) > MAX_IMAGE_BYTES) throw new Error("单张图片不能超过 3MB");
      }
    }
  }
  if (payload.video?.mode === "upload") {
    if (!String(payload.video.dataUrl || "").startsWith("data:video/")) throw new Error("视频格式不支持");
    if (dataUrlBytes(payload.video.dataUrl) > MAX_VIDEO_BYTES) throw new Error("Netlify 在线版视频不能超过 4MB");
  }
}

function normalizeBlocks(payload) {
  if (!Array.isArray(payload.blocks)) return [];
  return payload.blocks
    .map((block) => {
      if (block?.type === "image") {
        const images = normalizeImageList(block);
        return {
          type: "image",
          body: String(block.body || ""),
          image: images[0] || null,
          images
        };
      }
      if (block?.type === "mindmap") {
        return { type: "mindmap", mindmap: block.mindmap || payload.mindmap || null };
      }
      return { type: "text", body: String(block?.body || "") };
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

async function route(req) {
  const db = await readDb();
  const url = new URL(req.url);
  const pathname = url.pathname.replace(/^\/\.netlify\/functions\/api/, "/api");
  const method = req.method;

  if (pathname === "/api/login" && method === "POST") {
    const body = await readJson(req);
    const user = db.users.find((item) => item.username === String(body.username || "").trim());
    if (!user || !user.active || !verifyPassword(String(body.password || ""), user.passwordHash)) {
      return json({ error: "账号或密码错误" }, 401);
    }
    audit(db, user, "login", "session", "用户登录");
    await writeDb(db);
    return json(
      { user: publicUser(user) },
      200,
      { "Set-Cookie": `session=${makeSession(user.id, db)}; HttpOnly${secureCookieAttribute()}; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` }
    );
  }

  if (pathname === "/api/setup" && method === "POST") {
    if (!db.setupRequired) return json({ error: "系统已经完成初始化" }, 409);
    const body = await readJson(req);
    const password = String(body.password || "");
    if (password.length < 12) throw new Error("管理员密码至少需要 12 位");
    const admin = db.users.find((item) => item.role === "admin");
    if (!admin) throw Object.assign(new Error("系统缺少管理员账号"), { status: 500 });
    admin.displayName = String(body.displayName || admin.displayName).trim() || admin.displayName;
    admin.passwordHash = hashPassword(password);
    admin.active = true;
    db.setupRequired = false;
    audit(db, admin, "initial_setup", admin.id, "完成首次管理员设置");
    await writeDb(db);
    return json(
      { user: publicUser(admin) },
      200,
      { "Set-Cookie": `session=${makeSession(admin.id, db)}; HttpOnly${secureCookieAttribute()}; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` }
    );
  }

  if (pathname === "/api/logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": `session=; HttpOnly${secureCookieAttribute()}; SameSite=Lax; Path=/; Max-Age=0` });
  }

  if (pathname === "/api/me" && method === "GET") {
    return json({ user: publicUser(getSessionUser(req, db)), setupRequired: Boolean(db.setupRequired) });
  }

  const user = requireUser(req, db);

  if (pathname.startsWith("/api/merchant/")) {
    const merchantDb = await readMerchantDb();
    const result = handleMerchantAction(merchantDb, {
      path: pathname, method,
      body: ["POST", "PUT"].includes(method) ? await readJson(req) : {},
      user, uid, now
    });
    if (result.changed) {
      await writeMerchantDb(merchantDb);
      if (result.audit) {
        audit(db, user, result.audit.action, result.audit.target, result.audit.detail);
        await writeDb(db);
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

  if (pathname === "/api/materials/reorder" && method === "PUT") {
    const admin = requireAdmin(req, db);
    const body = await readJson(req);
    const orderedIds = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const byId = new Map(db.materials.map((item) => [item.id, item]));
    const ordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
    const orderedSet = new Set(ordered.map((item) => item.id));
    db.materials = [...ordered, ...db.materials.filter((item) => !orderedSet.has(item.id))];
    audit(db, admin, "reorder_materials", "materials", "更新资料排序");
    await writeDb(db);
    return json({ materials: db.materials });
  }

  const materialMatch = pathname.match(/^\/api\/materials\/([^/]+)$/);
  if (materialMatch && method === "GET") {
    const material = db.materials.find((item) => item.id === materialMatch[1]);
    if (!material || (user.role !== "admin" && material.status !== "published")) return json({ error: "资料不存在" }, 404);
    return json({ material });
  }

  if (pathname === "/api/materials" && method === "POST") {
    const admin = requireAdmin(req, db);
    const body = await readJson(req);
    const material = normalizeMaterial(body, { id: uid("mat"), createdAt: now() });
    db.materials.unshift(material);
    for (const tag of material.tags) if (!db.tags.includes(tag)) db.tags.push(tag);
    if (!db.categories.includes(material.category)) db.categories.push(material.category);
    audit(db, admin, "create_material", material.id, material.title);
    await writeDb(db);
    return json({ material }, 201);
  }

  if (materialMatch && method === "PUT") {
    const admin = requireAdmin(req, db);
    const index = db.materials.findIndex((item) => item.id === materialMatch[1]);
    if (index === -1) return json({ error: "资料不存在" }, 404);
    db.materials[index] = normalizeMaterial(await readJson(req), db.materials[index]);
    for (const tag of db.materials[index].tags) if (!db.tags.includes(tag)) db.tags.push(tag);
    if (!db.categories.includes(db.materials[index].category)) db.categories.push(db.materials[index].category);
    audit(db, admin, "update_material", db.materials[index].id, db.materials[index].title);
    await writeDb(db);
    return json({ material: db.materials[index] });
  }

  if (materialMatch && method === "DELETE") {
    const admin = requireAdmin(req, db);
    const index = db.materials.findIndex((item) => item.id === materialMatch[1]);
    if (index === -1) return json({ error: "资料不存在" }, 404);
    const [removed] = db.materials.splice(index, 1);
    audit(db, admin, "delete_material", removed.id, removed.title);
    await writeDb(db);
    return json({ ok: true });
  }

  if (pathname === "/api/taxonomy" && method === "PUT") {
    const admin = requireAdmin(req, db);
    const body = await readJson(req);
    db.categories = Array.from(new Set((body.categories || []).map((item) => String(item).trim()).filter(Boolean)));
    db.tags = Array.from(new Set((body.tags || []).map((item) => String(item).trim()).filter(Boolean)));
    audit(db, admin, "update_taxonomy", "taxonomy", "更新分类和标签");
    await writeDb(db);
    return json({ categories: db.categories, tags: db.tags });
  }

  if (pathname === "/api/users" && method === "GET") {
    requireAdmin(req, db);
    return json({ users: db.users.map(publicUser) });
  }

  if (pathname === "/api/users" && method === "POST") {
    const admin = requireAdmin(req, db);
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
      passwordHash: hashPassword(String(body.password)),
      createdAt: now()
    };
    db.users.push(created);
    audit(db, admin, "create_user", created.id, created.username);
    await writeDb(db);
    return json({ user: publicUser(created) }, 201);
  }

  const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && method === "PUT") {
    const admin = requireAdmin(req, db);
    const target = db.users.find((item) => item.id === userMatch[1]);
    if (!target) return json({ error: "账号不存在" }, 404);
    const body = await readJson(req);
    target.displayName = String(body.displayName || target.displayName).trim();
    target.role = body.role === "admin" ? "admin" : "employee";
    target.active = Boolean(body.active);
    if (body.password) {
      if (String(body.password).length < 6) throw new Error("密码至少 6 位");
      target.passwordHash = hashPassword(String(body.password));
    }
    audit(db, admin, "update_user", target.id, target.username);
    await writeDb(db);
    return json({ user: publicUser(target) });
  }

  if (userMatch && method === "DELETE") {
    const admin = requireAdmin(req, db);
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
    await writeDb(db);
    return json({ ok: true });
  }

  if (pathname === "/api/audit-logs" && method === "GET") {
    requireAdmin(req, db);
    return json({ auditLogs: db.auditLogs.slice(0, 100) });
  }

  return json({ error: "接口不存在" }, 404);
}

export default async function handler(req) {
  try {
    return await route(req);
  } catch (error) {
    return json({ error: error.message || "请求失败" }, error.status || 400);
  }
}

export const config = {
  path: ["/api", "/api/*"]
};
