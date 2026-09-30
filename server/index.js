import express from 'express'
import { db, run, all, get } from './db.js'

const app = express()
app.use(express.json())
const PORT = 4170

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

  // 裁判（含执法专项与等级；空专项 = 综合执法）
  const refs = [
    ['王裁判', '篮球', '国家级'], ['李裁判', '篮球', '一级'], ['张裁判', '五人制足球', '国家级'],
    ['赵裁判', '五人制足球', '一级'], ['陈裁判', '羽毛球', '一级'], ['孙裁判', null, '二级'],
    ['周裁判', '田径', '一级']
  ]
  refs.forEach(([r, sp, lv]) => run('INSERT INTO referees (name,sport,level,status) VALUES (?,?,?,?)', r, sp, lv, '就绪'))

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
  runners.forEach(([n, u]) => { run('INSERT INTO athletes (name,unit_id,sport_id) VALUES (?,?,?)', n, unitId[u], sp100) })

  // 循环赛助手
  const pairs = arr => { const p = []; for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) p.push([arr[i], arr[j]]); return p }

  const venueById = get('SELECT id FROM venues LIMIT 1').id

  // —— 篮球：4队 单循环 6 场（同馆时间错开，每场 80 分钟）
  let ono = 0
  const basketSlots = ['09:00', '10:30', '12:00', '13:30', '15:00', '16:30']
  pairs(B).forEach(([a, b]) => {
    ono++
    run(`INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,date_label,duration,status)
         VALUES (?,?,?,?,?,?,?,?,?,?)`, spBasket, '循环', a, b, venueById, ono, basketSlots[ono - 1], '第1比赛日', 80, 'scheduled')
  })

  // —— 足球：分 AB 两组（A: 雷霆/雄狮/闪电  B: 飞鹰/星河/烈焰），组内循环 6 场
  //    A/B 组使用不同场地且部分时段同时开赛 → 用于演示跨场地裁判时间冲突检测
  const grpA = [F[0], F[2], F[4]]
  const grpB = [F[1], F[3], F[5]]
  const slotA = ['09:00', '10:30', '12:00'], slotB = ['09:00', '10:30', '12:30']
  ono = 0
  pairs(grpA).forEach(([a, b]) => { ono++; run(`INSERT INTO matches (sport_id,stage,group_name,team_a,team_b,venue_id,order_no,time_label,date_label,duration,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, spFoot, '小组', 'A组', a, b, 2, ono, slotA[ono - 1], '第1比赛日', 70, 'scheduled') })
  ono = 0
  pairs(grpB).forEach(([a, b]) => { ono++; run(`INSERT INTO matches (sport_id,stage,group_name,team_a,team_b,venue_id,order_no,time_label,date_label,duration,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, spFoot, '小组', 'B组', a, b, 5, ono, slotB[ono - 1], '第1比赛日', 70, 'scheduled') })

  // —— 羽毛球：半决赛 2 场（固定对位），决赛/季军由编排按钮产生
  run(`INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,date_label,duration,status) VALUES (?,?,?,?,?,?,?,?,?,?)`, spBad, '半决赛', G[0], G[1], 3, 1, '09:30', '第2比赛日', 60, 'scheduled')
  run(`INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,date_label,duration,status) VALUES (?,?,?,?,?,?,?,?,?,?)`, spBad, '半决赛', G[2], G[3], 3, 2, '10:45', '第2比赛日', 60, 'scheduled')

  rebuildStandings()

  // —— 预录部分成绩（演示看板有内容）
  const sc = (sport, a, b, sa, sb) => { const m = get('SELECT id FROM matches WHERE sport_id=? AND team_a=? AND team_b=? AND status=\'scheduled\'', sport, a, b); if (m) finishMatch(m.id, sa, sb) }
  // 篮球全录 → 决出冠军
  sc(spBasket, B[0], B[1], 78, 70); sc(spBasket, B[2], B[3], 65, 71)
  sc(spBasket, B[0], B[2], 82, 60); sc(spBasket, B[1], B[3], 69, 74)
  sc(spBasket, B[0], B[3], 58, 66); sc(spBasket, B[1], B[2], 88, 77)
  // 足球小组录 4 场，留 2 场未赛（两组各留 09:00 一场，跨场地同时段，用于排班冲突演示）
  sc(spFoot, grpA[1], grpA[2], 2, 2); sc(spFoot, grpA[0], grpA[2], 4, 2)
  sc(spFoot, grpB[1], grpB[2], 2, 1); sc(spFoot, grpB[0], grpB[2], 0, 2)
  // 羽毛球两场半决赛都录 → 可编排决赛
  sc(spBad, G[0], G[1], 21, 16); sc(spBad, G[2], G[3], 18, 21)
  // 田径成绩
  const marks = [10.62, 10.88, 11.05, 11.21, 11.35, 11.42, 11.58, 11.79]
  all('SELECT id,name FROM athletes').forEach((ath, i) => run('INSERT INTO entries (sport_id,athlete_id,mark,rank,unit_id) VALUES (?,?,?,?,?)', sp100, ath.id, marks[i], i + 1, get('SELECT unit_id FROM athletes WHERE id=?', ath.id).unit_id))

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

  // —— 预置裁判排班（演示分配/调班留痕/跨场冲突）——
  seedAssignments()

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
      run(`INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,date_label,duration,status) VALUES (?,?,?,?,?,?,?,?,?,?)`, sportId, '决赛', w1, w2, 3, 9, '13:00', '第2比赛日', 60, 'scheduled')
      run(`INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,date_label,duration,status) VALUES (?,?,?,?,?,?,?,?,?,?)`, sportId, '季军', l1, l2, 5, 10, '12:30', '第2比赛日', 60, 'scheduled')
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
      run(`INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,date_label,duration,status) VALUES (?,?,?,?,?,?,?,?,?,?)`, sportId, '半决赛', A[0], B[1], 2, 99, '14:00', '第2比赛日', 70, 'scheduled')
      run(`INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,date_label,duration,status) VALUES (?,?,?,?,?,?,?,?,?,?)`, sportId, '半决赛', B[0], A[1], 2, 100, '15:20', '第2比赛日', 70, 'scheduled')
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
    run(`INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,date_label,duration,status) VALUES (?,?,?,?,?,?,?,?,?,?)`, sportId, '决赛', w1, w2, 2, 101, '16:40', '第2比赛日', 70, 'scheduled')
    run(`INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,date_label,duration,status) VALUES (?,?,?,?,?,?,?,?,?,?)`, sportId, '季军', l1, l2, 5, 102, '16:40', '第2比赛日', 70, 'scheduled')
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
      // 重排前先抓取旧对阵的执法安排，重排后按对阵双方迁移
      const { oldIds, oldMap } = migrateRoundRobinAssignments(reg.sport_id, '系统')
      run(`DELETE FROM matches WHERE sport_id=?`, reg.sport_id)
      const teams = all(`SELECT id FROM teams WHERE sport_id=? AND status='approved'`, reg.sport_id).map(t => t.id)
      const pairs = arr => { const p = []; for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) p.push([arr[i], arr[j]]); return p }
      let ono = 0
      pairs(teams).forEach(([a, b]) => {
        ono++
        const ins = run(`INSERT INTO matches (sport_id,stage,team_a,team_b,order_no,status) VALUES (?,?,?,?,?,?)`, reg.sport_id, '循环', a, b, ono, 'scheduled')
        // 相同对阵的裁判排班自动迁移到新场次
        applyAssignmentMigration(oldMap, Number(ins.lastInsertRowid), '系统')
      })
      // 被拆散/消失的对阵，释放其执法安排并留痕
      releaseOrphanAssignments(oldIds, '系统')
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
  const impact = { voided: 0, walkover: 0, entries: 0, assignments: 0 }
  if (reg.kind === 'team') {
    run(`UPDATE teams SET status=? WHERE id=?`, newStatus, reg.team_id)
    // 同步处理受影响的对阵
    const ms = all(`SELECT * FROM matches WHERE sport_id=? AND (team_a=? OR team_b=?)`, reg.sport_id, reg.team_id, reg.team_id)
    ms.forEach(m => {
      if (m.status === 'scheduled') {
        // 未赛：判弃权，对手 3:0 胜；执法安排保留（裁判到场完成弃权判罚），写联动留痕
        const isA = m.team_a === reg.team_id
        run(`UPDATE matches SET status='finished', score_a=?, score_b=?, winner=?, note=? WHERE id=?`,
          isA ? 0 : 3, isA ? 3 : 0, isA ? m.team_b : m.team_a, action === 'withdraw' ? '弃权(退报)' : '弃权(撤销资格)', m.id)
        all(`SELECT * FROM assignments WHERE match_id=? AND status='active'`, m.id).forEach(a =>
          logAssign('sync', m.id, a.referee_id, a.role, `赛程联动：对手${action === 'withdraw' ? '退报' : '被撤销资格'}，本场判弃权 3:0，${a.role}安排保留`, '系统'))
        impact.walkover++
      } else if (m.status === 'finished') {
        // 已赛：取消该场成绩，并自动释放执法安排（排班联动留痕）
        const reason = action === 'withdraw' ? '队伍退报，成绩取消' : '资格撤销，成绩取消'
        impact.assignments += releaseAssignmentsByMatch(m.id, reason, '系统')
        run(`UPDATE matches SET status='void', score_a=NULL, score_b=NULL, tb_a=NULL, tb_b=NULL, winner=NULL, note=? WHERE id=?`,
          action === 'withdraw' ? '成绩取消(退报)' : '成绩取消(撤销资格)', m.id)
        impact.voided++
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

/* ================= 裁判排班与场地资源协同 ================= */
const REF_ROLES = ['主裁判', '副裁判', '记录台']
const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { try { db.exec('ROLLBACK') } catch (_) {} throw e } }
const logAssign = (action, matchId, refereeId, role, detail, operator) =>
  run('INSERT INTO assignment_logs (action,match_id,referee_id,role,detail,operator) VALUES (?,?,?,?,?,?)',
    action, matchId, refereeId, role || null, detail || null, operator || '组委会')

function toMin(t) {
  if (!t) return null
  const [h, m] = String(t).split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}
// 两场（待赛）比赛在同一比赛日内时间是否重叠
function overlaps(a, b) {
  if (!a || !b || (a.date_label || '') !== (b.date_label || '')) return false
  const s1 = toMin(a.time_label), s2 = toMin(b.time_label)
  if (s1 == null || s2 == null) return false
  return s1 < s2 + (b.duration || 60) && s2 < s1 + (a.duration || 60)
}
// 裁判时间冲突：同一比赛日、时间重叠的其它待赛场次（不含已取消/已完赛）
function refereeConflicts(matchId, refereeId) {
  const cur = get('SELECT * FROM matches WHERE id=?', matchId)
  if (!cur) return []
  return all(`SELECT a.id a_id, a.role a_role, m.* FROM assignments a
              JOIN matches m ON m.id=a.match_id
              WHERE a.referee_id=? AND a.status='active' AND a.match_id<>? AND m.status='scheduled'`,
    refereeId, matchId)
    .filter(x => overlaps(cur, x))
}
// 场地时间冲突：同一场地、同一比赛日内时间重叠的其它待赛场次
function venueConflicts(matchId, venueId, dateLabel, timeLabel) {
  const cur = get('SELECT * FROM matches WHERE id=?', matchId)
  if (!cur || !venueId) return []
  const probe = { ...cur, venue_id: venueId, date_label: dateLabel ?? cur.date_label, time_label: timeLabel ?? cur.time_label }
  return all(`SELECT * FROM matches WHERE venue_id=? AND id<>? AND status='scheduled'`, venueId, matchId)
    .filter(x => overlaps(probe, x))
}
// 裁判执法资格校验（专项不符 / 休假 → 警告；停赛 → 硬性错误）
function refereeWarnings(refereeId, sportId) {
  const rf = get('SELECT * FROM referees WHERE id=?', refereeId)
  if (!rf) throw new Error('裁判不存在')
  if (rf.status === '停赛') throw new Error(`${rf.name} 当前处于停赛状态，不能安排执法`)
  const w = []
  const spo = get('SELECT name FROM sports WHERE id=?', sportId)
  if (rf.status === '休假') w.push(`${rf.name} 当前休假中，安排后需提前召回`)
  if (rf.sport && spo && rf.sport !== spo.name) w.push(`${rf.name} 专项为「${rf.sport}」，与本场「${spo.name}」不符`)
  return w
}
const matchLabel = m => {
  const spo = get('SELECT name FROM sports WHERE id=?', m.sport_id)?.name || ''
  const ta = m.team_a ? get('SELECT name FROM teams WHERE id=?', m.team_a)?.name : null
  const tb = m.team_b ? get('SELECT name FROM teams WHERE id=?', m.team_b)?.name : null
  return `${spo} ${m.stage}${m.group_name ? m.group_name : ''} ${ta || '待定'} vs ${tb || '待定'}`
}

// 安排裁判（同角色替换旧裁判）；force=true 时允许冲突/资格警告下强制安排
function assignReferee(matchId, refereeId, role, operator, force = false) {
  if (!REF_ROLES.includes(role)) throw new Error('执法角色无效')
  const m = get('SELECT * FROM matches WHERE id=?', matchId)
  if (!m) throw new Error('场次不存在')
  if (m.status === 'void') throw new Error('该场次已取消，不能安排执法')
  const warnings = refereeWarnings(refereeId, m.sport_id)
  if (get(`SELECT id FROM assignments WHERE match_id=? AND referee_id=? AND status='active'`, matchId, refereeId))
    throw new Error('该裁判已在本场执法名单中')
  const rconf = refereeConflicts(matchId, refereeId)
  const problems = [...warnings, ...rconf.map(c => {
    const rf = get('SELECT name FROM referees WHERE id=?', refereeId)
    return `与 ${rf.name} 已排执法冲突：${matchLabel(c)}（${c.date_label} ${c.time_label}）`
  })]
  if (problems.length && !force) {
    const e = new Error(problems[0]); e.conflicts = true
    throw e
  }
  return tx(() => {
    const old = get(`SELECT a.*, r.name rname FROM assignments a JOIN referees r ON r.id=a.referee_id
                     WHERE a.match_id=? AND a.role=? AND a.status='active'`, matchId, role)
    if (old) {
      run(`UPDATE assignments SET status='released' WHERE id=?`, old.id)
      logAssign('release', matchId, old.referee_id, role, `安排新裁判替换${role}（原：${old.rname}）`, operator)
    }
    run(`INSERT INTO assignments (match_id,referee_id,role,status,conflict_flag,created_by) VALUES (?,?,?,'active',?,?)`,
      matchId, refereeId, role, rconf.length ? 1 : 0, operator || '组委会')
    logAssign('assign', matchId, refereeId, role, problems.length ? `强制安排：${problems.join('；')}` : `安排为${role}`, operator)
    return { ok: true, replaced: old ? old.rname : null, warnings: problems }
  })
}

// 临时调班：同场同角色 旧裁判 → 新裁判（自动检测新裁判冲突）
function swapReferee(matchId, fromId, toId, operator, force = false) {
  const m = get('SELECT * FROM matches WHERE id=?', matchId)
  if (!m) throw new Error('场次不存在')
  if (m.status === 'void') throw new Error('该场次已取消，不能调班')
  if (fromId === toId) throw new Error('调班裁判不能相同')
  const cur = get(`SELECT * FROM assignments WHERE match_id=? AND referee_id=? AND status='active'`, matchId, fromId)
  if (!cur) throw new Error('被调下的裁判当前并未执法该场次')
  if (get(`SELECT id FROM assignments WHERE match_id=? AND referee_id=? AND status='active'`, matchId, toId))
    throw new Error('新裁判已在本场执法名单中')
  const warnings = refereeWarnings(toId, m.sport_id)
  const rconf = refereeConflicts(matchId, toId)
  const fromName = get('SELECT name FROM referees WHERE id=?', fromId)?.name
  const toName = get('SELECT name FROM referees WHERE id=?', toId)?.name
  const problems = [...warnings, ...rconf.map(c => `${toName} 与已排执法冲突：${matchLabel(c)}（${c.date_label} ${c.time_label}）`)]
  if (problems.length && !force) {
    const e = new Error(problems[0]); e.conflicts = true
    throw e
  }
  return tx(() => {
    run(`UPDATE assignments SET status='released' WHERE id=?`, cur.id)
    run(`INSERT INTO assignments (match_id,referee_id,role,status,conflict_flag,created_by) VALUES (?,?,?,'active',?,?)`,
      matchId, toId, cur.role, rconf.length ? 1 : 0, operator || '组委会')
    logAssign('swap', matchId, toId, cur.role, `临时调班：${fromName} → ${toName}（${cur.role}）${problems.length ? '；强制安排：' + problems.join('；') : ''}`, operator)
    return { ok: true, role: cur.role, warnings: problems }
  })
}

// 释放（撤出）某场某裁判
function releaseAssignment(matchId, refereeId, operator, reason) {
  const a = get(`SELECT a.*, r.name rname FROM assignments a JOIN referees r ON r.id=a.referee_id
                 WHERE a.match_id=? AND a.referee_id=? AND a.status='active'`, matchId, refereeId)
  if (!a) throw new Error('该裁判当前未执法该场次')
  return tx(() => {
    run(`UPDATE assignments SET status='released' WHERE id=?`, a.id)
    logAssign('release', matchId, refereeId, a.role, reason ? `撤出执法：${reason}` : `撤出${a.role}（${a.rname}）`, operator)
    return { ok: true }
  })
}

// 赛程改期/换场：同步校验场地与全部已排裁判的冲突，逐人刷新冲突标记
function rescheduleMatch(matchId, body, operator, force = false) {
  const m = get('SELECT * FROM matches WHERE id=?', matchId)
  if (!m) throw new Error('场次不存在')
  if (m.status !== 'scheduled') throw new Error('仅待赛场次可以改期/换场')
  const venueId = body.venue_id == null ? m.venue_id : Number(body.venue_id)
  const dateLabel = body.date_label == null ? m.date_label : String(body.date_label)
  const timeLabel = body.time_label == null ? m.time_label : String(body.time_label)
  const duration = body.duration == null || body.duration === '' ? m.duration : Number(body.duration)
  if (!timeLabel || !/^\d{1,2}:\d{2}$/.test(timeLabel)) throw new Error('开赛时间格式应为 HH:MM')
  if (!Number.isInteger(duration) || duration <= 0) throw new Error('时长需为正整数（分钟）')
  const vc = venueConflicts(matchId, venueId, dateLabel, timeLabel)
  const probe = { ...m, venue_id: venueId, date_label: dateLabel, time_label: timeLabel, duration }
  const active = all(`SELECT a.*, r.name rname FROM assignments a JOIN referees r ON r.id=a.referee_id
                      WHERE a.match_id=? AND a.status='active'`, matchId)
  const rcMap = {}
  const problems = []
  vc.forEach(c => problems.push(`场地冲突：${get('SELECT name FROM venues WHERE id=?', venueId)?.name} 同时段已有 ${matchLabel(c)}（${c.time_label}）`))
  active.forEach(a => {
    const cf = all(`SELECT b.id, b.role, mm.* FROM assignments b JOIN matches mm ON mm.id=b.match_id
                    WHERE b.referee_id=? AND b.status='active' AND b.match_id<>? AND mm.status='scheduled'`, a.referee_id, matchId)
      .filter(x => overlaps(probe, x))
    if (cf.length) { rcMap[a.referee_id] = cf; cf.forEach(c => problems.push(`裁判冲突：${a.rname} 与 ${matchLabel(c)}（${c.date_label} ${c.time_label}）重叠`)) }
  })
  if (problems.length && !force) {
    const e = new Error(problems[0]); e.conflicts = true; e.allProblems = problems
    throw e
  }
  return tx(() => {
    run(`UPDATE matches SET venue_id=?, date_label=?, time_label=?, duration=? WHERE id=?`, venueId, dateLabel, timeLabel, duration, matchId)
    active.forEach(a => run(`UPDATE assignments SET conflict_flag=? WHERE id=?`, rcMap[a.referee_id] ? 1 : 0, a.id))
    logAssign('reschedule', matchId, null, null,
      `改期/换场：${m.date_label} ${m.time_label}「${get('SELECT name FROM venues WHERE id=?', m.venue_id)?.name || '未定'}」→ ${dateLabel} ${timeLabel}「${get('SELECT name FROM venues WHERE id=?', venueId)?.name || '未定'}」（${duration}分钟）${problems.length ? '；强制安排，冲突 ' + problems.length + ' 项' : ''}`,
      operator)
    return { ok: true, venue_conflicts: vc.length, referee_conflicts: Object.keys(rcMap).length, problems }
  })
}

// 场次取消（退报/撤销资格导致）：自动释放全部执法安排并留痕
function releaseAssignmentsByMatch(matchId, reason, operator = '系统') {
  const acts = all(`SELECT * FROM assignments WHERE match_id=? AND status='active'`, matchId)
  acts.forEach(a => {
    run(`UPDATE assignments SET status='released' WHERE id=?`, a.id)
    logAssign('sync', matchId, a.referee_id, a.role, `赛程联动：${reason}，自动释放${a.role}安排`, operator)
  })
  return acts.length
}

// 循环赛重排（报名通过新增队伍）：按对阵双方迁移执法安排，找不到对阵的释放并留痕
function migrateRoundRobinAssignments(sportId, operator = '系统') {
  const olds = all(`SELECT * FROM matches WHERE sport_id=?`, sportId)
  const oldMap = {}
  olds.forEach(m => {
    if (m.team_a && m.team_b) oldMap[[m.team_a, m.team_b].sort().join('-')] = m
  })
  return { oldIds: olds.map(m => m.id), oldMap }
}
function applyAssignmentMigration(oldMap, newMatch, operator = '系统') {
  const m = get('SELECT * FROM matches WHERE id=?', newMatch)
  if (!m || !m.team_a || !m.team_b) return 0
  const old = oldMap[[m.team_a, m.team_b].sort().join('-')]
  if (!old) return 0
  const acts = all(`SELECT * FROM assignments WHERE match_id=? AND status='active'`, old.id)
  acts.forEach(a => {
    run(`UPDATE assignments SET status='released' WHERE id=?`, a.id)
    const exists = get(`SELECT id FROM assignments WHERE match_id=? AND referee_id=? AND status='active'`, m.id, a.referee_id)
    if (exists) return
    run(`INSERT INTO assignments (match_id,referee_id,role,status,conflict_flag,created_by) VALUES (?,?,?,'active',0,?)`,
      m.id, a.referee_id, a.role, operator)
    logAssign('sync', m.id, a.referee_id, a.role, `赛程联动：循环赛重排，${a.role}安排随对阵迁移`, operator)
  })
  return acts.length
}
function releaseOrphanAssignments(oldIds, operator = '系统') {
  let n = 0
  oldIds.forEach(oid => {
    const remain = all(`SELECT * FROM assignments WHERE match_id=? AND status='active'`, oid)
    remain.forEach(a => {
      run(`UPDATE assignments SET status='released' WHERE id=?`, a.id)
      const m = get('SELECT * FROM matches WHERE id=?', oid)
      logAssign('sync', oid, a.referee_id, a.role, m ? `赛程联动：循环赛重排，${matchLabel(m)} 对阵被拆散，释放${a.role}安排` : `赛程联动：原场次删除，释放${a.role}安排`, operator)
      n++
    })
  })
  return n
}

// 当前全部冲突（待赛场次）：场地重叠 + 裁判重叠
function allConflicts() {
  const sched = all(`SELECT * FROM matches WHERE status='scheduled' ORDER BY date_label, time_label, id`)
  const venueHit = {}, refHit = {}
  for (let i = 0; i < sched.length; i++) {
    for (let j = i + 1; j < sched.length; j++) {
      const a = sched[i], b = sched[j]
      if (a.venue_id && b.venue_id && a.venue_id === b.venue_id && overlaps(a, b)) {
        venueHit[a.id] = b.id; venueHit[b.id] = a.id
      }
    }
  }
  const acts = all(`SELECT * FROM assignments WHERE status='active'`)
  const byRef = {}
  acts.forEach(a => (byRef[a.referee_id] ||= []).push(a))
  Object.entries(byRef).forEach(([rid, list]) => {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i], y = list[j]
        const mx = get('SELECT * FROM matches WHERE id=?', x.match_id)
        const my = get('SELECT * FROM matches WHERE id=?', y.match_id)
        if (mx && my && mx.status === 'scheduled' && my.status === 'scheduled' && overlaps(mx, my)) {
          refHit[x.match_id] = (refHit[x.match_id] || new Set()); refHit[x.match_id].add(Number(rid))
          refHit[y.match_id] = (refHit[y.match_id] || new Set()); refHit[y.match_id].add(Number(rid))
          run(`UPDATE assignments SET conflict_flag=1 WHERE id=? OR id=?`, x.id, y.id)
        }
      }
    }
  })
  return {
    venueMatchIds: Object.keys(venueHit).map(Number),
    refereeMatchMap: Object.fromEntries(Object.entries(refHit).map(([k, v]) => [k, [...v]])),
    count: new Set([...Object.keys(venueHit), ...Object.keys(refHit)]).size
  }
}

