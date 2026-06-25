// ============================================
// 学习时间记录 - 渲染进程
// ============================================

// ---------- 常量 ----------
const TIMER_INTERVALS = {
  todayUpdate: 1000,
  historyRefresh: 2 * 60 * 1000
}
const TWO_HOURS_SECONDS = 2 * 60 * 60
const PROGRESS_RING_CIRCUMFERENCE = 201.06  // 2π × 32

// ---------- 状态 ----------
let currentSessionId = null
let currentSessionStartTime = null
let isPaused = false
let currentSessionPausedAt = null
let currentSessionPausedDuration = 0
let updateTimer = null
let todayTimeUpdateTimer = null
let lastDisplaySeconds = -1
let sessionOpLock = false  // 防止快速双击竞态

// ---------- 时间工具 ----------
function formatDuration(sec) {
  if (typeof sec !== 'number' || isNaN(sec) || sec < 0) return '00:00:00'
  const h = String(Math.floor(sec / 3600)).padStart(2, '0')
  const m = String(Math.floor(sec % 3600 / 60)).padStart(2, '0')
  const s = String(sec % 60).padStart(2, '0')
  return `${h}:${m}:${s}`
}

function formatHoursShort(sec) {
  if (!sec || sec < 0) return '0h'
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return m > 0 ? `${h}h${m}m` : `${h}h`
}

function toChinaTimeString(date = new Date()) {
  const chinaOffset = 8 * 60 * 60 * 1000
  const chinaTime = new Date(date.getTime() + chinaOffset)
  const pad = (n) => String(n).padStart(2, '0')
  return `${chinaTime.getUTCFullYear()}-${pad(chinaTime.getUTCMonth() + 1)}-${pad(chinaTime.getUTCDate())} ` +
         `${pad(chinaTime.getUTCHours())}:${pad(chinaTime.getUTCMinutes())}:${pad(chinaTime.getUTCSeconds())}`
}

function parseChinaTime(timeString) {
  if (!timeString) return new Date()
  // 新格式: "YYYY-MM-DD HH:mm:ss" — 中国时间无时区后缀
  const spaceMatch = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(timeString)
  if (spaceMatch) {
    return new Date(`${spaceMatch[1]}-${spaceMatch[2]}-${spaceMatch[3]}T${spaceMatch[4]}:${spaceMatch[5]}:${spaceMatch[6]}+08:00`)
  }
  if (timeString.includes('+08:00') || timeString.includes('+08')) return new Date(timeString)
  if (timeString.endsWith('Z')) return new Date(timeString.replace('Z', '+08:00'))
  if (timeString.includes('T') && !timeString.includes('+') && !timeString.includes('Z')) {
    return new Date(timeString + '+08:00')
  }
  return new Date(timeString)
}

// ---------- 配置 ----------
async function getTimeRangeConfig() {
  try {
    const cfg = await window.studyRecord.getConfig('stat_time_range')
    return cfg ? JSON.parse(cfg) : { start: '05:00', end: '05:00' }
  } catch (e) {
    return { start: '05:00', end: '05:00' }
  }
}

async function setTimeRangeConfig(rangeObj) {
  try {
    await window.studyRecord.setConfig('stat_time_range', JSON.stringify(rangeObj))
    return true
  } catch (e) { return false }
}

async function getDailyGoalSeconds() {
  try {
    const v = await window.studyRecord.getConfig('daily_goal_seconds')
    return v ? parseInt(v, 10) || TWO_HOURS_SECONDS : TWO_HOURS_SECONDS
  } catch (e) { return TWO_HOURS_SECONDS }
}

function inStatRange(startTime, timeRange, now = new Date()) {
  const [sh, sm] = timeRange.start.split(':').map(Number)
  const [eh, em] = timeRange.end.split(':').map(Number)
  const startMin = sh * 60 + sm
  const endMin = eh * 60 + em
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const crossMidnight = endMin <= startMin

  const startOfDay = new Date(now)
  startOfDay.setHours(sh, sm, 0, 0)
  startOfDay.setMilliseconds(0)

  if (crossMidnight && nowMin < startMin) {
    startOfDay.setDate(startOfDay.getDate() - 1)
  }

  const endOfDay = new Date(startOfDay)
  if (crossMidnight) {
    endOfDay.setDate(endOfDay.getDate() + 1)
  }
  endOfDay.setHours(eh, em, 0, 0)
  endOfDay.setMilliseconds(0)

  return startTime >= startOfDay && startTime < endOfDay
}

function getCurrentSessionElapsedSeconds(now = new Date()) {
  if (!currentSessionStartTime) return 0
  let elapsed = Math.floor((now - currentSessionStartTime) / 1000) - currentSessionPausedDuration
  if (isPaused && currentSessionPausedAt) {
    elapsed -= Math.max(0, Math.floor((now - currentSessionPausedAt) / 1000))
  }
  return Math.max(0, elapsed)
}

// ---------- 今日时长计算 ----------
async function calculateTodaySeconds() {
  const list = await window.studyRecord.getAllSessions()

  // 获取主进程计算的统计边界（保证与托盘、周统计等一致）
  let startBound = null, endBound = null
  try {
    const bounds = await window.studyRecord.statsTodayBoundaries()
    startBound = new Date(bounds.start)
    endBound = new Date(bounds.end)
  } catch (e) { /* 回退到本地逻辑 */ }

  // 回退：使用本地 inStatRange（理论上不会进入这里）
  const fallbackTimeRange = startBound ? null : await getTimeRangeConfig()
  const now = new Date()

  let todaySeconds = 0
  list.forEach((item) => {
    if (!item.end_time) return
    const st = parseChinaTime(item.start_time)

    const inRange = startBound
      ? (st >= startBound && st < endBound)
      : inStatRange(st, fallbackTimeRange, now)

    if (inRange) {
      if (item.duration) {
        todaySeconds += item.duration
      } else {
        const ed = parseChinaTime(item.end_time)
        const dur = Math.floor((ed - st) / 1000)
        if (dur > 0) todaySeconds += dur
      }
    }
  })
  return todaySeconds
}

// ---------- 进度环更新 ----------
function updateProgressRing(currentSec, goalSec) {
  const ring = document.querySelector('.progress-ring-fg')
  const percentEl = document.getElementById('progress-percent')
  const wrapper = document.querySelector('.progress-ring-wrapper')
  if (!ring || !percentEl || !wrapper) return

  const ratio = Math.min(currentSec / goalSec, 1)
  const offset = PROGRESS_RING_CIRCUMFERENCE * (1 - ratio)
  ring.style.strokeDashoffset = offset

  const percent = Math.round(ratio * 100)
  percentEl.textContent = `${percent}%`

  if (ratio >= 1) {
    wrapper.classList.add('complete')
  } else {
    wrapper.classList.remove('complete')
  }
}

// ---------- 显示更新 ----------
async function updateTodayDuration() {
  let todaySeconds = await calculateTodaySeconds()

  if (currentSessionStartTime) {
    todaySeconds += getCurrentSessionElapsedSeconds()
  }

  // 更新数字
  const digitsEl = document.querySelector('#today-duration .digits')
  if (digitsEl) {
    digitsEl.textContent = formatDuration(todaySeconds)
    if (lastDisplaySeconds !== -1 && todaySeconds !== lastDisplaySeconds) {
      digitsEl.classList.remove('tick-bump')
      void digitsEl.offsetWidth
      digitsEl.classList.add('tick-bump')
    }
    lastDisplaySeconds = todaySeconds
  }

    // 更新进度环
  const goal = await getDailyGoalSeconds()
  updateProgressRing(todaySeconds, goal)

  // 更新迷你模式进度条（通过 CSS 变量驱动伪元素）
  const miniBar = document.getElementById('mini-progress-bar')
  const miniPercent = document.getElementById('mini-percent')
  const ratio = Math.min(todaySeconds / goal, 1)
  if (miniBar) {
    miniBar.style.setProperty('--bar-width', `${ratio * 100}%`)
    miniBar.classList.toggle('complete', ratio >= 1)
  }
  if (miniPercent) {
    miniPercent.textContent = `${Math.round(ratio * 100)}%`
    miniPercent.classList.toggle('complete', ratio >= 1)
  }

  // 更新微数据行（不显示百分比，进度环中心已展示）
  const goalInfo = document.getElementById('goal-info')
  if (goalInfo) {
    const goalH = (goal / 3600).toFixed(1).replace(/\.0$/, '')
    const remaining = Math.max(goal - todaySeconds, 0)
    const remStr = remaining >= 3600
      ? `${(remaining / 3600).toFixed(1).replace(/\.0$/, '')}h`
      : `${Math.floor(remaining / 60)}min`
    goalInfo.innerHTML = ratio >= 1
      ? `<span style="color:var(--success);font-weight:700;">🎯 今日目标已达成</span>`
      : `目标 ${goalH}h · 剩余 ${remStr}`
  }

  // 里程碑庆祝
  checkMilestones(todaySeconds)

  // 2小时通知
  await maybeNotifyHourly(todaySeconds)
}

