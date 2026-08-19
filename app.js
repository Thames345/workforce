/* ============================================================
   WORKFORCE ATTENDANCE CONTROL — Application Logic
   ------------------------------------------------------------
   Vanilla JavaScript, no frameworks/build step.
   Sections:
     1. Constants
     2. State
     3. Backend API
     4. Date helpers
     5. Google Apps Script live data
     6. Rendering — header / nav
     7. Rendering — dashboard (KPIs, calendar, department details)
     8. Submit Status page
     9. Manage Employees page
     10. Toast / small utilities
     11. Event wiring & init
   ============================================================ */

/* ------------------------------------------------------------
   SECTION 1: CONSTANTS & INITIAL DATA
   ------------------------------------------------------------ */

var DEPARTMENTS = ['MVR', 'MVR-LOTUS', 'MSR', 'MPR'];

var STATUS_META = {
  work:  { label: 'ทำงาน',    icon: '🛠️', cls: 'status-work'  },
  leave: { label: 'ลา',        icon: '🏥', cls: 'status-leave' },
  off:   { label: 'วันหยุด',   icon: '🏡', cls: 'status-off'   },
  no_ot: { label: 'ไม่ทำ OT', icon: '🌙', cls: 'status-noot'  }
};

/* ------------------------------------------------------------
   SECTION 2: STATE
   ------------------------------------------------------------ */

var todayNow = new Date();

var state = {
  employees: [],
  attendance: [],
  currentPage: 'dashboard',
  calendarMonth: todayNow.getMonth(),
  calendarYear: todayNow.getFullYear(),
  selectedDate: null, // set in init() once formatDateISO is available
  syncStatus: 'syncing', // syncing | connected | error
  online: navigator.onLine,
  lastSyncedAt: null,
  selectedStatus: null, // used on the Submit Status page
  editingEntryId: null,
  requestInFlight: false
};

/* ------------------------------------------------------------
   SECTION 3: BACKEND-ONLY DATA
   ------------------------------------------------------------ */
function clearLegacyLocalData() {
  ['wfac_employees', 'wfac_attendance', 'wfac_sync_queue'].forEach(function (key) {
    try { localStorage.removeItem(key); } catch (e) { /* storage may be blocked */ }
  });
}

/* ------------------------------------------------------------
   SECTION 4: DATE HELPERS
   ------------------------------------------------------------
   IMPORTANT: never use Date#toISOString() for local dates — it
   converts to UTC first and can silently shift the day near
   midnight in Asia/Bangkok. Always build YYYY-MM-DD from local
   getFullYear/getMonth/getDate instead.
   ------------------------------------------------------------ */

