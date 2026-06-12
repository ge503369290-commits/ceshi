const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DB_PATH = path.join(ROOT, "data", "db.json");
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const MAX_JSON_BYTES = 60 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_VIDEO_BYTES = 4 * 1024 * 1024;

const sessions = new Map();

function now() {
  return new Date().toISOString();
}

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const test = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(test, "hex"));
}

function seedDb() {
  return {
    users: [
      {
        id: "user_admin",
        username: "admin",
        displayName: "系统管理员",
        role: "admin",
        active: true,
        passwordHash: hashPassword("admin123"),
        createdAt: now()
      },
      {
        id: "user_employee",
        username: "employee",
        displayName: "普通员工",
        role: "employee",
        active: true,
        passwordHash: hashPassword("employee123"),
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

function readDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(seedDb(), null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
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

function send(res, status, payload, headers = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": typeof payload === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(body);
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const safePath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden");
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return send(res, 404, "Not found");
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp"
  };
  res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((item) => item.trim().split("="))
      .filter((pair) => pair.length === 2)
  );
}

function getSessionUser(req, db) {
  const token = parseCookies(req).session;
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  const user = db.users.find((item) => item.id === session.userId && item.active);
  if (!user) return null;
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return user;
}

function requireUser(req, res, db) {
  const user = getSessionUser(req, db);
  if (!user) send(res, 401, { error: "请先登录" });
  return user;
}

function requireAdmin(req, res, db) {
  const user = requireUser(req, res, db);
  if (!user) return null;
  if (user.role !== "admin") {
    send(res, 403, { error: "只有管理员可以执行该操作" });
    return null;
  }
  return user;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON 格式错误"));
      }
    });
    req.on("error", reject);
  });
}

function dataUrlBytes(dataUrl) {
  const base64 = String(dataUrl || "").split(",")[1] || "";
  return Buffer.byteLength(base64, "base64");
}

function validateUploads(payload) {
  const images = Array.isArray(payload.images) ? payload.images : [];
  for (const image of images) {
    if (!String(image.dataUrl || "").startsWith("data:image/")) throw new Error("图片格式不支持");
    if (dataUrlBytes(image.dataUrl) > MAX_IMAGE_BYTES) throw new Error("单张图片不能超过 3MB");
  }
  const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
  for (const block of blocks) {
    if (block?.type === "image" && block.image?.dataUrl) {
      if (!String(block.image.dataUrl || "").startsWith("data:image/")) throw new Error("图片格式不支持");
      if (dataUrlBytes(block.image.dataUrl) > MAX_IMAGE_BYTES) throw new Error("单张图片不能超过 3MB");
    }
  }
  if (payload.video?.mode === "upload") {
    if (!String(payload.video.dataUrl || "").startsWith("data:video/")) throw new Error("视频格式不支持");
    if (dataUrlBytes(payload.video.dataUrl) > MAX_VIDEO_BYTES) throw new Error("视频不能超过 4MB");
  }
}

