import express from 'express'
import { db, run, all, get } from './db.js'

const app = express()
app.use(express.json())
const PORT = 4170

/* ================= 裁判排班：常量与工具 ================= */
const ROLE_NAME = { chief: '主裁', assistant: '助理裁判', recorder: '记录台' }
const ROLES = Object.keys(ROLE_NAME)

function addLog(action, matchId, refereeId, detail, reason, operator) {
  run(`INSERT INTO assignment_logs (action,match_id,referee_id,detail,reason,operator)
       VALUES (?,?,?,?,?,?)`, action, matchId ?? null, refereeId ?? null, detail ?? null, reason ?? null, operator || '组委会')
}
function matchTitle(m) {
  if (!m) return '场次#' + m
  const sp = get('SELECT name FROM sports WHERE id=?', m.sport_id)?.name || ''
  const ta = m.team_a ? get('SELECT name FROM teams WHERE id=?', m.team_a)?.name : '待定'
  const tb = m.team_b ? get('SELECT name FROM teams WHERE id=?', m.team_b)?.name : '待定'
  return `${sp}·${m.stage}${m.group_name ? m.group_name : ''} ${ta || '待定'} VS ${tb || '待定'}（${m.time_label || '时间待定'}）`
}
// 裁判在指定时段的全部"在派"待赛场次（排除 excludeMatchId 自身；assistant/recorder 同样算占用）
function refBusyMatches(refereeId, timeLabel, excludeMatchId) {
  if (!timeLabel) return []
  const rows = all(`SELECT a.id aid, a.role, m.* FROM assignments a JOIN matches m ON m.id=a.match_id
                    WHERE a.referee_id=? AND a.status='assigned' AND m.status='scheduled' AND m.time_label=?`, refereeId, timeLabel)
  return rows.filter(r => r.id !== excludeMatchId)
}
// 某场待赛在同场地同时段的其它场次
function venueClashMatches(venueId, timeLabel, excludeMatchId) {
  if (!venueId || !timeLabel) return []
  return all(`SELECT * FROM matches WHERE venue_id=? AND time_label=? AND status='scheduled' AND id<>?`, venueId, timeLabel, excludeMatchId ?? 0)
}
// 场地名 → id（种子与动态编排均按名称解析，避免自增 id 漂移）
function vid(name) { return get('SELECT id FROM venues WHERE name=?', name)?.id ?? null }
// 裁判专长与项目是否匹配（未登记专长视为综合执法，可派所有项目）
function refSportOk(referee, sportId) {
  if (!referee || !referee.sport) return true
  const sp = get('SELECT name, category FROM sports WHERE id=?', sportId)
  return referee.sport === sp?.name || referee.sport === sp?.category
}
// 为一场待赛挑选主裁：专长匹配优先 → 当前待赛负荷低优先 → 无时间冲突
function pickChiefFor(m) {
  if (!m.time_label) return null
  const spoName = get('SELECT name FROM sports WHERE id=?', m.sport_id)?.name
  const loadOf = rid => get(`SELECT COUNT(*) c FROM assignments a JOIN matches mm ON mm.id=a.match_id
    WHERE a.referee_id=? AND a.status='assigned' AND mm.status='scheduled'`, rid)?.c ?? 0
  const cands = all(`SELECT * FROM referees WHERE status IN ('就绪','在岗') ORDER BY id`)
    .filter(r => refSportOk(r, m.sport_id))
    .filter(r => refBusyMatches(r.id, m.time_label, m.id).length === 0)
    .filter(r => !get(`SELECT id FROM assignments WHERE match_id=? AND referee_id=? AND status='assigned'`, m.id, r.id))
    .map(r => ({ r, pri: r.sport === spoName ? 0 : 1, load: loadOf(r.id) }))
    .sort((a, b) => a.pri - b.pri || a.load - b.load || a.r.id - b.r.id)
  return cands[0]?.r || null
}

/* ================= 排班 / 调班 / 解除 ================= */
// 分配裁判到场次。返回 assignment；冲突或专长不符时默认拒绝，force=true 强制安排并留痕
function assignReferee(matchId, refereeId, role = 'chief', operator = '组委会', reason = '', force = false) {
  const m = get('SELECT * FROM matches WHERE id=?', matchId)
  if (!m) throw new Error('场次不存在')
  if (m.status !== 'scheduled') throw new Error('仅待赛场次可安排裁判（完赛/取消场次执法记录已归档）')
  if (!m.team_a || !m.team_b) throw new Error('该场次对阵尚未确定，编排后才能安排裁判')
  const ref = get('SELECT * FROM referees WHERE id=?', refereeId)
  if (!ref) throw new Error('裁判不存在')
  if (ref.status && ref.status !== '就绪' && ref.status !== '在岗') throw new Error(`裁判当前状态为「${ref.status}」，暂不可排班`)
  if (!ROLES.includes(role)) throw new Error('执法角色无效')
  const dup = get(`SELECT id FROM assignments WHERE match_id=? AND referee_id=? AND status='assigned'`, matchId, refereeId)
  if (dup) throw new Error('该裁判已在本场次执法名单中')

  const busy = refBusyMatches(refereeId, m.time_label, matchId)
  const sportOk = refSportOk(ref, m.sport_id)
  if (!force && busy.length) {
    const err = new Error(`时间冲突：${ref.name} 在 ${m.time_label} 已被安排执法 ${busy.length} 场`)
    err.code = 'CONFLICT'
    err.conflicts = { referee: busy.map(b => ({ match_id: b.id, title: matchTitle(b) })) }
    throw err
  }
  if (!force && !sportOk) {
    const err = new Error(`专长不符：${ref.name} 的专长为「${ref.sport}」，本场为「${get('SELECT name FROM sports WHERE id=?', m.sport_id).name}」`)
    err.code = 'SKILL_MISMATCH'
    throw err
  }
  const r = run(`INSERT INTO assignments (match_id,referee_id,role,status) VALUES (?,?,?,'assigned')`, matchId, refereeId, role)
  const aid = Number(r.lastInsertRowid)
  const forcedNotes = []
  if (busy.length) forcedNotes.push(`强制覆盖时间冲突 ${busy.length} 场`)
  if (!sportOk) forcedNotes.push('跨专长安排')
  addLog(busy.length || !sportOk ? 'force_assign' : 'assign', matchId, refereeId,
    `${matchTitle(m)} → ${ref.name} 担任${ROLE_NAME[role]}${forcedNotes.length ? '（' + forcedNotes.join('，') + '）' : ''}`, reason, operator)
  return { id: aid, forced: !!(busy.length || !sportOk) }
}

function releaseAssignment(assignmentId, operator = '组委会', reason = '') {
  const a = get('SELECT * FROM assignments WHERE id=?', assignmentId)
  if (!a) throw new Error('执法安排不存在')
  if (a.status !== 'assigned') throw new Error('该安排已解除，无需重复操作')
  const m = get('SELECT * FROM matches WHERE id=?', a.match_id)
  if (m && m.status !== 'scheduled') throw new Error('仅待赛场次可解除执法安排')
  const ref = get('SELECT name FROM referees WHERE id=?', a.referee_id)
  run(`UPDATE assignments SET status='released', released_at=datetime('now','localtime') WHERE id=?`, assignmentId)
  addLog('release', a.match_id, a.referee_id, `${matchTitle(m)}：${ref?.name || '裁判'} 解除${ROLE_NAME[a.role] || '执法'}安排`, reason, operator)
  return { ok: true }
}

