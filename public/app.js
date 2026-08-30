const state = {
  token: localStorage.getItem('meetly_token') || '',
  user: null,
  users: [],
  meetings: [],
  meetingRequests: [],
  notifications: [],
  analytics: null,
  auditLogs: [],
  statusChart: null,
  page: 'dashboard',
  dbStatus: 'offline'
};

const pageTitles = {
  dashboard: ['Workspace overview', 'Good morning'],
  meetings: ['UTC aligned schedule', 'Meetings and attendance'],
  employees: ['People and outcomes', 'Employee performance'],
  audit: ['Traceability', 'Activity audit log']
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function initials(name) {
  return String(name || 'U').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'U';
}

function currentTimezone() {
  return state.user?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function formatDateTime(iso, timezone = currentTimezone(), options = {}) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    dateStyle: options.dateStyle || 'medium',
    timeStyle: options.timeStyle || 'short'
  }).format(date);
}

function formatUtc(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short'
  }).format(date) + ' UTC';
}

function formatRelative(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(Math.abs(diff) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ${diff >= 0 ? 'ago' : 'from now'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ${diff >= 0 ? 'ago' : 'from now'}`;
  return formatDateTime(iso, currentTimezone(), { dateStyle: 'medium', timeStyle: 'short' });
}

function getApiUrl(path) {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  if (window.location.protocol === 'file:' || ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.port !== '3000' && window.location.port !== '')) {
    return `http://localhost:3000${path}`;
  }
  return path;
}

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const targetUrl = getApiUrl(path);
  let response;
  try {
    response = await fetch(targetUrl, { ...options, headers });
  } catch (err) {
    throw new Error('Cannot connect to backend server. Please ensure Node server is running (npm start / node server.js).');
  }
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(data?.message || `Request failed with status ${response.status}.`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function showToast(message, type = 'info') {
  const container = $('#toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type === 'success' ? 'success' : type === 'error' ? 'error' : ''}`;
  toast.innerHTML = `<span class="mt-0.5 text-base">${type === 'success' ? '✓' : type === 'error' ? '!' : 'i'}</span><span class="flex-1">${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
}

function setFormMessage(selector, message, success = false) {
  const element = $(selector);
  if (!element) return;
  element.textContent = message || '';
  element.classList.toggle('success', Boolean(success));
}

function availableTimezones() {
  const common = ['UTC', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney'];
  let all = [];
  try { all = Intl.supportedValuesOf('timeZone'); } catch (_) { all = []; }
  return [...new Set([...common, ...all])].sort((a, b) => a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b));
}

function populateTimezoneSelects(preferred = null) {
  const timezone = preferred || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const options = availableTimezones().map((zone) => `<option value="${escapeHtml(zone)}">${escapeHtml(zone)}</option>`).join('');
  $$('.timezone-select').forEach((select) => {
    const previous = select.value;
    select.innerHTML = options;
    select.value = [previous, timezone, 'UTC'].find((value) => value && [...select.options].some((option) => option.value === value)) || 'UTC';
  });
}

function setTheme(dark) {
  document.documentElement.classList.toggle('dark', dark);
  localStorage.setItem('meetly_theme', dark ? 'dark' : 'light');
  const symbol = dark ? '☀' : '◐';
  ['#theme-toggle', '#auth-theme-toggle'].forEach((id) => { const button = $(id); if (button) button.textContent = symbol; });
  if (state.analytics) renderStatusChart(state.analytics.statusCounts);
}

async function refreshDatabaseStatus() {
  const badge = $('#mongodb-status');
  if (!badge) return;

  try {
    const result = await api('/api/health');
    const connected = result?.database === 'mongodb-atlas';
    badge.classList.toggle('connected', connected);
    badge.classList.toggle('offline', !connected);
    badge.querySelector('.db-status-label').textContent = connected ? 'MongoDB connected' : 'MongoDB offline';
    state.dbStatus = connected ? 'connected' : 'offline';
  } catch (_) {
    badge.classList.remove('connected');
    badge.classList.add('offline');
    badge.querySelector('.db-status-label').textContent = 'MongoDB offline';
    state.dbStatus = 'offline';
  }
}

function initTheme() {
  const saved = localStorage.getItem('meetly_theme');
  setTheme(saved ? saved === 'dark' : window.matchMedia?.('(prefers-color-scheme: dark)').matches);
}

function showAuth() {
  $('#auth-screen').classList.remove('hidden');
  $('#app-screen').classList.add('hidden');
}

function showApp() {
  $('#auth-screen').classList.add('hidden');
  $('#app-screen').classList.remove('hidden');
}

function applyRoleVisibility() {
  const isAdmin = state.user?.role === 'admin';
  $$('.admin-only').forEach((element) => { element.style.display = isAdmin ? '' : 'none'; });
  $$('.employee-only').forEach((element) => { element.style.display = isAdmin ? 'none' : ''; });
  $$('.admin-only-page').forEach((element) => { if (!isAdmin) element.classList.add('hidden'); });
  $('#current-user-name').textContent = state.user?.name || 'User';
  $('#current-user-role').textContent = state.user?.role || 'employee';
  $('#user-avatar').textContent = initials(state.user?.name);
  populateTimezoneSelects(state.user?.timezone);
  if (!isAdmin && ['employees', 'audit'].includes(state.page)) showPage('dashboard');
}

async function loginUser(email, password) {
  const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  state.token = result.token;
  state.user = result.user;
  localStorage.setItem('meetly_token', state.token);
  showApp();
  applyRoleVisibility();
  await loadWorkspace();
  if (state.user.role === 'admin') await refreshAudit();
  showPage('dashboard');
}

async function registerUser(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const result = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(data) });
  state.token = result.token;
  state.user = result.user;
  localStorage.setItem('meetly_token', state.token);
  showApp();
  applyRoleVisibility();
  await loadWorkspace();
  showPage('dashboard');
  showToast('Account created. Welcome to Meetly.', 'success');
}

async function tryRestoreSession() {
  if (!state.token) return showAuth();
  try {
    const result = await api('/api/auth/me');
    state.user = result.user;
    showApp();
    applyRoleVisibility();
    await loadWorkspace();
    showPage('dashboard');
  } catch (_) {
    state.token = '';
    localStorage.removeItem('meetly_token');
    showAuth();
  }
}

async function loadNotifications() {
  if (!state.token) return;
  try {
    const result = await api('/api/notifications');
    state.notifications = result.notifications || [];
    renderNotifications();
  } catch (error) {
    console.error('Failed to load notifications:', error);
  }
}

function renderNotifications() {
  const badge = $('#notification-badge');
  const unreadLabel = $('#notification-unread-count');
  const container = $('#notification-list');
  if (!badge || !container) return;

  const unread = state.notifications.filter((n) => !n.read);
  if (unread.length > 0) {
    badge.textContent = unread.length > 99 ? '99+' : unread.length;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
  if (unreadLabel) unreadLabel.textContent = `${unread.length} unread`;

  if (!state.notifications.length) {
    container.innerHTML = '<div class="empty-state py-6 text-xs text-slate-400">No notifications yet.</div>';
    return;
  }

  const icons = {
    new_meeting: '📅',
    meeting_request: '✉️',
    request_response: '📋',
    absence_reason: '❌'
  };

  container.innerHTML = state.notifications.map((n) => `
    <div class="notif-item ${!n.read ? 'unread' : ''}" data-notif-id="${escapeHtml(n.id)}" data-link-page="${escapeHtml(n.linkPage || 'meetings')}" data-type="${escapeHtml(n.type)}" data-ref-id="${escapeHtml(n.refId || '')}">
      <div class="notif-icon ${escapeHtml(n.type)}">${icons[n.type] || '🔔'}</div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center justify-between gap-1">
          <p class="text-xs font-bold text-slate-800 dark:text-slate-100">${escapeHtml(n.title)}</p>
          <span class="text-[9px] font-semibold text-slate-400">${escapeHtml(formatRelative(n.createdAt))}</span>
        </div>
        <p class="mt-0.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">${escapeHtml(n.message)}</p>
      </div>
    </div>
  `).join('');
}

function handleNotificationClick(notif) {
  if (!notif) return;
  markNotificationRead(notif.id);
  showPage(notif.linkPage || 'meetings');
  $('#notification-popover')?.classList.add('hidden');

  const refId = notif.refId || '';
  const type = notif.type || '';

  setTimeout(() => {
    let targetCard = null;

    if (type === 'meeting_request') {
      if (refId) {
        targetCard = $(`[data-approve-request="${refId}"]`)?.closest('.meeting-card') || $(`[data-request-room="${refId}"]`)?.closest('.meeting-card');
      }
      if (!targetCard) {
        targetCard = $('#pending-requests-list');
      }
    } else if (type === 'request_response') {
      targetCard = $('#my-requests-list');
    } else if (type === 'absence_reason' || type === 'new_meeting') {
      const mId = refId.split(':')[0];
      if (mId) {
        targetCard = $(`[data-meeting-id="${mId}"]`)?.closest('.meeting-card');
      }
      if (!targetCard) {
        targetCard = $('#meetings-list');
      }
    }

    if (targetCard) {
      targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetCard.classList.add('ring-4', 'ring-indigo-500', 'dark:ring-indigo-400', 'transition-all', 'duration-500');
      setTimeout(() => {
        targetCard.classList.remove('ring-4', 'ring-indigo-500', 'dark:ring-indigo-400');
      }, 3000);
    }
  }, 120);
}

async function markNotificationRead(id) {
  try {
    await api(`/api/notifications/${id}/read`, { method: 'PATCH' });
    const item = state.notifications.find((n) => n.id === id);
    if (item) item.read = true;
    renderNotifications();
  } catch (error) {
    console.error(error);
  }
}

async function markAllNotificationsRead() {
  try {
    await api('/api/notifications/read-all', { method: 'PATCH' });
    state.notifications.forEach((n) => { n.read = true; });
    renderNotifications();
    showToast('All notifications marked as read.', 'info');
  } catch (error) {
    console.error(error);
  }
}

async function loadWorkspace() {
  try {
    const [meetingsResult, analyticsResult, usersResult, requestResult, notifResult] = await Promise.all([
      api('/api/meetings'),
      api('/api/analytics'),
      api('/api/users'),
      api('/api/meeting-requests'),
      api('/api/notifications').catch(() => ({ notifications: [] }))
    ]);
    state.meetings = meetingsResult.meetings || [];
    state.analytics = analyticsResult;
    state.users = usersResult.users || [];
    state.meetingRequests = requestResult.meetingRequests || [];
    state.notifications = notifResult.notifications || [];
    const scheduledCount = state.meetings.filter((meeting) => meeting.status === 'scheduled').length;
    const pendingCount = state.user?.role === 'admin' ? state.meetingRequests.filter((r) => r.status === 'pending').length : 0;
    $('#nav-meeting-count').textContent = pendingCount > 0 ? `${scheduledCount} (${pendingCount} req)` : (scheduledCount || '');
    renderAll();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderAll() {
  renderDashboard();
  renderMeetings();
  renderEmployees();
  renderAudit();
  renderMeetingRequests();
  renderNotifications();
  if (state.user?.role === 'admin') {
    participantOptions();
    populateHostSelect();
  }
  requestParticipantOptions();
  updateClock();
}

function showPage(page) {
  if (state.user?.role !== 'admin' && ['employees', 'audit'].includes(page)) page = 'dashboard';
  state.page = page;
  $$('.page-section').forEach((section) => section.classList.toggle('hidden', section.id !== `page-${page}`));
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  const title = pageTitles[page] || pageTitles.dashboard;
  $('#page-kicker').textContent = title[0];
  $('#page-title').textContent = page === 'dashboard' ? `${greeting()}, ${state.user?.name?.split(' ')[0] || 'there'}` : title[1];
  $('#sidebar').classList.remove('open');
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function updateClock() {
  const target = $('#dashboard-clock span:last-child');
  if (!target) return;
  target.textContent = new Intl.DateTimeFormat(undefined, { timeZone: currentTimezone(), dateStyle: 'medium', timeStyle: 'medium' }).format(new Date());
}

function renderDashboard() {
  if (!state.analytics) return;
  const meetings = state.meetings;
  const isAdmin = state.user?.role === 'admin';
  const myId = state.user?.id;
  const visible = meetings;
  const ownParticipants = meetings.flatMap((meeting) => meeting.participants.filter((participant) => participant.user?.id === myId));
  const attending = isAdmin
    ? meetings.reduce((sum, meeting) => sum + meeting.participants.filter((participant) => participant.status === 'attending').length, 0)
    : ownParticipants.filter((participant) => participant.status === 'attending').length;
  const scheduled = meetings.filter((meeting) => meeting.status === 'scheduled').length;
  const ratings = isAdmin ? state.users.filter((user) => user.role === 'employee') : [state.user];
  const averageRating = ratings.length ? ratings.reduce((sum, user) => sum + Number(user.performanceRating || 0), 0) / ratings.length : 0;
  $('#metric-total').textContent = visible.length;
  $('#metric-total-sub').textContent = isAdmin ? 'Across the workspace' : 'Assigned to you';
  $('#metric-attending').textContent = attending;
  $('#metric-attending-sub').textContent = isAdmin ? 'Employee responses' : 'Your confirmed responses';
  $('#metric-scheduled').textContent = scheduled;
  $('#metric-scheduled-sub').textContent = `${meetings.filter((meeting) => meeting.status === 'cancelled').length} cancelled`;
  $('#metric-rating').textContent = averageRating.toFixed(1);
  $('#metric-rating-sub').textContent = isAdmin ? 'Average employee rating' : 'Your current rating';
  renderStatusChart(state.analytics.statusCounts);
  renderAttendanceBars();
  const upcoming = meetings.filter((meeting) => meeting.status === 'scheduled' && new Date(meeting.endAt) >= new Date()).sort((a, b) => new Date(a.startAt) - new Date(b.startAt)).slice(0, 5);
  $('#upcoming-list').innerHTML = upcoming.length ? `<div class="divide-y divide-slate-100 dark:divide-slate-800">${upcoming.map(upcomingRow).join('')}</div>` : '<div class="empty-state">No upcoming meetings. Your calendar is clear.</div>';
}

function requestParticipantOptions() {
  const container = $('#request-participant-list');
  if (!container || state.user?.role === 'admin') return;
  const currentId = String(state.user?.id || '');
  const colleagues = state.users.filter((user) => user.active !== false && String(user.id) !== currentId);
  if (!colleagues.length) {
    container.innerHTML = '<div class="empty-state col-span-full">No other active colleagues found. You will still be included.</div>';
    return;
  }
  container.innerHTML = colleagues.map((user) => `<label class="participant-option"><input type="checkbox" name="requestParticipantIds" value="${escapeHtml(user.id)}" /><span class="participant-avatar">${initials(user.name)}</span><span class="min-w-0"><p class="text-xs font-extrabold text-slate-700 dark:text-slate-200">${escapeHtml(user.name)}</p><p class="mt-0.5 truncate text-[10px] font-semibold text-slate-400">${escapeHtml(user.email)} · ${escapeHtml(user.department || user.role)}</p></span></label>`).join('');
  $$('input[name="requestParticipantIds"]', container).forEach((input) => input.addEventListener('change', () => input.closest('.participant-option').classList.toggle('selected', input.checked)));
}

function renderMeetingRequests() {
  const pendingContainer = $('#pending-requests-list');
  const myContainer = $('#my-requests-list');
  const pending = state.meetingRequests.filter((request) => request.status === 'pending');
  if (pendingContainer && state.user?.role === 'admin') {
    $('#pending-request-count').textContent = `${pending.length} pending`;
    pendingContainer.innerHTML = pending.length ? pending.map(adminRequestCard).join('') : '<div class="empty-state">No pending employee requests. The approval queue is clear.</div>';
  }
  if (myContainer && state.user?.role !== 'admin') {
    myContainer.innerHTML = state.meetingRequests.length ? state.meetingRequests.map(employeeRequestRow).join('') : '<div class="empty-state">You have not submitted a meeting request yet.</div>';
  }
}

function adminRequestCard(request) {
  const requestedLocal = formatDateTime(request.requestedStartAt, currentTimezone(), { dateStyle: 'medium', timeStyle: 'short' });
  const requestedUtc = formatUtc(request.requestedStartAt);
  const participants = (request.participants || []).map((user) => user.name).join(', ');
  return `<article class="meeting-card"><div class="flex flex-col justify-between gap-4 lg:flex-row lg:items-start"><div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2">${statusPill('pending')}<span class="text-[10px] font-bold text-slate-400">Request #${escapeHtml(request.id.slice(0, 8))}</span></div><h3 class="meeting-title mt-2">${escapeHtml(request.title)}</h3><p class="meeting-description mt-1">${escapeHtml(request.agenda || 'No agenda provided.')}</p><div class="mt-3 meeting-meta"><span>Host (Requester): ${escapeHtml(request.requester?.name || 'Employee')}</span><span>◷ ${escapeHtml(requestedLocal)}</span><span>UTC ${escapeHtml(requestedUtc.replace(' UTC', ''))}</span><span>◎ ${escapeHtml(request.timezone)}</span></div><p class="mt-3 text-xs font-semibold text-slate-500 dark:text-slate-400"><b>Participants:</b> ${escapeHtml(participants || 'Requester')}</p>${request.roomPreference ? `<p class="mt-1 text-xs font-semibold text-slate-500 dark:text-slate-400"><b>Room preference:</b> ${escapeHtml(request.roomPreference)}</p>` : ''}</div><div class="w-full lg:max-w-xs"><label class="field-label">Assign meeting room<input class="input" data-request-room="${escapeHtml(request.id)}" value="${escapeHtml(request.roomPreference || '')}" placeholder="Boardroom A / Zoom" /></label><label class="mt-2 flex items-center gap-2 text-[11px] font-bold text-slate-500 dark:text-slate-400"><input type="checkbox" data-request-allow-conflicts="${escapeHtml(request.id)}" class="accent-indigo-600" /> Allow conflict override</label><div class="mt-3 flex flex-wrap gap-2"><button class="primary-button" data-approve-request="${escapeHtml(request.id)}">Approve request</button><button class="attendance-button" data-reject-request="${escapeHtml(request.id)}">Reject</button></div></div></div></article>`;
}

function employeeRequestRow(request) {
  const requestedLocal = formatDateTime(request.requestedStartAt, currentTimezone(), { dateStyle: 'medium', timeStyle: 'short' });
  const room = request.assignedRoom ? `Room: ${request.assignedRoom}` : request.roomPreference ? `Preference: ${request.roomPreference}` : 'Room not assigned yet';
  const outcome = request.status === 'rejected' ? `Reason: ${request.rejectionReason || 'No reason provided.'}` : room;
  return `<div class="meeting-card"><div class="flex flex-col justify-between gap-3 sm:flex-row sm:items-start"><div><div class="flex flex-wrap items-center gap-2">${statusPill(request.status)}<span class="text-[10px] font-bold text-slate-400">Submitted ${escapeHtml(formatRelative(request.createdAt))}</span></div><h3 class="meeting-title mt-2">${escapeHtml(request.title)}</h3><p class="meeting-description mt-1">${escapeHtml(request.agenda || 'No agenda provided.')}</p><p class="mt-2 text-xs font-semibold text-slate-500 dark:text-slate-400">Host: You · Preferred: ${escapeHtml(requestedLocal)} · ${escapeHtml(request.timezone)}</p><p class="mt-1 text-xs font-semibold text-slate-500 dark:text-slate-400">${escapeHtml(outcome)}</p></div>${request.approvedMeetingId ? `<button class="tiny-button" data-page-jump="meetings">View approved meeting →</button>` : ''}</div></div>`;
}

function renderStatusChart(statusCounts) {
  const fallback = $('#status-chart-fallback');
  const canvas = $('#status-chart');
  if (!canvas) return;
  const labels = ['Scheduled', 'Completed', 'Cancelled'];
  const values = [statusCounts?.scheduled || 0, statusCounts?.completed || 0, statusCounts?.cancelled || 0];
  if (window.Chart) {
    fallback.classList.add('hidden');
    canvas.classList.remove('hidden');
    if (state.statusChart) state.statusChart.destroy();
    state.statusChart = new Chart(canvas, {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: ['#5267e7', '#13b89a', '#e46887'], borderWidth: 0, hoverOffset: 5 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '72%',
        plugins: { legend: { position: 'right', labels: { color: document.documentElement.classList.contains('dark') ? '#cbd5e1' : '#64748b', usePointStyle: true, boxWidth: 8, padding: 16, font: { family: 'DM Sans', size: 11, weight: '700' } } } }
      }
    });
  } else {
    canvas.classList.add('hidden');
    fallback.classList.remove('hidden');
    const total = Math.max(1, values.reduce((sum, value) => sum + value, 0));
    fallback.innerHTML = labels.map((label, index) => `<div class="status-fallback-row"><span class="status-fallback-label">${label}</span><span class="status-fallback-track"><span class="status-fallback-fill" style="width:${Math.round(values[index] / total * 100)}%;background:${['#5267e7', '#13b89a', '#e46887'][index]}"></span></span><b class="text-xs text-slate-500 dark:text-slate-300">${values[index]}</b></div>`).join('');
  }
}

function renderAttendanceBars() {
  const container = $('#attendance-bars');
  if (!container || !state.analytics) return;
  let data = state.analytics.attendance || [];
  if (state.user?.role !== 'admin') data = data.filter((item) => item.userId === state.user.id);
  if (!data.length) {
    container.innerHTML = '<div class="empty-state">Attendance metrics will appear after employees are assigned to meetings.</div>';
    return;
  }
  container.innerHTML = data.slice(0, 8).map((item) => {
    const rate = Number(item.attendanceRate || 0);
    const fillClass = rate >= 80 ? 'attendance-fill-high' : rate >= 50 ? 'attendance-fill-med' : 'attendance-fill-low';
    return `<div class="attendance-row"><span class="attendance-name font-bold" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span><span class="attendance-track"><span class="attendance-fill ${fillClass}" style="width:${rate}%"></span></span><span class="attendance-value font-bold">${rate}%</span></div>`;
  }).join('');
}

function upcomingRow(meeting) {
  const start = formatDateTime(meeting.startAt, currentTimezone(), { dateStyle: 'medium', timeStyle: 'short' });
  return `<div class="flex min-w-[500px] items-center justify-between gap-4 py-3"><div class="flex min-w-0 items-center gap-3"><div class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-300">◷</div><div class="min-w-0"><p class="truncate text-sm font-extrabold">${escapeHtml(meeting.title)}</p><p class="mt-1 text-[11px] font-semibold text-slate-400">${escapeHtml(start)} · ${escapeHtml(meeting.timezone)}${meeting.room ? ` · ${escapeHtml(meeting.room)}` : ''}</p></div></div><span class="status-pill status-scheduled">${meeting.participants.length} participant${meeting.participants.length === 1 ? '' : 's'}</span></div>`;
}

function participantOptions() {
  const employees = state.users.filter((user) => user.role === 'employee' && user.active !== false);
  const container = $('#participant-list');
  if (!container) return;
  if (!employees.length) {
    container.innerHTML = '<div class="empty-state col-span-full">No active employees found.</div>';
    return;
  }
  container.innerHTML = employees.map((user) => `<label class="participant-option"><input type="checkbox" name="participantIds" value="${escapeHtml(user.id)}" /><span class="participant-avatar">${initials(user.name)}</span><span class="min-w-0"><p class="text-xs font-extrabold text-slate-700 dark:text-slate-200">${escapeHtml(user.name)}</p><p class="mt-0.5 truncate text-[10px] font-semibold text-slate-400">${escapeHtml(user.email)} · ${escapeHtml(user.timezone)}</p></span></label>`).join('');
  $$('input[name="participantIds"]', container).forEach((input) => input.addEventListener('change', () => input.closest('.participant-option').classList.toggle('selected', input.checked)));
  populateHostSelect();
}

function populateHostSelect() {
  const select = $('#meeting-host-select');
  if (!select) return;
  const activeUsers = state.users.filter((user) => user.active !== false);
  if (!activeUsers.length) {
    select.innerHTML = '<option value="">No active users available</option>';
    return;
  }
  const currentValue = select.value;
  activeUsers.sort((a, b) => {
    if (a.role === b.role) return a.name.localeCompare(b.name);
    return a.role === 'employee' ? -1 : 1;
  });
  select.innerHTML = activeUsers.map((user) => {
    const isCurrent = user.id === state.user?.id;
    const label = `${escapeHtml(user.name)} (${escapeHtml(user.role)}${isCurrent ? ' - You' : ''})`;
    return `<option value="${escapeHtml(user.id)}">${label}</option>`;
  }).join('');
  if (currentValue && activeUsers.some((u) => u.id === currentValue)) {
    select.value = currentValue;
  }
}

function meetingTimeMarkup(meeting) {
  const local = formatDateTime(meeting.startAt, currentTimezone(), { dateStyle: 'medium', timeStyle: 'short' });
  const utc = formatUtc(meeting.startAt);
  return `<div class="meeting-meta"><span>◷ ${escapeHtml(local)}</span><span class="text-slate-400">UTC ${escapeHtml(utc.replace(' UTC', ''))}</span><span>◎ ${escapeHtml(meeting.timezone)}</span>${meeting.room ? `<span>▣ ${escapeHtml(meeting.room)}</span>` : ''}</div>`;
}

function statusPill(status) {
  return `<span class="status-pill status-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function renderMeetings() {
  const container = $('#meetings-list');
  if (!container) return;
  const query = String($('#meeting-search')?.value || $('#global-search')?.value || '').trim().toLowerCase();
  const status = $('#meeting-status-filter')?.value || '';
  const meetings = state.meetings.filter((meeting) => {
    if (status && meeting.status !== status) return false;
    if (!query) return true;
    return `${meeting.title} ${meeting.description} ${meeting.timezone} ${meeting.room || ''} ${meeting.organizer?.name || ''} ${meeting.participants.map((participant) => participant.user?.name || '').join(' ')}`.toLowerCase().includes(query);
  }).sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  if (!meetings.length) {
    container.innerHTML = '<div class="empty-state">No meetings match the current filter.</div>';
    return;
  }
  container.innerHTML = meetings.map(meetingCard).join('');
}

function meetingCard(meeting) {
  const isAdmin = state.user?.role === 'admin';
  const currentParticipant = meeting.participants.find((participant) => participant.user?.id === state.user?.id);
  const responseButtons = !isAdmin && currentParticipant && meeting.status !== 'cancelled'
    ? `<div class="attendance-actions"><span class="mr-1 self-center text-[10px] font-extrabold uppercase tracking-wider text-slate-400">Your response</span><button class="attendance-button ${currentParticipant.status === 'attending' ? 'selected' : ''}" data-meeting-id="${meeting.id}" data-attendance-status="attending">✓ Attending</button><button class="attendance-button ${currentParticipant.status === 'absent' ? 'selected' : ''}" data-meeting-id="${meeting.id}" data-attendance-status="absent">× Absent</button></div>`
    : '';
  const adminStatusActions = isAdmin && meeting.status !== 'cancelled'
    ? `<div class="flex flex-wrap items-center gap-2"><button class="attendance-button" data-meeting-id="${meeting.id}" data-meeting-action="complete">Mark completed + summary</button><button class="attendance-button" data-meeting-id="${meeting.id}" data-meeting-action="cancel">Cancel meeting</button></div>`
    : '';
  return `<article class="meeting-card ${meeting.status === 'cancelled' ? 'cancelled' : ''}">
    <div class="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
      <div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2">${statusPill(meeting.status)}<span class="text-[10px] font-bold text-slate-400">Meeting #${escapeHtml(meeting.id.slice(0, 8))}</span></div><h3 class="meeting-title mt-2">${escapeHtml(meeting.title)}</h3><p class="meeting-description mt-1">${escapeHtml(meeting.description || 'No description added.')}</p>${meeting.summary ? `<p class="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-semibold leading-5 text-emerald-800 dark:bg-emerald-950/25 dark:text-emerald-200"><span class="font-black uppercase tracking-wide">Summary · </span>${escapeHtml(meeting.summary)}</p>` : ''}<div class="mt-3">${meetingTimeMarkup(meeting)}</div></div>
      <div class="flex flex-wrap gap-2 lg:justify-end">${responseButtons || adminStatusActions}</div>
    </div>
    ${meeting.status === 'cancelled' && meeting.cancellationReason ? `<p class="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">${escapeHtml(meeting.cancellationReason)}</p>` : ''}
    <div class="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800"><div class="mb-2 flex items-center justify-between"><p class="text-[10px] font-black uppercase tracking-[.15em] text-slate-400">Participants · ${meeting.participants.length}</p><p class="text-[10px] font-semibold text-slate-400">Host: ${escapeHtml(meeting.organizer?.name || 'Organizer')}</p></div><div class="flex flex-wrap gap-2">${meeting.participants.map((participant) => participantChip(meeting, participant, isAdmin)).join('')}</div></div>
  </article>`;
}

function participantChip(meeting, participant, isAdmin) {
  const user = participant.user || {};
  const reasonText = participant.absenceReason ? `Reason: ${participant.absenceReason}` : '';
  const reasonBadge = participant.absenceReason ? `<span class="block text-[9px] font-semibold text-amber-600 dark:text-amber-400 italic" title="${escapeHtml(participant.absenceReason)}">"${escapeHtml(participant.absenceReason)}"</span>` : '';
  if (isAdmin) {
    return `<div class="participant-chip" title="${escapeHtml(reasonText)}"><div><span>${escapeHtml(user.name || 'Unknown')}</span>${reasonBadge}</div><select class="mini-status rounded border-0 bg-transparent p-0 font-extrabold outline-none" data-meeting-id="${meeting.id}" data-participant-id="${user.id}" aria-label="Update participant status"><option value="pending" ${participant.status === 'pending' ? 'selected' : ''}>Pending</option><option value="attending" ${participant.status === 'attending' ? 'selected' : ''}>Attending</option><option value="absent" ${participant.status === 'absent' ? 'selected' : ''}>Absent</option><option value="busy" ${participant.status === 'busy' ? 'selected' : ''}>Lobby busy</option></select></div>`;
  }
  return `<span class="participant-chip flex-col !items-start" title="${escapeHtml(reasonText)}"><div class="flex items-center gap-1.5"><span>${escapeHtml(user.name || 'Participant')}</span><span class="mini-status status-${escapeHtml(participant.status)}">${escapeHtml(participant.status === 'busy' ? 'lobby busy' : participant.status)}</span></div>${reasonBadge}</span>`;
}

function renderEmployees() {
  const body = $('#employees-table');
  if (!body || state.user?.role !== 'admin') return;
  const query = String($('#employee-search')?.value || '').toLowerCase();
  const employeeStats = new Map((state.analytics?.attendance || []).map((item) => [item.userId, item]));
  const employees = state.users.filter((user) => user.role === 'employee' && `${user.name} ${user.email} ${user.department}`.toLowerCase().includes(query));
  if (!employees.length) {
    body.innerHTML = '<tr><td colspan="7"><div class="empty-state">No employees found.</div></td></tr>';
    return;
  }
  body.innerHTML = employees.map((user) => {
    const stats = employeeStats.get(user.id) || { assigned: 0, attendanceRate: 0 };
    const rate = Number(stats.attendanceRate || 0);
    const badgeClass = rate >= 80 ? 'attendance-badge-high' : rate >= 50 ? 'attendance-badge-med' : 'attendance-badge-low';
    const assignedMeetings = state.meetings.filter((meeting) => meeting.participants.some((participant) => participant.user?.id === user.id));
    const meetingTitles = assignedMeetings.map((meeting) => meeting.title).join(' • ') || 'No meetings assigned';
    return `<tr><td><div class="table-person"><span class="avatar">${initials(user.name)}</span><span><b class="block text-slate-700 dark:text-slate-100">${escapeHtml(user.name)}</b><small class="mt-0.5 block text-[10px] text-slate-400">${escapeHtml(user.email)}</small></span></div></td><td>${escapeHtml(user.department)}</td><td><span class="text-[11px]">${escapeHtml(user.timezone)}</span></td><td><span title="${escapeHtml(meetingTitles)}" class="font-extrabold">${assignedMeetings.length}</span><small class="mt-1 block max-w-[170px] truncate text-[10px] text-slate-400" title="${escapeHtml(meetingTitles)}">${escapeHtml(meetingTitles)}</small></td><td><span class="font-black ${badgeClass}">${rate}%</span></td><td><div class="flex items-center gap-2"><input class="rating-input" type="number" min="0" max="5" step="0.1" value="${Number(user.performanceRating || 0).toFixed(1)}" data-rating-id="${user.id}" aria-label="Performance rating for ${escapeHtml(user.name)}" /><button class="save-rating" data-save-rating="${user.id}">Save</button></div></td></tr>`;
  }).join('');
}

function renderAudit() {
  const body = $('#audit-table');
  if (!body || state.user?.role !== 'admin') return;
  if (!state.auditLogs.length) {
    body.innerHTML = '<tr><td colspan="5"><div class="empty-state">No audit events yet. Actions will appear here.</div></td></tr>';
    return;
  }
  body.innerHTML = state.auditLogs.map((log) => `<tr><td><span class="whitespace-nowrap text-[11px]">${escapeHtml(formatRelative(log.createdAt))}</span><small class="mt-1 block text-[10px] text-slate-400">${escapeHtml(formatDateTime(log.createdAt, 'UTC', { dateStyle: 'medium', timeStyle: 'short' }))} UTC</small></td><td>${escapeHtml(log.actor?.name || 'System')}</td><td><span class="soft-badge">${escapeHtml(log.action.replaceAll('_', ' '))}</span></td><td><span class="font-bold">${escapeHtml(log.entityType)}</span><small class="ml-1 text-[10px] text-slate-400">${escapeHtml(log.entityId.slice(0, 12))}</small></td><td><code class="max-w-[260px] truncate text-[10px] text-slate-400" title="${escapeHtml(JSON.stringify(log.metadata))}">${escapeHtml(JSON.stringify(log.metadata || {}))}</code></td></tr>`).join('');
}

async function refreshAudit() {
  if (state.user?.role !== 'admin') return;
  const result = await api('/api/audit-logs');
  state.auditLogs = result.logs || [];
  renderAudit();
}

function displayConflictError(error) {
  let message = error.message;
  if (error.data?.conflicts?.length) {
    const names = error.data.conflicts.map((item) => `${item.user.name}: ${item.meetings.map((meeting) => meeting.title).join(', ')}`).join(' | ');
    message += ` ${names}`;
  }
  return message;
}

async function submitMeeting(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const selected = $$('input[name="participantIds"]:checked').map((input) => input.value);
  const allEmployees = state.users.filter((user) => user.role === 'employee' && user.active !== false).every((user) => selected.includes(user.id));
  data.participantIds = selected;
  data.allEmployees = allEmployees;
  data.allowConflicts = Boolean(form.querySelector('[name="allowConflicts"]')?.checked);
  data.durationMinutes = Number(data.durationMinutes || 60);
  try {
    const result = await api('/api/meetings', { method: 'POST', body: JSON.stringify(data) });
    form.reset();
    populateTimezoneSelects(state.user.timezone);
    setDefaultMeetingDate();
    participantOptions();
    setFormMessage('#meeting-form-message', 'Meeting scheduled successfully.', true);
    showToast(`“${data.title}” is now on the calendar.`, 'success');
    await loadWorkspace();
  } catch (error) {
    setFormMessage('#meeting-form-message', displayConflictError(error));
    showToast(displayConflictError(error), 'error');
  }
}

async function submitMeetingRequest(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const selected = $$('input[name="requestParticipantIds"]:checked').map((input) => input.value);
  const otherEmployees = state.users.filter((user) => user.active !== false && String(user.id) !== String(state.user?.id));
  data.participantIds = selected;
  data.allEmployees = otherEmployees.length > 0 && otherEmployees.every((user) => selected.includes(user.id));
  data.durationMinutes = Number(data.durationMinutes || 60);
  try {
    await api('/api/meeting-requests', { method: 'POST', body: JSON.stringify(data) });
    form.reset();
    populateTimezoneSelects(state.user.timezone);
    setDefaultRequestDate();
    requestParticipantOptions();
    setFormMessage('#meeting-request-form-message', 'Request submitted. An administrator will review it.', true);
    showToast('Meeting request sent to the admin approval queue.', 'success');
    await loadWorkspace();
  } catch (error) {
    setFormMessage('#meeting-request-form-message', displayConflictError(error));
    showToast(displayConflictError(error), 'error');
  }
}

function setDefaultMeetingDate() {
  const input = $('#meeting-form input[name="startLocal"]');
  if (!input || input.value) return;
  const date = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  input.value = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function setDefaultRequestDate() {
  const input = $('#meeting-request-form input[name="startLocal"]');
  if (!input || input.value) return;
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  input.value = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}`;
}

async function updateAttendance(meetingId, status, userId = state.user.id) {
  let reason = '';
  if (status === 'absent' || status === 'busy') {
    reason = window.prompt('Please provide a reason why you cannot attend (e.g. attending another conflicting meeting):', '');
    if (reason === null) return;
  }
  try {
    const result = await api(`/api/meetings/${meetingId}/participants/${userId}/status`, { method: 'PATCH', body: JSON.stringify({ status, reason: reason || '' }) });
    const index = state.meetings.findIndex((meeting) => meeting.id === meetingId);
    if (index >= 0) state.meetings[index] = result.meeting;
    await reloadAnalyticsAndRender();
    showToast(`Attendance marked ${status}.`, 'success');
  } catch (error) {
    showToast(displayConflictError(error), 'error');
  }
}

async function updateMeetingStatus(meetingId, status) {
  const reason = status === 'cancelled' ? window.prompt('Cancellation reason (optional):', 'Cancelled by administrator') : '';
  if (status === 'cancelled' && reason === null) return;
  const summary = status === 'completed' ? window.prompt('Add the meeting summary or key decisions (optional):', '') : undefined;
  try {
    const result = await api(`/api/meetings/${meetingId}/status`, { method: 'PATCH', body: JSON.stringify({ status, reason, ...(status === 'completed' ? { summary: summary || '' } : {}) }) });
    const index = state.meetings.findIndex((meeting) => meeting.id === meetingId);
    if (index >= 0) state.meetings[index] = result.meeting;
    await reloadAnalyticsAndRender();
    showToast(`Meeting marked ${status}.`, 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function runAutomation() {
  try {
    const result = await api('/api/automation/run', { method: 'POST' });
    showToast(result.message, 'success');
    await loadWorkspace();
    await refreshAudit();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function updateParticipantAdmin(meetingId, userId, status) {
  try {
    await api(`/api/meetings/${meetingId}/participants/${userId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    showToast('Participant status updated.', 'success');
    await loadWorkspace();
    await refreshAudit();
  } catch (error) {
    showToast(displayConflictError(error), 'error');
  }
}

async function approveMeetingRequest(requestId) {
  const input = document.querySelector(`[data-request-room="${CSS.escape(requestId)}"]`);
  const allowConflictsInput = document.querySelector(`[data-request-allow-conflicts="${CSS.escape(requestId)}"]`);
  const room = String(input?.value || '').trim();
  const allowConflicts = Boolean(allowConflictsInput?.checked);
  if (!room) return showToast('Enter a meeting room before approving.', 'error');
  try {
    await api(`/api/meeting-requests/${requestId}/approve`, { method: 'PATCH', body: JSON.stringify({ room, allowConflicts }) });
    showToast('Request approved and meeting created.', 'success');
    await reloadAnalyticsAndRender();
    await refreshAudit();
  } catch (error) {
    showToast(displayConflictError(error), 'error');
  }
}

async function rejectMeetingRequest(requestId) {
  const reason = window.prompt('Why is this request being rejected?', 'Not approved by administrator');
  if (reason === null) return;
  try {
    await api(`/api/meeting-requests/${requestId}/reject`, { method: 'PATCH', body: JSON.stringify({ reason }) });
    showToast('Meeting request rejected.', 'success');
    await reloadAnalyticsAndRender();
    await refreshAudit();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function saveRating(userId) {
  const input = $(`[data-rating-id="${CSS.escape(userId)}"]`);
  const rating = Number(input?.value);
  if (!Number.isFinite(rating) || rating < 0 || rating > 5) return showToast('Rating must be between 0 and 5.', 'error');
  try {
    const result = await api(`/api/users/${userId}`, { method: 'PATCH', body: JSON.stringify({ performanceRating: rating }) });
    const index = state.users.findIndex((user) => user.id === userId);
    if (index >= 0) state.users[index] = result.user;
    await reloadAnalyticsAndRender();
    await refreshAudit();
    showToast('Performance rating saved.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function reloadAnalyticsAndRender() {
  const [meetingsResult, analyticsResult, usersResult, requestResult] = await Promise.all([
    api('/api/meetings'),
    api('/api/analytics'),
    api('/api/users'),
    api('/api/meeting-requests')
  ]);
  state.meetings = meetingsResult.meetings || [];
  state.analytics = analyticsResult;
  state.users = usersResult.users || [];
  state.meetingRequests = requestResult.meetingRequests || [];
  const scheduledCount = state.meetings.filter((meeting) => meeting.status === 'scheduled').length;
  const pendingCount = state.user?.role === 'admin' ? state.meetingRequests.filter((r) => r.status === 'pending').length : 0;
  $('#nav-meeting-count').textContent = pendingCount > 0 ? `${scheduledCount} (${pendingCount} req)` : (scheduledCount || '');
  renderAll();
}

async function downloadEndpoint(endpoint, filename) {
  try {
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${state.token}` } });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.message || 'Download failed.');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showToast('Export downloaded.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function bindEvents() {
  $$('.demo-credential-fill').forEach((button) => button.addEventListener('click', () => {
    const email = button.dataset.email;
    const password = button.dataset.password;
    const emailInput = $('#login-email');
    const passwordInput = $('#login-password');
    if (emailInput) emailInput.value = email;
    if (passwordInput) passwordInput.value = password;
    showToast(`Filled ${email} demo credentials.`, 'info');
  }));

  $$('.auth-tab').forEach((tab) => tab.addEventListener('click', () => {
    const isLogin = tab.dataset.authTab === 'login';
    $$('.auth-tab').forEach((item) => item.classList.toggle('active', item === tab));
    $('#login-panel').classList.toggle('hidden', !isLogin);
    $('#register-panel').classList.toggle('hidden', isLogin);
  }));

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setFormMessage('#login-message', '');
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    try { await loginUser(data.email, data.password); showToast('Signed in successfully.', 'success'); } catch (error) { setFormMessage('#login-message', error.message); }
  });

  $('#register-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setFormMessage('#register-message', '');
    try { await registerUser(event.currentTarget); } catch (error) { setFormMessage('#register-message', error.message); }
  });

  $$('.password-eye').forEach((button) => button.addEventListener('click', () => {
    const input = $(`#${button.dataset.target}`);
    input.type = input.type === 'password' ? 'text' : 'password';
    button.textContent = input.type === 'password' ? '◉' : '○';
  }));

  ['#theme-toggle', '#auth-theme-toggle'].forEach((selector) => $(selector)?.addEventListener('click', () => setTheme(!document.documentElement.classList.contains('dark'))));
  $('#logout-button').addEventListener('click', () => { state.token = ''; state.user = null; localStorage.removeItem('meetly_token'); showAuth(); showToast('You have been signed out.'); });
  $('#sidebar-toggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

  $('#notification-button')?.addEventListener('click', (event) => {
    event.stopPropagation();
    $('#notification-popover')?.classList.toggle('hidden');
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#notification-button') && !event.target.closest('#notification-popover')) {
      $('#notification-popover')?.classList.add('hidden');
    }
  });
  $('#mark-all-read-btn')?.addEventListener('click', markAllNotificationsRead);
  $('#notification-list')?.addEventListener('click', (event) => {
    const item = event.target.closest('[data-notif-id]');
    if (!item) return;
    const id = item.dataset.notifId;
    const notif = state.notifications.find((n) => n.id === id);
    if (notif) {
      handleNotificationClick(notif);
    } else {
      markNotificationRead(id);
      showPage(item.dataset.linkPage || 'meetings');
      $('#notification-popover')?.classList.add('hidden');
    }
  });

  $$('.nav-item').forEach((button) => button.addEventListener('click', () => showPage(button.dataset.page)));
  $$('[data-page-jump]').forEach((button) => button.addEventListener('click', () => showPage(button.dataset.pageJump)));

  $('#global-search').addEventListener('input', (event) => { $('#meeting-search').value = event.target.value; if (event.target.value) showPage('meetings'); renderMeetings(); });
  $('#meeting-search').addEventListener('input', renderMeetings);
  $('#meeting-status-filter').addEventListener('change', renderMeetings);
  $('#employee-search').addEventListener('input', renderEmployees);
  $('#meeting-form').addEventListener('submit', (event) => { event.preventDefault(); submitMeeting(event.currentTarget); });
  $('#meeting-request-form').addEventListener('submit', (event) => { event.preventDefault(); submitMeetingRequest(event.currentTarget); });
  $('#select-everyone').addEventListener('click', () => $$('input[name="participantIds"]').forEach((input) => { input.checked = true; input.closest('.participant-option').classList.add('selected'); }));
  $('#clear-participants').addEventListener('click', () => $$('input[name="participantIds"]').forEach((input) => { input.checked = false; input.closest('.participant-option').classList.remove('selected'); }));
  $('#request-select-everyone').addEventListener('click', () => $$('input[name="requestParticipantIds"]').forEach((input) => { input.checked = true; input.closest('.participant-option').classList.add('selected'); }));
  $('#request-clear-participants').addEventListener('click', () => $$('input[name="requestParticipantIds"]').forEach((input) => { input.checked = false; input.closest('.participant-option').classList.remove('selected'); }));
  $('#export-excel').addEventListener('click', () => downloadEndpoint('/api/export/meetings.xlsx', 'corporate-meetings.xlsx'));
  $('#run-automation').addEventListener('click', runAutomation);

  $('#meetings-list').addEventListener('click', (event) => {
    const response = event.target.closest('[data-attendance-status]');
    if (response) updateAttendance(response.dataset.meetingId, response.dataset.attendanceStatus);
    const action = event.target.closest('[data-meeting-action]');
    if (action) updateMeetingStatus(action.dataset.meetingId, action.dataset.meetingAction === 'complete' ? 'completed' : 'cancelled');
  });
  $('#meetings-list').addEventListener('change', (event) => {
    const select = event.target.closest('[data-participant-id]');
    if (select) updateParticipantAdmin(select.dataset.meetingId, select.dataset.participantId, select.value);
  });
  $('#pending-requests-list').addEventListener('click', (event) => {
    const approve = event.target.closest('[data-approve-request]');
    if (approve) approveMeetingRequest(approve.dataset.approveRequest);
    const reject = event.target.closest('[data-reject-request]');
    if (reject) rejectMeetingRequest(reject.dataset.rejectRequest);
  });
  $('#my-requests-list').addEventListener('click', (event) => {
    const jump = event.target.closest('[data-page-jump]');
    if (jump) showPage(jump.dataset.pageJump);
  });
  $('#employees-table').addEventListener('click', (event) => {
    const button = event.target.closest('[data-save-rating]');
    if (button) saveRating(button.dataset.saveRating);
  });
}

setInterval(updateClock, 1000);
setInterval(refreshDatabaseStatus, 15000);

(async function init() {
  initTheme();
  populateTimezoneSelects();
  bindEvents();
  setDefaultMeetingDate();
  setDefaultRequestDate();
  await refreshDatabaseStatus();
  await tryRestoreSession();
  if (state.user?.role === 'admin') {
    participantOptions();
    try { await refreshAudit(); } catch (_) { /* no-op during first render */ }
  }
})();