function normalizeBlocks(payload) {
  if (!Array.isArray(payload.blocks)) return [];
  return payload.blocks
    .map((block) => {
      if (block?.type === "image") {
        return {
          type: "image",
          body: String(block.body || ""),
          image: block.image?.dataUrl ? { name: String(block.image.name || ""), dataUrl: String(block.image.dataUrl) } : null
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
  const title = String(payload.title || "").trim();
  if (!title) throw new Error("标题不能为空");
  const category = String(payload.category || "").trim();
  if (!category) throw new Error("分类不能为空");
  const status = payload.status === "draft" ? "draft" : "published";
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
    status,
    type: payload.type || "text",
    body: String(payload.body || ""),
    images: Array.isArray(payload.images) ? payload.images : [],
    video,
    mindmap: payload.mindmap || null,
    blocks: normalizeBlocks(payload),
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

async function handleApi(req, res) {
  const db = readDb();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;

  try {
    if (url.pathname === "/api/login" && method === "POST") {
      const body = await readJson(req);
      const user = db.users.find((item) => item.username === String(body.username || "").trim());
      if (!user || !user.active || !verifyPassword(String(body.password || ""), user.passwordHash)) {
        return send(res, 401, { error: "账号或密码错误" });
      }
      const token = crypto.randomBytes(24).toString("hex");
      sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
      audit(db, user, "login", "session", "用户登录");
      writeDb(db);
      return send(res, 200, { user: publicUser(user) }, { "Set-Cookie": `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` });
    }

    if (url.pathname === "/api/logout" && method === "POST") {
      const token = parseCookies(req).session;
      if (token) sessions.delete(token);
      return send(res, 200, { ok: true }, { "Set-Cookie": "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
    }

    if (url.pathname === "/api/me" && method === "GET") {
      const user = getSessionUser(req, db);
      return send(res, 200, { user: publicUser(user) });
    }

    const user = requireUser(req, res, db);
    if (!user) return;

    if (url.pathname === "/api/bootstrap" && method === "GET") {
      return send(res, 200, {
        user: publicUser(user),
        categories: db.categories,
        tags: db.tags,
        materials: filterMaterials(db, user, url.searchParams).map((item) => ({
          ...item,
          body: item.body.length > 220 ? `${item.body.slice(0, 220)}...` : item.body
        }))
      });
    }

    if (url.pathname === "/api/materials" && method === "GET") {
      return send(res, 200, { materials: filterMaterials(db, user, url.searchParams) });
    }

    if (url.pathname === "/api/materials/reorder" && method === "PUT") {
      const admin = requireAdmin(req, res, db);
      if (!admin) return;
      const body = await readJson(req);
      const orderedIds = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const byId = new Map(db.materials.map((item) => [item.id, item]));
      const ordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
      const orderedSet = new Set(ordered.map((item) => item.id));
      db.materials = [...ordered, ...db.materials.filter((item) => !orderedSet.has(item.id))];
      audit(db, admin, "reorder_materials", "materials", "更新资料排序");
      writeDb(db);
      return send(res, 200, { materials: db.materials });
    }

    const materialMatch = url.pathname.match(/^\/api\/materials\/([^/]+)$/);
    if (materialMatch && method === "GET") {
      const material = db.materials.find((item) => item.id === materialMatch[1]);
      if (!material || (user.role !== "admin" && material.status !== "published")) return send(res, 404, { error: "资料不存在" });
      return send(res, 200, { material });
    }

    if (url.pathname === "/api/materials" && method === "POST") {
      const admin = requireAdmin(req, res, db);
      if (!admin) return;
      const body = await readJson(req);
      const material = normalizeMaterial(body, { id: uid("mat"), createdAt: now() });
      db.materials.unshift(material);
      for (const tag of material.tags) if (!db.tags.includes(tag)) db.tags.push(tag);
      if (!db.categories.includes(material.category)) db.categories.push(material.category);
      audit(db, admin, "create_material", material.id, material.title);
      writeDb(db);
      return send(res, 201, { material });
    }

    if (materialMatch && method === "PUT") {
      const admin = requireAdmin(req, res, db);
      if (!admin) return;
      const index = db.materials.findIndex((item) => item.id === materialMatch[1]);
      if (index === -1) return send(res, 404, { error: "资料不存在" });
      const body = await readJson(req);
      db.materials[index] = normalizeMaterial(body, db.materials[index]);
      for (const tag of db.materials[index].tags) if (!db.tags.includes(tag)) db.tags.push(tag);
      if (!db.categories.includes(db.materials[index].category)) db.categories.push(db.materials[index].category);
      audit(db, admin, "update_material", db.materials[index].id, db.materials[index].title);
      writeDb(db);
      return send(res, 200, { material: db.materials[index] });
    }

    if (materialMatch && method === "DELETE") {
      const admin = requireAdmin(req, res, db);
      if (!admin) return;
      const index = db.materials.findIndex((item) => item.id === materialMatch[1]);
      if (index === -1) return send(res, 404, { error: "资料不存在" });
      const [removed] = db.materials.splice(index, 1);
      audit(db, admin, "delete_material", removed.id, removed.title);
      writeDb(db);
      return send(res, 200, { ok: true });
    }

    if (url.pathname === "/api/taxonomy" && method === "PUT") {
      const admin = requireAdmin(req, res, db);
      if (!admin) return;
      const body = await readJson(req);
      db.categories = Array.from(new Set((body.categories || []).map((item) => String(item).trim()).filter(Boolean)));
      db.tags = Array.from(new Set((body.tags || []).map((item) => String(item).trim()).filter(Boolean)));
      audit(db, admin, "update_taxonomy", "taxonomy", "更新分类和标签");
      writeDb(db);
      return send(res, 200, { categories: db.categories, tags: db.tags });
    }

    if (url.pathname === "/api/users" && method === "GET") {
      const admin = requireAdmin(req, res, db);
      if (!admin) return;
      return send(res, 200, { users: db.users.map(publicUser) });
    }

    if (url.pathname === "/api/users" && method === "POST") {
      const admin = requireAdmin(req, res, db);
      if (!admin) return;
      const body = await readJson(req);
      const username = String(body.username || "").trim();
      if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) throw new Error("账号需为 3-32 位字母、数字或符号 ._-");
      if (db.users.some((item) => item.username === username)) throw new Error("账号已存在");
      const password = String(body.password || "");
      if (password.length < 6) throw new Error("密码至少 6 位");
      const created = {
        id: uid("user"),
        username,
        displayName: String(body.displayName || username).trim(),
        role: body.role === "admin" ? "admin" : "employee",
        active: true,
        passwordHash: hashPassword(password),
        createdAt: now()
      };
      db.users.push(created);
      audit(db, admin, "create_user", created.id, created.username);
      writeDb(db);
      return send(res, 201, { user: publicUser(created) });
    }

    const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch && method === "PUT") {
      const admin = requireAdmin(req, res, db);
      if (!admin) return;
      const target = db.users.find((item) => item.id === userMatch[1]);
      if (!target) return send(res, 404, { error: "账号不存在" });
      const body = await readJson(req);
      target.displayName = String(body.displayName || target.displayName).trim();
      target.role = body.role === "admin" ? "admin" : "employee";
      target.active = Boolean(body.active);
      if (body.password) {
        if (String(body.password).length < 6) throw new Error("密码至少 6 位");
        target.passwordHash = hashPassword(String(body.password));
      }
      audit(db, admin, "update_user", target.id, target.username);
      writeDb(db);
      return send(res, 200, { user: publicUser(target) });
    }

    if (userMatch && method === "DELETE") {
      const admin = requireAdmin(req, res, db);
      if (!admin) return;
      const index = db.users.findIndex((item) => item.id === userMatch[1]);
      if (index === -1) return send(res, 404, { error: "账号不存在" });
      const target = db.users[index];
      if (target.id === admin.id) throw new Error("不能删除当前登录账号");
      const activeAdmins = db.users.filter((item) => item.role === "admin" && item.active);
      if (target.role === "admin" && target.active && activeAdmins.length <= 1) {
        throw new Error("至少需要保留一个启用的管理员账号");
      }
      db.users.splice(index, 1);
      for (const [token, session] of sessions.entries()) {
        if (session.userId === target.id) sessions.delete(token);
      }
      audit(db, admin, "delete_user", target.id, target.username);
      writeDb(db);
      return send(res, 200, { ok: true });
    }

    if (url.pathname === "/api/audit-logs" && method === "GET") {
      const admin = requireAdmin(req, res, db);
      if (!admin) return;
      return send(res, 200, { auditLogs: db.auditLogs.slice(0, 100) });
    }

    send(res, 404, { error: "接口不存在" });
  } catch (error) {
    send(res, 400, { error: error.message || "请求失败" });
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`Training library running at http://localhost:${PORT}`);
  console.log("Default accounts: admin/admin123, employee/employee123");
});