const celebratedMilestones = new Set()
let celebratedMilestonesLoaded = false

function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function loadCelebratedMilestones() {
  if (celebratedMilestonesLoaded) return
  celebratedMilestonesLoaded = true
  try {
    const raw = await window.studyRecord.getConfig('celebrated_milestones_state')
    if (!raw) return
    const state = JSON.parse(raw)
    if (state.date === todayKey() && Array.isArray(state.list)) {
      state.list.forEach(m => celebratedMilestones.add(m))
    }
  } catch (e) {}
}

async function persistCelebratedMilestones() {
  try {
    await window.studyRecord.setConfig(
      'celebrated_milestones_state',
      JSON.stringify({ date: todayKey(), list: [...celebratedMilestones] })
    )
  } catch (e) {}
}

async function checkMilestones(sec) {
  await loadCelebratedMilestones()
  // 1h 仅在 < 2h 时弹；到达 2h 就让位给 maybeNotifyHourly 的提醒，避免同一时段两条
  const milestones = sec >= TWO_HOURS_SECONDS ? [] : [3600]
  let added = false

  // 跨过 2h 时把 1h 标记为已庆祝（吞掉），防止下次掉回 < 2h 区间又冒出来
  if (sec >= TWO_HOURS_SECONDS && !celebratedMilestones.has(3600)) {
    celebratedMilestones.add(3600)
    added = true
  }

  for (const m of milestones) {
    if (sec >= m && !celebratedMilestones.has(m)) {
      celebratedMilestones.add(m)
      added = true
      celebrateMilestone(`${m / 3600}h`)
    }
  }
  if (added) persistCelebratedMilestones()
}

function celebrateMilestone(label) {
  const emojis = ['🎉', '✨', '⭐', '🎊', '💫']
  const center = document.querySelector('.progress-ring-wrapper')
  if (!center) return
  const rect = center.getBoundingClientRect()
  for (let i = 0; i < 8; i++) {
    const el = document.createElement('div')
    el.className = 'celebrate'
    el.textContent = emojis[Math.floor(Math.random() * emojis.length)]
    el.style.left = `${rect.left + rect.width / 2 + (Math.random() - 0.5) * 40}px`
    el.style.top = `${rect.top + rect.height / 2}px`
    document.body.appendChild(el)
    setTimeout(() => el.remove(), 1500)
  }
  showToast(`🎯 已学习 ${label}，继续保持！`, 'success', 3000, false)
}

async function maybeNotifyHourly(todaySeconds) {
  try {
    const count = Math.floor(todaySeconds / TWO_HOURS_SECONDS)
    if (count <= 0) return
    const d = new Date()
    const todayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const raw = await window.studyRecord.getConfig('notified_over_2h_state')
    let state = { date: todayKey, count: 0 }
    if (raw) { try { state = JSON.parse(raw) } catch (e) {} }
    if (state.date !== todayKey) state = { date: todayKey, count: 0 }

    if (count > state.count) {
      showToast(`已学习超 ${count * 2} 小时啦，请休息一会哦~`, 'info', 6000, true)
      state.count = count
      await window.studyRecord.setConfig('notified_over_2h_state', JSON.stringify(state))
    }
  } catch (e) {
    // 静默
  }
}

// ---------- 历史渲染（通用） ----------
function renderHistoryItem(item) {
  const st = parseChinaTime(item.start_time)
  const ed = item.end_time ? parseChinaTime(item.end_time) : null
  const li = document.createElement('li')
  const deleteBtn = item.end_time
    ? `<span class="history-delete" data-delete-id="${item.id}" title="删除">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
          <path d="M10 11v6M14 11v6"></path>
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
        </svg>
      </span>`
    : ''

  let tagsHtml
  if (item.tag_names) {
    const names = item.tag_names.split(',')
    const colors = (item.tag_colors || '').split(',')
    tagsHtml = '<div class="nm-tags" data-tags-trigger>' + names.map((n, i) =>
      `<span class="nm-tag" style="background:${colors[i] || ''}33;color:${colors[i] || ''}">${escapeHtml(n)}</span>`
    ).join('') + '</div>'
  } else if (item.end_time) {
    // 已结束但无标签：显示占位提示可绑定
    tagsHtml = '<div class="nm-tags" data-tags-trigger><span class="nm-tag-add">添加标签</span></div>'
  } else {
    tagsHtml = ''
  }

  // 备注区（仅已结束会话支持）
  let noteHtml = ''
  if (item.end_time) {
    const note = (item.note || '').trim()
    if (note) {
      noteHtml = `<div class="nm-note" data-note-trigger>
        <svg class="nm-note-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
        </svg>
        <span class="nm-note-text">${escapeHtml(note)}</span>
      </div>`
    } else {
      noteHtml = '<div class="nm-note nm-note-empty" data-note-trigger><span class="nm-note-add">添加备注</span></div>'
    }
  }

  const tagIds = item.tag_ids || ''
  const noteAttr = escapeHtml(item.note || '')
  li.innerHTML = `
    <div class="nm-history-card ${item.end_time ? '' : 'ongoing'}" data-session-id="${item.id}" data-tag-ids="${tagIds}" data-note="${noteAttr}">
      <div class="nm-card-left">
        <div class="nm-card-dot"></div>
        <div class="nm-card-line"></div>
      </div>
      <div class="nm-card-body">
        <div class="nm-card-top">
          <div class="nm-card-time">
            <span class="nm-time-start">${formatHistoryTime(st)}</span>
            <span class="nm-time-sep">—</span>
            <span class="nm-time-end">${ed ? formatHistoryTime(ed) : (item.paused_at ? '已暂停' : '进行中…')}</span>
          </div>
          <span class="nm-duration">${item.duration ? formatDuration(item.duration) : (item.end_time ? '00:00:00' : (item.paused_at ? '已暂停' : '计时中'))}</span>
          ${deleteBtn}
        </div>
        ${tagsHtml}
        ${noteHtml}
      </div>
    </div>`
  return li
}

