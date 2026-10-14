const TAXONOMY_KEY = "v2:taxonomy";
const MATERIAL_INDEX_KEY = "v2:material-index";
const FEEDBACK_INDEX_KEY = "v2:feedback-index";
const MATERIAL_PREFIX = "v2:material:";
const FEEDBACK_PREFIX = "v2:feedback:";
// Keep one file inside a single D1 batch so an import either commits fully or
// leaves no partial records when the free-tier write quota is reached.
const MAX_IMPORT_ROWS = 900;
const MAX_TOTAL_ROWS = 50000;

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function text(value, limit = 200) {
  return String(value ?? "").replace(/^\uFEFF/, "").trim().slice(0, limit);
}

function phoneKey(value) {
  let digits = text(value, 80).replace(/\D/g, "");
  if (digits.startsWith("0086") && digits.length > 11) digits = digits.slice(4);
  if (digits.startsWith("86") && digits.length === 13) digits = digits.slice(2);
  return digits;
}

function requireDb(env) {
  if (!env.APP_DB) fail("缺少 Cloudflare D1 绑定 APP_DB", 500);
  return env.APP_DB;
}

function requireKv(env) {
  if (!env.TRAINING_DB) fail("缺少 Cloudflare KV 绑定 TRAINING_DB", 500);
  return env.TRAINING_DB;
}

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    active: Boolean(row.active),
    passwordHash: row.password_hash,
    createdAt: row.created_at
  };
}

export async function getSetupRequired(env) {
  const value = await requireDb(env)
    .prepare("SELECT value FROM app_state WHERE key = 'setup_required'")
    .first("value");
  return value === "1";
}