// 执法看板/报表汇总
function officiatingReport() {
  const scheduled = all(`SELECT * FROM matches WHERE status='scheduled'`)
  const active = all(`SELECT * FROM assignments WHERE status='active'`)
  const actByMatch = {}
  active.forEach(a => (actByMatch[a.match_id] ||= []).push(a))
  const unassigned = scheduled.filter(m => !actByMatch[m.id]?.length).length
  const c = allConflicts()
  const referees = all('SELECT * FROM referees').map(r => {
    const mine = active.filter(a => a.referee_id === r.id)
    const confCount = mine.filter(a => (c.refereeMatchMap[a.match_id] || []).includes(r.id)).length
    return { ...r, matches: mine.length, conflict_matches: confCount, scheduled_matches: mine.length }
  })
  return {
    total_scheduled: scheduled.length,
    covered: scheduled.length - unassigned,
    unassigned,
    conflict_matches: c.count,
    venue_conflict_matches: c.venueMatchIds.length,
    referee_conflict_matches: Object.keys(c.refereeMatchMap).length,
    referees
  }
}

// 种子演示：为已生成场次预排裁判（含一次调班留痕与一处跨场冲突）
function seedAssignments() {
  const rid = Object.fromEntries(all('SELECT id,name FROM referees').map(r => [r.name, r.id]))
  const seedAssign = (m, refereeName, role, force = false) => {
    try { assignReferee(m.id, rid[refereeName], role, '组委会', force) }
    catch (e) { /* 演示种子忽略 */ }
  }
  const foot = sp => all(`SELECT * FROM matches WHERE sport_id=? ORDER BY order_no`, sp)
  const spFootRow = get(`SELECT id FROM sports WHERE name='五人制足球'`)
  const spBadRow = get(`SELECT id FROM sports WHERE name='羽毛球'`)
  // 足球 A 组（场地2）：张主裁/赵副裁/孙记录台；B 组（场地5）：赵主裁…孙记录台
  const fm = foot(spFootRow.id)
  const A = fm.filter(m => m.group_name === 'A组'), B = fm.filter(m => m.group_name === 'B组')
  // A 组（场地2）正常排班；B 组（场地5）与 A 组多个时段重叠 → 演示跨场同时段强制安排（冲突标记+留痕）
  A.forEach(m => { seedAssign(m, '张裁判', '主裁判'); seedAssign(m, '赵裁判', '副裁判'); seedAssign(m, '孙裁判', '记录台') })
  B.forEach(m => { seedAssign(m, '赵裁判', '主裁判', true); seedAssign(m, '张裁判', '副裁判', true); seedAssign(m, '孙裁判', '记录台', true) })
  // 羽毛球半决赛：陈主裁 + 孙记录台（不同比赛日，无冲突）
  foot(spBadRow.id).forEach(m => { seedAssign(m, '陈裁判', '主裁判'); seedAssign(m, '孙裁判', '记录台') })
  // 演示一次完整临时调班留痕：足球B组首场 主裁 赵裁判 → 周裁判（跨专项，强制并记录）
  if (B[0]) {
    try { swapReferee(B[0].id, rid['赵裁判'], rid['周裁判'], '组委会', true) } catch (e) {}
  }
}