function formatHistoryTime(d) {
  const M = d.getMonth() + 1, D = d.getDate()
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${M}/${D} ${h}:${m}`
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch])
}

// ---------- 历史 + 今日总加载 ----------
async function loadHistoryAndToday() {
  try {
    const list = await window.studyRecord.getAllSessions()
    const historyListEl = document.getElementById('history-list')
    currentSessionId = null
    currentSessionStartTime = null
    currentSessionPausedDuration = 0
    isPaused = false
    currentSessionPausedAt = null
    if (historyListEl) {
      historyListEl.innerHTML = ''
      list.forEach((item) => {
        if (!item.end_time) {
          currentSessionId = item.id
          currentSessionStartTime = parseChinaTime(item.start_time)
          currentSessionPausedDuration = parseInt(item.paused_duration, 10) || 0
          isPaused = !!item.paused_at
          currentSessionPausedAt = item.paused_at ? parseChinaTime(item.paused_at) : null
        }
        historyListEl.appendChild(renderHistoryItem(item))
      })
      attachHistoryDeleteHandlers()
      attachHistoryTagHandlers()
    } else {
      // 至少更新 currentSession 状态
      list.forEach(item => {
        if (!item.end_time) {
          currentSessionId = item.id
          currentSessionStartTime = parseChinaTime(item.start_time)
          currentSessionPausedDuration = parseInt(item.paused_duration, 10) || 0
          isPaused = !!item.paused_at
          currentSessionPausedAt = item.paused_at ? parseChinaTime(item.paused_at) : null
        }
      })
    }

    await updateTodayDuration()
    await updateStreakDisplay()

    const startBtn = document.getElementById('start-btn')
    const endBtn = document.getElementById('end-btn')
    if (startBtn) {
      startBtn.disabled = !!currentSessionId
      startBtn.classList.toggle('control-hidden', !!currentSessionId)
    }
    if (endBtn) {
      endBtn.disabled = !currentSessionId
      endBtn.classList.toggle('control-hidden', !currentSessionId)
    }
    updatePauseButtonState()

    // 更新状态点 + body 标记
    const dot = document.getElementById('status-dot')
    if (dot) dot.classList.toggle('active', !!currentSessionId)
    document.body.classList.toggle('session-active', !!currentSessionId)
    document.body.classList.toggle('session-paused', isPaused)
  } catch (e) {
    console.error('加载历史失败:', e)
  }
}

function attachHistoryDeleteHandlers() {
  document.querySelectorAll('[data-delete-id]').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation()
      const id = parseInt(el.getAttribute('data-delete-id'), 10)
      await historyDelete(id)
    })
  })
}

// ---------- 会话↔标签 绑定浮层 ----------
const sessionTagsPopover = (() => {
  let popoverEl = null
  let currentSessionId = null
  let allTags = []
  let selectedIds = new Set()
  let saving = false

  function ensureEl() {
    if (!popoverEl) {
      popoverEl = document.getElementById('session-tags-popover')
      if (!popoverEl) return null
      popoverEl.addEventListener('click', e => e.stopPropagation())
      popoverEl.querySelector('[data-stp-close]').addEventListener('click', close)
      // 外部点击/Esc 关闭
      document.addEventListener('click', e => {
        if (!popoverEl.classList.contains('show')) return
        if (popoverEl.contains(e.target)) return
        if (e.target.closest('[data-tags-trigger]')) return
        close()
      })
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && popoverEl.classList.contains('show')) close()
      })
    }
    return popoverEl
  }

  function position(anchorEl) {
    const r = anchorEl.getBoundingClientRect()
    const pw = popoverEl.offsetWidth
    const ph = popoverEl.offsetHeight
    const vw = window.innerWidth
    let left = r.left
    if (left + pw > vw - 8) left = vw - pw - 8
    if (left < 8) left = 8
    let top = r.bottom + 6
    let flipped = false
    if (top + ph > window.innerHeight - 8) {
      top = r.top - ph - 6
      flipped = true
    }
    popoverEl.style.left = `${left}px`
    popoverEl.style.top = `${top}px`
    popoverEl.classList.toggle('flipped', flipped)
    // 箭头跟随触发器水平位置
    const arrow = popoverEl.querySelector('.stp-arrow')
    if (arrow) {
      const ax = Math.max(10, Math.min(pw - 18, r.left - left + r.width / 2 - 5))
      arrow.style.left = `${ax}px`
    }
  }

  function render() {
    const body = popoverEl.querySelector('#stp-options')
    const empty = popoverEl.querySelector('#stp-empty')
    if (!allTags.length) {
      body.classList.add('hidden')
      empty.classList.remove('hidden')
      return
    }
    body.classList.remove('hidden')
    empty.classList.add('hidden')
    body.innerHTML = allTags.map(t => {
      const selected = selectedIds.has(t.id)
      const inlineStyle = selected
        ? `border-color:${t.color};background:${t.color}22;color:${t.color};`
        : ''
      return `<span class="stp-opt ${selected ? 'selected' : ''}" data-tag-id="${t.id}" style="${inlineStyle}">
        ${t.icon ? `<span class="stp-opt-icon">${t.icon}</span>` : ''}${escapeHtml(t.name)}
      </span>`
    }).join('')
    body.querySelectorAll('.stp-opt').forEach(el => {
      el.addEventListener('click', async () => {
        if (saving) return
        const id = parseInt(el.getAttribute('data-tag-id'), 10)
        if (selectedIds.has(id)) selectedIds.delete(id)
        else selectedIds.add(id)
        render()
        await save()
      })
    })
  }

  async function save() {
    if (currentSessionId == null) return
    saving = true
    try {
      await window.studyRecord.tagAssignToSession({
        sessionId: currentSessionId,
        tagIds: [...selectedIds]
      })
      // 同步更新对应卡片的视觉（避免整列表重渲打断浮层）
      updateCardVisual(currentSessionId)
    } catch (e) {
      showToast('保存失败', 'warning', 2000)
    } finally {
      saving = false
    }
  }

  function updateCardVisual(sessionId) {
    const card = document.querySelector(`.nm-history-card[data-session-id="${sessionId}"]`)
    if (!card) return
    const tagsWrap = card.querySelector('.nm-tags')
    if (!tagsWrap) return
    if (!selectedIds.size) {
      tagsWrap.innerHTML = '<span class="nm-tag-add">添加标签</span>'
    } else {
      tagsWrap.innerHTML = [...selectedIds].map(id => {
        const t = allTags.find(x => x.id === id)
        if (!t) return ''
        return `<span class="nm-tag" style="background:${t.color}33;color:${t.color}">${escapeHtml(t.name)}</span>`
      }).join('')
    }
    card.setAttribute('data-tag-ids', [...selectedIds].join(','))
  }

  async function open(card, triggerEl) {
    const el = ensureEl()
    if (!el) return
    currentSessionId = parseInt(card.getAttribute('data-session-id'), 10)
    const idsAttr = card.getAttribute('data-tag-ids') || ''
    selectedIds = new Set(
      idsAttr.split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n))
    )
    try {
      allTags = await window.studyRecord.tagGetAll()
    } catch (e) {
      allTags = []
    }
    el.classList.remove('hidden')
    render()
    // 强制下一帧加 show，触发 transition；同时此时元素已可见，可以测量尺寸
    requestAnimationFrame(() => {
      el.classList.add('show')
      position(triggerEl)
    })
  }

  function close() {
    if (!popoverEl) return
    popoverEl.classList.remove('show')
    popoverEl.classList.add('hidden')
    currentSessionId = null
  }

  return { open, close }
})()

function attachHistoryTagHandlers() {
  // 事件委托：监听 document，覆盖所有渲染入口（inline 列表 / 模态列表）
  if (attachHistoryTagHandlers._bound) return
  attachHistoryTagHandlers._bound = true
  document.addEventListener('click', e => {
    const trigger = e.target.closest('[data-tags-trigger]')
    if (!trigger) return
    e.stopPropagation()
    const card = trigger.closest('.nm-history-card')
    if (!card) return
    sessionTagsPopover.open(card, trigger)
  })
  // 备注触发委托
  document.addEventListener('click', e => {
    const trigger = e.target.closest('[data-note-trigger]')
    if (!trigger) return
    e.stopPropagation()
    const card = trigger.closest('.nm-history-card')
    if (!card) return
    sessionNotePopover.open(card, trigger)
  })
}

// ---------- 会话备注 浮层 ----------
const NOTE_MAX = 500
const sessionNotePopover = (() => {
  let popoverEl = null
  let currentSessionId = null
  let currentCard = null

  function ensureEl() {
    if (popoverEl) return popoverEl
    popoverEl = document.createElement('div')
    popoverEl.id = 'session-note-popover'
    popoverEl.className = 'hidden'
    popoverEl.setAttribute('role', 'dialog')
    popoverEl.setAttribute('aria-label', '会话备注')
    popoverEl.innerHTML = `
      <div class="snp-arrow"></div>
      <div class="snp-header">
        <span class="snp-title">备注</span>
        <span class="snp-counter" id="snp-counter">0 / ${NOTE_MAX}</span>
      </div>
      <textarea id="snp-textarea" class="snp-textarea" rows="2"
        maxlength="${NOTE_MAX}" placeholder="记一句话…例如完成了什么、卡在哪里"></textarea>
      <div class="snp-footer">
        <button class="snp-btn snp-cancel" data-snp-cancel>取消</button>
        <button class="snp-btn snp-save" data-snp-save>保存</button>
      </div>
    `
    document.body.appendChild(popoverEl)

    const ta = popoverEl.querySelector('#snp-textarea')
    const counter = popoverEl.querySelector('#snp-counter')
    ta.addEventListener('input', () => {
      counter.textContent = `${ta.value.length} / ${NOTE_MAX}`
    })
    ta.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); close() }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save() }
    })
    popoverEl.querySelector('[data-snp-save]').addEventListener('click', save)
    popoverEl.querySelector('[data-snp-cancel]').addEventListener('click', close)
    popoverEl.addEventListener('click', e => e.stopPropagation())

    document.addEventListener('click', e => {
      if (!popoverEl.classList.contains('show')) return
      if (popoverEl.contains(e.target)) return
      if (e.target.closest('[data-note-trigger]')) return
      close()
    })

    return popoverEl
  }

  function position(anchorEl) {
    const r = anchorEl.getBoundingClientRect()
    const pw = popoverEl.offsetWidth
    const ph = popoverEl.offsetHeight
    const vw = window.innerWidth
    let left = r.left
    if (left + pw > vw - 8) left = vw - pw - 8
    if (left < 8) left = 8
    let top = r.bottom + 6
    let flipped = false
    if (top + ph > window.innerHeight - 8) {
      top = r.top - ph - 6
      flipped = true
    }
    popoverEl.style.left = `${left}px`
    popoverEl.style.top = `${top}px`
    popoverEl.classList.toggle('flipped', flipped)
    const arrow = popoverEl.querySelector('.snp-arrow')
    if (arrow) {
      const ax = Math.max(10, Math.min(pw - 18, r.left - left + r.width / 2 - 5))
      arrow.style.left = `${ax}px`
    }
  }

  async function save() {
    if (currentSessionId == null) return
    const ta = popoverEl.querySelector('#snp-textarea')
    const text = ta.value
    try {
      const res = await window.studyRecord.updateSessionNote({
        id: currentSessionId, note: text
      })
      if (res && res.success !== false) {
        updateCardVisual(text)
        close()
      } else {
        showToast('保存失败', 'warning', 2000)
      }
    } catch (e) {
      showToast('保存失败', 'warning', 2000)
    }
  }

  function updateCardVisual(text) {
    if (!currentCard) return
    const noteEl = currentCard.querySelector('.nm-note')
    if (!noteEl) return
    currentCard.setAttribute('data-note', text || '')
    const trimmed = (text || '').trim()
    if (trimmed) {
      noteEl.classList.remove('nm-note-empty')
      noteEl.innerHTML = `
        <svg class="nm-note-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
        </svg>
        <span class="nm-note-text">${escapeHtml(trimmed)}</span>`
    } else {
      noteEl.classList.add('nm-note-empty')
      noteEl.innerHTML = '<span class="nm-note-add">添加备注</span>'
    }
  }

  function open(card, triggerEl) {
    const el = ensureEl()
    currentSessionId = parseInt(card.getAttribute('data-session-id'), 10)
    currentCard = card
    const note = card.getAttribute('data-note') || ''
    const ta = el.querySelector('#snp-textarea')
    ta.value = note
    el.querySelector('#snp-counter').textContent = `${note.length} / ${NOTE_MAX}`
    el.classList.remove('hidden')
    requestAnimationFrame(() => {
      el.classList.add('show')
      position(triggerEl)
      ta.focus()
      ta.setSelectionRange(ta.value.length, ta.value.length)
    })
  }

  function close() {
    if (!popoverEl) return
    popoverEl.classList.remove('show')
    popoverEl.classList.add('hidden')
    currentSessionId = null
    currentCard = null
  }

  return { open, close }
})()

async function historyDelete(id) {
  const confirmed = await showConfirm({
    title: '删除学习记录',
    text: `确认删除学习记录 #${id} 吗？删除后无法恢复。`,
    okText: '删除',
    type: 'danger'
  })
  if (!confirmed) return
  try {
    const result = await window.studyRecord.deleteSession({ id })
    if (result.success) {
      showToast(`记录 #${id} 已删除`, 'success', 2000)
      await loadHistoryAndToday()
    } else {
      showToast('删除失败', 'warning', 2500)
    }
  } catch (e) {
    showToast('删除出错', 'warning', 2500)
  }
}

