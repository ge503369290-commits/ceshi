(() => {
  const $ = (selector) => document.querySelector(selector);
  const STORAGE_KEY = 'lead-generator-v2';
  const state = { leads: [], filtered: [], showFullPhone: false, shopId: '', shopNameForId: '', currentPage: 1, pageSize: 20, dateWeights: {} };
  const els = {
    form: $('#generatorForm'), storeName: $('#storeName'), startTime: $('#startTime'), endTime: $('#endTime'), leadCount: $('#leadCount'),
    distributionStartTime: $('#distributionStartTime'), distributionEndTime: $('#distributionEndTime'), dateWeightMode: $('#dateWeightMode'),
    connectedRatio: $('#connectedRatio'), rejectedRatio: $('#rejectedRatio'), unansweredRatio: $('#unansweredRatio'), statusRatioTotal: $('#statusRatioTotal'),
    dateWeightEditor: $('#dateWeightEditor'), dateWeightList: $('#dateWeightList'),
    body: $('#leadTableBody'), empty: $('#emptyState'), count: $('#visibleCount'), pageSummary: $('#pageSummary'),
    headerShopName: $('#headerShopName'), idFilter: $('#idFilter'), phoneFilter: $('#phoneFilter'), channelFilter: $('#channelFilter'), filterStartDate: $('#filterStartDate'), filterEndDate: $('#filterEndDate'),
    pageSize: $('#pageSize'), pageButtons: $('#pageButtons'), prevPage: $('#prevPage'), nextPage: $('#nextPage'), gotoPage: $('#gotoPage'),
    phoneButton: $('#definitionsButton'), dialog: $('#phoneDialog'), toast: $('#toast')
  };
  const pad = (value) => String(value).padStart(2, '0');
  const toLocalInput = (date) => `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const formatDateTime = (value) => { const d = new Date(value); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const formatDate = (date) => `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
  const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const randomOf = (items) => items[randomInt(0, items.length - 1)];
  const weightedRandom = (items) => {
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    let point = Math.random() * total;
    for (const item of items) {
      point -= item.weight;
      if (point < 0) return item;
    }
    return items[items.length - 1];
  };
  const randomPhone = () => {
    const prefixes = ['130','131','132','133','134','135','136','137','138','139','150','151','152','153','155','156','157','158','159','166','171','172','173','175','176','177','178','180','181','182','183','184','185','186','187','188','189','191','193','195','196','198','199'];
    return randomOf(prefixes) + String(randomInt(0, 99999999)).padStart(8, '0');
  };
  const maskPhone = (phone) => `${phone.slice(0, 4)}***${phone.slice(-4)}`;
  const randomId = (used) => { let id; do { id = String(randomInt(580000000, 599999999)); } while (used.has(id)); used.add(id); return id; };
  const randomShopId = () => String(randomInt(300000000, 999999999));
  const escapeHtml = (text) => String(text).replace(/[&<>'"]/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  const showToast = (message) => { els.toast.textContent = message; els.toast.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 2300); };

  function getDateKeys() {
    const start = new Date(`${els.startTime.value}T00:00`);
    const end = new Date(els.endTime.value);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
    const cursor = new Date(start); cursor.setHours(0, 0, 0, 0);
    const last = new Date(end); last.setHours(0, 0, 0, 0);
    const dates = [];
    while (cursor <= last && dates.length < 367) {
      dates.push(formatDate(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return dates;
  }

  function renderDateWeightEditor(weights = state.dateWeights) {
    const custom = els.dateWeightMode.value === 'custom';
    els.dateWeightEditor.hidden = !custom;
    if (!custom) return;
    const dates = getDateKeys();
    if (dates.length === 367) {
      els.dateWeightList.innerHTML = '<p class="advanced-warning">自定义日期权重最多支持 366 天，请缩短开始和结束时间范围。</p>';
      return;
    }
    state.dateWeights = Object.fromEntries(dates.map((date) => [date, Math.max(0, Number(weights[date] ?? 1))]));
    els.dateWeightList.innerHTML = dates.map((date) => `
      <label><span>${date}</span><input type="number" min="0" max="100" step="1" value="${state.dateWeights[date]}" data-date-weight="${date}" aria-label="${date} 权重" /></label>
    `).join('');
  }

  function syncRatioTotal() {
    const total = [els.connectedRatio, els.rejectedRatio, els.unansweredRatio].reduce((sum, input) => sum + (Number(input.value) || 0), 0);
    els.statusRatioTotal.textContent = `当前合计 ${total}%`;
    els.statusRatioTotal.classList.toggle('invalid', total !== 100);
  }

  function syncShopId(storeName) {
    if (!storeName) return;
    if (!/^\d{9}$/.test(state.shopId) || state.shopNameForId !== storeName) {
      state.shopId = randomShopId();
      state.shopNameForId = storeName;
    }
  }

  function setGeneratorDateRange(range) {
    const now = new Date(); now.setSeconds(0, 0);
    const start = new Date(now); const end = new Date(now);
    if (range === 'today') start.setHours(0, 0, 0, 0);
    if (range === 'yesterday') {
      start.setDate(start.getDate() - 1); start.setHours(0, 0, 0, 0);
      end.setDate(end.getDate() - 1); end.setHours(23, 59, 0, 0);
    }
    if (range === 'last7') { start.setDate(start.getDate() - 6); start.setHours(0, 0, 0, 0); }
    els.startTime.value = formatDate(start); els.endTime.value = toLocalInput(end);
    document.querySelectorAll('[data-generator-range]').forEach((button) => button.classList.toggle('selected', button.dataset.generatorRange === range));
    renderDateWeightEditor();
  }

  function readAdvancedSettings() {
    const [startHour, startMinute] = els.distributionStartTime.value.split(':').map(Number);
    const [endHour, endMinute] = els.distributionEndTime.value.split(':').map(Number);
    const timeStart = startHour * 60 + startMinute;
    const timeEnd = endHour * 60 + endMinute;
    if (![timeStart, timeEnd].every(Number.isFinite) || timeStart >= timeEnd) throw new Error('每日结束时间需要晚于开始时间');
    const statusRatios = {
      connected: Number(els.connectedRatio.value),
      rejected: Number(els.rejectedRatio.value),
      unanswered: Number(els.unansweredRatio.value)
    };
    if (Object.values(statusRatios).some((value) => !Number.isFinite(value) || value < 0 || value > 100)) throw new Error('通话状态比例需要设置为 0–100');
    if (Object.values(statusRatios).reduce((sum, value) => sum + value, 0) !== 100) throw new Error('通话状态比例合计必须为 100%');
    if (els.dateWeightMode.value === 'custom' && getDateKeys().length === 367) throw new Error('自定义日期权重最多支持 366 天');
    return { timeStart, timeEnd, dateWeightMode: els.dateWeightMode.value, dateWeights: { ...state.dateWeights }, statusRatios };
  }

  function buildDateDistribution(start, end, settings) {
    const dates = [];
    const cursor = new Date(start); cursor.setHours(0, 0, 0, 0);
    const last = new Date(end); last.setHours(0, 0, 0, 0);
    let index = 0;
    while (cursor <= last) {
      const date = new Date(cursor);
      const rangeStart = new Date(date); rangeStart.setHours(Math.floor(settings.timeStart / 60), settings.timeStart % 60, 0, 0);
      const rangeEnd = new Date(date); rangeEnd.setHours(Math.floor(settings.timeEnd / 60), settings.timeEnd % 60, 59, 999);
      const min = Math.max(start.getTime(), rangeStart.getTime());
      const max = Math.min(end.getTime(), rangeEnd.getTime());
      let weight = 1;
      if (settings.dateWeightMode === 'recent') weight = index + 1;
      if (settings.dateWeightMode === 'weekday') weight = [0, 6].includes(date.getDay()) ? 1 : 3;
      if (settings.dateWeightMode === 'custom') weight = Number(settings.dateWeights[formatDate(date)] || 0);
      if (min <= max && weight > 0) dates.push({ min, max, weight });
      cursor.setDate(cursor.getDate() + 1);
      index += 1;
    }
    if (!dates.length) throw new Error('当前时间范围和日期权重下没有可生成的时间');
    return dates;
  }

  function buildStatusPool(count, ratios) {
    const definitions = [
      {label:'接通',recording:true,ratio:ratios.connected},
      {label:'客服拒接',recording:false,ratio:ratios.rejected},
      {label:'客服无应答',recording:false,ratio:ratios.unanswered}
    ].map((item) => {
      const exact = count * item.ratio / 100;
      return { ...item, count: Math.floor(exact), fraction: exact - Math.floor(exact) };
    });
    let remainder = count - definitions.reduce((sum, item) => sum + item.count, 0);
    [...definitions].sort((a, b) => b.fraction - a.fraction).forEach((item) => {
      if (remainder > 0) { item.count += 1; remainder -= 1; }
    });
    const pool = definitions.flatMap((item) => Array.from({length:item.count}, () => ({label:item.label,recording:item.recording})));
    for (let index = pool.length - 1; index > 0; index -= 1) {
      const swapIndex = randomInt(0, index);
      [pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]];
    }
    return pool;
  }

  function setDefaults() {
    const end = new Date(); end.setSeconds(0, 0);
    const start = new Date(end); start.setDate(start.getDate() - 6); start.setHours(0, 0, 0, 0);
    els.startTime.value = formatDate(start); els.endTime.value = toLocalInput(end);
    els.storeName.value = '先驰汽车上门补胎修车搭电道路救援'; els.leadCount.value = 9;
    els.distributionStartTime.value = '08:00'; els.distributionEndTime.value = '22:00'; els.dateWeightMode.value = 'uniform';
    els.connectedRatio.value = 60; els.rejectedRatio.value = 20; els.unansweredRatio.value = 20; state.dateWeights = {}; state.shopId = ''; state.shopNameForId = ''; syncRatioTotal();
  }
  function createLeads(storeName, startMs, endMs, count, settings) {
    syncShopId(storeName);
    const usedIds = new Set(); const shopId = state.shopId;
    const dateDistribution = buildDateDistribution(new Date(startMs), new Date(endMs), settings);
    const statuses = buildStatusPool(count, settings.statusRatios);
    return Array.from({length: count}, (_, index) => {
      const call = statuses[index]; const day = weightedRandom(dateDistribution); const phone = randomPhone();
      return { plan:'电话', id:randomId(usedIds), shopId, storeName, phone, virtual:'-', source:'查看线索来源', channel:'店铺会员/流量宝', time:new Date(randomInt(day.min, day.max)).toISOString(), recording:call.recording, status:call.label };
    }).sort((a,b) => new Date(b.time) - new Date(a.time));
  }
  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      leads:state.leads, shopId:state.shopId, shopNameForId:state.shopNameForId, storeName:els.storeName.value, startTime:els.startTime.value, endTime:els.endTime.value, leadCount:els.leadCount.value,
      advanced:{distributionStartTime:els.distributionStartTime.value,distributionEndTime:els.distributionEndTime.value,dateWeightMode:els.dateWeightMode.value,dateWeights:state.dateWeights,connectedRatio:els.connectedRatio.value,rejectedRatio:els.rejectedRatio.value,unansweredRatio:els.unansweredRatio.value}
    }));
  }
  function load() {
    setDefaults();
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); if (!saved?.leads?.length) return false;
      state.leads = saved.leads.map((lead) => ({ ...lead, plan: lead.plan === '电话3' ? '电话' : lead.plan })); state.shopId = saved.shopId || '';
      els.storeName.value = saved.storeName || state.leads[0].storeName; els.startTime.value = (saved.startTime || els.startTime.value).slice(0, 10); els.endTime.value = saved.endTime || els.endTime.value; els.leadCount.value = saved.leadCount || state.leads.length;
      state.shopNameForId = saved.shopNameForId || els.storeName.value;
      const advanced = saved.advanced || {};
      els.distributionStartTime.value = advanced.distributionStartTime || els.distributionStartTime.value;
      els.distributionEndTime.value = advanced.distributionEndTime || els.distributionEndTime.value;
      els.dateWeightMode.value = advanced.dateWeightMode || els.dateWeightMode.value;
      els.connectedRatio.value = advanced.connectedRatio ?? els.connectedRatio.value;
      els.rejectedRatio.value = advanced.rejectedRatio ?? els.rejectedRatio.value;
      els.unansweredRatio.value = advanced.unansweredRatio ?? els.unansweredRatio.value;
      state.dateWeights = advanced.dateWeights || {};
      renderDateWeightEditor(state.dateWeights); syncRatioTotal();
      els.filterStartDate.value = els.startTime.value.slice(0, 10); els.filterEndDate.value = els.endTime.value.slice(0, 10);
      return true;
    } catch { return false; }
  }
  function render() {
    const total = state.filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    state.currentPage = Math.min(Math.max(1, state.currentPage), totalPages);
    const startIndex = (state.currentPage - 1) * state.pageSize;
    const rows = state.filtered.slice(startIndex, startIndex + state.pageSize);
    els.body.innerHTML = rows.map((lead) => `<tr>
      <td>${escapeHtml(lead.plan)}</td><td>${escapeHtml(lead.id)}</td><td>${escapeHtml(lead.shopId)}</td><td class="store-cell" title="${escapeHtml(lead.storeName)}">${escapeHtml(lead.storeName)}</td>
      <td class="phone">${state.showFullPhone ? lead.phone : maskPhone(lead.phone)}</td><td>${escapeHtml(lead.virtual)}</td><td><a class="text-link" data-source="${lead.id}">${escapeHtml(lead.source)}</a></td><td>${escapeHtml(lead.channel)}</td>
      <td title="${formatDateTime(lead.time)}">${formatDateTime(lead.time)}</td><td>${lead.recording ? '<a class="text-link" data-recording="'+lead.id+'">播放通话录音</a>' : '-'}</td><td><span class="status ${lead.status === '接通' ? '' : 'missed'}">${escapeHtml(lead.status)}</span></td></tr>`).join('');
    els.empty.hidden = total !== 0; els.count.textContent = total; els.pageSummary.textContent = `共 ${total} 条`;
    els.prevPage.disabled = state.currentPage === 1; els.nextPage.disabled = state.currentPage === totalPages;
    els.gotoPage.max = totalPages; els.gotoPage.value = state.currentPage;
    const pages = []; const from = Math.max(1, state.currentPage - 2); const to = Math.min(totalPages, state.currentPage + 2);
    if (from > 1) { pages.push(1); if (from > 2) pages.push('…'); }
    for (let page = from; page <= to; page++) pages.push(page);
    if (to < totalPages) { if (to < totalPages - 1) pages.push('…'); pages.push(totalPages); }
    els.pageButtons.innerHTML = pages.map((page) => page === '…' ? '<span>…</span>' : `<button type="button" data-page="${page}" class="${page === state.currentPage ? 'page-active' : ''}">${page}</button>`).join('');
    els.headerShopName.textContent = els.storeName.value.trim() || '未命名店铺';
    els.phoneButton.textContent = state.showFullPhone ? '隐藏明文线索' : '查看明文线索';
  }
  function applyFilters() {
    const id = els.idFilter.value.trim(); const phone = els.phoneFilter.value.trim(); const channel = els.channelFilter.value; const startDate = els.filterStartDate.value; const endDate = els.filterEndDate.value;
    if (startDate && endDate && startDate > endDate) { showToast('结束日期不能早于开始日期'); return false; }
    state.filtered = state.leads.filter((lead) => { const date = lead.time.slice(0, 10); return (!id || lead.id.includes(id)) && (!phone || lead.phone.includes(phone)) && (!channel || lead.channel === channel) && (!startDate || date >= startDate) && (!endDate || date <= endDate); });
    state.currentPage = 1;
    render(); return true;
  }
  function generate(event) {
    event?.preventDefault(); const name = els.storeName.value.trim(); const start = new Date(`${els.startTime.value}T00:00`); const end = new Date(els.endTime.value); const count = Number(els.leadCount.value);
    if (!name) return showToast('请输入店铺名称'); if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return showToast('请选择完整的时间范围');
    if (start >= end) return showToast('结束时间需要晚于开始时间'); if (!Number.isInteger(count) || count < 1 || count > 500) return showToast('线索数量请设置为 1–500');
    let advanced;
    try { advanced = readAdvancedSettings(); state.leads = createLeads(name, start.getTime(), end.getTime(), count, advanced); }
    catch (error) { return showToast(error.message); }
    state.filtered = [...state.leads]; state.showFullPhone = false; state.currentPage = 1;
    els.idFilter.value=''; els.phoneFilter.value=''; els.channelFilter.value=''; els.filterStartDate.value=els.startTime.value.slice(0,10); els.filterEndDate.value=els.endTime.value.slice(0,10); document.querySelectorAll('.quick-dates button').forEach(b=>b.classList.remove('selected'));
    save(); render(); showToast(`已生成 ${count} 条电话线索`);
  }
  function exportCsv() {
    if (!state.filtered.length) return showToast('当前没有可下载的线索');
    const fields = ['方案名称','线索ID','shopId','店铺名称','客户电话','店铺虚拟号','线索来源','流量渠道','时间','通话录音','通话状态'];
    const csvCell = (v) => `"${String(v).replace(/"/g,'""')}"`;
    const rows = state.filtered.map(l => [l.plan,l.id,l.shopId,l.storeName,l.phone,l.virtual,l.source,l.channel,formatDateTime(l.time),l.recording?'有':'无',l.status].map(csvCell).join(','));
    const blob = new Blob(['\ufeff'+fields.join(',')+'\n'+rows.join('\n')], {type:'text/csv;charset=utf-8'}); const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href=url; a.download=`${els.storeName.value.trim()}_电话线索_${new Date().toISOString().slice(0,10)}.csv`; a.click(); URL.revokeObjectURL(url); showToast(`已下载 ${state.filtered.length} 条线索`);
  }
  async function exportAsImage() {
    const button = $('#exportImage'); button.disabled = true; showToast('正在生成图片…');
    document.body.classList.add('export-capture');
    try {
      if (typeof window.html2canvas !== 'function') throw new Error('截图组件未加载');
      if (document.fonts?.ready) await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const width = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
      const height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      const canvas = await window.html2canvas(document.body,{backgroundColor:'#f4f6f9',scale:Math.min(2,window.devicePixelRatio||1.5),logging:false,useCORS:true,width,height,windowWidth:width,windowHeight:height,scrollX:0,scrollY:0,onclone:(clonedDocument)=>{clonedDocument.body.classList.add('export-capture');['#generatorCard','#openGeneratorTop','.heading-actions'].forEach((selector)=>clonedDocument.querySelector(selector)?.remove());clonedDocument.querySelectorAll('.toast,dialog').forEach((node)=>node.remove());}});
      const png = await new Promise((resolve,reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('图片编码失败')),'image/png',.95));
      const pngUrl = URL.createObjectURL(png); const link = document.createElement('a'); link.href=pngUrl; link.download=`${els.storeName.value.trim() || '店铺'}_电话线索_${new Date().toISOString().slice(0,10)}.png`; link.click(); setTimeout(()=>URL.revokeObjectURL(pngUrl),1000); showToast('图片已导出');
    } catch (error) { console.error(error); showToast('图片导出失败，请重试'); }
    finally { document.body.classList.remove('export-capture'); button.disabled = false; }
  }
  els.form.addEventListener('submit', generate);
  document.querySelectorAll('[data-step]').forEach(button => button.addEventListener('click', () => { const next = Math.max(1,Math.min(500,Number(els.leadCount.value||1)+Number(button.dataset.step))); els.leadCount.value=next; }));
  document.querySelectorAll('[data-generator-range]').forEach((button) => button.addEventListener('click', () => setGeneratorDateRange(button.dataset.generatorRange)));
  els.dateWeightMode.addEventListener('change', () => renderDateWeightEditor());
  [els.startTime, els.endTime].forEach((input) => input.addEventListener('change', () => { document.querySelectorAll('[data-generator-range]').forEach((button) => button.classList.remove('selected')); renderDateWeightEditor(); }));
  els.dateWeightList.addEventListener('input', (event) => {
    const date = event.target.dataset.dateWeight;
    if (date) state.dateWeights[date] = Math.max(0, Number(event.target.value) || 0);
  });
  [els.connectedRatio, els.rejectedRatio, els.unansweredRatio].forEach((input) => input.addEventListener('input', syncRatioTotal));
  $('#applyFilters').addEventListener('click', () => { if (applyFilters()) showToast(`筛选到 ${state.filtered.length} 条线索`); });
  $('#clearFilters').addEventListener('click', () => { els.idFilter.value='';els.phoneFilter.value='';els.channelFilter.value='';els.filterStartDate.value='';els.filterEndDate.value='';document.querySelectorAll('.quick-dates button').forEach(b=>b.classList.remove('selected'));applyFilters(); });
  document.querySelectorAll('.quick-dates button').forEach(button => button.addEventListener('click', () => { document.querySelectorAll('.quick-dates button').forEach(b=>b.classList.remove('selected'));button.classList.add('selected');const today=new Date();const end=new Date(today);const start=new Date(today);const days=Number(button.dataset.days);if(days===1){start.setDate(start.getDate()-1);end.setDate(end.getDate()-1);}else if(days===7){start.setDate(start.getDate()-6);}els.filterStartDate.value=`${start.getFullYear()}-${pad(start.getMonth()+1)}-${pad(start.getDate())}`;els.filterEndDate.value=`${end.getFullYear()}-${pad(end.getMonth()+1)}-${pad(end.getDate())}`;applyFilters(); }));
  $('#exportButton').addEventListener('click', exportCsv);
  $('#exportImage').addEventListener('click', exportAsImage);
  [els.filterStartDate,els.filterEndDate].forEach((input)=>input.addEventListener('input',()=>document.querySelectorAll('.quick-dates button').forEach(b=>b.classList.remove('selected'))));
  els.pageSize.addEventListener('change', () => { state.pageSize = Number(els.pageSize.value); state.currentPage = 1; render(); });
  els.prevPage.addEventListener('click', () => { if (state.currentPage > 1) { state.currentPage--; render(); } });
  els.nextPage.addEventListener('click', () => { const max = Math.max(1, Math.ceil(state.filtered.length / state.pageSize)); if (state.currentPage < max) { state.currentPage++; render(); } });
  els.pageButtons.addEventListener('click', (event) => { const page = Number(event.target.dataset.page); if (page) { state.currentPage = page; render(); } });
  $('#goPage').addEventListener('click', () => { const max = Math.max(1, Math.ceil(state.filtered.length / state.pageSize)); state.currentPage = Math.min(max, Math.max(1, Number(els.gotoPage.value) || 1)); render(); });
  els.phoneButton.addEventListener('click', () => { state.showFullPhone=!state.showFullPhone;render(); if(state.showFullPhone) els.dialog.showModal(); });
  $('#closeDialog').addEventListener('click',()=>els.dialog.close()); $('#confirmDialog').addEventListener('click',()=>els.dialog.close());
  $('#openGenerator').addEventListener('click',()=>{ $('#generatorCard').scrollIntoView({behavior:'smooth',block:'center'});els.storeName.focus(); }); $('#openGeneratorTop').addEventListener('click',()=>$('#openGenerator').click());
  els.body.addEventListener('click',(e)=>{ if(e.target.dataset.recording) showToast('模拟录音：该线索通话已接通'); if(e.target.dataset.source) showToast('线索来自店铺页面的电话咨询'); });
  els.storeName.addEventListener('input',()=>{ const name = els.storeName.value.trim(); els.headerShopName.textContent=name||'未命名店铺'; syncShopId(name); });
  const restored = load(); renderDateWeightEditor(state.dateWeights); syncRatioTotal();
  if (!restored) generate(); else { state.filtered=[...state.leads]; render(); }
})();