export async function setSetupRequired(env, required) {
  await requireDb(env)
    .prepare("INSERT INTO app_state (key, value) VALUES ('setup_required', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(required ? "1" : "0")
    .run();
}

export async function getUserByUsername(env, username) {
  const row = await requireDb(env)
    .prepare("SELECT * FROM users WHERE username = ? LIMIT 1")
    .bind(username)
    .first();
  return rowToUser(row);
}

export async function getUserById(env, id) {
  const row = await requireDb(env)
    .prepare("SELECT * FROM users WHERE id = ? LIMIT 1")
    .bind(id)
    .first();
  return rowToUser(row);
}

export async function listUsers(env) {
  const { results = [] } = await requireDb(env)
    .prepare("SELECT * FROM users ORDER BY created_at, username")
    .all();
  return results.map(rowToUser);
}

export async function createUser(env, user) {
  await requireDb(env)
    .prepare("INSERT INTO users (id, username, display_name, role, active, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(user.id, user.username, user.displayName, user.role, user.active ? 1 : 0, user.passwordHash, user.createdAt)
    .run();
  return user;
}

export async function updateUser(env, user) {
  await requireDb(env)
    .prepare("UPDATE users SET display_name = ?, role = ?, active = ?, password_hash = ? WHERE id = ?")
    .bind(user.displayName, user.role, user.active ? 1 : 0, user.passwordHash, user.id)
    .run();
  return user;
}

export async function deleteUser(env, id) {
  await requireDb(env).prepare("DELETE FROM users WHERE id = ?").bind(id).run();
}

export async function recordAudit(env, entry) {
  const db = requireDb(env);
  await db.batch([
    db.prepare("INSERT INTO audit_logs (id, user_id, username, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(entry.id, entry.userId, entry.username, entry.action, entry.target, entry.detail, entry.createdAt),
    db.prepare("DELETE FROM audit_logs WHERE id NOT IN (SELECT id FROM audit_logs ORDER BY created_at DESC LIMIT 300)")
  ]);
}

export async function listAuditLogs(env, limit = 100) {
  const { results = [] } = await requireDb(env)
    .prepare("SELECT id, user_id, username, action, target, detail, created_at FROM audit_logs ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all();
  return results.map((row) => ({
    id: row.id,
    userId: row.user_id,
    username: row.username,
    action: row.action,
    target: row.target,
    detail: row.detail,
    createdAt: row.created_at
  }));
}

function materialSummary(material) {
  return {
    id: material.id,
    title: material.title,
    category: material.category,
    tags: Array.isArray(material.tags) ? material.tags : [],
    status: material.status,
    type: material.type,
    body: String(material.body || ""),
    createdAt: material.createdAt,
    updatedAt: material.updatedAt
  };
}

export async function readTaxonomy(env) {
  return (await requireKv(env).get(TAXONOMY_KEY, "json")) || { categories: [], tags: [] };
}

export async function writeTaxonomy(env, taxonomy) {
  await requireKv(env).put(TAXONOMY_KEY, JSON.stringify(taxonomy));
}

export async function readMaterialIndex(env) {
  return (await requireKv(env).get(MATERIAL_INDEX_KEY, "json")) || [];
}

export async function readMaterial(env, id) {
  return await requireKv(env).get(`${MATERIAL_PREFIX}${id}`, "json");
}

export async function writeMaterial(env, material, { prepend = false } = {}) {
  const kv = requireKv(env);
  const index = await readMaterialIndex(env);
  const summary = materialSummary(material);
  const existing = index.findIndex((item) => item.id === material.id);
  if (existing >= 0) index[existing] = summary;
  else if (prepend) index.unshift(summary);
  else index.push(summary);
  await Promise.all([
    kv.put(`${MATERIAL_PREFIX}${material.id}`, JSON.stringify(material)),
    kv.put(MATERIAL_INDEX_KEY, JSON.stringify(index))
  ]);
  return material;
}

export async function reorderMaterials(env, orderedIds) {
  const index = await readMaterialIndex(env);
  const byId = new Map(index.map((item) => [item.id, item]));
  const ordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
  const seen = new Set(ordered.map((item) => item.id));
  const next = [...ordered, ...index.filter((item) => !seen.has(item.id))];
  await requireKv(env).put(MATERIAL_INDEX_KEY, JSON.stringify(next));
  return next;
}

export async function deleteMaterial(env, id) {
  const kv = requireKv(env);
  const index = await readMaterialIndex(env);
  const item = index.find((entry) => entry.id === id);
  if (!item) return null;
  await Promise.all([
    kv.delete(`${MATERIAL_PREFIX}${id}`),
    kv.put(MATERIAL_INDEX_KEY, JSON.stringify(index.filter((entry) => entry.id !== id)))
  ]);
  return item;
}

export async function createFeedback(env, feedback) {
  const kv = requireKv(env);
  const index = (await kv.get(FEEDBACK_INDEX_KEY, "json")) || [];
  index.unshift(feedback.id);
  await Promise.all([
    kv.put(`${FEEDBACK_PREFIX}${feedback.id}`, JSON.stringify(feedback)),
    kv.put(FEEDBACK_INDEX_KEY, JSON.stringify(index.slice(0, 500)))
  ]);
  return feedback;
}

export async function listFeedbacks(env, limit = 50) {
  const kv = requireKv(env);
  const index = ((await kv.get(FEEDBACK_INDEX_KEY, "json")) || []).slice(0, limit);
  const rows = await Promise.all(index.map((id) => kv.get(`${FEEDBACK_PREFIX}${id}`, "json")));
  return rows.filter(Boolean);
}

function adminOnly(user) {
  if (user.role !== "admin") fail("只有管理员可以执行该操作", 403);
}

function normalizeIndustry(row) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    recordCount: Number(row.record_count || 0)
  };
}

function normalizeImport(row) {
  return {
    id: row.id,
    fileName: row.file_name,
    province: row.province,
    city: row.city,
    industryId: row.industry_id,
    industryName: row.industry_name,
    totalRows: Number(row.total_rows),
    importedRows: Number(row.imported_rows),
    duplicateRows: Number(row.duplicate_rows),
    invalidRows: Number(row.invalid_rows),
    importedAt: row.imported_at
  };
}

function normalizeExport(row) {
  return {
    id: row.id,
    province: row.province,
    city: row.city,
    industryName: row.industry_name,
    recordCount: Number(row.record_count),
    exportedAt: row.exported_at,
    userId: row.user_id,
    username: row.username
  };
}

async function getIndustry(env, id) {
  const row = await requireDb(env)
    .prepare("SELECT id, name, created_at FROM industries WHERE id = ?")
    .bind(id)
    .first();
  if (!row) fail("行业不存在", 404);
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

async function importMerchantItems(env, items, user, uid, timestamp) {
  adminOnly(user);
  if (!Array.isArray(items) || !items.length || items.length > 20) fail("请选择 1–20 个文件");
  const db = requireDb(env);
  const results = [];

  for (const item of items) {
    const fileName = text(item?.fileName, 180);
    const province = text(item?.province, 60);
    const city = text(item?.city, 60);
    const industryId = text(item?.industryId, 80);
    try {
      if (!fileName || !province || !city) fail("文件名、省份和城市不能为空");
      const industry = await getIndustry(env, industryId);
      if (!Array.isArray(item.records) || item.records.length > MAX_IMPORT_ROWS) {
        fail(`每个文件最多导入 ${MAX_IMPORT_ROWS} 条有效数据`);
      }
      const sourceInvalidRows = Number(item.invalidRows);
      if (!Number.isInteger(sourceInvalidRows) || sourceInvalidRows < 0) fail("无效行数错误");
      const importId = uid("import");
      const rows = [];
      let rejectedRows = 0;
      const seen = new Set();
      const existingRows = await db.prepare(
        "SELECT phone_key FROM merchants WHERE province = ? AND city = ? AND industry_id = ?"
      ).bind(province, city, industryId).all();
      const existing = new Set(existingRows.results.map((row) => row.phone_key));
      for (const record of item.records) {
        const name = text(record?.name, 200);
        const phone = text(record?.phone, 80);
        const address = text(record?.address, 500);
        const key = phoneKey(phone);
        if (!key) { rejectedRows += 1; continue; }
        if (seen.has(key) || existing.has(key)) continue;
        seen.add(key);
        rows.push({ id: `${importId}_${rows.length}`, name, phone, phoneKey: key, address });
      }

      const total = Number(await db.prepare("SELECT COUNT(*) AS count FROM merchants").first("count") || 0);
      if (total + rows.length > MAX_TOTAL_ROWS) {
        fail(`数据总量最多支持 ${MAX_TOTAL_ROWS} 条，请先删除旧导入记录`);
      }

      const importedRows = rows.length;
      const duplicateRows = item.records.length - rejectedRows - importedRows;
      const invalidRows = sourceInvalidRows + rejectedRows;
      const statements = [
        db.prepare(
          "INSERT INTO imports (id, file_name, province, city, industry_id, industry_name, total_rows, imported_rows, duplicate_rows, invalid_rows, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          importId, fileName, province, city, industryId, industry.name,
          item.records.length + sourceInvalidRows, importedRows, duplicateRows, invalidRows, timestamp
        )
      ];
      const insert = db.prepare(
        "INSERT INTO merchants (id, name, phone, phone_key, address, province, city, industry_id, import_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      statements.push(...rows.map((row) => insert.bind(
        row.id, row.name, row.phone, row.phoneKey, row.address,
        province, city, industryId, importId, timestamp
      )));
      await db.batch(statements);
      results.push({
        ok: true, id: importId, fileName, province, city,
        industryId, industryName: industry.name,
        totalRows: item.records.length + sourceInvalidRows,
        importedRows, duplicateRows, invalidRows,
        importedAt: timestamp
      });
    } catch (error) {
      results.push({ ok: false, fileName, error: error.message });
    }
  }
  return results;
}

export async function handleMerchantRequest(env, { path, method, body = {}, user, uid, now }) {
  const db = requireDb(env);
  const timestamp = now();
  const result = (data, status = 200, audit = null) => ({ data, status, audit });

  if (path === "/api/merchant/overview" && method === "GET") {
    const [totals, breakdown] = await db.batch([
      db.prepare("SELECT (SELECT COUNT(*) FROM merchants) AS total_records, (SELECT COUNT(*) FROM imports) AS total_imports, (SELECT COUNT(*) FROM industries) AS total_industries, (SELECT COUNT(*) FROM (SELECT province, city FROM merchants GROUP BY province, city)) AS total_cities"),
      db.prepare("SELECT m.province, m.city, m.industry_id, i.name AS industry_name, COUNT(*) AS record_count FROM merchants m JOIN industries i ON i.id = m.industry_id GROUP BY m.province, m.city, m.industry_id, i.name ORDER BY m.province, m.city, i.name")
    ]);
    const counts = totals.results?.[0] || {};
    return result({
      totalRecords: Number(counts.total_records || 0),
      totalCities: Number(counts.total_cities || 0),
      totalIndustries: Number(counts.total_industries || 0),
      totalImports: Number(counts.total_imports || 0),
      breakdown: (breakdown.results || []).map((row) => ({
        province: row.province, city: row.city, industryId: row.industry_id,
        industryName: row.industry_name, recordCount: Number(row.record_count)
      }))
    });
  }

  if (path === "/api/merchant/industries" && method === "GET") {
    adminOnly(user);
    const { results = [] } = await db.prepare(
      "SELECT i.id, i.name, i.created_at, COUNT(m.id) AS record_count FROM industries i LEFT JOIN merchants m ON m.industry_id = i.id GROUP BY i.id ORDER BY i.name"
    ).all();
    return result({ industries: results.map(normalizeIndustry) });
  }

  if (path === "/api/merchant/industries" && method === "POST") {
    adminOnly(user);
    const name = text(body.name, 80);
    if (!name) fail("行业名称不能为空");
    const item = { id: uid("industry"), name, createdAt: timestamp };
    try {
      await db.prepare("INSERT INTO industries (id, name, created_at) VALUES (?, ?, ?)")
        .bind(item.id, item.name, item.createdAt).run();
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) fail("该行业已存在", 409);
      throw error;
    }
    return result({ industry: { ...item, recordCount: 0 } }, 201,
      { action: "merchant_add_industry", target: item.id, detail: name });
  }

  const industryId = path.match(/^\/api\/merchant\/industries\/([^/]+)$/)?.[1];
  if (industryId && method === "PUT") {
    adminOnly(user);
    const item = await getIndustry(env, industryId);
    const name = text(body.name, 80);
    if (!name) fail("行业名称不能为空");
    try {
      await db.prepare("UPDATE industries SET name = ? WHERE id = ?").bind(name, item.id).run();
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) fail("该行业已存在", 409);
      throw error;
    }
    return result({ industry: { ...item, name } }, 200,
      { action: "merchant_update_industry", target: item.id, detail: name });
  }

  if (industryId && method === "DELETE") {
    adminOnly(user);
    const item = await getIndustry(env, industryId);
    const count = Number(await db.prepare("SELECT COUNT(*) AS count FROM imports WHERE industry_id = ?").bind(item.id).first("count") || 0);
    if (count) fail("该行业已有导入记录，请先删除相关导入文件");
    await db.prepare("DELETE FROM industries WHERE id = ?").bind(item.id).run();
    return result({ ok: true }, 200,
      { action: "merchant_delete_industry", target: item.id, detail: item.name });
  }

  if (path === "/api/merchant/imports" && method === "GET") {
    adminOnly(user);
    const { results = [] } = await db.prepare("SELECT * FROM imports ORDER BY imported_at DESC").all();
    return result({ imports: results.map(normalizeImport) });
  }

  if (path === "/api/merchant/imports" && method === "POST") {
    const results = await importMerchantItems(env, body.items, user, uid, timestamp);
    const count = results.reduce((sum, item) => sum + (item.importedRows || 0), 0);
    const audit = results.some((item) => item.ok)
      ? { action: "merchant_import", target: "merchants", detail: `导入 ${count} 条商户数据` }
      : null;
    return result({ results }, 200, audit);
  }

  const importId = path.match(/^\/api\/merchant\/imports\/([^/]+)$/)?.[1];
  if (importId && method === "DELETE") {
    adminOnly(user);
    const row = await db.prepare("SELECT * FROM imports WHERE id = ?").bind(importId).first();
    if (!row) fail("导入记录不存在", 404);
    await db.batch([
      db.prepare("DELETE FROM merchants WHERE import_id = ?").bind(importId),
      db.prepare("DELETE FROM imports WHERE id = ?").bind(importId)
    ]);
    return result({ deletedRows: Number(row.imported_rows) }, 200,
      { action: "merchant_delete_import", target: importId, detail: `${row.file_name}，删除 ${row.imported_rows} 条` });
  }

  if (path === "/api/merchant/options" && method === "GET") {
    const [locations, industries] = await db.batch([
      db.prepare("SELECT province, city FROM merchants GROUP BY province, city ORDER BY province, city"),
      db.prepare("SELECT i.id, i.name, i.created_at, COUNT(m.id) AS record_count FROM industries i JOIN merchants m ON m.industry_id = i.id GROUP BY i.id ORDER BY i.name")
    ]);
    return result({
      locations: (locations.results || []).map((row) => ({ province: row.province, city: row.city })),
      industries: (industries.results || []).map(normalizeIndustry)
    });
  }

  if (path === "/api/merchant/count" && method === "POST") {
    const filters = body.filters || {};
    const count = Number(await db.prepare("SELECT COUNT(*) AS count FROM merchants WHERE (? = '' OR province = ?) AND (? = '' OR city = ?) AND (? = '' OR industry_id = ?)")
      .bind(text(filters.province, 60), text(filters.province, 60), text(filters.city, 60), text(filters.city, 60), text(filters.industryId, 80), text(filters.industryId, 80))
      .first("count") || 0);
    return result({ count });
  }

  if (path === "/api/merchant/exports" && method === "GET") {
    const { results = [] } = await db.prepare("SELECT * FROM export_records ORDER BY exported_at DESC").all();
    return result({ exportRecords: results.map(normalizeExport) });
  }

  if (path === "/api/merchant/export" && method === "POST") {
    const filters = body.filters || {};
    const province = text(filters.province, 60);
    const city = text(filters.city, 60);
    const industry = await getIndustry(env, text(filters.industryId, 80));
    if (!province || !city) fail("请选择省份、城市和行业");
    const { results = [] } = await db.prepare(
      "SELECT name, phone, address FROM merchants WHERE province = ? AND city = ? AND industry_id = ? ORDER BY created_at, id"
    ).bind(province, city, industry.id).all();
    if (!results.length) fail("当前筛选条件下没有可导出的数据");
    const record = {
      id: uid("export"), province, city, industryName: industry.name,
      recordCount: results.length, exportedAt: timestamp,
      userId: user.id, username: user.username
    };
    await db.prepare("INSERT INTO export_records (id, province, city, industry_name, record_count, exported_at, user_id, username) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(record.id, province, city, record.industryName, record.recordCount, record.exportedAt, record.userId, record.username)
      .run();
    return result({
      rows: results.map((row) => ({ "店名": row.name, "电话": row.phone, "地址": row.address })),
      record
    }, 200, {
      action: "merchant_export", target: record.id,
      detail: `${province}${city} / ${industry.name} / ${results.length} 条`
    });
  }

  fail("接口不存在", 404);
}