// ---------- 连续打卡 ----------
async function updateStreakDisplay() {
  try {
    const v = await window.studyRecord.getConfig('current_streak')
    const streak = v ? parseInt(v, 10) || 0 : 0
    const textEl = document.getElementById('streak-text')
    const badge = document.getElementById('streak-badge')
    if (textEl) textEl.textContent = String(streak)
    if (badge) badge.style.display = streak > 0 ? 'inline-flex' : 'none'
  } catch (e) { /* ignore */ }
}

// ---------- Session 操作 ----------
function updatePauseButtonState() {
  const pauseBtn = document.getElementById('pause-btn')
  if (!pauseBtn) return
  const label = pauseBtn.querySelector('span')
  const pauseIcon = pauseBtn.querySelector('.pause-icon')
  const resumeIcon = pauseBtn.querySelector('.resume-icon')
  pauseBtn.disabled = !currentSessionId || sessionOpLock
  pauseBtn.classList.toggle('is-paused', isPaused)
  pauseBtn.classList.toggle('control-hidden', !currentSessionId)
  if (label) label.textContent = isPaused ? '继续' : '暂停'
  if (pauseIcon) pauseIcon.classList.toggle('hidden', isPaused)
  if (resumeIcon) resumeIcon.classList.toggle('hidden', !isPaused)
  pauseBtn.title = isPaused ? '继续当前记录（Ctrl+Alt+P）' : '暂停当前记录（Ctrl+Alt+P）'
  document.body.classList.toggle('session-paused', isPaused)
}

async function startSession() {
  if (sessionOpLock) return
  sessionOpLock = true
  try {
    const now = new Date()
    const id = await window.studyRecord.startSession(toChinaTimeString(now))
    currentSessionId = id
    currentSessionStartTime = now
    currentSessionPausedDuration = 0
    isPaused = false
    currentSessionPausedAt = null
    updatePauseButtonState()
    celebratedMilestones.clear()  // 新 session 重置里程碑

    await loadHistoryAndToday()

    if (todayTimeUpdateTimer) clearInterval(todayTimeUpdateTimer)
    todayTimeUpdateTimer = setInterval(updateTodayDuration, TIMER_INTERVALS.todayUpdate)

    if (updateTimer) clearInterval(updateTimer)
    updateTimer = setInterval(loadHistoryAndToday, TIMER_INTERVALS.historyRefresh)

    showToast('▶ 已开始记录', 'success', 2200, true)
  } catch (e) {
    console.error('[startSession] 失败:', e)
    console.error('[startSession] stack:', e && e.stack)
    showToast('开始失败: ' + (e && e.message ? e.message : e), 'warning', 4000)
  } finally {
    sessionOpLock = false
    updatePauseButtonState()
  }
}

async function pauseSession() {
  if (sessionOpLock || !currentSessionId || isPaused) return
  sessionOpLock = true
  updatePauseButtonState()
  try {
    const now = new Date()
    const pausedAt = toChinaTimeString(now)
    await window.studyRecord.pauseSession({ id: currentSessionId, pausedAt })
    isPaused = true
    currentSessionPausedAt = now
    updatePauseButtonState()
    await updateTodayDuration()
    showToast('已暂停记录', 'info', 1600)
  } catch (e) {
    showToast('暂停失败: ' + (e && e.message ? e.message : e), 'warning', 3000)
  } finally {
    sessionOpLock = false
    updatePauseButtonState()
  }
}

async function resumeSession() {
  if (sessionOpLock || !currentSessionId || !isPaused) return
  sessionOpLock = true
  updatePauseButtonState()
  try {
    const now = new Date()
    const result = await window.studyRecord.resumeSession({
      id: currentSessionId,
      resumedAt: toChinaTimeString(now)
    })
    currentSessionPausedDuration = result && typeof result.pausedDuration === 'number'
      ? result.pausedDuration
      : currentSessionPausedDuration + Math.max(0, Math.floor((now - currentSessionPausedAt) / 1000))
    isPaused = false
    currentSessionPausedAt = null
    updatePauseButtonState()
    await updateTodayDuration()
    showToast('已继续记录', 'success', 1600)
  } catch (e) {
    showToast('继续失败: ' + (e && e.message ? e.message : e), 'warning', 3000)
  } finally {
    sessionOpLock = false
    updatePauseButtonState()
  }
}

function togglePauseSession() {
  if (isPaused) resumeSession()
  else pauseSession()
}