seed()

/* ================= API ================= */
const joinMatch = m => {
  if (!m) return null
  const referees = all(`SELECT a.id a_id, a.role, a.conflict_flag, r.id r_id, r.name, r.sport, r.level, r.status r_status
                        FROM assignments a JOIN referees r ON r.id=a.referee_id
                        WHERE a.match_id=? AND a.status='active' ORDER BY CASE a.role WHEN '主裁判' THEN 1 WHEN '副裁判' THEN 2 ELSE 3 END, a.id`, m.id)
    .map(a => ({ assignment_id: a.a_id, id: a.r_id, name: a.name, role: a.role, sport: a.sport, level: a.level, status: a.r_status, conflict_flag: a.conflict_flag }))
  return {
    ...m,
    teamA: m.team_a ? get('SELECT id,name,unit_id FROM teams WHERE id=?', m.team_a) : null,
    teamB: m.team_b ? get('SELECT id,name,unit_id FROM teams WHERE id=?', m.team_b) : null,
    venue: get('SELECT * FROM venues WHERE id=?', m.venue_id) || null,
    referees,
    sport_name: get('SELECT name FROM sports WHERE id=?', m.sport_id)?.name
  }
}
app.get('/api/sports', (_, res) => res.json(all('SELECT * FROM sports')))
app.get('/api/teams', (_, res) => res.json(all('SELECT t.*, u.name unit, u.color FROM teams t JOIN units u ON u.id=t.unit_id')))
app.get('/api/units', (_, res) => res.json(all('SELECT * FROM units')))
app.get('/api/venues', (_, res) => res.json(all('SELECT * FROM venues')))
app.get('/api/referees', (_, res) => res.json(all('SELECT * FROM referees')))
app.get('/api/athletes', (_, res) => res.json(all('SELECT a.*, u.name unit FROM athletes a JOIN units u ON u.id=a.unit_id')))
app.get('/api/matches', (_, res) => res.json(all('SELECT * FROM matches').map(joinMatch)))
app.get('/api/entries', (_, res) => res.json(all('SELECT e.*, a.name aname, u.name unit FROM entries e JOIN athletes a ON a.id=e.athlete_id JOIN units u ON u.id=a.unit_id')))

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