// 临时调班：target_id 为空=为 aid 改派裁判 new_referee_id；target_id 有值=两场裁判对调
function reassignAssignment(assignmentId, { target_id, new_referee_id, reason, operator } = {}) {
  const a = get('SELECT * FROM assignments WHERE id=?', assignmentId)
  if (!a) throw new Error('执法安排不存在')
  if (a.status !== 'assigned') throw new Error('该安排已解除，不能调班')
  const m = get('SELECT * FROM matches WHERE id=?', a.match_id)
  if (!m || m.status !== 'scheduled') throw new Error('仅待赛场次支持临时调班')
  if (!reason || !String(reason).trim()) throw new Error('调班必须填写原因并留痕')
  const op = operator || '组委会'

  if (target_id) {
    const b = get('SELECT * FROM assignments WHERE id=?', Number(target_id))
    if (!b || b.status !== 'assigned') throw new Error('对调目标安排不存在或已解除')
    if (b.id === a.id) throw new Error('不能与自身对调')
    const mb = get('SELECT * FROM matches WHERE id=?', b.match_id)
    if (!mb || mb.status !== 'scheduled') throw new Error('对调场次不是待赛状态')
    // 专长校验：两名裁判对调后均需能执法目标场次
    const refA0 = get('SELECT * FROM referees WHERE id=?', a.referee_id)
    const refB0 = get('SELECT * FROM referees WHERE id=?', b.referee_id)
    if (!refSportOk(refA0, mb.sport_id)) {
      const err = new Error(`专长不符：${refA0.name} 的专长为「${refA0.sport}」，不能调至 ${get('SELECT name FROM sports WHERE id=?', mb.sport_id).name} 场次`)
      err.code = 'SKILL_MISMATCH'; throw err
    }
    if (!refSportOk(refB0, m.sport_id)) {
      const err = new Error(`专长不符：${refB0.name} 的专长为「${refB0.sport}」，不能调至 ${get('SELECT name FROM sports WHERE id=?', m.sport_id).name} 场次`)
      err.code = 'SKILL_MISMATCH'; throw err
    }
    // 调班后冲突预检
    const busyA = refBusyMatches(a.referee_id, mb.time_label, m.id)
    if (busyA.length) {
      const err = new Error(`调班冲突：对调后该裁判在 ${mb.time_label} 仍有其它执法`)
      err.code = 'CONFLICT'
      err.conflicts = { referee: busyA.map(x => ({ match_id: x.id, title: matchTitle(x) })) }
      throw err
    }
    const busyB = refBusyMatches(b.referee_id, m.time_label, mb.id)
    if (busyB.length) {
      const err = new Error(`调班冲突：对调后该裁判在 ${m.time_label} 仍有其它执法`)
      err.code = 'CONFLICT'
      err.conflicts = { referee: busyB.map(x => ({ match_id: x.id, title: matchTitle(x) })) }
      throw err
    }
    const r1 = run(`INSERT INTO assignments (match_id,referee_id,role,status) VALUES (?,?,?,'assigned')`, mb.id, a.referee_id, a.role)
    const r2 = run(`INSERT INTO assignments (match_id,referee_id,role,status) VALUES (?,?,?,'assigned')`, m.id, b.referee_id, b.role)
    run(`UPDATE assignments SET status='released', released_at=datetime('now','localtime') WHERE id IN (?,?)`, a.id, b.id)
    const refA = get('SELECT name FROM referees WHERE id=?', a.referee_id)
    const refB = get('SELECT name FROM referees WHERE id=?', b.referee_id)
    const detail = `${matchTitle(m)}：${refA.name} ⇄ ${refB.name}（${matchTitle(mb)}）对调`
    addLog('swap', m.id, b.referee_id, detail, reason, op)
    addLog('swap', mb.id, a.referee_id, detail, reason, op)
    return { ok: true, swapped: true, new_a: Number(r2.lastInsertRowid), new_b: Number(r1.lastInsertRowid) }
  }

  const newId = Number(new_referee_id)
  if (!Number.isInteger(newId)) throw new Error('请选择改派裁判')
  const newRef = get('SELECT * FROM referees WHERE id=?', newId)
  if (!newRef) throw new Error('裁判不存在')
  if (newId === a.referee_id) throw new Error('新裁判与原裁判相同')
  if (!refSportOk(newRef, m.sport_id)) {
    const err = new Error(`专长不符：${newRef.name} 的专长为「${newRef.sport}」，本场为「${get('SELECT name FROM sports WHERE id=?', m.sport_id).name}」`)
    err.code = 'SKILL_MISMATCH'; throw err
  }
  const busy = refBusyMatches(newId, m.time_label, m.id)
  if (busy.length) {
    const err = new Error(`时间冲突：${newRef.name} 在 ${m.time_label} 已被安排执法 ${busy.length} 场`)
    err.code = 'CONFLICT'
    err.conflicts = { referee: busy.map(x => ({ match_id: x.id, title: matchTitle(x) })) }
    throw err
  }
  const dup = get(`SELECT id FROM assignments WHERE match_id=? AND referee_id=? AND status='assigned'`, m.id, newId)
  if (dup) throw new Error('该裁判已在本场次执法名单中')
  const r = run(`INSERT INTO assignments (match_id,referee_id,role,status) VALUES (?,?,?,'assigned')`, m.id, newId, a.role)
  run(`UPDATE assignments SET status='released', released_at=datetime('now','localtime') WHERE id=?`, a.id)
  const oldRef = get('SELECT name FROM referees WHERE id=?', a.referee_id)
  addLog('reassign', m.id, newId, `${matchTitle(m)}：${ROLE_NAME[a.role]}由 ${oldRef.name} 改为 ${newRef.name}`, reason, op)
  return { ok: true, swapped: false, new_a: Number(r.lastInsertRowid) }
}

// 智能排班：为尚无主裁的待赛场次，按"专长匹配 → 无时间冲突"自动安排主裁
function autoAssign(operator = '组委会') {
  const need = all(`SELECT m.* FROM matches m WHERE m.status='scheduled'
                    AND m.team_a IS NOT NULL AND m.team_b IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.match_id=m.id AND a.role='chief' AND a.status='assigned')`)
  const assigned = [], skipped = []
  for (const m of need) {
    if (!m.time_label) { skipped.push({ match_id: m.id, title: matchTitle(m), reason: '未排定开赛时间' }); continue }
    const pick = pickChiefFor(m)
    if (!pick) { skipped.push({ match_id: m.id, title: matchTitle(m), reason: '该时段无可用（专长匹配且无冲突）裁判' }); continue }
    run(`INSERT INTO assignments (match_id,referee_id,role,status) VALUES (?,?, 'chief','assigned')`, m.id, pick.id)
    addLog('auto_assign', m.id, pick.id, `${matchTitle(m)} → ${pick.name} 自动排班为主裁`, '智能排班', operator)
    assigned.push({ match_id: m.id, title: matchTitle(m), referee: pick.name })
  }
  return { assigned, skipped }
}

// 赛程变更：调整场次时间/场地，联动校验该场全部执法安排与场地占用
function updateMatchSchedule(matchId, { time_label, venue_id, operator, reason, force }) {
  const m = get('SELECT * FROM matches WHERE id=?', matchId)
  if (!m) throw new Error('场次不存在')
  if (m.status !== 'scheduled') throw new Error('仅待赛场次可调整赛程（完赛场次时间锁定）')
  const newTime = time_label == null ? m.time_label : String(time_label).trim()
  let newVenue = venue_id == null ? m.venue_id : Number(venue_id)
  if (newVenue && !get('SELECT id FROM venues WHERE id=?', newVenue)) throw new Error('场地不存在')
  const venueName = newVenue ? get('SELECT name FROM venues WHERE id=?', newVenue)?.name : null

  // 先应用变更，再基于"变更后"的全局排班状态检测（正确处理多场同时改期等交叉场景）
  const oldVenue = m.venue_id ? get('SELECT name FROM venues WHERE id=?', m.venue_id)?.name : '未指定'
  run(`UPDATE matches SET time_label=?, venue_id=? WHERE id=?`, newTime, newVenue || null, matchId)

  const clashRows = newVenue ? venueClashMatches(newVenue, newTime, matchId) : []
  const refConflicts = []
  all(`SELECT a.*, r.name rname FROM assignments a JOIN referees r ON r.id=a.referee_id WHERE a.match_id=? AND a.status='assigned'`, matchId)
    .forEach(a => refBusyMatches(a.referee_id, newTime, matchId)
      .forEach(b => refConflicts.push({ referee_id: a.referee_id, referee: a.rname, match_id: b.id, title: matchTitle(b) })))

  if (!force && (clashRows.length || refConflicts.length)) {
    // 回滚变更
    run(`UPDATE matches SET time_label=?, venue_id=? WHERE id=?`, m.time_label, m.venue_id, matchId)
    const err = new Error('赛程变更将引发场地撞场或裁判时间冲突，请确认后强制生效或先调班')
    err.code = 'CONFLICT'
    err.conflicts = { venue: clashRows.map(c => ({ match_id: c.id, title: matchTitle(c) })), referee: refConflicts }
    throw err
  }
  addLog('match_change', matchId, null,
    `${matchTitle(m)}：时间 ${m.time_label || '未指定'} → ${newTime || '未指定'}；场地 ${oldVenue} → ${venueName || '未指定'}`,
    reason || (force ? '强制变更（已存在冲突）' : '赛程调整'), operator || '组委会')
  return { ok: true }
}