async function endSession() {
  if (sessionOpLock) return
  if (!currentSessionId) return
  sessionOpLock = true
  try {
    const now = new Date()
    if (todayTimeUpdateTimer) { clearInterval(todayTimeUpdateTimer); todayTimeUpdateTimer = null }
    if (updateTimer) { clearInterval(updateTimer); updateTimer = null }

    const startBtn = document.getElementById('start-btn')
    const endBtn = document.getElementById('end-btn')
    if (endBtn) {
      endBtn.disabled = true
      endBtn.classList.add('control-hidden')
    }
    if (startBtn) {
      startBtn.disabled = false
      startBtn.classList.remove('control-hidden')
    }
    updatePauseButtonState()

    await window.studyRecord.endSession({
      id: currentSessionId,
      endTime: toChinaTimeString(now)
    })

    currentSessionId = null
    currentSessionStartTime = null
    currentSessionPausedDuration = 0
    isPaused = false
    currentSessionPausedAt = null
    updatePauseButtonState()

    await loadHistoryAndToday()
    showToast('⏹ 已结束记录', 'info', 2200, true)
  } catch (e) {
    console.error('[endSession] 失败:', e)
    console.error('[endSession] stack:', e && e.stack)
    showToast('结束失败: ' + (e && e.message ? e.message : e), 'warning', 4000)
  } finally {
    sessionOpLock = false
    updatePauseButtonState()
  }
}

// ---------- Toast 通知 ----------
// useSystemNotify=true 时走系统通知（仅用于"记录相关"事件），其他一律页面内 toast
async function showToast(text, type = 'info', duration = 3000, useSystemNotify = false) {
  if (useSystemNotify && window.studyRecord && window.studyRecord.notify) {
    try {
      await window.studyRecord.notify({
        title: '学习时间记录',
        body: text,
        silent: true
      })
      return
    } catch (e) { /* 回退到页面 toast */ }
  }

  let container = document.getElementById('toast-container')
  if (!container) {
    container = document.createElement('div')
    container.id = 'toast-container'
    document.body.appendChild(container)
  }

  const toast = document.createElement('div')
  toast.className = `toast ${type}`
  const iconSvg = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><line x1="12" y1="11" x2="12" y2="16"></line><circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none"></circle></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"></circle></svg>',
  }
  toast.innerHTML = `<span class="toast-icon">${iconSvg[type] || iconSvg.info}</span><span class="toast-text"></span>`
  toast.querySelector('.toast-text').textContent = text
  container.appendChild(toast)

  void toast.offsetWidth
  toast.classList.add('show')

  setTimeout(() => {
    toast.classList.remove('show')
    setTimeout(() => toast.remove(), 240)
  }, duration)
}

// ---------- 弹窗工具 ----------
let activeModalCount = 0
let confirmResolve = null

function showModal(id) {
  const el = document.getElementById(id)
  if (!el) return
  el.classList.remove('hidden')
  activeModalCount++
  document.body.classList.add('modal-open')
}

function hideModal(id) {
  const el = document.getElementById(id)
  if (!el) return
  el.classList.add('hidden')
  activeModalCount = Math.max(0, activeModalCount - 1)
  if (activeModalCount === 0) {
    document.body.classList.remove('modal-open')
  }
}

// ---------- Markdown 小型渲染器（用于发版说明） ----------
// 支持: # ## ###  -/* 列表  **粗体**  *斜体*  `代码`  [文本](url)  ---  自动换行
// 不支持: 嵌套列表 / 表格 / 引用块 / 围栏代码块（发版说明用不到）
function renderMarkdown(src) {
  if (!src) return ''
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0

  const escape = s => s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch])

  // 行内格式：先转义整段，再按顺序替换不会被嵌套的 token
  // 顺序：code → link → bold → italic（避免误伤）
  function inline(text) {
    let s = escape(text)
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code class="md-code">${c}</code>`)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_, t, u) => `<a class="md-a" href="${u}" target="_blank" rel="noopener">${t}</a>`)
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong class="md-strong">$1</strong>')
    s = s.replace(/\*([^*]+)\*/g, '<em class="md-em">$1</em>')
    return s
  }

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // 空行
    if (!trimmed) { i++; continue }

    // 分割线
    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      out.push('<hr class="md-hr">')
      i++; continue
    }

    // 标题
    const h = /^(#{1,3})\s+(.+)$/.exec(trimmed)
    if (h) {
      const lvl = h[1].length
      out.push(`<div class="md-h${lvl}">${inline(h[2])}</div>`)
      i++; continue
    }

    // 列表：连续的 -/* 行视作一个 ul
    if (/^[-*]\s+/.test(trimmed)) {
      const items = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li class="md-li">${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`)
        i++
      }
      out.push(`<ul class="md-ul">${items.join('')}</ul>`)
      continue
    }

    // 普通段落：连续非空非特殊行合并
    const para = [trimmed]
    i++
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,3})\s+/.test(lines[i].trim()) &&
      !/^[-*]\s+/.test(lines[i].trim()) &&
      !/^---+$/.test(lines[i].trim())
    ) {
      para.push(lines[i].trim())
      i++
    }
    out.push(`<div class="md-p">${inline(para.join(' '))}</div>`)
  }

  return out.join('')
}

// ---------- 更新弹窗（自渲染，替代系统 dialog） ----------
function showUpdateModal({ version, notes }) {
  const tagEl = document.getElementById('update-version-tag')
  const bodyEl = document.getElementById('update-notes')
  if (tagEl) tagEl.textContent = `v${version}`
  if (bodyEl) bodyEl.innerHTML = renderMarkdown(notes)
  showModal('update-modal')
}

function hideUpdateModal() {
  hideModal('update-modal')
}

function initUpdateModal() {
  const laterBtn = document.getElementById('update-later-btn')
  const nowBtn = document.getElementById('update-now-btn')
  if (laterBtn) laterBtn.addEventListener('click', () => {
    hideUpdateModal()
    window.studyRecord.respondUpdatePrompt?.(false)
  })
  if (nowBtn) nowBtn.addEventListener('click', () => {
    hideUpdateModal()
    window.studyRecord.respondUpdatePrompt?.(true)
  })
  // 关闭 / backdrop 点击视作"稍后"
  document.querySelectorAll('#update-modal [data-close]').forEach(el => {
    el.addEventListener('click', () => {
      window.studyRecord.respondUpdatePrompt?.(false)
    })
  })
  // 监听主进程"请求显示弹窗"事件
  if (window.studyRecord.onUpdatePromptRequested) {
    window.studyRecord.onUpdatePromptRequested(({ version, notes }) => {
      showUpdateModal({ version, notes })
    })
  }
}

function showMessage(text) {
  const modal = document.getElementById('message-modal')
  const textEl = document.getElementById('message-text')
  const okBtn = document.getElementById('message-ok')
  const backdrop = document.getElementById('message-backdrop')
  if (!modal || !textEl) return
  textEl.textContent = text
  showModal('message-modal')
  const close = () => hideModal('message-modal')
  okBtn.onclick = close
  backdrop.onclick = close
}

function showConfirm({ title = '确认操作', text = '', okText = '确认', cancelText = '取消', type = 'default' } = {}) {
  const modal = document.getElementById('confirm-modal')
  const titleEl = document.getElementById('confirm-title')
  const textEl = document.getElementById('confirm-text')
  const okBtn = document.getElementById('confirm-ok-btn')
  const cancelBtn = document.getElementById('confirm-cancel-btn')
  const backdrop = document.getElementById('confirm-modal-backdrop')
  if (!(modal && titleEl && textEl && okBtn && cancelBtn && backdrop)) return Promise.resolve(false)

  if (confirmResolve) confirmResolve(false)

  titleEl.textContent = title
  textEl.textContent = text
  okBtn.textContent = okText
  cancelBtn.textContent = cancelText
  okBtn.className = type === 'danger' ? 'danger' : 'primary'

  showModal('confirm-modal')

  return new Promise(resolve => {
    const close = (value) => {
      if (!confirmResolve) return
      const resolver = confirmResolve
      confirmResolve = null
      okBtn.onclick = null
      cancelBtn.onclick = null
      backdrop.onclick = null
      hideModal('confirm-modal')
      resolver(value)
    }

    confirmResolve = resolve
    okBtn.onclick = () => close(true)
    cancelBtn.onclick = () => close(false)
    backdrop.onclick = () => close(false)
  })
}

