const MAX_IMPORT_ROWS = 10000;
const MAX_TOTAL_ROWS = 50000;

export function emptyMerchantDb() {
  return { industries: [], imports: [], merchants: [], exportRecords: [] };
}

export function normalizeMerchantDb(value) {
  const db = value && typeof value === "object" ? value : {};
  for (const key of ["industries", "imports", "merchants", "exportRecords"]) {
    if (!Array.isArray(db[key])) db[key] = [];
  }
  return db;
}

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function adminOnly(user) {
  if (user.role !== "admin") fail("只有管理员可以执行该操作", 403);
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

function industry(db, id) {
  const result = db.industries.find((item) => item.id === String(id));
  if (!result) fail("行业不存在", 404);
  return result;
}

function industryRows(db) {
  return db.industries.map((item) => ({
    ...item,
    recordCount: db.merchants.filter((merchant) => merchant.industryId === item.id).length
  })).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function filterRows(db, filters = {}) {
  const province = text(filters.province, 60);
  const city = text(filters.city, 60);
  const industryId = text(filters.industryId, 80);
  return db.merchants.filter((item) =>
    (!province || item.province === province) &&
    (!city || item.city === city) &&
    (!industryId || item.industryId === industryId)
  );
}

function overview(db) {
  const groups = new Map();
  for (const row of db.merchants) {
    const key = JSON.stringify([row.province, row.city, row.industryId]);
    const group = groups.get(key) || {
      province: row.province,
      city: row.city,
      industryId: row.industryId,
      industryName: db.industries.find((item) => item.id === row.industryId)?.name || "已删除行业",
      recordCount: 0
    };
    group.recordCount += 1;
    groups.set(key, group);
  }
  return {
    totalRecords: db.merchants.length,
    totalCities: new Set(db.merchants.map((row) => JSON.stringify([row.province, row.city]))).size,
    totalIndustries: db.industries.length,
    totalImports: db.imports.length,
    breakdown: [...groups.values()].sort((a, b) =>
      `${a.province}${a.city}${a.industryName}`.localeCompare(`${b.province}${b.city}${b.industryName}`, "zh-CN")
    )
  };
}

function importOne(db, item, id, timestamp) {
  const fileName = text(item.fileName, 180);
  const province = text(item.province, 60);
  const city = text(item.city, 60);
  if (!fileName || !province || !city) fail("文件名、省份和城市不能为空");
  const selectedIndustry = industry(db, item.industryId);
  if (!Array.isArray(item.records) || item.records.length > MAX_IMPORT_ROWS) {
    fail(`每个文件最多导入 ${MAX_IMPORT_ROWS} 条有效数据`);
  }
  const invalidRows = Number(item.invalidRows);
  if (!Number.isInteger(invalidRows) || invalidRows < 0) fail("无效行数错误");
  const scopeKey = (key) => JSON.stringify([province, city, selectedIndustry.id, key]);
  const used = new Set(db.merchants
    .filter((row) => row.province === province && row.city === city && row.industryId === selectedIndustry.id)
    .map((row) => scopeKey(row.phoneKey)));
  const newRows = [];
  let duplicateRows = 0;
  let rejectedRows = 0;
  for (const record of item.records) {
    const name = text(record?.name, 200);
    const phone = text(record?.phone, 80);
    const address = text(record?.address, 500);
    const key = phoneKey(phone);
    if (!key) { rejectedRows += 1; continue; }
    if (used.has(scopeKey(key))) { duplicateRows += 1; continue; }
    used.add(scopeKey(key));
    newRows.push({ id: `${id}_${newRows.length}`, name, phone, phoneKey: key, address,
      province, city, industryId: selectedIndustry.id, importId: id, createdAt: timestamp });
  }
  if (db.merchants.length + newRows.length > MAX_TOTAL_ROWS) {
    fail(`数据总量最多支持 ${MAX_TOTAL_ROWS} 条，请先删除旧导入记录`);
  }
  const result = { id, fileName, province, city, industryId: selectedIndustry.id,
    industryName: selectedIndustry.name, totalRows: item.records.length + invalidRows,
    importedRows: newRows.length, duplicateRows, invalidRows: invalidRows + rejectedRows,
    importedAt: timestamp };
  db.merchants.push(...newRows);
  db.imports.unshift(result);
  return result;
}

export function handleMerchantAction(dbInput, { path, method, body = {}, user, uid, now }) {
  const db = normalizeMerchantDb(dbInput);
  const timestamp = now();
  const unchanged = (data) => ({ data, changed: false });
  const changed = (data, audit = null, status = 200) => ({ data, changed: true, audit, status });

  if (path === "/api/merchant/overview" && method === "GET") return unchanged(overview(db));
  if (path === "/api/merchant/industries" && method === "GET") {
    adminOnly(user);
    return unchanged({ industries: industryRows(db) });
  }
  if (path === "/api/merchant/industries" && method === "POST") {
    adminOnly(user);
    const name = text(body.name, 80);
    if (!name) fail("行业名称不能为空");
    if (db.industries.some((item) => item.name === name)) fail("该行业已存在");
    const item = { id: uid("industry"), name, createdAt: timestamp };
    db.industries.push(item);
    return changed({ industry: { ...item, recordCount: 0 } }, { action: "merchant_add_industry", target: item.id, detail: name }, 201);
  }
  const industryId = path.match(/^\/api\/merchant\/industries\/([^/]+)$/)?.[1];
  if (industryId && method === "PUT") {
    adminOnly(user);
    const item = industry(db, industryId);
    const name = text(body.name, 80);
    if (!name) fail("行业名称不能为空");
    if (db.industries.some((other) => other.id !== item.id && other.name === name)) fail("该行业已存在");
    item.name = name;
    return changed({ industry: item }, { action: "merchant_update_industry", target: item.id, detail: name });
  }
  if (industryId && method === "DELETE") {
    adminOnly(user);
    const item = industry(db, industryId);
    if (db.imports.some((record) => record.industryId === item.id)) fail("该行业已有导入记录，请先删除相关导入文件");
    db.industries = db.industries.filter((other) => other.id !== item.id);
    return changed({ ok: true }, { action: "merchant_delete_industry", target: item.id, detail: item.name });
  }
  if (path === "/api/merchant/imports" && method === "GET") {
    adminOnly(user);
    return unchanged({ imports: db.imports.map((item) => ({ ...item,
      industryName: db.industries.find((entry) => entry.id === item.industryId)?.name || item.industryName
    })) });
  }
  if (path === "/api/merchant/imports" && method === "POST") {
    adminOnly(user);
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 20) fail("请选择 1–20 个文件");
    const results = [];
    for (const item of body.items) {
      try { results.push({ ok: true, ...importOne(db, item, uid("import"), timestamp) }); }
      catch (error) { results.push({ ok: false, fileName: text(item?.fileName, 180), error: error.message }); }
    }
    if (!results.some((item) => item.ok)) return unchanged({ results });
    const count = results.reduce((sum, item) => sum + (item.importedRows || 0), 0);
    return changed({ results }, { action: "merchant_import", target: "merchants", detail: `导入 ${count} 条商户数据` });
  }
  const importId = path.match(/^\/api\/merchant\/imports\/([^/]+)$/)?.[1];
  if (importId && method === "DELETE") {
    adminOnly(user);
    const item = db.imports.find((record) => record.id === importId);
    if (!item) fail("导入记录不存在", 404);
    db.merchants = db.merchants.filter((row) => row.importId !== importId);
    db.imports = db.imports.filter((record) => record.id !== importId);
    return changed({ deletedRows: item.importedRows }, { action: "merchant_delete_import", target: importId, detail: `${item.fileName}，删除 ${item.importedRows} 条` });
  }
  if (path === "/api/merchant/options" && method === "GET") {
    const locations = [...new Map(db.merchants.map((row) =>
      [JSON.stringify([row.province, row.city]), { province: row.province, city: row.city }]
    )).values()].sort((a, b) => `${a.province}${a.city}`.localeCompare(`${b.province}${b.city}`, "zh-CN"));
    return unchanged({ locations, industries: industryRows(db).filter((item) => item.recordCount > 0) });
  }
  if (path === "/api/merchant/count" && method === "POST") {
    return unchanged({ count: filterRows(db, body.filters).length });
  }
  if (path === "/api/merchant/exports" && method === "GET") {
    return unchanged({ exportRecords: db.exportRecords });
  }
  if (path === "/api/merchant/export" && method === "POST") {
    const filters = body.filters || {};
    const province = text(filters.province, 60);
    const city = text(filters.city, 60);
    const selectedIndustry = industry(db, filters.industryId);
    if (!province || !city) fail("请选择省份、城市和行业");
    const rows = filterRows(db, { province, city, industryId: selectedIndustry.id });
    if (!rows.length) fail("当前筛选条件下没有可导出的数据");
    const record = { id: uid("export"), province, city, industryName: selectedIndustry.name,
      recordCount: rows.length, exportedAt: timestamp, userId: user.id, username: user.username };
    db.exportRecords.unshift(record);
    return changed({ rows: rows.map((item) => ({ "店名": item.name, "电话": item.phone, "地址": item.address })), record },
      { action: "merchant_export", target: record.id,
        detail: `${province}${city} / ${selectedIndustry.name} / ${rows.length} 条` });
  }
  fail("接口不存在", 404);
}