// 联动：场次完赛 → 执法安排归档
function lockAssignmentsOnFinish(m, operator = '系统') {
  const as = all(`SELECT * FROM assignments WHERE match_id=? AND status='assigned'`, m.id)
  as.forEach(a => {
    const r = get('SELECT name FROM referees WHERE id=?', a.referee_id)
    addLog('match_finish', m.id, a.referee_id, `${matchTitle(m)} 完赛，${r?.name || '裁判'} 的${ROLE_NAME[a.role]}安排归档`, null, operator)
  })
}
// 联动：场次取消（成绩取消）→ 解除全部在派安排
function releaseAssignmentsOfMatch(m, why, operator = '系统') {
  const as = all(`SELECT * FROM assignments WHERE match_id=? AND status='assigned'`, m.id)
  as.forEach(a => {
    run(`UPDATE assignments SET status='released', released_at=datetime('now','localtime') WHERE id=?`, a.id)
    const r = get('SELECT name FROM referees WHERE id=?', a.referee_id)
    addLog('void_release', m.id, a.referee_id, `${matchTitle(m)}：${r?.name || '裁判'} 的${ROLE_NAME[a.role]}安排随场次取消解除（${why}）`, why, operator)
  })
}

/* ================= 种子数据 ================= */
function seed() {
  if (get('SELECT COUNT(*) c FROM sports').c > 0) return

  // 单位
  const units = [['雷霆学院', '#ff7a2f'], ['飞鹰学院', '#2f9bff'], ['雄狮学院', '#2ecc71'], ['星河学院', '#9b59b6']]
  const unitId = {}
  units.forEach((u, i) => { run('INSERT INTO units (name,color) VALUES (?,?)', u[0], u[1]); unitId[u[0]] = i + 1 })

  // 场地
  const venues = ['中心篮球馆', '五人足球场', '羽毛球馆', '田径场', '备用2号场']
  venues.forEach(v => run('INSERT INTO venues (name,type) VALUES (?,?)', v, 'arena'))

  // 裁判（专长 / 等级）
  const refRows = [
    ['王裁判', '篮球', '主裁'], ['李裁判', '篮球', '助理裁判'],
    ['张裁判', '五人制足球', '主裁'], ['赵裁判', '五人制足球', '助理裁判'],
    ['陈裁判', '羽毛球', '主裁'], ['孙裁判', null, '主裁']   // 综合执法
  ]
  const refId = {}
  refRows.forEach(([n, sp, lv]) => { const r = run('INSERT INTO referees (name,sport,level,status) VALUES (?,?,?,?)', n, sp, lv, '就绪'); refId[n] = Number(r.lastInsertRowid) })

  // 项目
  const sp = (name, cat, fmt, venue) => { const r = run('INSERT INTO sports (name,category,format,venue) VALUES (?,?,?,?)', name, cat, fmt, venue); return Number(r.lastInsertRowid) }
  const spBasket = sp('篮球', '球类', 'roundrobin', '中心篮球馆')
  const spFoot = sp('五人制足球', '球类', 'group_knockout', '五人足球场')
  const spBad = sp('羽毛球', '球类', 'knockout', '羽毛球馆')
  const sp100 = sp('田径 · 100米', '田径', 'track', '田径场')

  // 队伍
  const mk = (name, unit) => { const r = run('INSERT INTO teams (name,unit_id,sport_id) VALUES (?,?,?)', name, unitId[unit], 0); return Number(r.lastInsertRowid) }
  // 篮球 4 队
  const B = ['雷霆学院', '飞鹰学院', '雄狮学院', '星河学院'].map(u => mk(u === '雷霆学院' ? '雷霆队' : u === '飞鹰学院' ? '飞鹰队' : u === '雄狮学院' ? '雄狮队' : '星河队', u))
  B.forEach(id => run('UPDATE teams SET sport_id=? WHERE id=?', spBasket, id))
  // 足球 6 队
  const F = [
    ['雷霆队', '雷霆学院'], ['飞鹰队', '飞鹰学院'], ['雄狮队', '雄狮学院'],
    ['星河队', '星河学院'], ['闪电队', '雷霆学院'], ['烈焰队', '雄狮学院']
  ].map(([n, u]) => mk(n, u))
  F.forEach(id => run('UPDATE teams SET sport_id=? WHERE id=?', spFoot, id))
  // 羽毛球 4 队（同名队伍）
  const G = ['雷霆队', '飞鹰队', '雄狮队', '星河队'].map((n, i) => mk(n, units[i][0]))
  G.forEach(id => run('UPDATE teams SET sport_id=? WHERE id=?', spBad, id))
  // 田径 8 名运动员
  const runners = [['林一', '雷霆学院'], ['周楠', '飞鹰学院'], ['陈晨', '雄狮学院'], ['顾言', '星河学院'], ['徐凯', '雷霆学院'], ['韩雪', '飞鹰学院'], ['陆鸣', '雄狮学院'], ['宋词', '星河学院']]
  const slotsA = ['09:00', '09:40', '10:40']
  const slotsB = ['09:20', '10:00', '11:00']
  runners.forEach(([n, u]) => { run('INSERT INTO athletes (name,unit_id,sport_id) VALUES (?,?,?)', n, unitId[u], sp100) })

  // 循环赛助手
  const pairs = arr => { const p = []; for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) p.push([arr[i], arr[j]]); return p }

  const venueById = vid('中心篮球馆')

  // —— 篮球：4队 单循环 6 场
  let ono = 0
  pairs(B).forEach(([a, b]) => {
    ono++
    run('INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?)', spBasket, '循环', a, b, venueById, ono, ['09:00', '09:20', '09:40', '10:00', '10:20', '10:40'][(ono - 1) % 6], 'scheduled')
  })

  // —— 足球：分 AB 两组（A: 雷霆/雄狮/闪电  B: 飞鹰/星河/烈焰），组内循环 6 场；两组时段错开避免同场撞档 ——
  const grpA = [F[0], F[2], F[4]]
  const grpB = [F[1], F[3], F[5]]
  const footIds = { A: [], B: [] }
  ono = 0
  pairs(grpA).forEach(([a, b]) => { ono++; const r = run('INSERT INTO matches (sport_id,stage,group_name,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?,?)', spFoot, '小组', 'A组', a, b, vid('五人足球场'), ono, slotsA[(ono - 1) % 3], 'scheduled'); footIds.A.push(Number(r.lastInsertRowid)) })
  pairs(grpB).forEach(([a, b]) => { ono++; const r = run('INSERT INTO matches (sport_id,stage,group_name,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?,?)', spFoot, '小组', 'B组', a, b, vid('五人足球场'), ono, slotsB[(ono - 1) % 3], 'scheduled'); footIds.B.push(Number(r.lastInsertRowid)) })

  // —— 羽毛球：半决赛 2 场（固定对位），决赛/季军由编排按钮产生 ——
  const badSemi1 = run('INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?)', spBad, '半决赛', G[0], G[1], vid('羽毛球馆'), 1, '09:30', 'scheduled')
  const badSemi2 = run('INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?)', spBad, '半决赛', G[2], G[3], vid('羽毛球馆'), 2, '10:00', 'scheduled')
  const badIds = [Number(badSemi1.lastInsertRowid), Number(badSemi2.lastInsertRowid)]

  rebuildStandings()

  // —— 预录部分成绩（演示看板有内容）——
  const sc = (sport, a, b, sa, sb) => { const m = get('SELECT id FROM matches WHERE sport_id=? AND team_a=? AND team_b=? AND status=\'scheduled\'', sport, a, b); if (m) finishMatch(m.id, sa, sb) }
  // 篮球全录 → 决出冠军
  sc(spBasket, B[0], B[1], 78, 70); sc(spBasket, B[2], B[3], 65, 71)
  sc(spBasket, B[0], B[2], 82, 60); sc(spBasket, B[1], B[3], 69, 74)
  sc(spBasket, B[0], B[3], 58, 66); sc(spBasket, B[1], B[2], 88, 77)
  // 足球小组录 4 场，留每组末轮 2 场未赛（演示排班/调班）
  sc(spFoot, grpA[0], grpA[1], 3, 1); sc(spFoot, grpA[1], grpA[2], 2, 2)
  sc(spFoot, grpB[0], grpB[1], 1, 3); sc(spFoot, grpB[1], grpB[2], 2, 1)
  // 羽毛球两场半决赛都录 → 可编排决赛
  sc(spBad, G[0], G[1], 21, 16); sc(spBad, G[2], G[3], 18, 21)
  // 田径成绩
  const marks = [10.62, 10.88, 11.05, 11.21, 11.35, 11.42, 11.58, 11.79]
  all('SELECT id,name FROM athletes').forEach((ath, i) => run('INSERT INTO entries (sport_id,athlete_id,mark,rank,unit_id) VALUES (?,?,?,?,?)', sp100, ath.id, marks[i], i + 1, get('SELECT unit_id FROM athletes WHERE id=?', ath.id).unit_id))

  // —— 历史执法安排（已完赛场次：静默回填，作为工作量统计口径）——
  const seedHist = (mid, rid, role = 'chief') => run(`INSERT INTO assignments (match_id,referee_id,role,status) VALUES (?,?,?,'assigned')`, mid, rid, role)
  const footDone = all(`SELECT id FROM matches WHERE sport_id=? AND status='finished' ORDER BY id`, spFoot).map(x => x.id)
  all(`SELECT id FROM matches WHERE sport_id=? AND status='finished' ORDER BY id`, spBasket).forEach((x, i) => seedHist(x.id, refId['王裁判'])); seedHist(get(`SELECT id FROM matches WHERE sport_id=? AND status='finished' ORDER BY id LIMIT 1`, spBasket).id, refId['李裁判'], 'recorder')
  footDone.forEach(x => seedHist(x, refId['张裁判']))
  badIds.forEach(x => seedHist(x, refId['陈裁判']))

  // —— 为已有队伍/运动员补建「已通过」报名记录（完整审计轨迹）——
  all('SELECT id, name, unit_id, sport_id FROM teams').forEach(t => {
    if (!get('SELECT id FROM registrations WHERE team_id=?', t.id)) {
      run(`INSERT INTO registrations (kind,unit_id,sport_id,team_id,name,status,reviewer,reviewed_at)
           VALUES ('team',?,?,?,?,'approved','组委会',datetime('now','localtime'))`, t.unit_id, t.sport_id, t.id, t.name)
    }
  })
  all('SELECT id, name, unit_id, sport_id FROM athletes').forEach(a => {
    if (!get('SELECT id FROM registrations WHERE athlete_id=?', a.id)) {
      run(`INSERT INTO registrations (kind,unit_id,sport_id,athlete_id,name,status,reviewer,reviewed_at)
           VALUES ('athlete',?,?,?,?,'approved','组委会',datetime('now','localtime'))`, a.unit_id, a.sport_id, a.id, a.name)
    }
  })

  // —— 演示：新增待审核报名（队伍/运动员），由组委会审核资格与名额 ——
  const addPendingTeam = (name, unit, sport) => {
    const r = run('INSERT INTO teams (name,unit_id,sport_id,status) VALUES (?,?,?,?)', name, unitId[unit], sport, 'pending')
    const tid = Number(r.lastInsertRowid)
    run('INSERT INTO registrations (kind,unit_id,sport_id,team_id,name,status) VALUES (?,?,?,?,?,?)', 'team', unitId[unit], sport, tid, name, 'pending')
  }
  const addPendingAthlete = (name, unit, sport) => {
    const r = run('INSERT INTO athletes (name,unit_id,sport_id,status) VALUES (?,?,?,?)', name, unitId[unit], sport, 'pending')
    const aid = Number(r.lastInsertRowid)
    run('INSERT INTO registrations (kind,unit_id,sport_id,athlete_id,name,status) VALUES (?,?,?,?,?,?)', 'athlete', unitId[unit], sport, aid, name, 'pending')
  }
  addPendingTeam('雷霆三队', '雷霆学院', spBasket)
  addPendingTeam('飞鹰二队', '飞鹰学院', spFoot)
  addPendingAthlete('许诺', '星河学院', sp100)

  // —— 淘汰赛按真实赛果动态生成（与赛程编排页同一入口）——
  generateKO(spBad)
  // 决赛已自动排班；季军战留空，展示"待安排"覆盖率
  const finalM = get(`SELECT * FROM matches WHERE sport_id=? AND stage='决赛'`, spBad)
  if (finalM && !get(`SELECT id FROM assignments WHERE match_id=? AND role='chief' AND status='assigned'`, finalM.id)) {
    assignReferee(finalM.id, refId['陈裁判'], 'chief', '组委会', '淘汰赛编排后联动排班')
  }
  const thirdM = get(`SELECT * FROM matches WHERE sport_id=? AND stage='季军'`, spBad)
  if (thirdM) {
    const thirdChief = get(`SELECT id FROM assignments WHERE match_id=? AND role='chief' AND status='assigned'`, thirdM.id)
    if (thirdChief) releaseAssignment(thirdChief.id, '组委会', '季军战裁判长待定，暂时留空待排班')
  }

  // —— 待赛小组末轮排班 + 一次临时调班演示（完整留痕）——
  const mA3 = get(`SELECT id FROM matches WHERE sport_id=? AND group_name='A组' AND status='scheduled'`, spFoot).id
  const mB3 = get(`SELECT id FROM matches WHERE sport_id=? AND group_name='B组' AND status='scheduled'`, spFoot).id
  const aAss = assignReferee(mA3, refId['赵裁判'], 'chief', '组委会', '末轮初排')
  assignReferee(mB3, refId['张裁判'], 'chief', '组委会', '末轮初排')
  reassignAssignment(aAss.id, { target_id: get(`SELECT id FROM assignments WHERE match_id=? AND role='chief' AND status='assigned'`, mB3).id, reason: '赵裁判临时请假，末轮主裁对调', operator: '裁判长' })

  recomputeMedals()
}
/* ================= 积分与奖牌 ================= */
function rebuildStandings(sportId) {
  const sports = sportId ? [sportId] : all('SELECT * FROM sports').map(s => s.id)
  sports.forEach(sid => {
    all('SELECT id FROM standings WHERE sport_id=?', sid).forEach(r => run('DELETE FROM standings WHERE id=?', r.id))
    // 仅已通过资格审核的队伍纳入积分榜
    const teams = all(`SELECT id FROM teams WHERE sport_id=? AND status='approved'`, sid).map(t => t.id)
    teams.forEach(t => run('INSERT INTO standings (sport_id,team_id) VALUES (?,?)', sid, t))
    const done = all(`SELECT * FROM matches WHERE sport_id=? AND status='finished'`, sid)
    done.forEach(m => {
      const rowA = get('SELECT * FROM standings WHERE sport_id=? AND team_id=?', sid, m.team_a)
      const rowB = get('SELECT * FROM standings WHERE sport_id=? AND team_id=?', sid, m.team_b)
      if (!rowA || !rowB) return
      const sa = m.score_a, sb = m.score_b
      // 已存在记录则不重复累加
      if (m._acc) return
      rowA.play += 1; rowB.play += 1
      rowA.gf += sa; rowA.ga += sb; rowB.gf += sb; rowB.ga += sa
      if (sa > sb) { rowA.win++; rowB.lose++; rowA.points += 3 }
      else if (sa < sb) { rowB.win++; rowA.lose++; rowB.points += 3 }
      else { rowA.draw++; rowB.draw++; rowA.points += 1; rowB.points += 1 }
      run('UPDATE standings SET play=?,win=?,draw=?,lose=?,gf=?,ga=?,points=? WHERE id=?',
        rowA.play, rowA.win, rowA.draw, rowA.lose, rowA.gf, rowA.ga, rowA.points, rowA.id)
      run('UPDATE standings SET play=?,win=?,draw=?,lose=?,gf=?,ga=?,points=? WHERE id=?',
        rowB.play, rowB.win, rowB.draw, rowB.lose, rowB.gf, rowB.ga, rowB.points, rowB.id)
      m._acc = 1
    })
    // 排名
    const rows = all('SELECT * FROM standings WHERE sport_id=?', sid).sort((x, y) => y.points - x.points || (y.gf - y.ga) - (x.gf - x.ga) || x.id - y.id)
    rows.forEach((r, i) => run('UPDATE standings SET rank=? WHERE id=?', i + 1, r.id))
  })
}
function unitOfTeam(teamId) {
  const t = teamId == null ? null : get('SELECT unit_id FROM teams WHERE id=?', teamId)
  return t ? t.unit_id : null
}
function recomputeMedals() {
  all('SELECT unit_id FROM medals').forEach(r => run('DELETE FROM medals WHERE unit_id=?', r.unit_id))
  const add = (uid, medal) => { if (!uid) return; const row = get('SELECT * FROM medals WHERE unit_id=?', uid); const k = medal === 'gold' ? 'gold' : medal === 'silver' ? 'silver' : 'bronze'; if (row) run(`UPDATE medals SET ${k}=${k}+1 WHERE unit_id=?`, uid); else run(`INSERT INTO medals (unit_id,${k}) VALUES (?,1)`, uid) }
  const sports = all('SELECT * FROM sports')
  sports.forEach(spo => {
    if (spo.format === 'track') {
      const tops = all('SELECT * FROM entries WHERE sport_id=? ORDER BY mark ASC LIMIT 3', spo.id)
      add(tops[0]?.unit_id, 'gold'); add(tops[1]?.unit_id, 'silver'); add(tops[2]?.unit_id, 'bronze')
    } else if (spo.format === 'roundrobin') {
      const champ = get('SELECT s.*, t.unit_id FROM standings s JOIN teams t ON t.id=s.team_id WHERE s.sport_id=? AND s.rank=1', spo.id)
      const second = get('SELECT s.*, t.unit_id FROM standings s JOIN teams t ON t.id=s.team_id WHERE s.sport_id=? AND s.rank=2', spo.id)
      const third = get('SELECT s.*, t.unit_id FROM standings s JOIN teams t ON t.id=s.team_id WHERE s.sport_id=? AND s.rank=3', spo.id)
      if (all('SELECT * FROM standings WHERE sport_id=?', spo.id).some(r => r.play > 0)) { add(champ?.unit_id, 'gold'); add(second?.unit_id, 'silver'); add(third?.unit_id, 'bronze') }
    } else {
      const fin = get(`SELECT * FROM matches WHERE sport_id=? AND status='finished' AND stage='决赛'`, spo.id)
      if (fin && fin.winner != null) {
        add(unitOfTeam(fin.winner), 'gold')
        add(unitOfTeam(fin.winner === fin.team_a ? fin.team_b : fin.team_a), 'silver')
      }
      const thirdM = get(`SELECT * FROM matches WHERE sport_id=? AND status='finished' AND stage='季军'`, spo.id)
      if (thirdM && thirdM.winner != null) add(unitOfTeam(thirdM.winner), 'bronze')
    }
  })
}
/* ================= 编排下一轮（KO） ================= */
const STAGE_ORDER = { '小组': 1, '循环': 1, '半决赛': 2, '决赛': 3, '季军': 3 }
const KO_STAGES = ['半决赛', '决赛', '季军']   // 淘汰赛阶段：不允许平分收场
const loserOf = m => (m.winner === m.team_a ? m.team_b : m.team_a)
function finishMatch(id, sa, sb, tbA = null, tbB = null) {
  const m = get('SELECT * FROM matches WHERE id=?', id)
  let winner = null, ta = null, tb = null
  if (sa > sb) winner = m.team_a
  else if (sb > sa) winner = m.team_b
  else if (KO_STAGES.includes(m.stage)) {
    // 淘汰赛常规时间平分：必须录入加时/点球决胜比分，且决胜不能再次持平
    ta = tbA === null || tbA === undefined || tbA === '' ? null : Number(tbA)
    tb = tbB === null || tbB === undefined || tbB === '' ? null : Number(tbB)
    if (!Number.isInteger(ta) || !Number.isInteger(tb) || ta < 0 || tb < 0) {
      throw new Error('淘汰赛常规时间平分，需录入加时/点球决胜比分')
    }
    if (ta === tb) throw new Error('决胜比分不能再次持平')
    winner = ta > tb ? m.team_a : m.team_b
  }
  // 小组/循环允许平局（winner 为 NULL）；决胜比分不计入进失球
  run(`UPDATE matches SET score_a=?, score_b=?, tb_a=?, tb_b=?, winner=?, status='finished' WHERE id=?`, sa, sb, ta, tb, winner, id)
  rebuildStandings(m.sport_id)
  recomputeMedals()
  // 联动比赛状态：执法安排随完赛归档留痕
  lockAssignmentsOnFinish({ ...m, status: 'finished' }, '系统')
}

