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
const PET_STATES = {
  IDLE: 'idle',
  STUDYING: 'studying',
  PAUSED: 'paused',
  CELEBRATE: 'celebrate',
  TIRED: 'tired',
  LEVEL_UP: 'levelup'
}
const PET_META = {
  cat: {
    id: 'cat',
    name: '学霸猫',
    accent: 'var(--accent)',
    unlockHint: '默认伙伴，陪你从第一分钟开始。',
    stageNames: ['初生奶猫', '机敏花猫', '博学虎斑', '玄学神猫']
  },
  dog: {
    id: 'dog',
    name: '努力汪',
    accent: 'var(--success)',
    unlockHint: '累计学习 10 小时，或连续学习 7 天。',
    stageNames: ['好奇幼犬', '勤奋牧犬', '机警柴犬', '智勇双全']
  },
  owl: {
    id: 'owl',
    name: '智慧鸮',
    accent: 'var(--warning)',
    unlockHint: '获得 5 个徽章，或累计学习 50 小时。',
    stageNames: ['毛茸幼鸮', '夜读雏鸮', '深思学者', '通晓贤者']
  }
}

// 进化阶段:Lv 1-9 / 10-29 / 30-49 / 50+
const PET_STAGE_THRESHOLDS = [1, 10, 30, 50]
function getPetStage(level) {
  const lv = Math.max(1, parseInt(level, 10) || 1)
  if (lv >= 50) return 3
  if (lv >= 30) return 2
  if (lv >= 10) return 1
  return 0
}
function getNextStageInfo(level) {
  const stage = getPetStage(level)
  if (stage >= 3) return { nextLevel: null, currentStage: stage }
  return { nextLevel: PET_STAGE_THRESHOLDS[stage + 1], currentStage: stage }
}

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
let updateModalOpen = false
let updateInstalling = false
let updateAccepted = false

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

let petManager = null

function getSessionDurationSeconds(item) {
  const st = parseChinaTime(item.start_time)
  const ed = parseChinaTime(item.end_time)
  if (Number.isNaN(st.getTime()) || Number.isNaN(ed.getTime()) || ed <= st) return 0
  const pausedDuration = Math.max(0, parseInt(item.paused_duration, 10) || 0)
  return Math.max(0, Math.floor((ed - st) / 1000) - pausedDuration)
}