// ---------- 时间区间弹窗 ----------
async function showTimeRangeModal() {
  const modal = document.getElementById('time-range-modal')
  const startInput = document.getElementById('time-range-start')
  const endInput = document.getElementById('time-range-end')
  const cancelBtn = document.getElementById('time-range-cancel')
  const confirmBtn = document.getElementById('time-range-confirm')
  const backdrop = document.getElementById('time-range-backdrop')
  if (!modal) return

  const cfg = await getTimeRangeConfig()
  startInput.value = cfg.start
  endInput.value = cfg.end
  showModal('time-range-modal')

  const close = () => hideModal('time-range-modal')
  cancelBtn.onclick = close
  backdrop.onclick = close
  document.getElementById('time-range-close').onclick = close
  confirmBtn.onclick = async () => {
    const start = startInput.value
    const end = endInput.value
    if (!start || !end) { showMessage('请填写完整时间区间'); close(); return }
    const ok = await setTimeRangeConfig({ start, end })
    close()
    if (ok) {
      showToast('统计区间已保存', 'success', 2000)
      await loadHistoryAndToday()
    } else {
      showMessage('保存失败')
    }
  }
}

// ---------- 目标设定弹窗 ----------
async function showGoalModal() {
  const modal = document.getElementById('goal-modal')
  const dailyInput = document.getElementById('goal-daily')
  const weeklyInput = document.getElementById('goal-weekly')
  const confirmBtn = document.getElementById('goal-confirm')
  if (!modal) return

  try {
    const dailyV = await window.studyRecord.getConfig('daily_goal_seconds')
    const weeklyV = await window.studyRecord.getConfig('weekly_goal_seconds')
    dailyInput.value = dailyV ? (parseInt(dailyV, 10) / 3600).toFixed(1) : '2'
    weeklyInput.value = weeklyV ? (parseInt(weeklyV, 10) / 3600).toFixed(0) : '10'
  } catch (e) {}

  showModal('goal-modal')

  confirmBtn.onclick = async () => {
    const d = parseFloat(dailyInput.value)
    const w = parseFloat(weeklyInput.value)
    if (isNaN(d) || isNaN(w) || d <= 0 || w <= 0) {
      showMessage('请输入有效的目标')
      return
    }
    try {
      await window.studyRecord.setConfig('daily_goal_seconds', String(Math.round(d * 3600)))
      await window.studyRecord.setConfig('weekly_goal_seconds', String(Math.round(w * 3600)))
      hideModal('goal-modal')
      showToast('🎯 目标已保存', 'success', 2000)
      await updateTodayDuration()
    } catch (e) {
      showMessage('保存失败')
    }
  }
}

// ---------- 统计弹窗 ----------
async function showStatsModal() {
  const modal = document.getElementById('stats-modal')
  if (!modal) return
  showModal('stats-modal')

  // 周柱状图
  try {
    const weekData = await window.studyRecord.statsWeek()
    const chart = document.getElementById('week-chart')
    if (chart) {
      const maxSec = Math.max(...weekData.map(d => d.seconds), 1)
      const MAX_BAR_HEIGHT = 42  // 留出 14px 给底部 label 和 gap
      chart.innerHTML = weekData.map(d => `
        <div class="week-bar">
          <div class="week-bar-value">${d.seconds > 0 ? formatHoursShort(d.seconds) : ''}</div>
          <div class="week-bar-fill" style="height: 0px;"></div>
          <div class="week-bar-label">${d.label}</div>
        </div>`).join('')

      // 动画展开
      requestAnimationFrame(() => {
        chart.querySelectorAll('.week-bar-fill').forEach((el, i) => {
          const ratio = weekData[i].seconds / maxSec
          const h = weekData[i].seconds > 0 ? Math.max(ratio * MAX_BAR_HEIGHT, 3) : 0
          el.style.height = `${h}px`
        })
      })
    }
  } catch (e) { console.error('周数据加载失败', e) }

  // 热力图
  try {
    const heatData = await window.studyRecord.statsHeatmap(35)
    const heat = document.getElementById('heatmap')
    if (heat) {
      const maxSec = Math.max(...heatData.map(d => d.seconds), 1)
      heat.innerHTML = heatData.map(d => {
        const level = d.seconds === 0 ? 0 :
                      d.seconds / maxSec < 0.25 ? 1 :
                      d.seconds / maxSec < 0.5 ? 2 :
                      d.seconds / maxSec < 0.75 ? 3 : 4
        return `<div class="heatmap-cell ${level > 0 ? 'l' + level : ''}" data-tooltip="${d.date}: ${formatHoursShort(d.seconds)}"></div>`
      }).join('')
    }
  } catch (e) { console.error('热力图加载失败', e) }

  // 总览：实时从 study_sessions 表聚合（不再读 user_config 缓存）
  try {
    const ov = await window.studyRecord.statsOverview()
    document.getElementById('ov-total').textContent = formatHoursShort(ov.totalSeconds || 0)
    document.getElementById('ov-sessions').textContent = String(ov.totalSessions || 0)
    document.getElementById('ov-max-streak').textContent = `${ov.maxStreak || 0} 天`
  } catch (e) {
    console.error('总览数据加载失败', e)
  }
}

// ---------- 标签管理弹窗 ----------
async function showTagModal() {
  const modal = document.getElementById('tag-modal')
  if (!modal) return
  showModal('tag-modal')
  await renderTagList()

  // 初始化图标选择器
  initIconPicker()

  const addBtn = document.getElementById('add-tag-btn')
  const nameInput = document.getElementById('new-tag-name')
  addBtn.onclick = async () => {
    const name = nameInput.value.trim()
    const color = document.getElementById('new-tag-color').value
    const icon = document.getElementById('tag-icon-preview').textContent || ''
    if (!name) { showMessage('请输入标签名'); return }
    try {
      await window.studyRecord.tagCreate({ name, color, icon })
      nameInput.value = ''
      await renderTagList()
      showToast('标签已添加', 'success', 1500)
    } catch (e) {
      showMessage('添加失败：可能已存在同名标签')
    }
  }
  nameInput.onkeydown = (e) => {
    if (e.key === 'Enter') addBtn.click()
  }
}

// 图标选择器初始化
function initIconPicker() {
  const trigger = document.getElementById('tag-icon-trigger')
  const panel = document.getElementById('tag-icon-picker')
  const preview = document.getElementById('tag-icon-preview')
  if (!trigger || !panel || !preview) return

  // 关闭面板（点击外部）
  const closeOnOutsideClick = (e) => {
    if (!trigger.contains(e.target) && !panel.contains(e.target)) {
      panel.classList.add('hidden')
      trigger.classList.remove('active')
      document.removeEventListener('click', closeOnOutsideClick)
    }
  }

  trigger.onclick = (e) => {
    e.stopPropagation()
    const willShow = panel.classList.contains('hidden')
    panel.classList.toggle('hidden')
    trigger.classList.toggle('active', willShow)
    if (willShow) {
      setTimeout(() => document.addEventListener('click', closeOnOutsideClick), 0)
    }
  }

  panel.querySelectorAll('.icon-option').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation()
      const icon = btn.getAttribute('data-icon')
      preview.textContent = icon
      panel.classList.add('hidden')
      trigger.classList.remove('active')
      document.removeEventListener('click', closeOnOutsideClick)
    }
  })
}

async function renderTagList() {
  const listEl = document.getElementById('tag-list')
  if (!listEl) return
  try {
    const tags = await window.studyRecord.tagGetAll()
    if (tags.length === 0) {
      listEl.innerHTML = '<div class="tag-empty">暂无标签，添加你的第一个标签吧</div>'
      return
    }
    listEl.innerHTML = tags.map(t => `
      <div class="tag-row" data-tag-id="${t.id}">
        <span class="tag-color-dot" style="background:${t.color}"></span>
        <span class="tag-icon-display">${t.icon || ''}</span>
        <span class="tag-name">${escapeHtml(t.name)}</span>
        <div class="tag-actions">
          <button class="tag-del-btn" data-id="${t.id}">删除</button>
        </div>
      </div>`).join('')
    listEl.querySelectorAll('.tag-del-btn').forEach(btn => {
      btn.onclick = async () => {
        const id = parseInt(btn.getAttribute('data-id'), 10)
        const confirmed = await showConfirm({
          title: '删除标签',
          text: '确认删除该标签吗？相关记录将解除关联。',
          okText: '删除',
          type: 'danger'
        })
        if (!confirmed) return
        try {
          await window.studyRecord.tagDelete({ id })
          await renderTagList()
          showToast('已删除', 'success', 1500)
        } catch (e) { showMessage('删除失败') }
      }
    })
  } catch (e) {
    listEl.innerHTML = '<div class="tag-empty" style="color:var(--danger);">加载失败</div>'
  }
}