// 新增场次后：尝试自动安排主裁（失败不阻断编排，供排班页处理）
function autoChiefForNewMatches(matchIds, operator = '系统') {
  matchIds.forEach(id => {
    const m = get('SELECT * FROM matches WHERE id=?', id)
    if (!m || !m.time_label) return
    const has = get(`SELECT id FROM assignments WHERE match_id=? AND role='chief' AND status='assigned'`, id)
    if (has) return
    const pick = pickChiefFor(m)
    if (pick) {
      run(`INSERT INTO assignments (match_id,referee_id,role,status) VALUES (?,?,'chief','assigned')`, id, pick.id)
      addLog('auto_assign', id, pick.id, `${matchTitle(m)} → ${pick.name} 随赛程生成自动排班为主裁`, '赛程新增联动', operator)
    }
  })
}

function generateKO(sportId) {
  const spo = get('SELECT * FROM sports WHERE id=?', sportId)
  if (spo.format === 'knockout') {
    // 羽毛球：半决赛是否已全部完成
    const semis = all(`SELECT * FROM matches WHERE sport_id=? AND stage='半决赛'`, sportId)
    const hasFinal = get(`SELECT id FROM matches WHERE sport_id=? AND stage='决赛'`, sportId)
    if (semis.length && semis.every(s => s.status === 'finished') && !hasFinal) {
      if (semis.some(s => s.winner == null)) return '半决赛存在平分未决胜场次，请先补录加时/点球决胜比分'
      const w1 = semis[0].winner, w2 = semis[1].winner
      const l1 = loserOf(semis[0]), l2 = loserOf(semis[1])
      const r1 = run('INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?)', sportId, '决赛', w1, w2, vid('羽毛球馆'), 9, '13:00', 'scheduled')
      const r2 = run('INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?)', sportId, '季军', l1, l2, vid('备用2号场'), 10, '12:30', 'scheduled')
      const ids = [Number(r1.lastInsertRowid), Number(r2.lastInsertRowid)]
      ids.forEach(id => addLog('schedule_added', id, null, `${matchTitle(get('SELECT * FROM matches WHERE id=?', id))} 由淘汰赛编排生成`, null, '系统'))
      // 赛程变更同步更新执法安排：新场次自动排班（无可用裁判时留待排班页处理）
      autoChiefForNewMatches(ids, '系统')
      return '已生成羽毛球 决赛 与 季军战'
    }
    return null
  }
  // group_knockout：小组完成后生成半决赛，半决赛完成后生成决赛
  const groups = ['A组', 'B组']
  const done = {}
  groups.forEach(g => {
    const gms = all(`SELECT * FROM matches WHERE sport_id=? AND group_name=?`, sportId, g)
    done[g] = gms.length === 0 || gms.every(m => m.status === 'finished')
  })
  const hasSemi = get(`SELECT id FROM matches WHERE sport_id=? AND stage='半决赛'`, sportId)
  if (groups.every(g => done[g]) && !hasSemi) {
    const rankOf = g => {
      const ids = all(`SELECT DISTINCT team_a id FROM matches WHERE sport_id=? AND group_name=? AND team_a IS NOT NULL UNION SELECT DISTINCT team_b FROM matches WHERE sport_id=? AND group_name=? AND team_b IS NOT NULL`, sportId, g, sportId, g)
        .map(r => r.id)
        .filter(id => get('SELECT status FROM teams WHERE id=?', id)?.status === 'approved')
      // 与积分榜同一排名口径（积分 → 净胜球），避免同分时晋级对阵与榜单不一致
      return ids.map(id => ({ id, rank: get('SELECT rank r FROM standings WHERE sport_id=? AND team_id=?', sportId, id)?.r ?? 999 })).sort((a, b) => a.rank - b.rank).map(r => r.id)
    }
    const A = rankOf('A组'), B = rankOf('B组')
    if (A.length >= 2 && B.length >= 2) {
      const r1 = run('INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?)', sportId, '半决赛', A[0], B[1], vid('五人足球场'), 99, '14:00', 'scheduled')
      const r2 = run('INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?)', sportId, '半决赛', B[0], A[1], vid('五人足球场'), 100, '14:30', 'scheduled')
      const ids = [Number(r1.lastInsertRowid), Number(r2.lastInsertRowid)]
      ids.forEach(id => addLog('schedule_added', id, null, `${matchTitle(get('SELECT * FROM matches WHERE id=?', id))} 由小组出线排名生成`, null, '系统'))
      autoChiefForNewMatches(ids, '系统')
      return '已按小组排名生成足球半决赛'
    }
    return null
  }
  const semis = all(`SELECT * FROM matches WHERE sport_id=? AND stage='半决赛'`, sportId)
  const hasFinal = get(`SELECT id FROM matches WHERE sport_id=? AND stage='决赛'`, sportId)
  if (semis.length && semis.every(s => s.status === 'finished') && !hasFinal) {
    if (semis.some(s => s.winner == null)) return '半决赛存在平分未决胜场次，请先补录加时/点球决胜比分'
    const w1 = semis[0].winner, w2 = semis[1].winner
    const l1 = loserOf(semis[0]), l2 = loserOf(semis[1])
    const r1 = run('INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?)', sportId, '决赛', w1, w2, vid('五人足球场'), 101, '16:00', 'scheduled')
    const r2 = run('INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?)', sportId, '季军', l1, l2, vid('备用2号场'), 102, '15:30', 'scheduled')
    const ids = [Number(r1.lastInsertRowid), Number(r2.lastInsertRowid)]
    ids.forEach(id => addLog('schedule_added', id, null, `${matchTitle(get('SELECT * FROM matches WHERE id=?', id))} 由半决赛赛果生成`, null, '系统'))
    autoChiefForNewMatches(ids, '系统')
    return '已生成决赛 与 季军战'
  }
  return null
}
function finishTrack(sportId, body) {
  // body: [{athlete_id, mark}] 按顺序
  body.forEach((b, i) => run('UPDATE entries SET mark=?, rank=? WHERE athlete_id=? AND sport_id=?', b.mark, i + 1, b.athlete_id, sportId))
  run('UPDATE sports SET finished=1 WHERE id=?', sportId)

  recomputeMedals()
}
/* ================= 参赛资格审核（报名 → 审核 → 退报/撤销） ================= */
function submitRegistration(kind, unitId, sportId, name) {
  if (!get('SELECT id FROM units WHERE id=?', unitId)) throw new Error('参赛单位不存在')
  if (!get('SELECT id FROM sports WHERE id=?', sportId)) throw new Error('比赛项目不存在')
  name = (name || '').trim()
  if (!name) throw new Error('名称不能为空')
  if (kind === 'team') {
    if (get('SELECT id FROM teams WHERE name=? AND sport_id=? AND unit_id=?', name, sportId, unitId)) throw new Error('该单位已报名同名队伍')
    const r = run('INSERT INTO teams (name,unit_id,sport_id,status) VALUES (?,?,?,?)', name, unitId, sportId, 'pending')
    const teamId = Number(r.lastInsertRowid)
    run('INSERT INTO registrations (kind,unit_id,sport_id,team_id,name,status) VALUES (?,?,?,?,?,?)', kind, unitId, sportId, teamId, name, 'pending')
    return { id: teamId, kind }
  }
  if (get('SELECT id FROM athletes WHERE name=? AND sport_id=? AND unit_id=?', name, sportId, unitId)) throw new Error('该单位已报名同名运动员')
  const r = run('INSERT INTO athletes (name,unit_id,sport_id,status) VALUES (?,?,?,?)', name, unitId, sportId, 'pending')
  const athId = Number(r.lastInsertRowid)
  run('INSERT INTO registrations (kind,unit_id,sport_id,athlete_id,name,status) VALUES (?,?,?,?,?,?)', kind, unitId, sportId, athId, name, 'pending')
  return { id: athId, kind }
}