/* ---------- 裁判排班与场地资源协同 ---------- */
app.post('/api/referees', (req, res) => {
  const name = (req.body.name || '').trim()
  if (!name) return res.status(400).json({ error: '裁判姓名不能为空' })
  const r = run('INSERT INTO referees (name,sport,level,phone,status) VALUES (?,?,?,?,?)',
    name, req.body.sport || null, req.body.level || '一级', req.body.phone || null, req.body.status || '就绪')
  logAssign('sync', null, Number(r.lastInsertRowid), null, `录入裁判：${name}（${req.body.sport || '综合执法'} / ${req.body.level || '一级'}）`, '组委会')
  res.json({ ok: true, id: Number(r.lastInsertRowid) })
})

app.put('/api/referees/:id', (req, res) => {
  const r = get('SELECT * FROM referees WHERE id=?', Number(req.params.id))
  if (!r) return res.status(404).json({ error: '裁判不存在' })
  const { name, sport, level, phone, status } = req.body
  run('UPDATE referees SET name=COALESCE(?,name), sport=?, level=COALESCE(?,level), phone=?, status=COALESCE(?,status) WHERE id=?',
    name == null ? null : String(name), sport == null ? r.sport : (sport || null), level == null ? null : String(level),
    phone == null ? r.phone : String(phone), status == null ? null : String(status), r.id)
  res.json({ ok: true })
})