// ---------- 徽章弹窗 ----------
async function showBadgeModal() {
  const modal = document.getElementById('badge-modal')
  if (!modal) return
  showModal('badge-modal')
  try {
    const badges = await window.studyRecord.badgeGetAll()
    const grid = document.getElementById('badge-grid')
    if (grid) {
      grid.innerHTML = badges.map(b => `
        <div class="badge-item ${b.earned ? '' : 'locked'}" title="${escapeHtml(b.desc)}">
          <div class="badge-icon">${b.icon}</div>
          <div class="badge-name">${escapeHtml(b.name)}</div>
          <div class="badge-desc">${escapeHtml(b.desc)}</div>
        </div>`).join('')
    }
  } catch (e) {
    showMessage('加载徽章失败')
  }
}

function showBadgeUnlock(badge) {
  const toast = document.getElementById('badge-unlock-toast')
  if (!toast) return
  document.getElementById('unlock-icon').textContent = badge.icon
  document.getElementById('unlock-name').textContent = badge.name
  document.getElementById('unlock-desc').textContent = badge.desc
  toast.classList.remove('hidden')
  void toast.offsetWidth
  toast.classList.add('show')
  setTimeout(() => {
    toast.classList.remove('show')
    setTimeout(() => toast.classList.add('hidden'), 400)
  }, 3500)
}

// ---------- 导出弹窗 ----------
function showExportModal() {
  const modal = document.getElementById('export-modal')
  if (!modal) return
  showModal('export-modal')

  document.getElementById('export-csv').onclick = () => doExport('csv')
  document.getElementById('export-json').onclick = () => doExport('json')
}

async function doExport(format) {
  try {
    const result = await window.studyRecord.exportData(format)
    if (result.canceled) return
    if (result.success) {
      hideModal('export-modal')
      showToast(`✓ 已导出 ${result.count} 条记录`, 'success', 3000)
    } else {
      showMessage('导出失败')
    }
  } catch (e) {
    showMessage('导出出错：' + e.message)
  }
}

// ---------- 寄语管理弹窗 ----------
async function showQuotesModal() {
  const modal = document.getElementById('quotes-modal')
  if (!modal) return
  showModal('quotes-modal')
  await renderQuoteList()

  const addBtn = document.getElementById('add-quote-btn')
  const input = document.getElementById('new-quote-text')
  const counter = document.getElementById('quote-char-counter')

  // 字数计数
  if (input && counter) {
    const updateCounter = () => { counter.textContent = `${input.value.length}/40` }
    input.oninput = updateCounter
    updateCounter()
  }

  addBtn.onclick = async () => {
    const text = input.value.trim()
    if (!text) { showMessage('请输入寄语内容'); return }
    if (text.length > 40) { showMessage('寄语不能超过 40 字'); return }
    try {
      await window.studyRecord.quoteAdd(text)
      input.value = ''
      if (counter) counter.textContent = '0/40'
      await renderQuoteList()
      showToast('已添加', 'success', 1500)
    } catch (e) {
      showMessage('添加失败：可能已存在相同寄语')
    }
  }
  input.onkeydown = (e) => {
    if (e.key === 'Enter') addBtn.click()
  }
}

async function renderQuoteList() {
  const listEl = document.getElementById('quote-list')
  const countEl = document.getElementById('quotes-count')
  if (!listEl) return
  try {
    const quotes = await window.studyRecord.quoteGetAll()
    if (countEl) countEl.textContent = `${quotes?.length || 0} 条`
    if (!quotes || quotes.length === 0) {
      listEl.innerHTML = '<div class="quote-empty">还没有寄语，添加第一句吧</div>'
      return
    }
    listEl.innerHTML = quotes.map(q => `
      <div class="quote-item" data-id="${q.id}">
        <span class="quote-text" title="${escapeHtml(q.content)}">${escapeHtml(q.content)}</span>
        <button class="quote-del-btn" data-id="${q.id}">删除</button>
      </div>`).join('')
    listEl.querySelectorAll('.quote-del-btn').forEach(btn => {
      btn.onclick = async () => {
        const id = parseInt(btn.getAttribute('data-id'), 10)
        const confirmed = await showConfirm({
          title: '删除寄语',
          text: '确认删除该寄语吗？删除后无法恢复。',
          okText: '删除',
          type: 'danger'
        })
        if (!confirmed) return
        try {
          await window.studyRecord.quoteDelete({ id })
          await renderQuoteList()
          showToast('已删除', 'success', 1500)
        } catch (e) { showMessage('删除失败') }
      }
    })
  } catch (e) {
    listEl.innerHTML = '<div class="quote-empty" style="color:var(--danger);">加载失败</div>'
  }
}

// ---------- 主题切换 ----------
async function loadTheme() {
  try {
    const theme = await window.studyRecord.getConfig('theme')
    if (theme) document.body.setAttribute('data-theme', theme)
  } catch (e) {}
}

async function toggleTheme() {
  const themes = ['light', 'dark', 'eyecare']
  const cur = document.body.getAttribute('data-theme') || 'light'
  const next = themes[(themes.indexOf(cur) + 1) % themes.length]
  document.body.setAttribute('data-theme', next)
  try {
    await window.studyRecord.setTheme(next)
  } catch (e) {}
}

// ---------- 词条：更新内嵌寄语 ----------
async function getAndSetWord() {
  try {
    const word = await window.studyRecord.getWord()
    const el = document.getElementById('inline-quote')
    if (el && word) {
      el.textContent = word
      el.title = word
    }
  } catch (e) {}
}

// ---------- 右侧菜单 ----------
function initRightMenuEvent() {
  const settingsPanel = document.querySelector('.settings-content')
  const studyPanel = document.querySelector('.study-content')
  const rightMenus = document.querySelector('.right-menus')

  // right-menus 始终隐藏，设置入口移至标题栏
  if (rightMenus) rightMenus.style.display = 'none'

  function toggleSettings(show) {
    if (show) {
      settingsPanel.classList.remove('hidden')
      studyPanel.classList.add('hidden')
    } else {
      settingsPanel.classList.add('hidden')
      studyPanel.classList.remove('hidden')
    }
  }

  // 标题栏设置按钮
  const titlebarSettingsBtn = document.getElementById('settings-toggle-btn')
  if (titlebarSettingsBtn) {
    titlebarSettingsBtn.addEventListener('click', () => {
      const settingsOpen = !settingsPanel.classList.contains('hidden')
      // 关掉所有打开的 modal（设置子页面：时间区间/目标/统计/标签/导出/寄语/历史/更新/消息）
      const openModals = document.querySelectorAll('.modal-root:not(.hidden)')
      const hasOpenModal = openModals.length > 0
      if (hasOpenModal) {
        openModals.forEach(m => hideModal(m.id))
      }
      // 任意"非主页"状态（设置面板开 或 有 modal 开）→ 回到主页面；
      // 否则才打开设置面板
      if (settingsOpen || hasOpenModal) {
        toggleSettings(false)
      } else {
        toggleSettings(true)
      }
    })
  }

  // 设置面板的关闭按钮
  const closeBtn = document.getElementById('settings-close-btn')
  if (closeBtn) {
    closeBtn.addEventListener('click', () => toggleSettings(false))
  }

  // 寄语按钮：点击刷新内嵌寄语
  const wordIcon = document.getElementById('word-icon')
  if (wordIcon) {
    wordIcon.addEventListener('click', () => {
      getAndSetWord()
      showToast('已刷新寄语', 'info', 1200)
    })
  }
}

// ---------- 历史弹窗 ----------
function initHistoryModal() {
  const fab = document.getElementById('history-fab')
  const modal = document.getElementById('history-modal')
  const backdrop = document.getElementById('history-modal-backdrop')
  const closeBtn = document.getElementById('close-history-btn')
  if (!(fab && modal && backdrop && closeBtn)) return

  fab.addEventListener('click', async () => {
    showModal('history-modal')
    await loadHistoryListForModal()
  })
  const close = () => hideModal('history-modal')
  closeBtn.addEventListener('click', close)
  backdrop.addEventListener('click', close)
}

async function loadHistoryListForModal() {
  try {
    const list = await window.studyRecord.getAllSessions()
    const historyListEl = document.getElementById('history-list')
    if (!historyListEl) return
    historyListEl.innerHTML = ''
    list.forEach((item) => {
      historyListEl.appendChild(renderHistoryItem(item))
    })
    attachHistoryDeleteHandlers()
  } catch (e) {
    console.error('加载历史列表失败', e)
  }
}