function approveRegistration(regId, reviewer) {
  const reg = get('SELECT * FROM registrations WHERE id=?', regId)
  if (!reg) throw new Error('报名记录不存在')
  if (reg.status !== 'pending') throw new Error('该报名已处理，不能重复审核')
  const quota = get('SELECT quota FROM sports WHERE id=?', reg.sport_id)?.quota ?? 8
  const approved = reg.kind === 'team'
    ? get(`SELECT COUNT(*) c FROM teams WHERE sport_id=? AND status='approved'`, reg.sport_id).c
    : get(`SELECT COUNT(*) c FROM athletes WHERE sport_id=? AND status='approved'`, reg.sport_id).c
  if (approved >= quota) throw new Error(`名额已满（${quota} 个），无法通过`)
  const quotaNo = approved + 1
  run(`UPDATE registrations SET status='approved', quota_no=?, reviewed_at=datetime('now','localtime'), reviewer=? WHERE id=?`, quotaNo, reviewer || '组委会', regId)
  if (reg.kind === 'team') {
    run(`UPDATE teams SET status='approved' WHERE id=?`, reg.team_id)
    // 循环赛：若尚未开赛，重新排定循环赛程，把新队伍纳入对阵
    const spo = get('SELECT * FROM sports WHERE id=?', reg.sport_id)
    const finished = get(`SELECT COUNT(*) c FROM matches WHERE sport_id=? AND status='finished'`, reg.sport_id).c
    if (spo.format === 'roundrobin' && finished === 0) {
      // 赛程重排：先释放旧场次在派执法安排并留痕，再重建对阵
      const old = all(`SELECT * FROM matches WHERE sport_id=?`, reg.sport_id)
      old.forEach(m => releaseAssignmentsOfMatch(m, '报名通过触发循环赛程重排', reviewer || '系统'))
      run(`DELETE FROM matches WHERE sport_id=?`, reg.sport_id)
      const teams = all(`SELECT id FROM teams WHERE sport_id=? AND status='approved'`, reg.sport_id).map(t => t.id)
      const pairList = arr => { const p = []; for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) p.push([arr[i], arr[j]]); return p }
      let ono = 0
      const newIds = []
      pairList(teams).forEach(([a, b]) => { ono++; const r = run('INSERT INTO matches (sport_id,stage,team_a,team_b,order_no,status) VALUES (?,?,?,?,?,?)', reg.sport_id, '循环', a, b, ono, 'scheduled'); newIds.push(Number(r.lastInsertRowid)) })
      addLog('schedule_rebuild', null, null, `${spo.name} 循环赛程因新增通过队伍「${reg.name}」重排，共 ${newIds.length} 场（执法安排需重新排班）`, null, reviewer || '系统')
    }
  } else {
    run(`UPDATE athletes SET status='approved' WHERE id=?`, reg.athlete_id)
  }
  rebuildStandings(reg.sport_id)
  recomputeMedals()
  return { ok: true, quota_no: quotaNo }
}