// 冲突预检（GET，不改数据）
app.get('/api/matches/:id/conflicts', (req, res) => {
  const m = get('SELECT * FROM matches WHERE id=?', Number(req.params.id))
  if (!m) return res.status(404).json({ error: '场次不存在' })
  const refereeId = req.query.referee_id ? Number(req.query.referee_id) : null
  const venueId = req.query.venue_id != null ? Number(req.query.venue_id) : null
  const dateLabel = req.query.date_label ?? null
  const timeLabel = req.query.time_label ?? null
  const probe = { ...m, venue_id: venueId ?? m.venue_id, date_label: dateLabel ?? m.date_label, time_label: timeLabel ?? m.time_label }
  const vcs = (venueId != null || dateLabel || timeLabel)
    ? venueConflicts(m.id, probe.venue_id, probe.date_label, probe.time_label)
    : all(`SELECT * FROM matches WHERE venue_id=? AND id<>? AND status='scheduled'`, m.venue_id, m.id).filter(x => overlaps(m, x))
  const refConflicts = refereeId ? refereeConflicts(m.id, refereeId) : []
  res.json({
    venue_conflicts: vcs.map(joinMatch),
    referee_conflicts: refConflicts.map(joinMatch),
    warnings: refereeId ? (() => { try { return refereeWarnings(refereeId, m.sport_id) } catch (e) { return [e.message] } })() : []
  })
})