function formatDateISO(d) {
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function todayISO() {
  return formatDateISO(new Date());
}

function formatDateDisplay(iso) {
  var parts = iso.split('-').map(Number);
  var d = new Date(parts[0], parts[1] - 1, parts[2]);
  // -u-ca-gregory keeps the year in Gregorian form (matches the ISO
  // dates used everywhere else) while still showing Thai day/month names.
  return d.toLocaleDateString('th-TH-u-ca-gregory', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/* ------------------------------------------------------------
   SECTION 5: GOOGLE APPS SCRIPT SYNC
   ------------------------------------------------------------ */

function isConfigured() {
  var url = (window.APP_CONFIG && window.APP_CONFIG.scriptUrl) || '';
  return !!url && url.indexOf('GOOGLE_APPS_SCRIPT_WEB_APP_URL') === -1 && url.indexOf('http') === 0;
}

async function fetchFromSheet() {
  if (!isConfigured()) throw new Error('NOT_CONFIGURED');
  var res = await fetch(window.APP_CONFIG.scriptUrl + '?action=read&_ts=' + Date.now(), { method: 'GET', cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP_' + res.status);
  var data = await res.json();
  if (!data.ok) throw new Error(data.error || 'UNKNOWN_ERROR');
  return data;
}

async function postToScript(action, record) {
  if (!isConfigured()) throw new Error('NOT_CONFIGURED');
  // text/plain avoids Apps Script's flaky CORS preflight (OPTIONS) handling.
  var res = await fetch(window.APP_CONFIG.scriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: action, record: record })
  });
  if (!res.ok) throw new Error('HTTP_' + res.status);
  var data = await res.json();
  if (!data.ok) throw new Error(data.error || 'UNKNOWN_ERROR');
  return data;
}

function replaceWithServerData(data) {
  state.employees = (Array.isArray(data.employees) ? data.employees : []).map(function (e) {
    return {
      employee_code: String(e.employee_code == null ? '' : e.employee_code).trim(),
      full_name: String(e.full_name == null ? '' : e.full_name).trim(),
      department: String(e.department == null ? '' : e.department).trim(),
      department_code: String(e.department_code == null ? '' : e.department_code).trim(),
      position: String(e.position == null ? '' : e.position).trim(),
      shift: String(e.shift == null ? '' : e.shift).trim()
    };
  }).filter(function (e) { return e.employee_code; });

  state.attendance = (Array.isArray(data.attendance) ? data.attendance : []).map(function (r) {
    var code = String(r.employee_code == null ? '' : r.employee_code).trim();
    var date = normalizeBackendDate(r.date);
    return {
      entry_id: String(r.entry_id || (date + '_' + code)),
      date: date,
      employee_code: code,
      full_name: String(r.full_name == null ? '' : r.full_name).trim(),
      department_code: String(r.department_code == null ? '' : r.department_code).trim(),
      shift: String(r.shift == null ? '' : r.shift).trim(),
      status: String(r.status == null ? '' : r.status).trim(),
      note: String(r.note == null ? '' : r.note),
      updated_at: r.updated_at || ''
    };
  }).filter(function (r) { return r.employee_code && r.date; });
}

function normalizeBackendDate(value) {
  if (!value) return '';
  var text = String(value);
  var isoMatch = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  var d = new Date(value);
  return isNaN(d.getTime()) ? text : formatDateISO(d);
}

async function syncNow(opts) {
  opts = opts || {};
  var silent = !!opts.silent;

  if (!isConfigured()) {
    if (!silent) showToast('ยังไม่ได้ตั้งค่า URL ของ Google Apps Script กรุณาแก้ไขไฟล์ config.js ก่อน', 'error');
    setSyncStatus('error');
    return;
  }

  setSyncStatus('syncing');

  try {
    var data = await fetchFromSheet();
    replaceWithServerData(data);
    setSyncStatus('connected'); // only reported after a REAL successful request
  } catch (err) {
    setSyncStatus('error');
    if (!silent) showToast('ไม่สามารถเชื่อมต่อระบบหลังบ้านได้ กรุณาตรวจอินเทอร์เน็ตแล้วลองใหม่', 'error');
  }
  renderDashboard();
  if (state.currentPage === 'manage') renderEmployeeTable();
  if (state.currentPage === 'submit') {
    populateEmployeeSelect();
    renderAttendanceTable();
  }
}

/* ------------------------------------------------------------
   SECTION 6: RENDERING — HEADER / NAV
   ------------------------------------------------------------ */

var SYNC_STATUS_META = {
  syncing:   { label: 'กำลังซิงค์ข้อมูล…',          cls: 'sync-syncing' },
  connected: { label: 'เชื่อมต่อ Google Sheets แล้ว', cls: 'sync-connected' },
  error:     { label: 'ซิงค์ข้อมูลล้มเหลว',         cls: 'sync-error' }
};

function setSyncStatus(status) {
  state.syncStatus = status;
  if (status === 'connected') state.lastSyncedAt = new Date();
  renderSyncBadge();
}

function formatTimeHM(d) {
  var hh = String(d.getHours()).padStart(2, '0');
  var mm = String(d.getMinutes()).padStart(2, '0');
  return hh + ':' + mm + ' น.';
}

function renderSyncBadge() {
  var badge = document.getElementById('sync-badge');
  var text = document.getElementById('sync-text');
  var info = SYNC_STATUS_META[state.syncStatus] || SYNC_STATUS_META.error;
  badge.className = 'sync-badge ' + info.cls;
  text.textContent = info.label;

  var lastEl = document.getElementById('sync-last-time');
  if (lastEl) {
    lastEl.textContent = state.lastSyncedAt ? 'อัปเดตล่าสุด ' + formatTimeHM(state.lastSyncedAt) : '';
  }
}

function openSheet() {
  var url = (window.APP_CONFIG && window.APP_CONFIG.sheetUrl) || '';
  if (!url || url.indexOf('GOOGLE_SHEET_URL') !== -1) {
    showToast('ยังไม่ได้ตั้งค่า URL ของ Google Sheet กรุณาแก้ไขไฟล์ config.js ก่อน', 'error');
    return;
  }
  window.open(url, '_blank');
}

function switchPage(page) {
  state.currentPage = page;

  document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
  document.getElementById('page-' + page).classList.add('active');

  document.querySelectorAll('.nav-btn[data-page]').forEach(function (b) { b.classList.remove('active'); });
  var btn = document.querySelector('.nav-btn[data-page="' + page + '"]');
  if (btn) btn.classList.add('active');

  if (page === 'submit') prepareSubmitForm();
  if (page === 'manage') renderEmployeeTable();
}

/* ------------------------------------------------------------
   SECTION 7: RENDERING — DASHBOARD
   ------------------------------------------------------------ */

function getDayStats(dateISO) {
  var total = state.employees.length;
  var recordsByCode = new Map();
  var leave = 0, off = 0, noot = 0;

  state.attendance.forEach(function (r) {
    if (r.date !== dateISO) return;
    recordsByCode.set(r.employee_code, r);
    if (r.status === 'leave') leave++;
    else if (r.status === 'off') off++;
    else if (r.status === 'no_ot') noot++;
    // 'work' needs no separate counter — anyone not explicitly on
    // leave/day-off/no-OT is counted as working below, whether they
    // submitted an explicit "Working" record or submitted nothing at
    // all. Nobody marking anything for the day means everyone is in.
  });

  var work = total - leave - off - noot;

  return { total: total, work: work, leave: leave, off: off, noot: noot, recordsByCode: recordsByCode };
}

function renderDashboard() {
  renderGreeting();
  renderKPIs();
  renderCalendar();
  renderDeptGrid();
  document.getElementById('details-date').textContent = formatDateDisplay(state.selectedDate);
}

function renderGreeting() {
  var hour = new Date().getHours();
  var greet = 'สวัสดีตอนเช้า 👋';
  if (hour >= 12 && hour < 18) greet = 'สวัสดีตอนบ่าย 👋';
  else if (hour >= 18 || hour < 5) greet = 'สวัสดีตอนเย็น 👋';
  document.getElementById('greeting-text').textContent = greet;
  document.getElementById('greeting-date').textContent =
    new Date().toLocaleDateString('th-TH-u-ca-gregory', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function renderKPIs() {
  var stats = getDayStats(state.selectedDate);
  var pct = stats.total > 0 ? Math.round((stats.work / stats.total) * 100) : 0;

  // Built with explicit template strings so a value of 0 is always
  // rendered as "0" (never blank) — e.g. "0/23 คน", not "/23 คน".
  document.getElementById('kpi-workforce-value').textContent = stats.work + '/' + stats.total + ' คน';
  document.getElementById('kpi-percent-value').textContent = pct + '%';
  document.getElementById('kpi-work-value').textContent = String(stats.work);
  document.getElementById('kpi-leave-value').textContent = String(stats.leave);
  document.getElementById('kpi-off-value').textContent = String(stats.off);
  document.getElementById('kpi-noot-value').textContent = String(stats.noot);
}

function renderCalendar() {
  var year = state.calendarYear;
  var month = state.calendarMonth;

  document.getElementById('calendar-title').textContent =
    new Date(year, month, 1).toLocaleDateString('th-TH-u-ca-gregory', { month: 'long', year: 'numeric' });

  var firstDay = new Date(year, month, 1);
  var startWeekday = firstDay.getDay(); // 0 = Sunday
  var daysInMonth = new Date(year, month + 1, 0).getDate();
  var daysInPrevMonth = new Date(year, month, 0).getDate();

  var cells = [];
  for (var i = startWeekday - 1; i >= 0; i--) {
    cells.push({ day: daysInPrevMonth - i, outside: true });
  }
  for (var d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, outside: false, dateISO: formatDateISO(new Date(year, month, d)) });
  }
  var trailDay = 1;
  while (cells.length % 7 !== 0) {
    cells.push({ day: trailDay++, outside: true });
  }

  var grid = document.getElementById('calendar-grid');
  grid.innerHTML = '';
  var todayStr = todayISO();

  cells.forEach(function (cell) {
    var div = document.createElement('div');

    if (cell.outside) {
      div.className = 'cal-day cal-day-outside';
      div.innerHTML = '<div class="cal-day-top"><span class="cal-day-num">' + cell.day + '</span></div>';
      grid.appendChild(div);
      return;
    }

    var stats = getDayStats(cell.dateISO);
    var isToday = cell.dateISO === todayStr;
    var isSelected = cell.dateISO === state.selectedDate;

    div.className = 'cal-day' + (isToday ? ' cal-day-today' : '') + (isSelected ? ' cal-day-selected' : '');
    div.dataset.date = cell.dateISO;

    var dotsHtml = '';
    if (stats.leave > 0) dotsHtml += '<span class="dot dot-leave">' + stats.leave + '</span>';
    if (stats.off > 0) dotsHtml += '<span class="dot dot-off">' + stats.off + '</span>';
    if (stats.noot > 0) dotsHtml += '<span class="dot dot-noot">' + stats.noot + '</span>';

    div.innerHTML =
      '<div class="cal-day-top">' +
        '<span class="cal-day-num">' + cell.day + '</span>' +
        (isToday ? '<span class="cal-day-today-badge">วันนี้</span>' : '') +
      '</div>' +
      '<div class="cal-day-fraction">' + stats.work + '/' + stats.total + '</div>' +
      '<div class="cal-day-dots">' + dotsHtml + '</div>';

    div.addEventListener('click', function () {
      state.selectedDate = this.dataset.date;
      renderDashboard();
    });

    grid.appendChild(div);
  });
}

function renderDeptGrid() {
  var stats = getDayStats(state.selectedDate);
  var grid = document.getElementById('dept-grid');
  grid.innerHTML = '';

  DEPARTMENTS.forEach(function (code) {
    var emps = state.employees
      .filter(function (e) { return e.department_code === code; })
      .sort(function (a, b) { return a.full_name.localeCompare(b.full_name, 'th'); });

    // Anyone without an explicit leave/day-off/no-OT record for the day
    // counts as working — matches getDayStats()'s definition exactly.
    var working = emps.filter(function (e) {
      var r = stats.recordsByCode.get(e.employee_code);
      return !r || r.status === 'work';
    }).length;

    var card = document.createElement('div');
    card.className = 'dept-card';

    var rowsHtml = emps.map(function (e) { return renderEmployeeRow(e, stats); }).join('');
    var listClass = 'dept-employees' + (emps.length > 6 ? ' dept-employees-2col' : '');

    card.innerHTML =
      '<div class="dept-card-header">' +
        '<span class="dept-name">' + escapeHtml(code) + '</span>' +
        '<span class="dept-count">' + working + '/' + emps.length + '</span>' +
      '</div>' +
      '<div class="' + listClass + '">' + rowsHtml + '</div>';

    grid.appendChild(card);
  });
}

function renderEmployeeRow(emp, stats) {
  var record = stats.recordsByCode.get(emp.employee_code);
  // No record submitted for the day = assumed working, same as everywhere else.
  var status = record ? record.status : 'work';
  var meta = STATUS_META[status] || STATUS_META.work;

  return (
    '<div class="emp-row ' + meta.cls + '">' +
      '<span class="emp-shift shift-' + escapeHtml(emp.shift) + '">' + escapeHtml(emp.shift) + '</span>' +
      '<span class="emp-name" title="' + escapeHtml(emp.full_name) + '">' + escapeHtml(emp.full_name) + '</span>' +
      '<span class="emp-status ' + meta.cls + '" title="' + escapeHtml(meta.label) + '">' + meta.icon + '</span>' +
    '</div>'
  );
}

/* ------------------------------------------------------------
   SECTION 8: SUBMIT STATUS PAGE
   ------------------------------------------------------------ */

function populateEmployeeSelect() {
  var select = document.getElementById('submit-employee');
  var currentValue = select.value;

  var sorted = state.employees.slice().sort(function (a, b) {
    return a.department_code.localeCompare(b.department_code) || a.full_name.localeCompare(b.full_name, 'th');
  });

  var options = '<option value="">— Select employee —</option>' + sorted.map(function (e) {
    return '<option value="' + escapeHtml(e.employee_code) + '">' +
      escapeHtml(e.employee_code) + ' — ' + escapeHtml(e.full_name) + ' (' + escapeHtml(e.department_code) + ')' +
      '</option>';
  }).join('');

  select.innerHTML = options;
  select.value = currentValue;
}

function prepareSubmitForm() {
  populateEmployeeSelect();
  var dateInput = document.getElementById('submit-date');
  dateInput.value = state.selectedDate || todayISO();
  resetSubmitFormFields();
  renderAttendanceTable();
}

function resetSubmitFormFields() {
  state.editingEntryId = null;
  document.getElementById('submit-employee').value = '';
  document.getElementById('submit-employee').disabled = false;
  updateEmployeeInfo(null);
  document.getElementById('submit-note').value = '';
  document.getElementById('btn-submit-delete').classList.add('is-hidden');
  document.getElementById('submit-save-label').textContent = 'บันทึก';
  clearStatusSelection();
}

function updateEmployeeInfo(emp) {
  document.getElementById('info-code').textContent = emp ? emp.employee_code : '—';
  document.getElementById('info-name').textContent = emp ? emp.full_name : '—';
  document.getElementById('info-dept').textContent = emp ? (emp.department + ' (' + emp.department_code + ')') : '—';
  document.getElementById('info-shift').textContent = emp ? emp.shift : '—';
  document.getElementById('submit-shift').value = emp ? emp.shift : 'A';
}

function clearStatusSelection() {
  state.selectedStatus = null;
  document.querySelectorAll('.status-btn').forEach(function (b) { b.classList.remove('selected'); });
}

// With the records table hidden, selecting an employee + date is the edit path.
// If a record already exists, load it into the same form and reveal Delete.
function loadExistingAttendanceIntoForm() {
  var empCode = document.getElementById('submit-employee').value;
  var date = document.getElementById('submit-date').value;
  var record = state.attendance.find(function (r) {
    return r.employee_code === empCode && r.date === date;
  });

  state.editingEntryId = record ? record.entry_id : null;
  document.getElementById('submit-employee').disabled = false;
  document.getElementById('btn-submit-delete').classList.toggle('is-hidden', !record);
  document.getElementById('submit-save-label').textContent = record ? 'บันทึกการแก้ไข' : 'บันทึก';

  if (!record) {
    document.getElementById('submit-note').value = '';
    clearStatusSelection();
    return;
  }

  document.getElementById('submit-shift').value = record.shift;
  document.getElementById('submit-note').value = record.note || '';
  state.selectedStatus = record.status;
  document.querySelectorAll('.status-btn').forEach(function (b) {
    b.classList.toggle('selected', b.dataset.status === record.status);
  });
}

async function handleSubmitSave() {
  if (state.requestInFlight) return;
  var wasEditing = !!state.editingEntryId;
  var empCode = document.getElementById('submit-employee').value;
  var date = document.getElementById('submit-date').value;
  var shift = document.getElementById('submit-shift').value;
  var note = document.getElementById('submit-note').value.trim();

  if (!empCode) { showToast('กรุณาเลือกพนักงาน', 'error'); return; }
  if (!date) { showToast('กรุณาเลือกวันที่', 'error'); return; }
  if (!state.selectedStatus) { showToast('กรุณาเลือกสถานะ', 'error'); return; }

  var emp = state.employees.find(function (e) { return e.employee_code === empCode; });
  if (!emp) { showToast('ไม่พบข้อมูลพนักงาน', 'error'); return; }

  var record = {
    entry_id: date + '_' + empCode,
    date: date,
    employee_code: empCode,
    full_name: emp.full_name,
    department_code: emp.department_code,
    shift: shift,
    status: state.selectedStatus,
    note: note,
    updated_at: new Date().toISOString(),
    original_entry_id: state.editingEntryId || ''
  };

  state.requestInFlight = true;
  setSyncStatus('syncing');
  try {
    await postToScript('upsertAttendance', record);
    await syncNow({ silent: true });
    resetSubmitFormFields();
    renderAttendanceTable();
    showToast((wasEditing ? 'แก้ไข' : 'บันทึก') + 'สถานะของ ' + emp.full_name + ' เรียบร้อยแล้ว', 'success');
  } catch (err) {
    setSyncStatus('error');
    showToast('บันทึกไม่สำเร็จ ระบบไม่ได้เก็บข้อมูลไว้ในเครื่อง กรุณาลองใหม่', 'error');
  } finally {
    state.requestInFlight = false;
  }
}

function renderAttendanceTable() {
  var date = document.getElementById('submit-date').value || state.selectedDate || todayISO();
  var body = document.getElementById('attendance-table-body');
  var dateLabel = document.getElementById('attendance-list-date');
  if (!body) return;
  dateLabel.textContent = formatDateDisplay(date);
  var rows = state.attendance.filter(function (r) { return r.date === date; }).sort(function (a, b) {
    return String(a.full_name).localeCompare(String(b.full_name), 'th');
  });
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty-table-message">ยังไม่มีรายการในวันนี้</td></tr>';
    return;
  }
  body.innerHTML = rows.map(function (r) {
    var meta = STATUS_META[r.status] || STATUS_META.work;
    return '<tr>' +
      '<td>' + escapeHtml(r.employee_code + ' — ' + r.full_name) + '</td>' +
      '<td>' + escapeHtml(r.shift) + '</td>' +
      '<td>' + meta.icon + ' ' + escapeHtml(meta.label) + '</td>' +
      '<td>' + escapeHtml(r.note || '—') + '</td>' +
      '<td>' + escapeHtml(formatServerDateTime(r.updated_at)) + '</td>' +
      '<td><div class="attendance-actions">' +
        '<button class="btn btn-outline" type="button" data-edit-entry="' + escapeHtml(r.entry_id) + '">แก้ไข</button>' +
        '<button class="btn btn-danger" type="button" data-delete-entry="' + escapeHtml(r.entry_id) + '">ลบ</button>' +
      '</div></td></tr>';
  }).join('');
}

function formatServerDateTime(value) {
  if (!value) return '—';
  var d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleString('th-TH-u-ca-gregory', { dateStyle: 'short', timeStyle: 'short' });
}

function startEditAttendance(entryId) {
  var record = state.attendance.find(function (r) { return r.entry_id === entryId; });
  if (!record) return;
  state.editingEntryId = entryId;
  document.getElementById('submit-employee').value = record.employee_code;
  document.getElementById('submit-employee').disabled = true;
  document.getElementById('submit-date').value = record.date;
  document.getElementById('submit-note').value = record.note || '';
  updateEmployeeInfo(state.employees.find(function (e) { return e.employee_code === record.employee_code; }) || null);
  document.getElementById('submit-shift').value = record.shift;
  state.selectedStatus = record.status;
  document.querySelectorAll('.status-btn').forEach(function (b) { b.classList.toggle('selected', b.dataset.status === record.status); });
  document.getElementById('btn-submit-delete').classList.remove('is-hidden');
  document.getElementById('submit-save-label').textContent = 'บันทึกการแก้ไข';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteAttendance(entryId) {
  var record = state.attendance.find(function (r) { return r.entry_id === entryId; });
  if (!record || state.requestInFlight) return;
  if (!window.confirm('ยืนยันลบรายการของ ' + record.full_name + ' วันที่ ' + record.date + ' ?')) return;
  state.requestInFlight = true;
  setSyncStatus('syncing');
  try {
    await postToScript('deleteAttendance', { entry_id: entryId });
    await syncNow({ silent: true });
    resetSubmitFormFields();
    renderAttendanceTable();
    showToast('ลบรายการเรียบร้อยแล้ว', 'success');
  } catch (err) {
    setSyncStatus('error');
    showToast('ลบรายการไม่สำเร็จ กรุณาลองใหม่', 'error');
  } finally {
    state.requestInFlight = false;
  }
}

/* ------------------------------------------------------------
   SECTION 9: MANAGE EMPLOYEES PAGE
   ------------------------------------------------------------ */

function renderEmployeeTable() {
  var q = (document.getElementById('mgr-search').value || '').trim().toLowerCase();

  var sorted = state.employees.slice().sort(function (a, b) {
    return a.department_code.localeCompare(b.department_code) || a.full_name.localeCompare(b.full_name, 'th');
  });

  var filtered = q ? sorted.filter(function (e) {
    return e.full_name.toLowerCase().indexOf(q) !== -1 || e.employee_code.toLowerCase().indexOf(q) !== -1;
  }) : sorted;

  var tbody = document.getElementById('employee-table-body');
  tbody.innerHTML = filtered.map(function (e) {
    return (
      '<tr>' +
        '<td>' + escapeHtml(e.employee_code) + '</td>' +
        '<td>' + escapeHtml(e.full_name) + '</td>' +
        '<td>' + escapeHtml(e.department) + '</td>' +
        '<td><span class="dept-chip">' + escapeHtml(e.department_code) + '</span></td>' +
        '<td>' + escapeHtml(e.position) + '</td>' +
        '<td><span class="emp-shift shift-' + escapeHtml(e.shift) + '">' + escapeHtml(e.shift) + '</span></td>' +
      '</tr>'
    );
  }).join('');

  document.getElementById('mgr-total-count').textContent = String(state.employees.length);
}

async function handleAddEmployee() {
  if (state.requestInFlight) return;
  var code = document.getElementById('mgr-code').value.trim();
  var name = document.getElementById('mgr-name').value.trim();
  var dept = document.getElementById('mgr-dept').value.trim();
  var deptCode = document.getElementById('mgr-dept-code').value;
  var position = document.getElementById('mgr-position').value.trim() || 'ช่างเทคนิค';
  var shift = document.getElementById('mgr-shift').value;

  if (!code || !name || !dept) {
    showToast('กรุณากรอกรหัสพนักงาน ชื่อ-นามสกุล และแผนกให้ครบ', 'error');
    return;
  }

  var exists = state.employees.some(function (e) { return e.employee_code === code; });
  if (exists) {
    showToast('รหัสพนักงาน "' + code + '" มีอยู่แล้ว', 'error');
    return;
  }

  var record = {
    employee_code: code,
    full_name: name,
    department: dept,
    department_code: deptCode,
    position: position,
    shift: shift
  };

  state.requestInFlight = true;
  setSyncStatus('syncing');
  try {
    await postToScript('upsertEmployee', record);
    await syncNow({ silent: true });
    ['mgr-code', 'mgr-name', 'mgr-dept'].forEach(function (id) { document.getElementById(id).value = ''; });
    document.getElementById('mgr-position').value = 'ช่างเทคนิค';
    document.getElementById('mgr-dept-code').value = 'MVR';
    document.getElementById('mgr-shift').value = 'A';
    showToast('เพิ่มพนักงาน "' + name + '" เรียบร้อยแล้ว', 'success');
  } catch (err) {
    setSyncStatus('error');
    showToast('เพิ่มพนักงานไม่สำเร็จ กรุณาลองใหม่', 'error');
  } finally {
    state.requestInFlight = false;
  }
}

/* ------------------------------------------------------------
   SECTION 10: TOAST / SMALL UTILITIES
   ------------------------------------------------------------ */

function showToast(message, type) {
  var container = document.getElementById('toast-container');
  var toast = document.createElement('div');
  var cls = 'toast';
  var icon = '✅';
  if (type === 'error') { cls += ' toast-error'; icon = '⚠️'; }
  else if (type === 'warning') { cls += ' toast-warning'; icon = '🕓'; }
  toast.className = cls;
  toast.innerHTML = '<span aria-hidden="true">' + icon + '</span><span>' + escapeHtml(message) + '</span>';
  container.appendChild(toast);

  requestAnimationFrame(function () { toast.classList.add('toast-show'); });
  setTimeout(function () {
    toast.classList.remove('toast-show');
    setTimeout(function () { toast.remove(); }, 300);
  }, 3200);
}

function escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str === undefined || str === null ? '' : String(str);
  return div.innerHTML;
}

/* ------------------------------------------------------------
   SECTION 11: EVENT WIRING & INIT
   ------------------------------------------------------------ */

function wireEvents() {
  document.querySelectorAll('.nav-btn[data-page]').forEach(function (btn) {
    btn.addEventListener('click', function () { switchPage(btn.dataset.page); });
  });

  document.getElementById('btn-open-sheet').addEventListener('click', openSheet);
  document.getElementById('nav-open-sheet').addEventListener('click', openSheet);
  document.getElementById('btn-sync-now').addEventListener('click', function () { syncNow(); });
  document.getElementById('btn-submit-future').addEventListener('click', function () { switchPage('submit'); });

  document.getElementById('cal-prev').addEventListener('click', function () {
    state.calendarMonth--;
    if (state.calendarMonth < 0) { state.calendarMonth = 11; state.calendarYear--; }
    renderCalendar();
  });
  document.getElementById('cal-next').addEventListener('click', function () {
    state.calendarMonth++;
    if (state.calendarMonth > 11) { state.calendarMonth = 0; state.calendarYear++; }
    renderCalendar();
  });

  document.getElementById('submit-employee').addEventListener('change', function (e) {
    var emp = state.employees.find(function (x) { return x.employee_code === e.target.value; });
    updateEmployeeInfo(emp || null);
    loadExistingAttendanceIntoForm();
  });

  document.querySelectorAll('.status-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.selectedStatus = btn.dataset.status;
      document.querySelectorAll('.status-btn').forEach(function (b) { b.classList.remove('selected'); });
      btn.classList.add('selected');
    });
  });

  document.getElementById('btn-submit-cancel').addEventListener('click', function () {
    resetSubmitFormFields();
    switchPage('dashboard');
  });
  document.getElementById('btn-submit-save').addEventListener('click', handleSubmitSave);
  document.getElementById('btn-submit-delete').addEventListener('click', function () {
    if (state.editingEntryId) deleteAttendance(state.editingEntryId);
  });
  document.getElementById('submit-date').addEventListener('change', loadExistingAttendanceIntoForm);

  document.getElementById('btn-mgr-add').addEventListener('click', handleAddEmployee);
  document.getElementById('mgr-search').addEventListener('input', renderEmployeeTable);

  window.addEventListener('online', function () {
    state.online = true;
    syncNow({ silent: true });
  });
  window.addEventListener('offline', function () {
    state.online = false;
  });

  // A phone browser is often backgrounded between uses — pull fresh data
  // (and push anything still queued) the moment it's looked at again.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.online) {
      syncNow({ silent: true });
    }
  });
}

var AUTO_SYNC_INTERVAL_MS = 15000; // backend is the source of truth; refresh every 15 seconds
var autoSyncTimer = null;

function startAutoSync() {
  if (autoSyncTimer || !isConfigured()) return;
  autoSyncTimer = setInterval(function () {
    if (state.online) syncNow({ silent: true });
  }, AUTO_SYNC_INTERVAL_MS);
}

function init() {
  state.selectedDate = todayISO();
  clearLegacyLocalData();
  wireEvents();
  renderDashboard();
  renderSyncBadge();

  if (isConfigured()) {
    syncNow();
    startAutoSync();
  } else {
    setSyncStatus('error');
    showToast('ยังไม่ได้ตั้งค่า URL ของระบบหลังบ้าน', 'error');
  }
}

document.addEventListener('DOMContentLoaded', init, { once: true });