function rejectRegistration(regId, note, reviewer) {
  const reg = get('SELECT * FROM registrations WHERE id=?', regId)
  if (!reg) throw new Error('报名记录不存在')
  if (reg.status !== 'pending') throw new Error('该报名已处理')
  run(`UPDATE registrations SET status='rejected', review_note=?, reviewed_at=datetime('now','localtime'), reviewer=? WHERE id=?`, note || '资料不符', reviewer || '组委会', regId)
  if (reg.kind === 'team') run(`UPDATE teams SET status='rejected' WHERE id=?`, reg.team_id)
  else run(`UPDATE athletes SET status='rejected' WHERE id=?`, reg.athlete_id)
  return { ok: true }
}

// 退报（单位主动）/ 撤销资格（组委会）：同步处理受影响的对阵及成绩
function withdrawOrRevoke(regId, action, note, reviewer) {
  const reg = get('SELECT * FROM registrations WHERE id=?', regId)
  if (!reg) throw new Error('报名记录不存在')
  if (reg.status !== 'approved') throw new Error('仅已通过的报名可退报/撤销')
  const newStatus = action === 'withdraw' ? 'withdrawn' : 'revoked'
  const reason = note || (action === 'withdraw' ? '单位退报' : '组委会撤销资格')
  run(`UPDATE registrations SET status=?, review_note=?, reviewed_at=datetime('now','localtime'), reviewer=? WHERE id=?`, newStatus, reason, reviewer || '组委会', regId)
  const impact = { voided: 0, walkover: 0, entries: 0 }
  if (reg.kind === 'team') {
    run(`UPDATE teams SET status=? WHERE id=?`, newStatus, reg.team_id)
    // 同步处理受影响的对阵
    const ms = all(`SELECT * FROM matches WHERE sport_id=? AND (team_a=? OR team_b=?)`, reg.sport_id, reg.team_id, reg.team_id)
    ms.forEach(m => {
      if (m.status === 'scheduled') {
        // 未赛：判弃权，对手 3:0 胜；裁判安排随比赛状态联动归档
        const isA = m.team_a === reg.team_id
        run(`UPDATE matches SET status='finished', score_a=?, score_b=?, winner=?, note=? WHERE id=?`,
          isA ? 0 : 3, isA ? 3 : 0, isA ? m.team_b : m.team_a, action === 'withdraw' ? '弃权(退报)' : '弃权(撤销资格)', m.id)
        impact.walkover++
        lockAssignmentsOnFinish({ ...m, status: 'finished' }, reviewer || '系统')
      } else if (m.status === 'finished') {
        // 已赛：取消该场成绩，并解除/归档执法安排
        run(`UPDATE matches SET status='void', score_a=NULL, score_b=NULL, tb_a=NULL, tb_b=NULL, winner=NULL, note=? WHERE id=?`,
          action === 'withdraw' ? '成绩取消(退报)' : '成绩取消(撤销资格)', m.id)
        impact.voided++
        releaseAssignmentsOfMatch(m, action === 'withdraw' ? '成绩取消(退报)' : '成绩取消(撤销资格)', reviewer || '系统')
      }
    })
    rebuildStandings(reg.sport_id)
  } else {
    run(`UPDATE athletes SET status=? WHERE id=?`, newStatus, reg.athlete_id)
    // 田径：删除该运动员在该项目的成绩
    const r = run(`DELETE FROM entries WHERE athlete_id=? AND sport_id=?`, reg.athlete_id, reg.sport_id)
    impact.entries = r.changes
    recomputeTrackRanks(reg.sport_id)
  }
  recomputeMedals()
  return { ok: true, impact }
}