app.post('/api/matches/:id/assign', (req, res) => {
  try {
    const r = assignReferee(Number(req.params.id), Number(req.body.referee_id), req.body.role || '主裁判', req.body.operator, !!req.body.force)
    res.json(r)
  } catch (e) { res.status(e.conflicts ? 409 : 400).json({ error: e.message, conflicts: !!e.conflicts }) }
})
app.post('/api/matches/:id/swap', (req, res) => {
  try {
    const r = swapReferee(Number(req.params.id), Number(req.body.from_referee_id), Number(req.body.to_referee_id), req.body.operator, !!req.body.force)
    res.json(r)
  } catch (e) { res.status(e.conflicts ? 409 : 400).json({ error: e.message, conflicts: !!e.conflicts }) }
})
app.post('/api/matches/:id/release', (req, res) => {
  try { res.json(releaseAssignment(Number(req.params.id), Number(req.body.referee_id), req.body.operator, req.body.reason)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/matches/:id/reschedule', (req, res) => {
  try { res.json(rescheduleMatch(Number(req.params.id), req.body, req.body.operator, !!req.body.force)) }
  catch (e) {
    if (e.conflicts) return res.status(409).json({ error: e.message, conflicts: true, problems: e.allProblems || [e.message] })
    res.status(400).json({ error: e.message })
  }
})
app.get('/api/assignment-logs', (req, res) => {
  const limit = Math.min(300, Number(req.query.limit) || 100)
  const rows = all(`SELECT l.*, r.name referee_name,
    s.name sport_name, m.stage, m.group_name,
    ta.name team_a_name, tb.name team_b_name, m.time_label, m.date_label
    FROM assignment_logs l
    LEFT JOIN referees r ON r.id=l.referee_id
    LEFT JOIN matches m ON m.id=l.match_id
    LEFT JOIN sports s ON s.id=m.sport_id
    LEFT JOIN teams ta ON ta.id=m.team_a
    LEFT JOIN teams tb ON tb.id=m.team_b
    ORDER BY l.id DESC LIMIT ?`, limit)
  res.json(rows)
})
app.get('/api/officiating', (_, res) => res.json(officiatingReport()))

app.get('/api/overview', (_, res) => {
  const sp = all('SELECT * FROM sports')
  const mats = all('SELECT * FROM matches')
  const done = mats.filter(m => m.status === 'finished')
  const pend = mats.filter(m => m.status === 'scheduled')
  const activeCount = get(`SELECT COUNT(DISTINCT match_id) c FROM assignments WHERE status='active'`)?.c || 0
  const ofc = officiatingReport()
  res.json({
    sports: sp.length,
    finishedMatches: done.length,
    pendingMatches: pend.length,
    teams: all('SELECT id FROM teams').length || 0,
    athletes: all('SELECT id FROM athletes').length,
    officiating: {
      covered: ofc.covered, unassigned: ofc.unassigned, conflict_matches: ofc.conflict_matches,
      referee_conflicts: ofc.referee_conflict_matches, venue_conflicts: ofc.venue_conflict_matches
    },
    assignmentsActive: activeCount,
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
  try {
    finishMatch(m.id, sa, sb, tb_a, tb_b)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }
  res.json({ ok: true })
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
  ['registrations', 'entries', 'standings', 'medals', 'assignment_logs', 'assignments', 'matches', 'referees', 'venues', 'athletes', 'teams', 'units', 'sports'].forEach(t => { try { run(`DELETE FROM ${t}`) } catch (e) {} })
  // 清空自增序列，保证种子数据中对场地 id 的引用（2/3/5）一致
  try { run(`DELETE FROM sqlite_sequence`) } catch (e) {}
  seed()
  res.json({ ok: true })
})

app.listen(PORT, () => console.log(`[SPORT] API running at http://localhost:${PORT}`))