function getSessionSecondsInBounds(item, startBound, endBound) {
  const st = parseChinaTime(item.start_time)
  const ed = parseChinaTime(item.end_time)
  if (Number.isNaN(st.getTime()) || Number.isNaN(ed.getTime()) || ed <= st) return 0

  const overlapStart = st > startBound ? st : startBound
  const overlapEnd = ed < endBound ? ed : endBound
  if (overlapEnd <= overlapStart) return 0

  const rawSeconds = Math.floor((ed - st) / 1000)
  const totalSeconds = getSessionDurationSeconds(item)
  if (rawSeconds <= 0 || totalSeconds <= 0) return 0

  const overlapSeconds = Math.floor((overlapEnd - overlapStart) / 1000)
  if (overlapSeconds >= rawSeconds) return totalSeconds
  return Math.min(totalSeconds, Math.floor(overlapSeconds * totalSeconds / rawSeconds))
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
    if (startBound) {
      todaySeconds += getSessionSecondsInBounds(item, startBound, endBound)
      return
    }

    const st = parseChinaTime(item.start_time)
    if (inStatRange(st, fallbackTimeRange, now)) {
      todaySeconds += getSessionDurationSeconds(item)
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

  if (petManager && currentSessionStartTime && !isPaused) {
    const elapsed = getCurrentSessionElapsedSeconds()
    if (elapsed >= TWO_HOURS_SECONDS) petManager.showTiredWarning()
  }

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
    // 用主进程统计区间的 start 作为 "统计日 key",而非自然日
    // 否则统计区间是 05:00-05:00 时,凌晨 0:00-5:00 学习会被自然日切换误判
    let statKey
    try {
      const bounds = await window.studyRecord.statsTodayBoundaries()
      const start = new Date(bounds.start)
      statKey = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`
    } catch (e) {
      const d = new Date()
      statKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    const raw = await window.studyRecord.getConfig('notified_over_2h_state')
    let state = { date: statKey, count: 0 }
    if (raw) { try { state = JSON.parse(raw) } catch (e) {} }
    if (state.date !== statKey) state = { date: statKey, count: 0 }

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
  const durationText = item.end_time
    ? formatDuration(getSessionDurationSeconds(item))
    : (item.paused_at ? '已暂停' : '计时中')
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
          <span class="nm-duration">${durationText}</span>
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

function renderEmptyState(title = '暂无记录', desc = '', extraClass = '') {
  return `
    <div class="empty-state ${extraClass}">
      <div class="empty-state-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 6h8"></path>
          <path d="M8 10h8"></path>
          <path d="M8 14h5"></path>
          <rect x="5" y="3" width="14" height="18" rx="3"></rect>
        </svg>
      </div>
      <div class="empty-state-title">${escapeHtml(title)}</div>
      ${desc ? `<div class="empty-state-desc">${escapeHtml(desc)}</div>` : ''}
    </div>`
}

function renderErrorState(title = '加载失败', desc = '请稍后重试') {
  return renderEmptyState(title, desc, 'is-error')
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
      if (!list.length) {
        historyListEl.innerHTML = `<li class="history-empty-item">${renderEmptyState('暂无学习记录', '开始一次学习后，这里会显示历史记录。', 'history-empty')}</li>`
      } else {
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
      }
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
    const streak = await window.studyRecord.getCurrentStreak()
    const textEl = document.getElementById('streak-text')
    const badge = document.getElementById('streak-badge')
    if (textEl) textEl.textContent = String(streak || 0)
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

    if (petManager) {
      petManager.tiredWarnShown = false
      await petManager.setState(PET_STATES.STUDYING)
      petManager.playAnimation('excited')
      petManager.startEnergyDrain()
    }

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
    if (petManager) {
      await petManager.setState(PET_STATES.PAUSED)
      petManager.playAnimation('confused')
      petManager.startEnergyRecovery()
    }
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
    if (petManager) {
      await petManager.setState(PET_STATES.STUDYING)
      petManager.playAnimation('excited')
      petManager.startEnergyDrain()
    }
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

    const endedSessionId = currentSessionId
    const endResult = await window.studyRecord.endSession({
      id: endedSessionId,
      endTime: toChinaTimeString(now)
    })
    const sessionSeconds = endResult && typeof endResult.duration === 'number' ? endResult.duration : 0

    if (petManager) {
      petManager.stopAllTimers()
      await petManager.setState(PET_STATES.CELEBRATE)
      const earnedExp = Math.floor(sessionSeconds / 60)
      const didLevelUp = await petManager.addExp(earnedExp, sessionSeconds)
      petManager.playAnimation('celebrate', { exp: earnedExp })
      if (didLevelUp) setTimeout(() => petManager.playAnimation('levelup'), 900)
      await petManager.checkUnlocks(true)
    }

    currentSessionId = null
    currentSessionStartTime = null
    currentSessionPausedDuration = 0
    isPaused = false
    currentSessionPausedAt = null
    updatePauseButtonState()

    await loadHistoryAndToday()
    if (petManager && !currentSessionId) {
      setTimeout(() => {
        if (!currentSessionId) petManager.setState(PET_STATES.IDLE)
      }, 3600)
    }
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

function resetScrollPosition(root) {
  if (!root) return
  const reset = () => {
    root.scrollTop = 0
    root.querySelectorAll('.modal-body, .settings-body, .update-notes, #history-list, [data-reset-scroll]').forEach(el => {
      el.scrollTop = 0
    })
  }
  reset()
  requestAnimationFrame(reset)
  setTimeout(reset, 30)
}

function showModal(id) {
  const el = document.getElementById(id)
  if (!el) return
  const wasHidden = el.classList.contains('hidden')
  el.classList.remove('hidden')
  if (wasHidden) activeModalCount++
  document.body.classList.add('modal-open')
  resetScrollPosition(el)
}

function hideModal(id) {
  const el = document.getElementById(id)
  if (!el || el.classList.contains('hidden')) return
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
async function setUpdateInteractionState(state) {
  try {
    await window.studyRecord.setUpdateInteractionState?.(state)
  } catch (e) {}
}

async function prepareForUpdateInstall(downloadingText) {
  if (!currentSessionId) return true
  if (downloadingText) downloadingText.textContent = '正在结束当前记录...'
  await endSession()
  return !currentSessionId
}

function resetUpdateModalActions() {
  const laterBtn = document.getElementById('update-later-btn')
  const nowBtn = document.getElementById('update-now-btn')
  const closeBtn = document.querySelector('#update-modal .modal-close-btn')
  updateAccepted = false
  updateInstalling = false
  setUpdateInteractionState(updateModalOpen ? 'prompt' : 'normal')
  if (nowBtn) { nowBtn.disabled = false; nowBtn.textContent = '立即更新' }
  if (laterBtn) laterBtn.disabled = false
  if (closeBtn) closeBtn.disabled = false
}

function showUpdateModal({ version, notes }) {
  const tagEl = document.getElementById('update-version-tag')
  const bodyEl = document.getElementById('update-notes')
  if (tagEl) tagEl.textContent = `v${version}`
  if (bodyEl) bodyEl.innerHTML = renderMarkdown(notes)
  const nowBtn = document.getElementById('update-now-btn')
  const laterBtn = document.getElementById('update-later-btn')
  const closeBtn = document.querySelector('#update-modal .modal-close-btn')
  const progress = document.getElementById('update-progress')
  const overlay = document.getElementById('update-downloading-overlay')
  updateAccepted = false
  updateModalOpen = true
  updateInstalling = false
  if (nowBtn) { nowBtn.disabled = false; nowBtn.textContent = '立即更新' }
  if (laterBtn) laterBtn.disabled = false
  if (closeBtn) closeBtn.disabled = false
  if (progress) progress.classList.add('hidden')
  if (overlay) overlay.classList.add('hidden')
  setUpdateInteractionState('prompt')
  showModal('update-modal')
}

function hideUpdateOverlay() {
  const overlay = document.getElementById('update-downloading-overlay')
  if (overlay) overlay.classList.add('hidden')
}

function hideUpdateModal() {
  if (updateInstalling) return
  updateModalOpen = false
  setUpdateInteractionState('normal')
  hideModal('update-modal')
}

function initUpdateModal() {
  const laterBtn = document.getElementById('update-later-btn')
  const nowBtn = document.getElementById('update-now-btn')
  const overlay = document.getElementById('update-downloading-overlay')
  if (laterBtn) laterBtn.addEventListener('click', () => {
    if (updateInstalling) return
    updateAccepted = false
    hideUpdateModal()
    window.studyRecord.respondUpdatePrompt?.(false)
  })
  if (nowBtn) nowBtn.addEventListener('click', async () => {
    if (updateAccepted) return
    updateAccepted = true
    updateInstalling = true
    setUpdateInteractionState('installing')
    nowBtn.disabled = true
    nowBtn.textContent = '准备更新...'
    if (laterBtn) laterBtn.disabled = true
    const closeBtn = document.querySelector('#update-modal .modal-close-btn')
    if (closeBtn) closeBtn.disabled = true
    // 显示遮罩，阻断所有交互
    if (overlay) overlay.classList.remove('hidden')
    const downloadingText = document.getElementById('update-downloading-text')
    if (downloadingText) downloadingText.textContent = '准备更新...'
    const progressEl = document.getElementById('update-progress')
    try {
      const ready = await prepareForUpdateInstall(downloadingText)
      if (!ready) throw new Error('当前记录结束失败')
      if (downloadingText) downloadingText.textContent = '准备下载...'
      const result = await window.studyRecord.respondUpdatePrompt?.(true)
      if (result && result.ok) {
        if (progressEl) progressEl.classList.remove('hidden')
        if (downloadingText) downloadingText.textContent = '正在下载更新...'
        showToast('正在下载更新...', 'info', 2000)
      } else if (result) {
        if (result.reason === 'already-downloading') {
          if (downloadingText) downloadingText.textContent = '正在下载更新...'
          showToast('更新已在下载中', 'info', 2000)
        } else {
          hideUpdateOverlay()
          resetUpdateModalActions()
          showToast('启动下载失败: ' + (result.reason || '未知错误'), 'warning', 3000)
        }
      } else {
        hideUpdateOverlay()
        resetUpdateModalActions()
        showToast('启动下载失败', 'warning', 2000)
      }
    } catch (e) {
      hideUpdateOverlay()
      resetUpdateModalActions()
      showToast('下载失败: ' + (e && e.message ? e.message : e), 'warning', 4000)
    }
  })
  // 关闭 / backdrop 点击：安装中拦截
  document.querySelectorAll('#update-modal [data-update-close]').forEach(el => {
    el.addEventListener('click', () => {
      if (updateInstalling) return
      updateAccepted = false
      hideUpdateModal()
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

// ---------- 首次使用引导 ----------
async function initOnboarding() {
  const modal = document.getElementById('onboarding-modal')
  const startBtn = document.getElementById('onboarding-start')
  const dontShow = document.getElementById('onboarding-dont-show')
  const backdrop = document.getElementById('onboarding-backdrop')
  if (!(modal && startBtn && dontShow && backdrop)) return

  const close = async () => {
    if (dontShow.checked) {
      try { await window.studyRecord.setConfig('onboarding_shown', '1') } catch (e) {}
    }
    hideModal('onboarding-modal')
  }
  startBtn.addEventListener('click', close)
  backdrop.addEventListener('click', close)

  try {
    const shown = await window.studyRecord.getConfig('onboarding_shown')
    if (!shown) showModal('onboarding-modal')
  } catch (e) {}
}

// ---------- 时间区间弹窗 ----------
function syncTimeRangePreset(start, end) {
  const presets = document.querySelectorAll('input[name="time-preset"]')
  if (!presets.length) return
  let matched = false
  presets.forEach(input => {
    const isMatch = input.dataset.start === start && input.dataset.end === end
    input.checked = isMatch
    if (isMatch) matched = true
  })
  const custom = document.querySelector('input[name="time-preset"][value="custom"]')
  if (custom) custom.checked = !matched
}

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
  syncTimeRangePreset(cfg.start, cfg.end)
  showModal('time-range-modal')

  document.querySelectorAll('input[name="time-preset"]').forEach(input => {
    input.onchange = () => {
      if (!input.checked || !input.dataset.start || !input.dataset.end) return
      startInput.value = input.dataset.start
      endInput.value = input.dataset.end
    }
  })
  const syncCustom = () => syncTimeRangePreset(startInput.value, endInput.value)
  startInput.oninput = syncCustom
  endInput.oninput = syncCustom

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

function formatTooltipDuration(sec) {
  if (!sec || sec < 0) return '学习 0 分钟'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (h && m) return `学习 ${h} 小时 ${m} 分`
  if (h) return `学习 ${h} 小时`
  return `学习 ${m} 分钟`
}

function bindChartTooltip(container) {
  const tooltip = document.getElementById('chart-tooltip')
  if (!container || !tooltip) return
  const dateEl = tooltip.querySelector('.tooltip-date')
  const valueEl = tooltip.querySelector('.tooltip-value')

  const move = (e) => {
    const offset = 8
    const rect = tooltip.getBoundingClientRect()
    let left = e.clientX + offset
    let top = e.clientY + offset
    if (left + rect.width > window.innerWidth - 6) left = e.clientX - rect.width - offset
    if (top + rect.height > window.innerHeight - 6) top = e.clientY - rect.height - offset
    tooltip.style.left = `${Math.max(6, left)}px`
    tooltip.style.top = `${Math.max(6, top)}px`
  }

  container.querySelectorAll('[data-tooltip-date]').forEach(el => {
    el.onmouseenter = (e) => {
      if (dateEl) dateEl.textContent = el.dataset.tooltipDate || ''
      if (valueEl) valueEl.textContent = el.dataset.tooltipValue || ''
      tooltip.classList.remove('hidden')
      void tooltip.offsetWidth
      tooltip.classList.add('show')
      move(e)
    }
    el.onmousemove = move
    el.onmouseleave = () => {
      tooltip.classList.remove('show')
      setTimeout(() => {
        if (!tooltip.classList.contains('show')) tooltip.classList.add('hidden')
      }, 150)
    }
  })
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
      const hasWeekRecord = weekData.some(d => d.seconds > 0)
      if (!hasWeekRecord) {
        chart.innerHTML = renderEmptyState('最近 7 天无记录', '开始学习后会生成每日时长柱状图。', 'stats-empty')
      } else {
        const maxSec = Math.max(...weekData.map(d => d.seconds), 1)
        const MAX_BAR_HEIGHT = 42  // 留出 14px 给底部 label 和 gap
        chart.innerHTML = weekData.map(d => `
          <div class="week-bar" data-tooltip-date="${escapeHtml(d.date || d.label)}" data-tooltip-value="${formatTooltipDuration(d.seconds)}">
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
        bindChartTooltip(chart)
      }
    }
  } catch (e) { console.error('周数据加载失败', e) }

  // 热力图
  try {
    const heatData = await window.studyRecord.statsHeatmap(35)
    const heat = document.getElementById('heatmap')
    if (heat) {
      const hasHeatRecord = heatData.some(d => d.seconds > 0)
      if (!hasHeatRecord) {
        heat.innerHTML = renderEmptyState('暂无热力数据', '近 35 天有学习记录后会显示热力图。', 'stats-empty')
      } else {
        const maxSec = Math.max(...heatData.map(d => d.seconds), 1)
        heat.innerHTML = heatData.map(d => {
          const level = d.seconds === 0 ? 0 :
                        d.seconds / maxSec < 0.25 ? 1 :
                        d.seconds / maxSec < 0.5 ? 2 :
                        d.seconds / maxSec < 0.75 ? 3 : 4
          return `<div class="heatmap-cell ${level > 0 ? 'l' + level : ''}" data-tooltip-date="${escapeHtml(d.date)}" data-tooltip-value="${formatTooltipDuration(d.seconds)}"></div>`
        }).join('')
        bindChartTooltip(heat)
      }
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
      listEl.innerHTML = renderEmptyState('暂无标签', '添加标签后，可以给学习记录分类。', 'compact-empty')
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
    listEl.innerHTML = renderErrorState('标签加载失败', '请关闭后重新打开。')
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
      if (!badges || badges.length === 0) {
        grid.innerHTML = renderEmptyState('暂无徽章', '完成更多学习记录后会解锁成就。', 'compact-empty')
        return
      }
      grid.innerHTML = badges.map(b => `
        <div class="badge-item ${b.earned ? '' : 'locked'}" title="${escapeHtml(b.desc)}">
          <div class="badge-icon">${b.icon}</div>
          <div class="badge-name">${escapeHtml(b.name)}</div>
          <div class="badge-desc">${escapeHtml(b.desc)}</div>
        </div>`).join('')
    }
  } catch (e) {
    const grid = document.getElementById('badge-grid')
    if (grid) grid.innerHTML = renderErrorState('徽章加载失败', '请稍后重试。')
    else showMessage('加载徽章失败')
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

// ---------- 学习宠物 ----------
function clampNumber(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

function getPetTodayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function getLevelNeed(level) {
  return 100 + (Math.max(1, level) - 1) * 50
}

function createDefaultPetRecord() {
  return {
    level: 1,
    exp: 0,
    mood: 80,
    affection: 20,
    energy: 100,
    totalStudyTime: 0,
    createdAt: new Date().toISOString(),
    lastInteractAt: null
  }
}

function normalizeRendererPetState(state) {
  const base = {
    activePetId: 'cat',
    unlockedPets: ['cat'],
    pets: { cat: createDefaultPetRecord() },
    dailyStats: { date: getPetTodayKey(), interactCount: 0 },
    enabled: true,
    version: 1
  }
  const next = state && typeof state === 'object' ? state : base
  next.activePetId = PET_META[next.activePetId] ? next.activePetId : 'cat'
  next.unlockedPets = Array.isArray(next.unlockedPets) ? [...new Set(['cat', ...next.unlockedPets])] : ['cat']
  next.pets = next.pets && typeof next.pets === 'object' ? next.pets : {}
  next.unlockedPets.forEach(id => {
    if (!next.pets[id]) next.pets[id] = createDefaultPetRecord()
  })
  if (!next.dailyStats || next.dailyStats.date !== getPetTodayKey()) {
    next.dailyStats = { date: getPetTodayKey(), interactCount: 0 }
  }
  next.enabled = next.enabled !== false
  next.version = 1
  return next
}

function renderPetSvg(petId, stage = 0) {
  const s = Math.max(0, Math.min(3, stage | 0))
  const colors = {
    cat: {
      body: 'var(--warning)',
      body2: 'color-mix(in srgb, var(--warning) 72%, #e87830)',
      ear: 'color-mix(in srgb, var(--warning) 55%, #f5d0a0)',
      mark: '#5c3826',
      eye: '#3a2a18',
      nose: '#e87890'
    },
    dog: {
      body: 'color-mix(in srgb, var(--success) 72%, #e8c97a)',
      body2: 'var(--success)',
      ear: 'color-mix(in srgb, var(--success) 48%, #8b6914)',
      mark: '#4a3520',
      eye: '#2e2210',
      nose: '#3a2818'
    },
    owl: {
      body: 'var(--accent-2)',
      body2: 'var(--accent)',
      ear: 'color-mix(in srgb, var(--accent-2) 30%, #fff)',
      mark: '#1a2740',
      eye: '#1a2440',
      nose: '#f2b84b'
    }
  }[petId] || { body: 'var(--accent)', body2: 'var(--accent-2)', ear: 'var(--accent-soft)', mark: '#333', eye: '#222', nose: '#f2b84b' }

  // ---- 猫：尖耳 + 胡须 + 俏皮眼 + 三瓣嘴 + 弯尾 ----
  const catParts = petId === 'cat' ? `
    <path d="M16 24 8 8l10 10" fill="${colors.ear}"></path>
    <path d="M48 24 56 8 46 18" fill="${colors.ear}"></path>
    <path d="M16 24 12 14l6 5" fill="color-mix(in srgb, ${colors.mark} 24%, ${colors.ear})" opacity=".55"></path>
    <path d="M48 24 52 14l-6 5" fill="color-mix(in srgb, ${colors.mark} 24%, ${colors.ear})" opacity=".55"></path>
    <line x1="10" y1="33" x2="22" y2="35" stroke="${colors.mark}" stroke-width="0.9" opacity=".5" stroke-linecap="round"></line>
    <line x1="10" y1="37" x2="22" y2="37" stroke="${colors.mark}" stroke-width="0.9" opacity=".5" stroke-linecap="round"></line>
    <line x1="54" y1="33" x2="42" y2="35" stroke="${colors.mark}" stroke-width="0.9" opacity=".5" stroke-linecap="round"></line>
    <line x1="54" y1="37" x2="42" y2="37" stroke="${colors.mark}" stroke-width="0.9" opacity=".5" stroke-linecap="round"></line>
    <path class="pet-tail" d="M48 44c8 0 14-8 6-14" fill="none" stroke="${colors.body2}" stroke-width="5" stroke-linecap="round"></path>
  ` : ''

  // ---- 狗：垂耳 + 圆鼻 + 吐舌 + 蓬松脸颊 ----
  const dogParts = petId === 'dog' ? `
    <ellipse cx="14" cy="22" rx="7" ry="10" fill="${colors.ear}" transform="rotate(18 14 22)"></ellipse>
    <ellipse cx="50" cy="22" rx="7" ry="10" fill="${colors.ear}" transform="rotate(-18 50 22)"></ellipse>
    <ellipse cx="20" cy="32" rx="6" ry="5" fill="color-mix(in srgb, ${colors.ear} 40%, #fff)" opacity=".6"></ellipse>
    <ellipse cx="44" cy="32" rx="6" ry="5" fill="color-mix(in srgb, ${colors.ear} 40%, #fff)" opacity=".6"></ellipse>
    <ellipse cx="32" cy="36" rx="3.8" ry="2.8" fill="${colors.nose}"></ellipse>
    <ellipse cx="30.5" cy="35.2" rx="1.2" ry="0.9" fill="rgba(255,255,255,.45)"></ellipse>
    <path d="M29 39.5c0 3 3 6 6 6s6-3 6-6" fill="#f27a8a"></path>
    <path d="M30.5 39.5v2" stroke="${colors.mark}" stroke-width="0.8" stroke-linecap="round"></path>
    <path class="pet-tail" d="M46 44c6 3 12-4 8-9" fill="none" stroke="${colors.body2}" stroke-width="5" stroke-linecap="round"></path>
  ` : ''

  // ---- 猫头鹰：大圆眼 + 喙 + 羽冠 + 翅膀 + 爪 ----
  const owlParts = petId === 'owl' ? `
    <path d="M18 26 12 8l8 12" fill="${colors.ear}"></path>
    <path d="M46 26 52 8l-8 12" fill="${colors.ear}"></path>
    <path d="M14 8 16 12" stroke="${colors.mark}" stroke-width="1.2" stroke-linecap="round" opacity=".4"></path>
    <path d="M18 6 19 10" stroke="${colors.mark}" stroke-width="1.2" stroke-linecap="round" opacity=".4"></path>
    <path d="M50 8 48 12" stroke="${colors.mark}" stroke-width="1.2" stroke-linecap="round" opacity=".4"></path>
    <path d="M46 6 45 10" stroke="${colors.mark}" stroke-width="1.2" stroke-linecap="round" opacity=".4"></path>
    <ellipse cx="25" cy="30" rx="8" ry="9" fill="#fff"></ellipse>
    <ellipse cx="39" cy="30" rx="8" ry="9" fill="#fff"></ellipse>
    <circle cx="26" cy="30" r="4.5" fill="${colors.eye}"></circle>
    <circle cx="38" cy="30" r="4.5" fill="${colors.eye}"></circle>
    <circle cx="27.5" cy="27.5" r="1.6" fill="rgba(255,255,255,.7)"></circle>
    <circle cx="39.5" cy="27.5" r="1.6" fill="rgba(255,255,255,.7)"></circle>
    <circle cx="24.5" cy="31.5" r="0.8" fill="rgba(255,255,255,.4)"></circle>
    <circle cx="36.5" cy="31.5" r="0.8" fill="rgba(255,255,255,.4)"></circle>
    <polygon points="32,36 28,42 36,42" fill="${colors.nose}"></polygon>
    <path d="M18 44c0-8 4-14 14-10" fill="${colors.body2}" opacity=".7"></path>
    <path d="M46 44c0-8-4-14-14-10" fill="${colors.body2}" opacity=".7"></path>
    <path d="M28 53h2l-1 3-1-3" fill="${colors.nose}"></path>
    <path d="M34 53h2l-1 3-1-3" fill="${colors.nose}"></path>
  ` : ''

  // ---- 进化装饰 ----
  const blush = s >= 1
    ? `<circle cx="20" cy="34" r="2.4" fill="#ff8aa6" opacity=".45"></circle><circle cx="44" cy="34" r="2.4" fill="#ff8aa6" opacity=".45"></circle>`
    : ''
  const glasses = s >= 2
    ? `<g class="pet-glasses">
        <circle cx="25" cy="29" r="5" fill="none" stroke="${colors.mark}" stroke-width="1.6"></circle>
        <circle cx="39" cy="29" r="5" fill="none" stroke="${colors.mark}" stroke-width="1.6"></circle>
        <line x1="30" y1="29" x2="34" y2="29" stroke="${colors.mark}" stroke-width="1.6"></line>
      </g>` : ''
  const cap = s >= 3
    ? `<g class="pet-cap">
        <rect x="14" y="6" width="36" height="3.6" fill="#1f2745"></rect>
        <polygon points="12,8 52,8 32,1" fill="#283153"></polygon>
        <circle cx="46" cy="5" r="2" fill="${colors.body}"></circle>
        <line x1="46" y1="5" x2="50" y2="10" stroke="#1f2745" stroke-width="1.5"></line>
      </g>` : ''
  const halo = s >= 3
    ? `<ellipse cx="32" cy="2" rx="14" ry="2.4" fill="none" stroke="#f3c948" stroke-width="2" opacity=".85"></ellipse>`
    : ''

  // s=0 幼年:缩小
  const scaleAttr = s === 0 ? ' transform="translate(32 38) scale(0.82) translate(-32 -38)"' : ''

  // 不同宠物的脸型微调
  const faceRx = petId === 'owl' ? 16 : 18
  const faceRy = petId === 'owl' ? 14 : 17

  return `<svg class="pet-svg pet-stage-${s}" viewBox="0 0 64 64" aria-hidden="true">
    <ellipse cx="32" cy="54" rx="20" ry="4.5" fill="rgba(20,40,80,.12)"></ellipse>
    <g class="pet-body-group"${scaleAttr}>
      ${halo}
      ${cap}
      ${catParts}${dogParts}${owlParts}
      <ellipse cx="32" cy="40" rx="20" ry="16" fill="${colors.body2}"></ellipse>
      <ellipse cx="32" cy="28" rx="${faceRx}" ry="${faceRy}" fill="${colors.body}"></ellipse>
      ${petId !== 'owl' ? `
        <ellipse cx="25" cy="28" rx="6.5" ry="7" fill="rgba(255,255,255,.52)"></ellipse>
        <ellipse cx="39" cy="28" rx="6.5" ry="7" fill="rgba(255,255,255,.52)"></ellipse>
        <g class="pet-eyes-open">
          <ellipse cx="25" cy="28" rx="2.8" ry="3.2" fill="${colors.eye}"></ellipse>
          <ellipse cx="39" cy="28" rx="2.8" ry="3.2" fill="${colors.eye}"></ellipse>
          <circle cx="26.4" cy="26" r="1" fill="rgba(255,255,255,.55)"></circle>
          <circle cx="40.4" cy="26" r="1" fill="rgba(255,255,255,.55)"></circle>
        </g>
      ` : ''}
      ${blush}
      ${glasses}
      ${petId !== 'owl' ? `
        <path d="M26 38c3.4 3 8.6 3 12 0" fill="none" stroke="${colors.mark}" stroke-width="2" stroke-linecap="round"></path>
      ` : ''}
    </g>
  </svg>`
}

class PetManager {
  constructor() {
    this.state = PET_STATES.IDLE
    this.petState = null
    this.energyTimer = null
    this.hintTimer = null
    this.tiredWarnShown = false
  }

  get activePet() {
    if (!this.petState) return createDefaultPetRecord()
    const id = this.petState.activePetId || 'cat'
    if (!this.petState.pets[id]) this.petState.pets[id] = createDefaultPetRecord()
    return this.petState.pets[id]
  }

  async init() {
    try {
      const state = await window.studyRecord.petGetState()
      this.petState = normalizeRendererPetState(state)
      this.render()
      this.bind()
      await this.checkUnlocks(false)
      if (currentSessionId) {
        await this.setState(isPaused ? PET_STATES.PAUSED : PET_STATES.STUDYING, false)
        if (isPaused) this.startEnergyRecovery()
        else this.startEnergyDrain()
      }
    } catch (e) {
      console.error('[Pet] 初始化失败:', e)
    }
  }

  bind() {
    const visual = document.getElementById('pet-visual')
    if (visual) visual.addEventListener('click', () => this.onPetClick())
  }

  async save() {
    if (!this.petState) return
    try { await window.studyRecord.petSaveState(this.petState) } catch (e) { console.error('[Pet] 保存失败:', e) }
  }

  async setState(newState, persist = true) {
    this.state = newState
    const visual = document.getElementById('pet-visual')
    if (visual) visual.dataset.state = newState
    if (persist) await this.save()
  }

  render() {
    if (!this.petState) return
    const activeId = this.petState.activePetId || 'cat'
    const visual = document.getElementById('pet-visual')
    const pet = this.activePet
    const stage = getPetStage(pet.level)
    if (visual) {
      visual.innerHTML = renderPetSvg(activeId, stage)
      visual.dataset.state = this.state
      visual.dataset.stage = String(stage)
      visual.title = `${PET_META[activeId].name} · ${PET_META[activeId].stageNames[stage]} · 点击互动`
    }
    this.updateStatsUI()
    this.updateExpUI()
  }

  updateStatsUI() {
    const pet = this.activePet
    const level = document.getElementById('pet-level-badge')
    const mood = document.getElementById('mood-fill')
    const energy = document.getElementById('energy-fill')
    const affection = document.getElementById('affection-fill')
    if (level) level.textContent = `Lv.${pet.level || 1}`
    if (mood) mood.style.width = `${clampNumber(pet.mood, 0, 100)}%`
    if (energy) energy.style.width = `${clampNumber(pet.energy, 0, 100)}%`
    if (affection) affection.style.width = `${clampNumber(pet.affection, 0, 100)}%`
  }

  updateExpUI() {
    const pet = this.activePet
    const need = getLevelNeed(pet.level || 1)
    const fill = document.getElementById('pet-exp-fill')
    if (fill) fill.style.width = `${clampNumber((pet.exp || 0) / need * 100, 0, 100)}%`
  }

  playAnimation(type, params = {}) {
    const visual = document.getElementById('pet-visual')
    if (!visual) return
    if (type === 'celebrate') {
      visual.classList.remove('is-celebrating')
      void visual.offsetWidth
      visual.classList.add('is-celebrating')
      this.spawnParticles(['✦', '•', '+'], 10)
      if (params.exp) this.spawnExpPop(`+${params.exp} EXP`)
      setTimeout(() => visual.classList.remove('is-celebrating'), 900)
    } else if (type === 'levelup') {
      visual.classList.remove('is-level-up')
      void visual.offsetWidth
      visual.classList.add('is-level-up')
      this.spawnParticles(['Lv', '✦', '↑'], 12)
      this.showSpeechBubble('升级了！')
      setTimeout(() => visual.classList.remove('is-level-up'), 1700)
    } else if (type === 'interact') {
      this.spawnParticles(['♥', '♡'], 6)
    } else if (type === 'excited') {
      this.showSpeechBubble('一起专注')
    } else if (type === 'confused') {
      this.showSpeechBubble('休息一下')
    }
  }

  spawnParticles(symbols, count = 8) {
    const visual = document.getElementById('pet-visual')
    if (!visual) return
    const rect = visual.getBoundingClientRect()
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div')
      el.className = 'pet-particle'
      el.textContent = symbols[i % symbols.length]
      el.style.left = `${rect.left + rect.width / 2 + (Math.random() - 0.5) * 36}px`
      el.style.top = `${rect.top + rect.height / 2 + (Math.random() - 0.5) * 18}px`
      el.style.setProperty('--pet-drift', `${(Math.random() - 0.5) * 62}px`)
      document.body.appendChild(el)
      setTimeout(() => el.remove(), 1500)
    }
  }

  spawnExpPop(text) {
    const visual = document.getElementById('pet-visual')
    if (!visual) return
    const rect = visual.getBoundingClientRect()
    const el = document.createElement('div')
    el.className = 'pet-exp-pop'
    el.textContent = text
    el.style.left = `${rect.left + rect.width / 2}px`
    el.style.top = `${rect.top + 4}px`
    document.body.appendChild(el)
    setTimeout(() => el.remove(), 1300)
  }

  startEnergyDrain() {
    this.stopAllTimers()
    this.energyTimer = setInterval(() => {
      const pet = this.activePet
      pet.energy = clampNumber((pet.energy || 100) - 1 / 60, 0, 100)
      pet.mood = clampNumber((pet.mood || 80) + 1 / 60, 0, 100)
      this.updateStatsUI()
    }, TIMER_INTERVALS.todayUpdate)
  }

  startEnergyRecovery() {
    this.stopAllTimers()
    this.energyTimer = setInterval(() => {
      const pet = this.activePet
      pet.energy = clampNumber((pet.energy || 100) + 2 / 60, 0, 100)
      pet.mood = clampNumber((pet.mood || 80) - 0.5 / 60, 0, 100)
      this.updateStatsUI()
    }, TIMER_INTERVALS.todayUpdate)
  }

  stopAllTimers() {
    if (this.energyTimer) clearInterval(this.energyTimer)
    this.energyTimer = null
    this.save()
  }

  async addExp(amount, seconds = 0) {
    if (!this.petState || amount <= 0) return false
    const pet = this.activePet
    const prevStage = getPetStage(pet.level)
    pet.exp = (pet.exp || 0) + amount
    pet.totalStudyTime = (pet.totalStudyTime || 0) + Math.max(0, seconds)
    pet.mood = clampNumber((pet.mood || 80) + Math.min(12, amount / 8), 0, 100)
    pet.energy = clampNumber(pet.energy || 100, 0, 100)

    let didLevelUp = false
    while ((pet.exp || 0) >= getLevelNeed(pet.level || 1) && (pet.level || 1) < 100) {
      pet.exp -= getLevelNeed(pet.level || 1)
      pet.level = (pet.level || 1) + 1
      didLevelUp = true
    }
    const newStage = getPetStage(pet.level)
    const didEvolve = newStage > prevStage
    this.updateStatsUI()
    this.updateExpUI()
    if (didEvolve) {
      // 重新渲染整只宠物(切换 stage 的装饰)
      this.render()
    }
    await this.save()
    if (didLevelUp) showToast(`宠物升级到 Lv.${pet.level}`, 'success', 2600)
    if (didEvolve) {
      const petId = this.petState.activePetId || 'cat'
      const stageName = PET_META[petId].stageNames[newStage]
      setTimeout(() => {
        this.showEvolutionToast(petId, prevStage, newStage)
        showToast(`✨ 进化为「${stageName}」!`, 'success', 4000)
      }, didLevelUp ? 1200 : 0)
    }
    return didLevelUp
  }

  showEvolutionToast(petId, prevStage, newStage) {
    // 全屏中央炫光特效
    const visual = document.getElementById('pet-visual')
    if (!visual) return
    visual.classList.remove('is-evolving')
    void visual.offsetWidth
    visual.classList.add('is-evolving')
    this.spawnParticles(['✦', '★', '◆', '✧'], 18)
    setTimeout(() => visual.classList.remove('is-evolving'), 2400)
  }

  async onPetClick() {
    if (!this.petState) return
    const stats = this.petState.dailyStats || { date: getPetTodayKey(), interactCount: 0 }
    if (stats.date !== getPetTodayKey()) {
      stats.date = getPetTodayKey()
      stats.interactCount = 0
    }
    if (stats.interactCount >= 20) {
      this.showSpeechBubble('今天已经很亲密啦')
      return
    }
    stats.interactCount += 1
    this.petState.dailyStats = stats
    const pet = this.activePet
    pet.affection = clampNumber((pet.affection || 0) + 1, 0, 100)
    pet.mood = clampNumber((pet.mood || 80) + 0.5, 0, 100)
    pet.lastInteractAt = new Date().toISOString()
    this.updateStatsUI()
    this.playAnimation('interact')
    this.showSpeechBubble(['继续保持', '专注很棒', '我在陪你'][stats.interactCount % 3])
    await this.save()
  }

  showSpeechBubble(text, duration = 2200) {
    const hint = document.getElementById('pet-status-hint')
    if (!hint) return
    hint.textContent = text
    hint.classList.remove('hidden')
    if (this.hintTimer) clearTimeout(this.hintTimer)
    this.hintTimer = setTimeout(() => hint.classList.add('hidden'), duration)
  }

  async showTiredWarning() {
    if (this.tiredWarnShown) return
    this.tiredWarnShown = true
    await this.setState(PET_STATES.TIRED)
    this.showSpeechBubble('休息一会吧')
    showToast('宠物提醒：已经学习很久了，休息一下更高效。', 'info', 4200)
  }

  async checkUnlocks(showNotice = true) {
    if (!this.petState) return
    try {
      const result = await window.studyRecord.petCheckUnlocks()
      const unlockable = Array.isArray(result?.unlockable) ? result.unlockable : ['cat']
      const fresh = unlockable.filter(id => PET_META[id] && !this.petState.unlockedPets.includes(id))
      if (!fresh.length) return
      fresh.forEach(id => {
        this.petState.unlockedPets.push(id)
        if (!this.petState.pets[id]) this.petState.pets[id] = createDefaultPetRecord()
      })
      await this.save()
      if (showNotice) fresh.forEach(id => showToast(`已解锁 ${PET_META[id].name}`, 'success', 3000))
    } catch (e) {
      console.error('[Pet] 解锁检查失败:', e)
    }
  }

  async switchPet(id) {
    if (!this.petState || !this.petState.unlockedPets.includes(id)) return
    this.petState.activePetId = id
    if (!this.petState.pets[id]) this.petState.pets[id] = createDefaultPetRecord()
    this.render()
    this.showSpeechBubble(`${PET_META[id].name} 出场`)
    await this.save()
  }

  async renderCollection() {
    await this.checkUnlocks(false)
    const root = document.getElementById('pet-collection')
    const meta = document.getElementById('pet-modal-meta')
    if (!root || !this.petState) return
    const allPets = Object.values(PET_META)
    const unlockedCount = allPets.filter(p => this.petState.unlockedPets.includes(p.id)).length
    if (meta) meta.textContent = `${unlockedCount}/${allPets.length} 已解锁`

    const activeId = this.petState.activePetId
    const activeMeta = PET_META[activeId] || allPets[0]
    const activeRecord = this.petState.pets[activeMeta.id] || createDefaultPetRecord()
    const activeStage = getPetStage(activeRecord.level)
    const activeStageName = activeMeta.stageNames[activeStage]
    const stageInfo = getNextStageInfo(activeRecord.level)
    const currentLv = activeRecord.level || 1
    const expNeed = getLevelNeed(currentLv)
    const expPct = clampNumber((activeRecord.exp || 0) / expNeed * 100, 0, 100)
    const nextStageLabel = stageInfo.nextLevel
      ? `距 Lv.${stageInfo.nextLevel} 进化还差 ${stageInfo.nextLevel - currentLv} 级`
      : '已达最终形态'

    const evolutionTree = `
      <div class="pet-evolution-tree" aria-label="进化路径">
        ${activeMeta.stageNames.map((sName, idx) => {
          const reached = activeStage >= idx
          const isCurrent = activeStage === idx
          const threshold = PET_STAGE_THRESHOLDS[idx]
          return `
            <div class="pet-evo-step ${reached ? 'reached' : ''} ${isCurrent ? 'current' : ''}" title="${escapeHtml(sName)} · Lv.${threshold}+">
              <div class="pet-evo-avatar">${renderPetSvg(activeMeta.id, idx)}</div>
              <div class="pet-evo-meta">
                <span class="pet-evo-name">${escapeHtml(sName)}</span>
                <span class="pet-evo-lv">Lv.${threshold}+</span>
              </div>
            </div>
            ${idx < activeMeta.stageNames.length - 1 ? '<span class="pet-evo-arrow">›</span>' : ''}
          `
        }).join('')}
      </div>
    `

    const hero = `
      <section class="pet-hero">
        <div class="pet-hero-top">
          <div class="pet-hero-avatar">${renderPetSvg(activeMeta.id, activeStage)}</div>
          <div class="pet-hero-info">
            <div class="pet-hero-name">
              ${escapeHtml(activeMeta.name)}
              <span class="pet-hero-stage">${escapeHtml(activeStageName)}</span>
            </div>
            <div class="pet-hero-lv">Lv.${currentLv}</div>
            <div class="pet-hero-next">${escapeHtml(nextStageLabel)}</div>
          </div>
        </div>
        <div class="pet-hero-exp" aria-label="经验进度">
          <div class="pet-hero-exp-fill" style="width:${expPct}%"></div>
          <span class="pet-hero-exp-text">${activeRecord.exp || 0} / ${expNeed} EXP</span>
        </div>
        ${evolutionTree}
      </section>
    `

    const listRows = allPets.map(pet => {
      const unlocked = this.petState.unlockedPets.includes(pet.id)
      const isActive = pet.id === activeMeta.id
      const record = this.petState.pets[pet.id] || createDefaultPetRecord()
      const stage = unlocked ? getPetStage(record.level) : 0
      const stageName = unlocked ? pet.stageNames[stage] : ''
      const subtitle = unlocked
        ? `Lv.${record.level || 1} · ${stageName}`
        : pet.unlockHint
      const statusLabel = isActive ? '当前' : unlocked ? '切换' : '未解锁'
      const statusClass = isActive ? 'is-active' : unlocked ? 'is-switch' : 'is-locked'
      const disabled = !unlocked || isActive
      return `
        <button class="pet-row ${isActive ? 'active' : ''} ${unlocked ? '' : 'locked'}"
                data-pet-id="${pet.id}" ${disabled ? 'disabled' : ''}>
          <div class="pet-row-avatar">${renderPetSvg(pet.id, stage)}</div>
          <div class="pet-row-info">
            <div class="pet-row-name">${escapeHtml(pet.name)}</div>
            <div class="pet-row-sub">${escapeHtml(subtitle)}</div>
          </div>
          <span class="pet-row-status ${statusClass}">${statusLabel}</span>
        </button>
      `
    }).join('')

    root.innerHTML = `
      ${hero}
      <div class="pet-switcher-label">切换伙伴</div>
      <div class="pet-switcher">${listRows}</div>
    `

    root.querySelectorAll('.pet-row:not(.locked):not(.active)').forEach(row => {
      row.addEventListener('click', async () => {
        await this.switchPet(row.dataset.petId)
        await this.renderCollection()
      })
    })
  }
}

petManager = new PetManager()
window.petManager = petManager

async function showPetModal() {
  showModal('pet-modal')
  await petManager.renderCollection()
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

// ---------- 分享卡片 ----------
const shareCardManager = (() => {
  let currentScope = 'day'
  let currentSummary = null

  function fmtH(sec) {
    if (!sec || sec < 0) return '0h'
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    if (h && m) return `${h}h ${m}m`
    if (h) return `${h}h`
    return `${m}m`
  }

  // 主题色:跟随当前主题
  function getTheme() {
    const t = document.body.getAttribute('data-theme') || 'light'
    if (t === 'dark') {
      return {
        bgGrad: ['#1c2238', '#252c4a'],
        accent: '#82a0ff', accent2: '#b48aff',
        text: '#e4eaf7', textSoft: '#a0a8c2',
        card: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.08)',
        success: '#38d196'
      }
    }
    if (t === 'eyecare') {
      return {
        bgGrad: ['#e4f1de', '#cfe2c6'],
        accent: '#5a8a4f', accent2: '#7aa66e',
        text: '#263822', textSoft: '#4a5e44',
        card: 'rgba(255,255,255,0.6)', border: 'rgba(80,110,70,0.14)',
        success: '#5a8a4f'
      }
    }
    return {
      bgGrad: ['#f2f5fc', '#e8ecf8'],
      accent: '#6a84e6', accent2: '#936ae6',
      text: '#1a1f36', textSoft: '#5e6480',
      card: 'rgba(255,255,255,0.85)', border: 'rgba(130,150,190,0.16)',
      success: '#38b978'
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }

function drawCard(canvas, summary) {
    const ctx = canvas.getContext('2d')
    const W = canvas.width, H = canvas.height
    const th = getTheme()
    const FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
    const PAD = 56

    // ---- 1. Background ----
    const bg = ctx.createLinearGradient(0, 0, 0, H)
    bg.addColorStop(0, th.bgGrad[0])
    bg.addColorStop(1, th.bgGrad[1])
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, W, H)

    // Soft ambient blobs
    ;[
      [W * 0.88, H * 0.08, 340, th.accent2, '28'],
      [W * 0.12, H * 0.94, 280, th.accent, '22']
    ].forEach(([cx, cy, r, color, alpha]) => {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
      g.addColorStop(0, color + alpha)
      g.addColorStop(1, 'transparent')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, W, H)
    })

    let y = PAD

    // ---- 2. Brand strip + hairline ----
    ctx.font = `500 15px ${FONT}`
    ctx.fillStyle = th.textSoft
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    ctx.fillText('学习时间记录', PAD, y)
    ctx.textAlign = 'right'
    ctx.font = `400 13px ${FONT}`
    ctx.fillText(summary.rangeLabel || '', W - PAD, y)
    ctx.textAlign = 'left'
    y += 28

    ctx.strokeStyle = th.border
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(PAD, y)
    ctx.lineTo(W - PAD, y)
    ctx.stroke()
    y += 28

    // ---- 3. Label chip ----
    const isWeek = summary.scope === 'week'
    const chipLabel = isWeek ? '本周专注' : '今日专注'
    ctx.font = `600 13px ${FONT}`
    const chipW = ctx.measureText(chipLabel).width + 20
    const chipH = 24
    roundRect(ctx, (W - chipW) / 2, y, chipW, chipH, 12)
    ctx.fillStyle = th.accent
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(chipLabel, W / 2, y + chipH / 2)
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    y += chipH + 20

    // ---- 4. Hero: duration + circular glow ----
    const hero = fmtH(summary.totalSeconds || 0)
    const haloR = 120
    const haloCy = y + 58
    const halo = ctx.createRadialGradient(W / 2, haloCy, haloR * 0.3, W / 2, haloCy, haloR)
    halo.addColorStop(0, th.accent + '1a')
    halo.addColorStop(1, 'transparent')
    ctx.fillStyle = halo
    ctx.beginPath()
    ctx.arc(W / 2, haloCy, haloR, 0, Math.PI * 2)
    ctx.fill()

    ctx.font = `800 96px ${FONT}`
    const heroGrad = ctx.createLinearGradient(W / 2 - 260, y, W / 2 + 260, y + 100)
    heroGrad.addColorStop(0, th.accent)
    heroGrad.addColorStop(1, th.accent2)
    ctx.fillStyle = heroGrad
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(hero, W / 2, y)
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    y += 110

    // ---- 5. Stats row: 3 equal columns with vertical dividers ----
    const stats = [
      { label: '专注次数', value: `${summary.sessionCount || 0} 次`, color: th.accent2 },
      { label: '连续天数', value: `${summary.streak || 0} 天`, color: th.success },
      { label: '标签数', value: `${(summary.tags || []).length} 个`, color: th.accent }
    ]
    const statY = y
    const statH = 72
    const colW = (W - PAD * 2) / 3

    roundRect(ctx, PAD, statY, W - PAD * 2, statH, 16)
    ctx.fillStyle = th.card
    ctx.fill()
    ctx.strokeStyle = th.border
    ctx.lineWidth = 1
    ctx.stroke()

    stats.forEach((s, i) => {
      const cx = PAD + colW * i + colW / 2
      if (i > 0) {
        ctx.beginPath()
        ctx.moveTo(PAD + colW * i, statY + 14)
        ctx.lineTo(PAD + colW * i, statY + statH - 14)
        ctx.strokeStyle = th.border
        ctx.lineWidth = 1
        ctx.stroke()
      }
      ctx.textAlign = 'center'
      ctx.font = `700 26px ${FONT}`
      ctx.fillStyle = s.color
      ctx.textBaseline = 'top'
      ctx.fillText(s.value, cx, statY + 12)
      ctx.font = `500 13px ${FONT}`
      ctx.fillStyle = th.textSoft
      ctx.fillText(s.label, cx, statY + 44)
    })
    ctx.textAlign = 'left'
    y += statH + 24

    // ---- 6. Quote ----
    if (summary.quote) {
      ctx.font = `italic 400 16px ${FONT}`
      ctx.fillStyle = th.textSoft
      ctx.textAlign = 'center'
      const q = '"' + summary.quote + '"'
      const maxW = W - PAD * 2 - 40
      let text = q
      if (ctx.measureText(text).width > maxW) {
        while (ctx.measureText(text + '…"').width > maxW && text.length > 4) {
          text = text.slice(0, -1)
        }
        text = text.replace(/"$/, '') + '…"'
      }
      ctx.fillText(text, W / 2, y)
      ctx.textAlign = 'left'
      y += 32
    }
    y += 8

    // ---- 7. Chart card ----
    const footerH = 60
    const chartTop = y
    const chartBottom = H - PAD - footerH
    const chartH = chartBottom - chartTop

    roundRect(ctx, PAD, chartTop, W - PAD * 2, chartH, 20)
    ctx.fillStyle = th.card
    ctx.fill()
    ctx.strokeStyle = th.border
    ctx.lineWidth = 1
    ctx.stroke()

    if (isWeek) {
      drawWeekChart(ctx, summary.dayBuckets || [], PAD + 32, chartTop + 20, W - PAD * 2 - 64, chartH - 40, th, FONT)
    } else {
      drawTagChart(ctx, summary.tags || [], summary.totalSeconds || 0, PAD + 32, chartTop + 20, W - PAD * 2 - 64, chartH - 40, th, FONT)
    }

    // ---- 8. Footer ----
    ctx.font = `400 14px ${FONT}`
    ctx.fillStyle = th.textSoft
    ctx.textAlign = 'center'
    ctx.fillText('坚持的每一刻 · 都在为更好的自己积累', W / 2, H - PAD - 20)
    ctx.textAlign = 'left'
  }

  function drawWeekChart(ctx, days, x, y, w, h, th, FONT) {
    FONT = FONT || '-apple-system, sans-serif'
    ctx.font = `700 16px ${FONT}`
    ctx.fillStyle = th.text
    ctx.fillText('过去 7 天', x, y)

    const maxSec = Math.max(...days.map(d => d.seconds || 0), 1)
    const chartTop = y + 36
    const chartBottom = y + h - 32
    const chartH = chartBottom - chartTop
    const gap = 16
    const barW = (w - gap * (days.length - 1)) / days.length

    days.forEach((d, i) => {
      const bx = x + i * (barW + gap)
      const ratio = (d.seconds || 0) / maxSec
      const bh = Math.max(ratio * chartH, d.seconds > 0 ? 3 : 0)
      const by = chartBottom - bh
      const grad = ctx.createLinearGradient(0, by, 0, chartBottom)
      grad.addColorStop(0, th.accent2)
      grad.addColorStop(1, th.accent)
      ctx.fillStyle = grad
      roundRect(ctx, bx, by, barW, bh, Math.min(7, barW / 3))
      ctx.fill()
      if (d.seconds > 0) {
        ctx.font = `600 12px ${FONT}`
        ctx.fillStyle = th.textSoft
        ctx.textAlign = 'center'
        ctx.fillText(fmtH(d.seconds), bx + barW / 2, by - 14)
      }
      ctx.font = `500 13px ${FONT}`
      ctx.fillStyle = th.textSoft
      ctx.textAlign = 'center'
      ctx.fillText(d.weekday, bx + barW / 2, chartBottom + 8)
    })
    ctx.textAlign = 'left'
  }

  function drawTagChart(ctx, tags, total, x, y, w, h, th, FONT) {
    FONT = FONT || '-apple-system, sans-serif'
    ctx.font = `700 16px ${FONT}`
    ctx.fillStyle = th.text
    ctx.fillText('标签分布', x, y)

    if (!tags.length) {
      ctx.font = `400 14px ${FONT}`
      ctx.fillStyle = th.textSoft
      ctx.fillText('暂无标签，试试给学习内容分类', x, y + 40)
      return
    }
    const rowH = 26
    const rowGap = 8
    const startY = y + 36
    const maxRows = Math.min(tags.length, Math.floor((h - 36) / (rowH + rowGap)))
    const list = tags.slice(0, maxRows)
    const labelW = 100
    const valueW = 72
    const barX = x + labelW
    const barW = w - labelW - valueW - 16

    list.forEach((t, i) => {
      const ry = startY + i * (rowH + rowGap)
      ctx.font = `600 13px ${FONT}`
      ctx.fillStyle = th.text
      ctx.textBaseline = 'middle'
      const name = t.name && t.name.length > 6 ? t.name.slice(0, 6) + '…' : (t.name || '')
      ctx.fillText(name, x, ry + rowH / 2)

      roundRect(ctx, barX, ry + rowH / 2 - 5, barW, 10, 5)
      ctx.fillStyle = th.border
      ctx.fill()

      const ratio = total > 0 ? (t.seconds || 0) / total : 0
      const fw = Math.max(barW * ratio, 5)
      roundRect(ctx, barX, ry + rowH / 2 - 5, fw, 10, 5)
      const g = ctx.createLinearGradient(barX, 0, barX + fw, 0)
      g.addColorStop(0, t.color || th.accent)
      g.addColorStop(1, th.accent2)
      ctx.fillStyle = g
      ctx.fill()

      ctx.font = `600 12px ${FONT}`
      ctx.fillStyle = th.textSoft
      ctx.textAlign = 'right'
      ctx.fillText(fmtH(t.seconds || 0), x + w, ry + rowH / 2)
      ctx.textAlign = 'left'
    })
    ctx.textBaseline = 'top'
  }

  async function load() {
    const loading = document.getElementById('share-loading')
    if (loading) loading.classList.remove('hidden')
    try {
      currentSummary = await window.studyRecord.shareGetSummary({ scope: currentScope })
      const canvas = document.getElementById('share-canvas')
      if (canvas) drawCard(canvas, currentSummary)
    } catch (e) {
      showToast('加载汇总数据失败', 'warning', 2500)
    } finally {
      if (loading) loading.classList.add('hidden')
    }
  }

  async function save() {
    const canvas = document.getElementById('share-canvas')
    if (!canvas) return
    try {
      const dataUrl = canvas.toDataURL('image/png')
      const name = `study-${currentScope === 'week' ? 'week' : 'day'}-summary.png`
      const res = await window.studyRecord.shareSaveImage({ dataUrl, defaultName: name })
      if (res && res.success) {
        showToast(`✓ 已保存到 ${res.path}`, 'success', 3500)
      } else if (res && res.canceled) {
        // 用户取消,不提示
      } else {
        showToast('保存失败: ' + (res && res.error || '未知错误'), 'warning', 3000)
      }
    } catch (e) {
      showToast('保存失败: ' + (e.message || e), 'warning', 3000)
    }
  }

  function bind() {
    if (bind._bound) return
    bind._bound = true
    const tabsRoot = document.querySelector('.share-scope-tabs')
    document.querySelectorAll('.share-tab').forEach(btn => {
      btn.addEventListener('click', async () => {
        document.querySelectorAll('.share-tab').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
        currentScope = btn.dataset.scope || 'day'
        if (tabsRoot) tabsRoot.dataset.scope = currentScope
        await load()
      })
    })
    const refreshBtn = document.getElementById('share-refresh-btn')
    if (refreshBtn) refreshBtn.addEventListener('click', load)
    const saveBtn = document.getElementById('share-save-btn')
    if (saveBtn) saveBtn.addEventListener('click', save)
    const trigger = document.getElementById('share-preview-trigger')
    if (trigger) trigger.addEventListener('click', openLightbox)
    bindLightbox()
  }

  // ---- Lightbox：放大预览 ----
  const ZOOM_MIN = 0.5
  const ZOOM_MAX = 5
  const ZOOM_STEP = 0.25
  let lbZoom = 1
  let lbPanX = 0
  let lbPanY = 0
  let lbBound = false

  function openLightbox() {
    const canvas = document.getElementById('share-canvas')
    const lb = document.getElementById('share-lightbox')
    const img = document.getElementById('share-lightbox-img')
    if (!canvas || !lb || !img) return
    try {
      img.src = canvas.toDataURL('image/png')
    } catch (_) { return }
    lb.classList.remove('hidden')
    lb.setAttribute('aria-hidden', 'false')
    document.body.style.overflow = 'hidden'
    resetLb(false)
  }

  function closeLightbox() {
    const lb = document.getElementById('share-lightbox')
    if (!lb) return
    lb.classList.add('hidden')
    lb.setAttribute('aria-hidden', 'true')
    document.body.style.overflow = ''
  }

  function applyLbTransform(animate = true) {
    const img = document.getElementById('share-lightbox-img')
    const stage = document.getElementById('share-lightbox-stage')
    if (!img || !stage) return
    stage.classList.toggle('no-transition', !animate)
    if (lbZoom <= 1) { lbPanX = 0; lbPanY = 0 }
    img.style.transform = `translate(${lbPanX}px, ${lbPanY}px) scale(${lbZoom})`
    const pct = document.getElementById('share-lb-percent')
    if (pct) pct.textContent = `${Math.round(lbZoom * 100)}%`
    const zo = document.getElementById('share-lb-zoom-out')
    const zi = document.getElementById('share-lb-zoom-in')
    if (zo) zo.disabled = lbZoom <= ZOOM_MIN + 0.001
    if (zi) zi.disabled = lbZoom >= ZOOM_MAX - 0.001
  }

  function setLbZoom(next, focal) {
    const prev = lbZoom
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next))
    if (clamped === prev) return
    if (focal) {
      const ratio = clamped / prev
      lbPanX = focal.x + (lbPanX - focal.x) * ratio
      lbPanY = focal.y + (lbPanY - focal.y) * ratio
    }
    lbZoom = clamped
    applyLbTransform(true)
  }

  function resetLb(animate = true) {
    lbZoom = 1; lbPanX = 0; lbPanY = 0
    applyLbTransform(animate)
  }

  function bindLightbox() {
    if (lbBound) return
    lbBound = true
    const lb = document.getElementById('share-lightbox')
    const stage = document.getElementById('share-lightbox-stage')
    if (!lb || !stage) return

    document.getElementById('share-lb-zoom-in')?.addEventListener('click', () => setLbZoom(lbZoom + ZOOM_STEP))
    document.getElementById('share-lb-zoom-out')?.addEventListener('click', () => setLbZoom(lbZoom - ZOOM_STEP))
    document.getElementById('share-lb-reset')?.addEventListener('click', () => resetLb(true))
    document.getElementById('share-lb-close')?.addEventListener('click', closeLightbox)
    lb.querySelector('[data-close="share-lightbox"]')?.addEventListener('click', closeLightbox)

    stage.addEventListener('wheel', (e) => {
      e.preventDefault()
      const rect = stage.getBoundingClientRect()
      const focal = { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 }
      const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP
      setLbZoom(lbZoom + delta, focal)
    }, { passive: false })

    stage.addEventListener('dblclick', () => {
      if (lbZoom > 1) resetLb(true)
      else setLbZoom(2)
    })

    let isPanning = false
    let startX = 0, startY = 0, sx = 0, sy = 0
    stage.addEventListener('pointerdown', (e) => {
      if (lbZoom <= 1) return
      isPanning = true
      stage.classList.add('is-panning')
      stage.setPointerCapture(e.pointerId)
      startX = e.clientX; startY = e.clientY
      sx = lbPanX; sy = lbPanY
    })
    stage.addEventListener('pointermove', (e) => {
      if (!isPanning) return
      lbPanX = sx + (e.clientX - startX)
      lbPanY = sy + (e.clientY - startY)
      applyLbTransform(false)
    })
    const end = (e) => {
      if (!isPanning) return
      isPanning = false
      stage.classList.remove('is-panning')
      try { stage.releasePointerCapture(e.pointerId) } catch (_) {}
    }
    stage.addEventListener('pointerup', end)
    stage.addEventListener('pointercancel', end)
    stage.addEventListener('pointerleave', end)

    document.addEventListener('keydown', (e) => {
      const open = !lb.classList.contains('hidden')
      if (!open) return
      if (e.key === 'Escape') { e.preventDefault(); closeLightbox() }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); setLbZoom(lbZoom + ZOOM_STEP) }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); setLbZoom(lbZoom - ZOOM_STEP) }
      else if (e.key === '0') { e.preventDefault(); resetLb(true) }
    })
  }

  return {
    async open(scope = 'day') {
      currentScope = scope
      const tabsRoot = document.querySelector('.share-scope-tabs')
      if (tabsRoot) tabsRoot.dataset.scope = scope
      document.querySelectorAll('.share-tab').forEach(b => {
        b.classList.toggle('active', b.dataset.scope === scope)
      })
      bind()
      showModal('share-modal')
      await load()
    }
  }
})()