// ---------- 通用关闭按钮（data-close） ----------
function initCloseHandlers() {
  document.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      hideModal(el.getAttribute('data-close'))
    })
  })
}

// ---------- 全局快捷键事件 ----------
function bindGlobalShortcuts() {
  window.studyRecord.onGlobalShortcut(async (action) => {
    if (action === 'start') {
      const btn = document.getElementById('start-btn')
      if (btn && !btn.disabled) startSession()
    } else if (action === 'end') {
      const btn = document.getElementById('end-btn')
      if (btn && !btn.disabled) endSession()
    } else if (action === 'togglePause') {
      const btn = document.getElementById('pause-btn')
      if (btn && !btn.disabled) togglePauseSession()
    } else if (action === 'end-and-quit') {
      // 安全退出：先结束 session 再确认
      if (currentSessionId) {
        try { await endSession() } catch (e) {}
      }
      window.studyRecord.confirmSessionEndedForQuit()
    } else if (action === 'toggleMiniMode') {
      toggleMiniMode()
    } else if (action === 'toggleTheme') {
      toggleTheme()
    }
  })

  window.studyRecord.onBadgeUnlocked((badges) => {
    if (!badges || !badges.length) return
    // 依次弹出
    badges.forEach((b, i) => {
      setTimeout(() => showBadgeUnlock(b), i * 4000)
    })
  })
}

// ---------- 主题按钮 + 最小化 + 迷你模式 ----------
function initTitlebar() {
  const themeBtn = document.getElementById('theme-toggle-btn')
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme)

  const miniBtn = document.getElementById('mini-toggle-btn')
  if (miniBtn) miniBtn.addEventListener('click', toggleMiniMode)

  const updateBtn = document.getElementById('check-update-btn')
  if (updateBtn) {
    updateBtn.addEventListener('click', async () => {
      if (updateBtn.classList.contains('checking')) return
      // 已发现新版本：直接弹"立即更新"对话框，不重新检查
      if (updateBtn.classList.contains('has-update')) {
        try {
          await window.studyRecord.showUpdatePrompt()
        } catch (e) {
          showToast('打开更新提示失败: ' + e.message, 'warning', 3000)
        }
        return
      }
      // 没有已知更新：正常触发一次检查
      updateBtn.classList.add('checking')
      try {
        const res = await window.studyRecord.checkForUpdates()
        if (res && res.skipped) {
          showToast('首次运行，已跳过', 'info', 2000)
          updateBtn.classList.remove('checking')
        } else if (res && !res.ok) {
          showToast('检查失败: ' + res.error, 'warning', 3000)
          updateBtn.classList.remove('checking')
        }
        // 成功路径下由 onUpdaterStatus 回调收尾（available / not-available / error）
      } catch (e) {
        showToast('检查失败: ' + e.message, 'warning', 3000)
        updateBtn.classList.remove('checking')
      }
    })
  }

  if (window.studyRecord.onUpdaterStatus) {
    window.studyRecord.onUpdaterStatus(({ state, manual, version, message }) => {
      // 任何渠道发现新版本（自动 / 手动）都点亮按钮
      if (state === 'available' && updateBtn) {
        updateBtn.classList.add('has-update')
        updateBtn.title = `发现新版本 ${version || ''}，点击查看`
      }
      if (!manual) return  // 自动检查全部静默 toast，按钮高亮已经够强
      if (state === 'not-available') {
        showToast('已是最新版本', 'success', 2000)
      } else if (state === 'available') {
        // 手动检查时按钮也会变高亮，无需 toast 提示重复打扰
      } else if (state === 'error') {
        // 常见错误：发布源还没有版本文件（latest.yml 404 / ENOENT）
        const m = String(message || '')
        const friendly = /404|ENOENT|not found|HttpError: 404/i.test(m)
          ? '暂无可用更新源'
          : '检查失败，请稍后再试'
        showToast(friendly, 'warning', 2500)
      }
      if (state !== 'checking' && updateBtn) {
        updateBtn.classList.remove('checking')
      }
    })
  }

  const minBtn = document.getElementById('minimize-btn')
  if (minBtn) minBtn.addEventListener('click', async () => {
    try { await window.studyRecord.minimizeWindow() } catch (e) {}
  })

  const closeBtn = document.getElementById('close-btn')
  if (closeBtn) closeBtn.addEventListener('click', async () => {
    try { await window.studyRecord.closeWindow() } catch (e) {}
  })

  // 监听主进程模式变化通知
  if (window.studyRecord.onMiniModeChanged) {
    window.studyRecord.onMiniModeChanged((isMini) => {
      document.body.classList.toggle('mini-mode', !!isMini)
    })
  }
}

async function toggleMiniMode() {
  try {
    const current = await window.studyRecord.getMiniMode()
    const next = !current
    if (next) {
      const settingsPanel = document.querySelector('.settings-content')
      const studyPanel = document.querySelector('.study-content')
      if (settingsPanel) settingsPanel.classList.add('hidden')
      if (studyPanel) studyPanel.classList.remove('hidden')
    }
    await window.studyRecord.setMiniMode(next)
    document.body.classList.toggle('mini-mode', next)
  } catch (e) {
    console.error('切换迷你模式失败', e)
  }
}

// ---------- 主按钮绑定 ----------
function bindMainButtons() {
  document.getElementById('start-btn').addEventListener('click', startSession)
  document.getElementById('end-btn').addEventListener('click', endSession)
  const pauseBtn = document.getElementById('pause-btn')
  if (pauseBtn) pauseBtn.addEventListener('click', togglePauseSession)
  document.getElementById('set-time-range').addEventListener('click', showTimeRangeModal)

  const setGoalBtn = document.getElementById('set-goal')
  if (setGoalBtn) setGoalBtn.addEventListener('click', showGoalModal)

  const statsBtn = document.getElementById('open-stats')
  if (statsBtn) statsBtn.addEventListener('click', showStatsModal)

  const tagsBtn = document.getElementById('open-tags')
  if (tagsBtn) tagsBtn.addEventListener('click', showTagModal)

  const badgesBtn = document.getElementById('open-badges')
  if (badgesBtn) badgesBtn.addEventListener('click', showBadgeModal)

  const exportBtn = document.getElementById('open-export')
  if (exportBtn) exportBtn.addEventListener('click', showExportModal)

  const quotesBtn = document.getElementById('open-quotes')
  if (quotesBtn) quotesBtn.addEventListener('click', showQuotesModal)
}

// ---------- 卸载清理 ----------
window.addEventListener('beforeunload', () => {
  if (todayTimeUpdateTimer) clearInterval(todayTimeUpdateTimer)
  if (updateTimer) clearInterval(updateTimer)
})

// ---------- DOMContentLoaded ----------
window.addEventListener('DOMContentLoaded', async () => {
  await loadTheme()
  initTitlebar()
  bindMainButtons()
  initRightMenuEvent()
  initHistoryModal()
  initUpdateModal()
  initCloseHandlers()
  bindGlobalShortcuts()
  attachHistoryTagHandlers()

  // 注入版本号到标题栏
  try {
    const v = await window.studyRecord.getAppVersion()
    const versionEl = document.getElementById('brand-version')
    if (versionEl && v) versionEl.textContent = `v${v}`
  } catch (e) {}

  // 加载初始数据
  await loadHistoryAndToday()
  getAndSetWord()

  // 点击内嵌寄语即可换一条
  const quoteEl = document.getElementById('inline-quote')
  if (quoteEl) {
    quoteEl.addEventListener('click', () => {
      getAndSetWord()
      showToast('已刷新寄语', 'info', 1000)
    })
  }

  // 如果有正在进行的 session，恢复定时器
  if (currentSessionId && currentSessionStartTime) {
    if (todayTimeUpdateTimer) clearInterval(todayTimeUpdateTimer)
    todayTimeUpdateTimer = setInterval(updateTodayDuration, TIMER_INTERVALS.todayUpdate)
    if (updateTimer) clearInterval(updateTimer)
    updateTimer = setInterval(loadHistoryAndToday, TIMER_INTERVALS.historyRefresh)
  }
})

// 暴露给可能的 inline 调用（兼容）
window.historyDelete = historyDelete