function recomputeTrackRanks(sportId) {
  const rows = all(`SELECT id FROM entries WHERE sport_id=? ORDER BY mark ASC`, sportId)
  rows.forEach((r, i) => run(`UPDATE entries SET rank=? WHERE id=?`, i + 1, r.id))
}
seed()

/* ================= API ================= */
const joinMatch = m => {
  if (!m) return null
  return {
    ...m,
    teamA: m.team_a ? get('SELECT id,name,unit_id FROM teams WHERE id=?', m.team_a) : null,
    teamB: m.team_b ? get('SELECT id,name,unit_id FROM teams WHERE id=?', m.team_b) : null,
    venue: get('SELECT * FROM venues WHERE id=?', m.venue_id) || null
  }
}
app.get('/api/sports', (_, res) => res.json(all('SELECT * FROM sports')))
app.get('/api/teams', (_, res) => res.json(all('SELECT t.*, u.name unit, u.color FROM teams t JOIN units u ON u.id=t.unit_id')))
app.get('/api/units', (_, res) => res.json(all('SELECT * FROM units')))
app.get('/api/venues', (_, res) => res.json(all('SELECT * FROM venues')))
app.get('/api/referees', (_, res) => res.json(all('SELECT * FROM referees ORDER BY id')))
app.post('/api/referees', (req, res) => {
  const name = (req.body.name || '').trim()
  if (!name) return res.status(400).json({ error: '裁判姓名不能为空' })
  if (get('SELECT id FROM referees WHERE name=?', name)) return res.status(400).json({ error: '已存在同名裁判' })
  const r = run('INSERT INTO referees (name,sport,level,status) VALUES (?,?,?,?)', name, req.body.sport || null, req.body.level || '主裁', req.body.status || '就绪')
  res.json({ ok: true, id: Number(r.lastInsertRowid) })
})
app.get('/api/athletes', (_, res) => res.json(all('SELECT a.*, u.name unit FROM athletes a JOIN units u ON u.id=a.unit_id')))
app.get('/api/matches', (_, res) => res.json(all('SELECT * FROM matches').map(joinMatch)))
app.get('/api/entries', (_, res) => res.json(all('SELECT e.*, a.name aname, u.name unit FROM entries e JOIN athletes a ON a.id=e.athlete_id JOIN units u ON u.id=e.unit_id')))

