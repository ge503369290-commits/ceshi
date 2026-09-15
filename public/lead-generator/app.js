(() => {
  const $ = (selector) => document.querySelector(selector);
  const STORAGE_KEY = 'lead-generator-zip-template-v1';
  const state = { leads: [], filtered: [], showFullPhone: false, shopId: '', activeStoreName: '', sessionShopIds: new Map(), customDateWeights: new Map(), currentPage: 1, pageSize: 20 };
  const els = {
    form: $('#generatorForm'), storeName: $('#storeName'), startTime: $('#startTime'), endTime: $('#endTime'), leadCount: $('#leadCount'), dailyStartTime: $('#dailyStartTime'), dailyEndTime: $('#dailyEndTime'), connectRate: $('#connectRate'), dateWeight: $('#dateWeight'), customWeightPanel: $('#customWeightPanel'), customWeightList: $('#customWeightList'), weightDescription: $('#weightDescription'),
    body: $('#leadTableBody'), empty: $('#emptyState'), count: $('#visibleCount'), pageSummary: $('#pageSummary'),
    headerShopName: $('#headerShopName'), idFilter: $('#idFilter'), phoneFilter: $('#phoneFilter'), channelFilter: $('#channelFilter'), filterStartDate: $('#filterStartDate'), filterEndDate: $('#filterEndDate'),
    pageSize: $('#pageSize'), pageButtons: $('#pageButtons'), prevPage: $('#prevPage'), nextPage: $('#nextPage'), gotoPage: $('#gotoPage'),
    phoneButton: $('#definitionsButton'), dialog: $('#phoneDialog'), toast: $('#toast')
  };
  const pad = (value) => String(value).padStart(2, '0');
  const toLocalInput = (date) => `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const formatDateTime = (value) => { const d = new Date(value); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const randomOf = (items) => items[randomInt(0, items.length - 1)];
  const randomPhone = () => {
    const prefixes = ['130','131','132','133','134','135','136','137','138','139','150','151','152','153','155','156','157','158','159','166','171','172','173','175','176','177','178','180','181','182','183','184','185','186','187','188','189','191','193','195','196','198','199'];
    return randomOf(prefixes) + String(randomInt(0, 99999999)).padStart(8, '0');
  };
  const maskPhone = (phone) => `${phone.slice(0, 4)}***${phone.slice(-4)}`;
  const randomId = (used) => { let id; do { id = String(randomInt(580000000, 599999999)); } while (used.has(id)); used.add(id); return id; };
  const getSessionShopId = (storeName) => {
    const key = storeName.trim();
    if (state.sessionShopIds.has(key)) return state.sessionShopIds.get(key);
    const usedIds = new Set(state.sessionShopIds.values());
    let shopId;
    do { shopId = String(randomInt(300000000, 999999999)); } while (usedIds.has(shopId));
    state.sessionShopIds.set(key, shopId);
    return shopId;
  };
  const escapeHtml = (text) => String(text).replace(/[&<>'"]/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  const showToast = (message) => { els.toast.textContent = message; els.toast.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 2300); };
  const dateKey = (date) => `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
  const weekdayNames = ['周日','周一','周二','周三','周四','周五','周六'];
  const parseClockSeconds = (value) => {
    const parts = String(value).split(':').map(Number);
    if (parts.length < 2 || parts.some(Number.isNaN)) return NaN;
    return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
  };

  function buildDateBuckets(startMs, endMs) {
    const buckets = [];
    const cursor = new Date(startMs); cursor.setHours(0, 0, 0, 0);
    while (cursor.getTime() <= endMs) {
      const dayStart = cursor.getTime();
      const nextDay = new Date(cursor); nextDay.setDate(nextDay.getDate() + 1);
      buckets.push({key:dateKey(cursor), label:`${dateKey(cursor)} ${weekdayNames[cursor.getDay()]}`, day:cursor.getDay(), start:Math.max(startMs, dayStart), end:Math.min(endMs, nextDay.getTime() - 1)});
      cursor.setDate(cursor.getDate() + 1);
    }
    return buckets.filter((bucket) => bucket.start <= bucket.end);
  }

  function buildCallableDateBuckets(startMs, endMs, dailyStartSeconds, dailyEndSeconds) {
    return buildDateBuckets(startMs, endMs).map((bucket) => {
      const day = new Date(bucket.start); day.setHours(0, 0, 0, 0);
      const allowedStart = day.getTime() + dailyStartSeconds * 1000;
      const allowedEnd = day.getTime() + dailyEndSeconds * 1000 + 999;
      return {...bucket, start:Math.max(bucket.start, allowedStart), end:Math.min(bucket.end, allowedEnd)};
    }).filter((bucket) => bucket.start <= bucket.end);
  }

  function renderCustomWeights() {
    const start = new Date(els.startTime.value); const end = new Date(els.endTime.value);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) { els.customWeightList.innerHTML = '<span class="weight-empty">请先选择有效的开始和结束时间</span>'; return; }
    const buckets = buildDateBuckets(start.getTime(), end.getTime());
    els.customWeightList.innerHTML = buckets.map((bucket) => `<label class="custom-weight-item"><span>${bucket.label}</span><input type="number" min="0" step="0.1" value="${state.customDateWeights.get(bucket.key) ?? 1}" data-weight-date="${bucket.key}" aria-label="${bucket.label}权重" /></label>`).join('');
  }

  function updateWeightUI() {
    const descriptions = {uniform:'范围内每个日期获得相同的生成概率。',recent:'越接近结束日期，生成概率越高。',workday:'周一至周五的生成概率为周末的 3 倍。',custom:'按每天填写的相对权重分配，数值越大概率越高。'};
    els.weightDescription.textContent = descriptions[els.dateWeight.value];
    els.customWeightPanel.hidden = els.dateWeight.value !== 'custom';
    if (!els.customWeightPanel.hidden) renderCustomWeights();
  }

  function setGeneratorRange(days) {
    const now = new Date(); now.setSeconds(0, 0);
    const start = new Date(now); const end = new Date(now);
    if (days === 1) { start.setDate(start.getDate() - 1); start.setHours(0,0,0,0); end.setDate(end.getDate() - 1); end.setHours(23,59,0,0); }
    else { start.setHours(0,0,0,0); if (days === 7) start.setDate(start.getDate() - 6); }
    els.startTime.value = toLocalInput(start); els.endTime.value = toLocalInput(end);
    document.querySelectorAll('[data-generator-days]').forEach((button) => button.classList.toggle('selected', Number(button.dataset.generatorDays) === days));
    if (els.dateWeight.value === 'custom') renderCustomWeights();
  }

  function setDefaults() {
    const end = new Date(); end.setSeconds(0, 0);
    const start = new Date(end); start.setDate(start.getDate() - 6); start.setHours(0, 0, 0, 0);
    els.startTime.value = toLocalInput(start); els.endTime.value = toLocalInput(end); els.dailyStartTime.value = '08:30:00'; els.dailyEndTime.value = '23:59:59'; els.connectRate.value = 90;
    els.storeName.value = '先驰汽车上门补胎修车搭电道路救援'; els.leadCount.value = 9;
  }
  function createLeads(storeName, startMs, endMs, count, weightMode, dailyStartSeconds, dailyEndSeconds, connectRate) {
    const usedIds = new Set(); const shopId = getSessionShopId(storeName); state.shopId = shopId;
    const connectedCount = Math.round(count * connectRate / 100);
    const calls = Array.from({length:count}, (_, index) => index < connectedCount ? {label:'接通',recording:true} : {label:'网民中止呼叫',recording:false});
    for (let index = calls.length - 1; index > 0; index--) { const target = randomInt(0, index); [calls[index], calls[target]] = [calls[target], calls[index]]; }
    const buckets = buildCallableDateBuckets(startMs, endMs, dailyStartSeconds, dailyEndSeconds);
    const weights = buckets.map((bucket, index) => {
      if (weightMode === 'recent') return buckets.length === 1 ? 1 : 1 + (index / (buckets.length - 1)) * 2;
      if (weightMode === 'workday') return bucket.day >= 1 && bucket.day <= 5 ? 3 : 1;
      if (weightMode === 'custom') return Math.max(0, Number(state.customDateWeights.get(bucket.key)) || 0);
      return 1;
    });
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const weightedTime = () => {
      let target = Math.random() * totalWeight;
      let index = weights.length - 1;
      for (let i = 0; i < weights.length; i++) { target -= weights[i]; if (target < 0) { index = i; break; } }
      return new Date(randomInt(buckets[index].start, buckets[index].end)).toISOString();
    };
    return Array.from({length: count}, (_, index) => {
      const call = calls[index]; const phone = randomPhone();
      return { plan:'电话', id:randomId(usedIds), shopId, storeName, phone, virtual:'-', source:'查看线索来源', channel:'店铺会员/流量宝', time:weightedTime(), recording:call.recording, status:call.label };
    }).sort((a,b) => new Date(b.time) - new Date(a.time));
  }
  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({leads:state.leads, shopId:state.shopId, storeName:state.activeStoreName, startTime:els.startTime.value, endTime:els.endTime.value, leadCount:els.leadCount.value, dailyStartTime:els.dailyStartTime.value, dailyEndTime:els.dailyEndTime.value, connectRate:els.connectRate.value, dateWeight:els.dateWeight.value, customDateWeights:Object.fromEntries(state.customDateWeights)}));
  }
  function load() {
    setDefaults();
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); if (!saved?.leads?.length) return false;
      state.leads = saved.leads.map((lead) => ({...lead, plan:'电话'})); state.shopId = saved.shopId || '';
      state.activeStoreName = saved.storeName || state.leads[0].storeName;
      if (state.activeStoreName && /^\d{9}$/.test(state.shopId)) state.sessionShopIds.set(state.activeStoreName, state.shopId);
      els.storeName.value = state.activeStoreName; els.startTime.value = saved.startTime || els.startTime.value; els.endTime.value = saved.endTime || els.endTime.value; els.leadCount.value = saved.leadCount || state.leads.length; els.dailyStartTime.value = saved.dailyStartTime || els.dailyStartTime.value; els.dailyEndTime.value = saved.dailyEndTime || els.dailyEndTime.value; els.connectRate.value = saved.connectRate ?? els.connectRate.value;
      if (['uniform','recent','workday','custom'].includes(saved.dateWeight)) els.dateWeight.value = saved.dateWeight;
      if (saved.customDateWeights && typeof saved.customDateWeights === 'object') state.customDateWeights = new Map(Object.entries(saved.customDateWeights));
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
    els.headerShopName.textContent = state.activeStoreName || '未选择店铺';
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
    event?.preventDefault(); const name = els.storeName.value.trim(); const start = new Date(els.startTime.value); const end = new Date(els.endTime.value); const count = Number(els.leadCount.value); const weightMode = els.dateWeight.value; const dailyStartSeconds = parseClockSeconds(els.dailyStartTime.value); const dailyEndSeconds = parseClockSeconds(els.dailyEndTime.value); const connectRate = Number(els.connectRate.value);
    if (!name) return showToast('请输入店铺名称'); if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return showToast('请选择完整的时间范围');
    if (start >= end) return showToast('结束时间需要晚于开始时间'); if (!Number.isInteger(count) || count < 1 || count > 500) return showToast('线索数量请设置为 1–500');
    if (Number.isNaN(dailyStartSeconds) || Number.isNaN(dailyEndSeconds)) return showToast('请选择完整的每日电话时间');
    if (dailyStartSeconds > dailyEndSeconds) return showToast('每日结束时间不能早于开始时间');
    if (!Number.isFinite(connectRate) || connectRate < 0 || connectRate > 100) return showToast('接通比例请输入 0–100 之间的数值');
    const callableBuckets = buildCallableDateBuckets(start.getTime(), end.getTime(), dailyStartSeconds, dailyEndSeconds);
    if (!callableBuckets.length) return showToast('所选日期范围与每日电话时间限制没有交集');
    document.querySelectorAll('[data-weight-date]').forEach((input) => state.customDateWeights.set(input.dataset.weightDate, Math.max(0, Number(input.value) || 0)));
    if (weightMode === 'custom' && !callableBuckets.some((bucket) => (Number(state.customDateWeights.get(bucket.key)) || 0) > 0)) return showToast('可生成日期的自定义权重不能全部为 0');
    state.leads = createLeads(name, start.getTime(), end.getTime(), count, weightMode, dailyStartSeconds, dailyEndSeconds, connectRate); state.activeStoreName = name; state.filtered = [...state.leads]; state.showFullPhone = false; state.currentPage = 1;
    els.idFilter.value=''; els.phoneFilter.value=''; els.channelFilter.value=''; els.filterStartDate.value=els.startTime.value.slice(0,10); els.filterEndDate.value=els.endTime.value.slice(0,10); document.querySelectorAll('.quick-dates button').forEach(b=>b.classList.remove('selected'));
    save(); render(); showToast(`已生成 ${count} 条电话线索 · shopId ${state.shopId}`);
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
    const viewportWidth = window.innerWidth; const viewportHeight = window.innerHeight;
    const selectedGeneratorDays = document.querySelector('[data-generator-days].selected')?.dataset.generatorDays || '';
    const exportStartDate = els.startTime.value.slice(0,10); const exportEndDate = els.endTime.value.slice(0,10);
    const originalScrollX = window.scrollX; const originalScrollY = window.scrollY;
    document.body.classList.add('export-capture');
    try {
      if (typeof window.html2canvas !== 'function') throw new Error('截图组件未加载');
      if (document.fonts?.ready) await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const captureX = window.scrollX; const captureY = window.scrollY;
      const canvas = await window.html2canvas(document.body,{backgroundColor:'#f4f6f9',scale:1,logging:false,useCORS:true,x:captureX,y:captureY,width:viewportWidth,height:viewportHeight,windowWidth:viewportWidth,windowHeight:viewportHeight,scrollX:captureX,scrollY:captureY,onclone:(clonedDocument)=>{
        clonedDocument.body.classList.add('export-capture');
        ['#generatorCard','.heading-actions'].forEach((selector)=>clonedDocument.querySelector(selector)?.remove());
        clonedDocument.querySelectorAll('.toast,dialog').forEach((node)=>node.remove());
        const clonedStart = clonedDocument.querySelector('#filterStartDate'); const clonedEnd = clonedDocument.querySelector('#filterEndDate');
        if (clonedStart && exportStartDate) clonedStart.value = exportStartDate; if (clonedEnd && exportEndDate) clonedEnd.value = exportEndDate;
        clonedDocument.querySelectorAll('.filter-card .quick-dates button').forEach((quickButton)=>quickButton.classList.toggle('selected', Boolean(selectedGeneratorDays) && quickButton.dataset.days === selectedGeneratorDays));
        clonedDocument.querySelectorAll('.filter-card input,.filter-card select').forEach((control)=>{
          const rect = control.getBoundingClientRect();
          const text = control.tagName === 'SELECT' ? control.selectedOptions?.[0]?.textContent || '' : control.value || control.placeholder || '';
          const replacement = clonedDocument.createElement('span');
          replacement.className = `export-control-text${control.tagName !== 'SELECT' && !control.value ? ' is-placeholder' : ''}`;
          replacement.textContent = text;
          replacement.style.width = `${Math.round(rect.width)}px`;
          replacement.style.height = `${Math.round(rect.height)}px`;
          control.replaceWith(replacement);
        });
      }});
      const png = await new Promise((resolve,reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('图片编码失败')),'image/png',.95));
      const pngUrl = URL.createObjectURL(png); const link = document.createElement('a'); link.href=pngUrl; link.download=`${els.storeName.value.trim() || '店铺'}_电话线索_${new Date().toISOString().slice(0,10)}.png`; link.click(); setTimeout(()=>URL.revokeObjectURL(pngUrl),1000); showToast('图片已导出');
    } catch (error) { console.error(error); showToast('图片导出失败，请重试'); }
    finally { document.body.classList.remove('export-capture'); window.scrollTo(originalScrollX, originalScrollY); button.disabled = false; }
  }
  els.form.addEventListener('submit', generate);
  document.querySelectorAll('[data-step]').forEach(button => button.addEventListener('click', () => { const next = Math.max(1,Math.min(500,Number(els.leadCount.value||1)+Number(button.dataset.step))); els.leadCount.value=next; }));
  document.querySelectorAll('[data-generator-days]').forEach((button) => button.addEventListener('click', () => setGeneratorRange(Number(button.dataset.generatorDays))));
  [els.startTime,els.endTime].forEach((input) => input.addEventListener('input', () => { document.querySelectorAll('[data-generator-days]').forEach((button) => button.classList.remove('selected')); if (els.dateWeight.value === 'custom') renderCustomWeights(); }));
  els.dateWeight.addEventListener('change', updateWeightUI);
  els.customWeightList.addEventListener('input', (event) => { if (event.target.dataset.weightDate) state.customDateWeights.set(event.target.dataset.weightDate, Math.max(0, Number(event.target.value) || 0)); });
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
  $('#openGenerator').addEventListener('click',()=>{ $('#generatorCard').scrollIntoView({behavior:'smooth',block:'center'});els.storeName.focus(); });
  els.body.addEventListener('click',(e)=>{ if(e.target.dataset.recording) showToast('模拟录音：该线索通话已接通'); if(e.target.dataset.source) showToast('线索来自店铺页面的电话咨询'); });
  if (!load()) generate(); else { state.filtered=[...state.leads]; render(); }
  updateWeightUI();
})();