async function showShareModal() {
  await shareCardManager.open('day')
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
      listEl.innerHTML = renderEmptyState('暂无寄语', '添加一句鼓励自己的话，会显示在主页。', 'compact-empty')
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
    listEl.innerHTML = renderErrorState('寄语加载失败', '请关闭后重新打开。')
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
      resetScrollPosition(settingsPanel)
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
    if (!list.length) {
      historyListEl.innerHTML = `<li class="history-empty-item">${renderEmptyState('暂无学习记录', '完成一次学习后，这里会按时间线展示。', 'history-empty')}</li>`
      return
    }
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

function isUpdateShortcutBlocked(action) {
  if (!updateModalOpen && !updateInstalling) return false
  if (action === 'end-and-quit') return updateInstalling
  return true
}

// ---------- 全局快捷键事件 ----------
function bindGlobalShortcuts() {
  window.studyRecord.onGlobalShortcut(async (action) => {
    if (isUpdateShortcutBlocked(action)) return
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
    window.studyRecord.onUpdaterStatus(({ state, manual, version, message, percent }) => {
      // 任何渠道发现新版本（自动 / 手动）都点亮按钮
      if (state === 'available' && updateBtn) {
        updateBtn.classList.add('has-update')
        updateBtn.title = `发现新版本 ${version || ''}，点击查看`
      }
      // 下载进度：更新弹窗内进度条
      if (state === 'downloading') {
        const progressBar = document.getElementById('update-progress-bar')
        const progressText = document.getElementById('update-progress-text')
        const downloadingText = document.getElementById('update-downloading-text')
        const pct = Math.round(percent || 0)
        if (progressBar) progressBar.style.setProperty('--dl-progress', `${pct}%`)
        if (progressText) progressText.textContent = `${pct}%`
        if (downloadingText) downloadingText.textContent = `正在下载更新 ${pct}%...`
      }
      // 下载完成：弹窗内提示，保持遮罩直到安装流程接管
      if (state === 'downloaded') {
        const downloadingText = document.getElementById('update-downloading-text')
        const nowBtn = document.getElementById('update-now-btn')
        if (downloadingText) downloadingText.textContent = '下载完成，正在安装...'
        if (nowBtn) nowBtn.textContent = '即将安装...'
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

  const petsBtn = document.getElementById('open-pets')
  if (petsBtn) petsBtn.addEventListener('click', showPetModal)

  const exportBtn = document.getElementById('open-export')
  if (exportBtn) exportBtn.addEventListener('click', showExportModal)

  const shareBtn = document.getElementById('open-share')
  if (shareBtn) shareBtn.addEventListener('click', showShareModal)

  const quotesBtn = document.getElementById('open-quotes')
  if (quotesBtn) quotesBtn.addEventListener('click', showQuotesModal)
}

// ---------- 卸载清理 ----------
window.addEventListener('beforeunload', () => {
  if (todayTimeUpdateTimer) clearInterval(todayTimeUpdateTimer)
  if (updateTimer) clearInterval(updateTimer)
  if (petManager) petManager.stopAllTimers()
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
  await initOnboarding()

  // 注入版本号到标题栏
  try {
    const v = await window.studyRecord.getAppVersion()
    const versionEl = document.getElementById('brand-version')
    if (versionEl && v) versionEl.textContent = `v${v}`
  } catch (e) {}

  // 加载初始数据
  await loadHistoryAndToday()
  await petManager.init()
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
