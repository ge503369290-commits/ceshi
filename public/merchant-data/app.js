(() => {
  const root = document.querySelector("#app");
  const state = { user: null, view: "overview", overview: null, industries: [], imports: [],
    exports: [], options: { locations: [], industries: [] }, staged: [],
    filters: { province: "", city: "", industryId: "" }, citySearch: "", busy: false };
  const provinces = ["内蒙古自治区","广西壮族自治区","西藏自治区","宁夏回族自治区","新疆维吾尔自治区",
    "香港特别行政区","澳门特别行政区","北京市","天津市","上海市","重庆市","河北省","山西省","辽宁省",
    "吉林省","黑龙江省","江苏省","浙江省","安徽省","福建省","江西省","山东省","河南省","湖北省",
    "湖南省","广东省","海南省","四川省","贵州省","云南省","陕西省","甘肃省","青海省","台湾省"];
  const directCities = new Set(["北京市","天津市","上海市","重庆市"]);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[char]);
  const dateText = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "-";
  const clean = (value) => String(value ?? "").replace(/^\uFEFF/, "").trim();
  const normalizePhone = (value) => {
    let digits = clean(value).replace(/\D/g, "");
    if (digits.startsWith("0086") && digits.length > 11) digits = digits.slice(4);
    if (digits.startsWith("86") && digits.length === 13) digits = digits.slice(2);
    return digits;
  };

  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "请求失败");
    return data;
  }

  function toast(message, error = false) {
    const node = document.querySelector("#toast");
    if (!node) return;
    node.textContent = message;
    node.style.background = error ? "#9e3137" : "#263c42";
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { node.hidden = true; }, 3500);
  }

  function detectLocation(address) {
    const value = clean(address).replace(/\s+/g, "");
    const province = provinces.find((item) => value.includes(item)) || "";
    if (directCities.has(province)) return { province, city: province };
    const remainder = value.slice(province ? value.indexOf(province) + province.length : 0);
    const match = remainder.match(/^(.{2,20}?(?:自治州|地区|盟|市))/);
    return { province, city: match?.[1] || "" };
  }

  function majorityLocation(records) {
    const counts = new Map();
    for (const row of records) {
      const { province, city } = detectLocation(row.address);
      if (!province || !city) continue;
      const key = JSON.stringify([province, city]);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const top = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (!top) return { province: "", city: "", matchedRows: 0 };
    const [province, city] = JSON.parse(top[0]);
    return { province, city, matchedRows: top[1] };
  }

  async function parseFile(file) {
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error("仅支持 .xlsx、.xls 和 .csv 文件");
    let workbook;
    const bytes = await file.arrayBuffer();
    if (/\.csv$/i.test(file.name)) {
      let encoding = "utf-8";
      if (new Uint8Array(bytes)[0] === 0xff && new Uint8Array(bytes)[1] === 0xfe) encoding = "utf-16le";
      let content;
      try { content = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
      catch { content = new TextDecoder("gbk").decode(bytes); }
      workbook = XLSX.read(content, { type: "string" });
    } else workbook = XLSX.read(bytes, { type: "array", cellDates: false });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error("表格中没有工作表");
    const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName],
      { header: 1, defval: "", raw: false, blankrows: false });
    let headerIndex = -1;
    let indexes;
    for (let index = 0; index < Math.min(matrix.length, 30); index++) {
      const headers = matrix[index].map((value) => clean(value).replace(/\s+/g, ""));
      const candidate = ["店名","电话","地址"].map((name) => headers.indexOf(name));
      if (candidate.every((value) => value >= 0)) { headerIndex = index; indexes = candidate; break; }
    }
    if (headerIndex < 0) throw new Error("未找到固定列名：店名、电话、地址");
    const records = [];
    let invalidRows = 0;
    for (const row of matrix.slice(headerIndex + 1)) {
      const [name, phone, address] = indexes.map((index) => clean(row[index]));
      if (!name && !phone && !address) continue;
      if (!normalizePhone(phone)) { invalidRows++; continue; }
      records.push({ name, phone, address });
    }
    if (records.length > 900) throw new Error("免费版为保证导入原子性，单个文件最多导入 900 条有效数据");
    return { fileName: file.name, records, invalidRows, ...majorityLocation(records), industryId: "" };
  }

  function options(items, selected = "", placeholder = "请选择") {
    return `<option value="">${esc(placeholder)}</option>${items.map((item) =>
      `<option value="${esc(item.value)}" ${String(item.value) === String(selected) ? "selected" : ""}>${esc(item.label)}</option>`).join("")}`;
  }

  function matchIndustry(fileName, industries) {
    const normalize = (value) => String(value).normalize("NFKC").toLocaleLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, "");
    const name = normalize(fileName.replace(/\.[^.]+$/, ""));
    const matches = industries.filter((item) => normalize(item.name) && name.includes(normalize(item.name)))
      .sort((a, b) => normalize(b.name).length - normalize(a.name).length);
    if (!matches.length || (matches[1] && normalize(matches[0].name).length === normalize(matches[1].name).length)) return "";
    return matches[0].id;
  }

  async function loadView() {
    if (state.view === "overview") {
      const [overview, optionData] = await Promise.all([
        api("/api/merchant/overview"), api("/api/merchant/options")]);
      state.overview = overview;
      state.options = optionData;
    } else if (state.view === "exports") {
      state.exports = (await api("/api/merchant/exports")).exportRecords;
    } else if (state.user.role === "admin" && ["import","imports"].includes(state.view)) {
      const [imports, industries] = await Promise.all([
        api("/api/merchant/imports"), api("/api/merchant/industries")]);
      state.imports = imports.imports;
      state.industries = industries.industries;
    } else if (state.user.role === "admin" && state.view === "industries") {
      state.industries = (await api("/api/merchant/industries")).industries;
    }
  }

  function overviewHtml() {
    const data = state.overview;
    const locations = state.options.locations;
    const provincesList = [...new Set(locations.map((item) => item.province))].map((value) => ({ value, label: value }));
    const citySearch = state.citySearch.trim().toLocaleLowerCase();
    const cities = locations.filter((item) => (!state.filters.province || item.province === state.filters.province) &&
        (!citySearch || item.city.toLocaleLowerCase().includes(citySearch)))
      .map((item) => ({ value: item.city, label: item.city }));
    const breakdown = data.breakdown.filter((row) =>
      (!state.filters.province || row.province === state.filters.province) &&
      (!state.filters.city || row.city === state.filters.city) &&
      (!state.filters.industryId || row.industryId === state.filters.industryId) &&
      (!citySearch || row.city.toLocaleLowerCase().includes(citySearch)));
    const canExportSelection = state.filters.province && state.filters.city && state.filters.industryId && breakdown.length;
    return `<div class="metrics">
      ${[["商户数据",data.totalRecords],["覆盖城市",data.totalCities],["行业",data.totalIndustries],["导入批次",data.totalImports]]
        .map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join("")}
    </div>
    <section class="band"><div class="section-head"><h2>筛选与导出</h2><input class="city-search" id="citySearch" type="search" aria-label="搜索城市" placeholder="搜索城市" value="${esc(state.citySearch)}" /></div>
      <div class="controls">
        <label class="field"><span>省份</span><select data-filter="province">${options(provincesList,state.filters.province,"全部省份")}</select></label>
        <label class="field"><span>城市</span><select data-filter="city">${options(cities,state.filters.city,"全部城市")}</select></label>
        <label class="field"><span>行业</span><select data-filter="industryId">${options(state.options.industries.map((item) => ({ value:item.id,label:item.name })),state.filters.industryId,"全部行业")}</select></label>
        <button class="btn" data-action="export" ${state.busy || !canExportSelection ? "disabled" : ""}>导出 Excel</button>
      </div></section>
    <section class="band"><div class="section-head"><h2>地区与行业分布</h2></div>
      ${breakdown.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>省份</th><th>城市</th><th>行业</th><th>商户数量</th><th>操作</th></tr></thead><tbody>${breakdown.map((row) => `<tr><td>${esc(row.province)}</td><td>${esc(row.city)}</td><td>${esc(row.industryName)}</td><td>${row.recordCount}</td><td><button class="btn secondary small" data-export-group data-province="${esc(row.province)}" data-city="${esc(row.city)}" data-industry-id="${esc(row.industryId)}" ${state.busy ? "disabled" : ""}>导出 Excel</button></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">暂无符合条件的城市与行业</div>`}
    </section>`;
  }

  function stageHtml() {
    if (!state.staged.length) return "";
    return `<h3 class="stage-title">待导入文件</h3><div class="staged">${state.staged.map((item, index) =>
      `<div class="stage-row"><div class="stage-file"><strong title="${esc(item.fileName)}">${esc(item.fileName)}</strong><small>有效 ${item.records.length} 条 · 无效 ${item.invalidRows} 条 · 地址匹配 ${item.matchedRows} 条</small></div>
        <label class="field"><span>省份</span><input data-stage="province" data-index="${index}" value="${esc(item.province)}" /></label>
        <label class="field"><span>城市</span><input data-stage="city" data-index="${index}" value="${esc(item.city)}" /></label>
        <label class="field"><span>行业</span><select data-stage="industryId" data-index="${index}">${options(state.industries.map((entry) => ({ value:entry.id,label:entry.name })),item.industryId,"选择行业")}</select></label></div>`).join("")}</div>
      <div class="stage-actions"><button class="btn" data-action="commit" ${state.busy ? "disabled" : ""}>确认导入</button></div>`;
  }

  function importHtml() {
    return `<section class="band"><div class="section-head"><h2>导入线索</h2></div>
      <div class="file-picker"><input id="importFiles" type="file" accept=".xlsx,.xls,.csv" multiple ${state.busy ? "disabled" : ""} />
        <span class="muted">表格列名：店名、电话、地址</span>
        <div class="bulk-industry"><label class="field"><span>批量修改行业</span><select id="bulkIndustry" ${!state.staged.length || state.busy ? "disabled" : ""}>${options(state.industries.map((item) => ({ value:item.id,label:item.name })),"","选择行业")}</select></label>
          <button class="btn secondary" data-action="bulk-industry" disabled>应用全部</button></div></div>${stageHtml()}</section>`;
  }

  function importsHtml() {
    return `<section class="band"><div class="section-head"><h2>导入记录</h2><span class="muted">${state.imports.length} 批</span></div>
        ${state.imports.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>文件</th><th>地区</th><th>行业</th><th>总行数</th><th>新增</th><th>重复</th><th>无效</th><th>操作</th></tr></thead><tbody>${state.imports.map((item) => `<tr><td>${dateText(item.importedAt)}</td><td>${esc(item.fileName)}</td><td>${esc(item.province)} ${esc(item.city)}</td><td>${esc(item.industryName)}</td><td>${item.totalRows}</td><td>${item.importedRows}</td><td>${item.duplicateRows}</td><td>${item.invalidRows}</td><td><button class="btn danger small" data-delete-import="${esc(item.id)}">删除</button></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">暂无导入记录</div>`}
      </section>`;
  }

  function industriesHtml() {
    return `<section class="band"><div class="section-head"><h2>行业设置</h2></div>
      <form class="industry-form" id="industryForm"><input class="inline-input" name="name" maxlength="80" placeholder="输入行业名称" required /><button class="btn" type="submit">添加行业</button></form>
      ${state.industries.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>行业名称</th><th>商户数量</th><th>操作</th></tr></thead><tbody>${state.industries.map((item) => `<tr><td><input class="inline-input industry-name" data-industry-name="${esc(item.id)}" value="${esc(item.name)}" /></td><td>${item.recordCount}</td><td><div class="actions"><button class="btn secondary small" data-save-industry="${esc(item.id)}">保存</button><button class="btn danger small" data-delete-industry="${esc(item.id)}">删除</button></div></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">暂无行业</div>`}
    </section>`;
  }

  function exportsHtml() {
    return `<section class="band"><div class="section-head"><h2>导出记录</h2><span class="muted">${state.exports.length} 次</span></div>
      ${state.exports.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>导出时间</th><th>账号</th><th>省份</th><th>城市</th><th>行业</th><th>条数</th></tr></thead><tbody>${state.exports.map((item) => `<tr><td>${dateText(item.exportedAt)}</td><td>${esc(item.username || "-")}</td><td>${esc(item.province)}</td><td>${esc(item.city)}</td><td>${esc(item.industryName)}</td><td>${item.recordCount}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">暂无导出记录</div>`}
    </section>`;
  }

  function render() {
    const tabs = [["overview","数据概览"],["import","导入线索"],["imports","导入记录"],["industries","行业设置"],["exports","导出记录"]]
      .filter(([key]) => state.user.role === "admin" || ["overview","exports"].includes(key));
    root.innerHTML = `<nav class="tabs">${tabs.map(([key,label]) => `<button type="button" data-view="${key}" class="${state.view === key ? "active" : ""}">${label}</button>`).join("")}</nav>
      <main class="content">${state.view === "overview" ? overviewHtml() : state.view === "import" ? importHtml() : state.view === "imports" ? importsHtml() : state.view === "industries" ? industriesHtml() : exportsHtml()}</main>
      <div class="toast" id="toast" role="status" hidden></div>`;
  }

  async function refresh() { await loadView(); render(); }

  async function exportWorkbook(filters = state.filters) {
    const { province, city, industryId } = filters;
    if (!province || !city || !industryId) return toast("请选择省份、城市和行业", true);
    state.busy = true; render();
    let exportedCount = 0;
    try {
      const result = await api("/api/merchant/export", { method: "POST", body: JSON.stringify({ filters }) });
      const sheet = XLSX.utils.json_to_sheet(result.rows, { header: ["店名","电话","地址"] });
      sheet["!cols"] = [{ wch: 28 },{ wch: 18 },{ wch: 58 }];
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, "商户数据");
      const bytes = XLSX.write(book, { bookType: "xlsx", type: "array", compression: true });
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      const link = document.createElement("a");
      const today = new Date();
      const filePart = (value) => String(value).replace(/[<>:"/\\|?*]/g, "_");
      link.href = url; link.download = `${filePart(city)}-${filePart(result.record.industryName)}-${today.getMonth()+1}月${today.getDate()}日.xlsx`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      exportedCount = result.rows.length;
    } finally { state.busy = false; render(); }
    toast(`已导出 ${exportedCount} 条`);
  }

  root.addEventListener("click", async (event) => {
    const tab = event.target.closest("[data-view]");
    if (tab) {
      if (state.user.role !== "admin" && !["overview","exports"].includes(tab.dataset.view)) return;
      state.view = tab.dataset.view;
      try { await refresh(); } catch (error) { toast(error.message, true); }
      return;
    }
    try {
      const bulkIndustry = event.target.closest('[data-action="bulk-industry"]');
      if (bulkIndustry && state.staged.length && !state.busy) {
        const industryId = root.querySelector("#bulkIndustry").value;
        if (!industryId) return toast("请先选择行业", true);
        state.staged.forEach((item) => { item.industryId = industryId; });
        render();
        toast(`已修改 ${state.staged.length} 个文件的行业`);
        return;
      }
      const groupExport = event.target.closest("[data-export-group]");
      if (groupExport && !state.busy) await exportWorkbook({
        province: groupExport.dataset.province,
        city: groupExport.dataset.city,
        industryId: groupExport.dataset.industryId
      });
      else if (event.target.closest('[data-action="export"]') && !state.busy) await exportWorkbook();
      const commit = event.target.closest('[data-action="commit"]');
      if (commit && !state.busy) {
        const invalid = state.staged.find((item) => !item.province.trim() || !item.city.trim() || !item.industryId);
        if (invalid) return toast("请为每个文件填写省份、城市并选择行业", true);
        state.busy = true; render();
        const results = [];
        for (const item of state.staged) {
          const response = await api("/api/merchant/imports", { method: "POST",
            body: JSON.stringify({ items: [item] }) });
          results.push(...response.results);
        }
        state.staged = [];
        state.busy = false;
        state.view = "imports";
        await refresh();
        toast(results.map((item) => item.ok ? `${item.fileName}: 新增 ${item.importedRows} 条，重复 ${item.duplicateRows} 条` : `${item.fileName}: ${item.error}`).join("；"), results.some((item) => !item.ok));
      }
      const importButton = event.target.closest("[data-delete-import]");
      if (importButton && confirm("删除这批导入记录及其商户数据？")) {
        await api(`/api/merchant/imports/${encodeURIComponent(importButton.dataset.deleteImport)}`, { method: "DELETE" });
        await refresh(); toast("已删除导入记录");
      }
      const saveIndustry = event.target.closest("[data-save-industry]");
      if (saveIndustry) {
        const id = saveIndustry.dataset.saveIndustry;
        const name = document.querySelector(`[data-industry-name="${CSS.escape(id)}"]`).value;
        await api(`/api/merchant/industries/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ name }) });
        await refresh(); toast("行业已更新");
      }
      const deleteIndustry = event.target.closest("[data-delete-industry]");
      if (deleteIndustry && confirm("删除这个行业？")) {
        await api(`/api/merchant/industries/${encodeURIComponent(deleteIndustry.dataset.deleteIndustry)}`, { method: "DELETE" });
        await refresh(); toast("行业已删除");
      }
    } catch (error) { state.busy = false; render(); toast(error.message, true); }
  });

  root.addEventListener("change", async (event) => {
    if (event.target.matches("[data-filter]")) {
      const key = event.target.dataset.filter;
      state.filters[key] = event.target.value;
      if (key === "province") state.filters.city = "";
      render();
    }
    if (event.target.matches("[data-stage]")) {
      state.staged[Number(event.target.dataset.index)][event.target.dataset.stage] = event.target.value;
    }
    if (event.target.id === "bulkIndustry") {
      root.querySelector('[data-action="bulk-industry"]').disabled = !event.target.value;
    }
    if (event.target.id === "importFiles") {
      const files = [...event.target.files];
      if (files.length > 20) return toast("一次最多选择 20 个文件", true);
      const parsed = [];
      const failures = [];
      for (const file of files) {
        try {
          const item = await parseFile(file);
          item.industryId = matchIndustry(file.name, state.industries);
          parsed.push(item);
        }
        catch (error) { failures.push(`${file.name}: ${error.message}`); }
      }
      state.staged = parsed;
      render();
      if (failures.length) toast(failures.join("；"), true);
      else if (parsed.length) toast(`已从文件名识别 ${parsed.filter((item) => item.industryId).length} 个文件的行业`);
    }
  });

  function applyCitySearch(input) {
    state.citySearch = input.value;
    if (state.filters.city && !state.filters.city.toLocaleLowerCase().includes(state.citySearch.trim().toLocaleLowerCase())) {
      state.filters.city = "";
    }
    const cursor = input.selectionStart;
    render();
    const search = root.querySelector("#citySearch");
    search.focus();
    search.setSelectionRange(cursor, cursor);
  }

  root.addEventListener("input", (event) => {
    if (event.target.id === "citySearch" && !event.isComposing) applyCitySearch(event.target);
  });

  root.addEventListener("compositionend", (event) => {
    if (event.target.id === "citySearch") applyCitySearch(event.target);
  });

  root.addEventListener("submit", async (event) => {
    if (event.target.id !== "industryForm") return;
    event.preventDefault();
    try {
      const name = new FormData(event.target).get("name");
      await api("/api/merchant/industries", { method: "POST", body: JSON.stringify({ name }) });
      await refresh(); toast("行业已添加");
    } catch (error) { toast(error.message, true); }
  });

  (async () => {
    try {
      const { user } = await api("/api/me");
      if (!user) throw new Error("请先登录知识库");
      state.user = user;
      await refresh();
    } catch (error) { root.innerHTML = `<main class="loading">${esc(error.message)}</main>`; }
  })();
})();