/* —— 裁判排班：执法安排 / 冲突 / 留痕 —— */
const joinAssignment = a => ({
  ...a,
  referee: get('SELECT id,name,sport,level,status FROM referees WHERE id=?', a.referee_id),
  match: joinMatch(get('SELECT * FROM matches WHERE id=?', a.match_id))
})
app.get('/api/assignments', (_, res) => {
  res.json(all(`SELECT a.* FROM assignments a WHERE a.status='assigned' ORDER BY a.id DESC`).map(joinAssignment))
})
app.post('/api/assignments', (req, res) => {
  try {
    const r = assignReferee(Number(req.body.match_id), Number(req.body.referee_id), req.body.role || 'chief', req.body.operator, req.body.reason, !!req.body.force)
    res.json({ ok: true, ...r })
  } catch (e) {
    res.status(e.code === 'CONFLICT' || e.code === 'SKILL_MISMATCH' ? 409 : 400).json({ error: e.message, code: e.code, conflicts: e.conflicts })
  }
})
app.post('/api/assignments/auto', (req, res) => res.json({ ok: true, ...autoAssign(req.body.operator) }))
app.post('/api/assignments/:id/release', (req, res) => {
  try { res.json(releaseAssignment(Number(req.params.id), req.body.operator, req.body.reason)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/assignments/:id/reassign', (req, res) => {
  try {
    const r = reassignAssignment(Number(req.params.id), {
      target_id: req.body.target_id ? Number(req.body.target_id) : null,
      new_referee_id: req.body.new_referee_id,
      reason: req.body.reason, operator: req.body.operator
    })
    res.json({ ok: true, ...r })
  } catch (e) {
    res.status(e.code === 'CONFLICT' ? 409 : 400).json({ error: e.message, code: e.code, conflicts: e.conflicts })
  }
})
// 赛程变更（时间/场地），联动执法安排
app.patch('/api/matches/:id/schedule', (req, res) => {
  try {
    const r = updateMatchSchedule(Number(req.params.id), {
      time_label: req.body.time_label, venue_id: req.body.venue_id,
      operator: req.body.operator, reason: req.body.reason, force: !!req.body.force
    })
    res.json({ ok: true, ...r })
  } catch (e) {
    res.status(e.code === 'CONFLICT' ? 409 : 400).json({ error: e.message, code: e.code, conflicts: e.conflicts })
  }
})
app.get('/api/assignment-logs', (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 100)
  const rows = all(`SELECT l.*, r.name referee_name,
    s.name sport_name,
    (SELECT ta.name FROM matches m2 LEFT JOIN teams ta ON ta.id=m2.team_a WHERE m2.id=l.match_id) team_a_name,
    (SELECT tb.name FROM matches m3 LEFT JOIN teams tb ON tb.id=m3.team_b WHERE m3.id=l.match_id) team_b_name
    FROM assignment_logs l
    LEFT JOIN referees r ON r.id=l.referee_id
    LEFT JOIN matches m ON m.id=l.match_id
    LEFT JOIN sports s ON s.id=m.sport_id
    ORDER BY l.id DESC LIMIT ?`, limit)
  res.json(rows)
})
// 冲突与排班覆盖总览：待安排 / 裁判撞档 / 场地撞场 / 专长不符
app.get('/api/conflicts', (_, res) => {
  const scheduled = all(`SELECT * FROM matches WHERE status='scheduled' AND team_a IS NOT NULL AND team_b IS NOT NULL`)
  const unassigned = scheduled.filter(m => !get(`SELECT id FROM assignments WHERE match_id=? AND role='chief' AND status='assigned'`, m.id))
  const refereeConflicts = []
  all(`SELECT a.* FROM assignments a WHERE a.status='assigned'`).forEach(a => {
    const m = get(`SELECT * FROM matches WHERE id=?`, a.match_id)
    if (!m || m.status !== 'scheduled') return
    refBusyMatches(a.referee_id, m.time_label, m.id).forEach(b => {
      const key = [a.id, b.aid].sort().join('-')
      if (refereeConflicts.some(c => c.key === key)) return
      const r1 = get('SELECT name FROM referees WHERE id=?', a.referee_id)
      refereeConflicts.push({
        key, referee_id: a.referee_id, referee: r1?.name, time: m.time_label,
        match_x: { match_id: m.id, title: matchTitle(m) },
        match_y: { match_id: b.id, title: matchTitle(b) }
      })
    })
  })
  const venueConflicts = []
  scheduled.forEach(m => {
    if (!m.venue_id) return
    venueClashMatches(m.venue_id, m.time_label, m.id).forEach(o => {
      const key = [m.id, o.id].sort().join('-')
      if (venueConflicts.some(c => c.key === key)) return
      const v = get('SELECT name FROM venues WHERE id=?', m.venue_id)
      venueConflicts.push({ key, venue_id: m.venue_id, venue: v?.name, time: m.time_label,
        match_x: { match_id: m.id, title: matchTitle(m) }, match_y: { match_id: o.id, title: matchTitle(o) } })
    })
  })
  const skillMismatch = []
  all(`SELECT a.* FROM assignments a WHERE a.status='assigned'`).forEach(a => {
    const m = get(`SELECT * FROM matches WHERE id=?`, a.match_id)
    if (!m || m.status !== 'scheduled') return
    const r = get('SELECT * FROM referees WHERE id=?', a.referee_id)
    if (!refSportOk(r, m.sport_id)) skillMismatch.push({ assignment_id: a.id, referee: r.name, referee_sport: r.sport, match_id: m.id, title: matchTitle(m) })
  })
  res.json({
    unassigned: unassigned.map(m => ({ match_id: m.id, title: matchTitle(m) })),
    referee_conflicts: refereeConflicts,
    venue_conflicts: venueConflicts,
    skill_mismatch: skillMismatch
  })
})
// 裁判执法工作量（含历史完赛场次）
app.get('/api/referee-workload', (_, res) => {
  res.json(all(`SELECT r.id, r.name, r.sport, r.level, r.status,
      SUM(CASE WHEN m.status='finished' THEN 1 ELSE 0 END) done,
      SUM(CASE WHEN m.status='scheduled' THEN 1 ELSE 0 END) upcoming
    FROM referees r LEFT JOIN assignments a ON a.referee_id=r.id AND a.status='assigned'
    LEFT JOIN matches m ON m.id=a.match_id
    GROUP BY r.id ORDER BY done DESC, upcoming DESC, r.id`))
})

// 参赛报名与资格审核
app.get('/api/registrations', (_, res) => {
  const rows = all(`SELECT r.*, u.name unit, s.name sport, s.format, s.category,
    CASE WHEN r.kind='team' THEN t.name ELSE a.name END AS name
    FROM registrations r
    JOIN units u ON u.id=r.unit_id
    JOIN sports s ON s.id=r.sport_id
    LEFT JOIN teams t ON t.id=r.team_id
    LEFT JOIN athletes a ON a.id=r.athlete_id
    ORDER BY r.id DESC`)
  res.json(rows)
})
app.post('/api/registrations', (req, res) => {
  const { kind, unit_id, sport_id, name } = req.body
  if (!['team', 'athlete'].includes(kind)) return res.status(400).json({ error: '报名类型无效' })
  try {
    const r = submitRegistration(kind, Number(unit_id), Number(sport_id), name)
    res.json({ ok: true, ...r })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/registrations/:id/approve', (req, res) => {
  try { res.json(approveRegistration(Number(req.params.id), req.body.reviewer)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/registrations/:id/reject', (req, res) => {
  try { res.json(rejectRegistration(Number(req.params.id), req.body.note, req.body.reviewer)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/registrations/:id/withdraw', (req, res) => {
  try { res.json(withdrawOrRevoke(Number(req.params.id), 'withdraw', req.body.note, req.body.reviewer)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/registrations/:id/revoke', (req, res) => {
  try { res.json(withdrawOrRevoke(Number(req.params.id), 'revoke', req.body.note, req.body.reviewer)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.get('/api/quota', (_, res) => {
  const sports = all('SELECT * FROM sports')
  res.json(sports.map(s => {
    const approved = s.format === 'track'
      ? get(`SELECT COUNT(*) c FROM athletes WHERE sport_id=? AND status='approved'`, s.id).c
      : get(`SELECT COUNT(*) c FROM teams WHERE sport_id=? AND status='approved'`, s.id).c
    const pending = get(`SELECT COUNT(*) c FROM registrations WHERE sport_id=? AND status='pending'`, s.id).c
    return { sport_id: s.id, name: s.name, format: s.format, quota: s.quota, approved, pending, used: approved + pending }
  }))
})
app.get('/api/standings/:sid', (req, res) => res.json(all('SELECT s.*, t.name tname, u.name unit, u.color FROM standings s JOIN teams t ON t.id=s.team_id JOIN units u ON u.id=t.unit_id WHERE s.sport_id=? ORDER BY s.rank', Number(req.params.sid))))
app.get('/api/medals', (_, res) => res.json(all('SELECT m.*, u.name FROM medals m JOIN units u ON u.id=m.unit_id ORDER BY m.gold DESC, m.silver DESC')))

app.get('/api/overview', (_, res) => {
  const sp = all('SELECT * FROM sports')
  const mats = all('SELECT * FROM matches')
  const done = mats.filter(m => m.status === 'finished')
  const pend = mats.filter(m => m.status === 'scheduled' && m.team_a && m.team_b)
  // 排班联动速览：待赛覆盖率与冲突数
  const unassigned = pend.filter(m => !get(`SELECT id FROM assignments WHERE match_id=? AND role='chief' AND status='assigned'`, m.id)).length
  res.json({
    sports: sp.length,
    finishedMatches: done.length,
    pendingMatches: mats.filter(m => m.status === 'scheduled').length,
    teams: all('SELECT id FROM teams').length || 0,
    athletes: all('SELECT id FROM athletes').length,
    unassignedMatches: unassigned,
    refereeConflicts: all(`SELECT COUNT(DISTINCT a1.id) c FROM assignments a1
      JOIN assignments a2 ON a1.referee_id=a2.referee_id AND a1.id<a2.id AND a1.status='assigned' AND a2.status='assigned'
      JOIN matches m1 ON m1.id=a1.match_id JOIN matches m2 ON m2.id=a2.match_id
      WHERE m1.status='scheduled' AND m2.status='scheduled' AND m1.time_label=m2.time_label`)[0]?.c || 0,
    sportDone: sp.map(s => ({ ...s, total: mats.filter(m => m.sport_id === s.id).length, done: done.filter(m => m.sport_id === s.id).length })),
    recent: all('SELECT * FROM matches ORDER BY id DESC LIMIT 5').map(joinMatch)
  })
})
app.post('/api/matches/:id/score', (req, res) => {
  const { score_a, score_b, tb_a, tb_b } = req.body
  const m = get('SELECT * FROM matches WHERE id=?', Number(req.params.id))
  if (!m) return res.status(404).json({ error: '场次不存在' })
  if (m.team_a == null || m.team_b == null) return res.status(400).json({ error: '对阵尚未编排，先编排淘汰赛' })
  const sa = Number(score_a), sb = Number(score_b)
  if (!Number.isInteger(sa) || !Number.isInteger(sb) || sa < 0 || sb < 0) return res.status(400).json({ error: '比分必须为非负整数' })
  const chief = get(`SELECT id FROM assignments WHERE match_id=? AND role='chief' AND status='assigned'`, m.id)
  try {
    finishMatch(m.id, sa, sb, tb_a, tb_b)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }
  res.json({ ok: true, warning: chief ? null : '该场次未安排主裁，请注意补录执法记录' })
})
app.post('/api/ko/:sportId', (req, res) => {
  const msg = generateKO(Number(req.params.sportId))
  res.json({ ok: !!msg, msg })
})
app.post('/api/track/:sportId', (req, res) => {
  finishTrack(Number(req.params.sportId), req.body)
  res.json({ ok: true })
})
app.get('/api/reset', (_, res) => {
  ['assignment_logs', 'assignments', 'registrations', 'entries', 'standings', 'medals', 'matches', 'referees', 'venues', 'athletes', 'teams', 'units', 'sports'].forEach(t => { try { run(`DELETE FROM ${t}`) } catch (e) {} })
  seed()
  res.json({ ok: true })
})

app.listen(PORT, () => console.log(`[SPORT] API running at http://localhost:${PORT}`))
