<script setup>
import { computed } from 'vue'
import { useEventStore } from '@/store/event'
const store = useEventStore()

const bestAttack = computed(() => {
  const rows = []
  store.sports.forEach(s => {
    (store.standings[s.id] || []).forEach(r => { if (r.play > 0) rows.push({ t: r.tname, sport: s.name, gf: r.gf - r.ga, unit: r.unit, color: r.color }) })
  })
  return rows.sort((a, b) => b.gf - a.gf).slice(0, 6)
})
const maxGD = computed(() => Math.max(1, ...bestAttack.value.map(r => r.gf)))

const unitPoints = computed(() => {
  const m = {}
  const u = store.units
  u.forEach(x => m[x.id] = { name: x.name, color: x.color, pts: 0, gold: 0 })
  store.teams.forEach(t => {
    const st = (store.standings[t.sport_id] || []).find(r => r.team_id === t.id)
    if (st && m[t.unit_id]) m[t.unit_id].pts += st.points
  })
  store.medals.forEach(md => { if (m[md.unit_id]) m[md.unit_id].gold = md.gold })
  return Object.values(m).sort((a, b) => b.pts - a.pts)
})
const maxPts = computed(() => Math.max(1, ...unitPoints.value.map(x => x.pts)))

// 裁判执法负荷（待赛场次）
const refLoad = computed(() => store.referees.map(r => {
  const mids = new Set(store.matches.filter(m => m.status === 'scheduled' && (m.referees || []).some(x => x.id === r.id)).map(m => m.id))
  const done = store.matches.filter(m => m.status === 'finished' && (m.referees || []).some(x => x.id === r.id)).length
  const conflicts = store.matches.filter(m => mids.has(m.id) && m.referees.find(x => x.id === r.id)?.conflict_flag).length
  return { ...r, pending: mids.size, done, conflicts }
}).sort((a, b) => (b.pending + b.done) - (a.pending + a.done)))
const maxRefLoad = computed(() => Math.max(1, ...refLoad.value.map(r => r.pending + r.done)))

// 未安排执法的待赛场次
const unassignedMatches = computed(() => store.matches.filter(m => m.status === 'scheduled' && !(m.referees || []).length))

// 留痕动作分布
const logStat = computed(() => {
  const g = {}
  store.assignmentLogs.forEach(l => { g[l.action] = (g[l.action] || 0) + 1 })
  return g
})
const LOG_LABEL = { assign: '安排', swap: '临时调班', release: '释放撤出', reschedule: '改期换场', sync: '赛程联动' }
const sportName = id => store.sports.find(s => s.id === id)?.name || ''

// 各项目执法排班覆盖与冲突
function sportCoverage(sid) {
  const sched = store.matches.filter(m => m.sport_id === sid && m.status === 'scheduled')
  const covered = sched.filter(m => (m.referees || []).length).length
  const conflicts = sched.filter(m => (m.referees || []).some(r => r.conflict_flag)).length
  return { total: sched.length, covered, unassigned: sched.length - covered, conflicts }
}
</script>

<template>
  <div v-if="store.loaded">
    <div class="page-h">
      <div><h2>📊 报表中心</h2><div class="sub">赛事数据洞察：净胜球排行 · 综合积分 · 裁判执法排班 · 项目概览</div></div>
    </div>

    <div class="grid g2">
      <!-- 净胜球排行 -->
      <div class="card">
        <div class="caption">🔥 最佳攻击线（净胜球）</div>
        <div class="pad" style="display:flex;flex-direction:column;gap:14px">
          <div v-for="(r, ri) in bestAttack" :key="ri + '-' + r.t">
            <div class="row spread" style="margin-bottom:6px">
              <span class="badge"><span class="dot" :style="{ background: r.color }"></span>{{ r.t }} <span class="tag gray" style="margin-left:4px">{{ r.sport }}</span></span>
              <b class="mono">{{ r.gf > 0 ? '+' : '' }}{{ r.gf }}</b>
            </div>
            <div class="hbar"><i :style="{ width: (r.gf / maxGD) * 100 + '%', background: r.gf > 0 ? 'var(--accent)' : '#e5484d' }"></i></div>
          </div>
        </div>
      </div>

      <!-- 单位综合积分 -->
      <div class="card">
        <div class="caption">🏅 单位综合积分（球类积分之和）</div>
        <div class="pad" style="display:flex;flex-direction:column;gap:14px">
          <div v-for="u in unitPoints" :key="u.name">
            <div class="row spread" style="margin-bottom:6px">
              <span class="badge"><span class="dot" :style="{ background: u.color }"></span>{{ u.name }}</span>
              <span><span class="tag y">🥇{{ u.gold }}</span> <b class="mono" style="font-size:16px;color:var(--accent)">{{ u.pts }}</b></span>
            </div>
            <div class="hbar"><i :style="{ width: (u.pts / maxPts) * 100 + '%' }"></i></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 裁判执法报表 -->
    <div class="grid g2 mt">
      <div class="card">
        <div class="caption">🧑‍⚖️ 裁判执法负荷 <span class="hint">待赛 {{ store.officiating?.covered || 0 }}/{{ store.officiating?.total_scheduled || 0 }} 场已覆盖 · {{ store.officiating?.conflict_matches || 0 }} 场冲突</span></div>
        <div class="pad" style="display:flex;flex-direction:column;gap:12px">
          <div v-for="r in refLoad" :key="r.id">
            <div class="row spread" style="margin-bottom:5px">
              <span class="badge">{{ r.name }} <span class="tag gray" style="margin-left:4px">{{ r.level }} · {{ r.sport || '综合' }}</span><span v-if="r.conflicts" class="tag r" style="margin-left:4px">⚠{{ r.conflicts }}冲突</span></span>
              <span class="mono" style="font-size:12px"><span style="color:var(--accent3);font-weight:800">{{ r.pending }} 待赛</span> · {{ r.done }} 已完赛</span>
            </div>
            <div class="hbar"><i :style="{ width: ((r.pending + r.done) / maxRefLoad) * 100 + '%', background: r.conflicts ? '#e5484d' : 'var(--accent3)' }"></i></div>
          </div>
        </div>
      </div>

      <div class="grid" style="grid-template-columns:1fr;gap:16px">
        <!-- 排班留痕统计 -->
        <div class="card">
          <div class="caption">📜 排班操作留痕分布 <span class="hint">共 {{ store.assignmentLogs.length }} 条</span></div>
          <div class="pad">
            <div class="grid g2" style="gap:10px">
              <div v-for="(label, key) in LOG_LABEL" :key="key" class="log-stat">
                <b class="mono">{{ logStat[key] || 0 }}</b><span class="tag gray">{{ label }}</span>
              </div>
            </div>
          </div>
        </div>
        <!-- 未安排执法场次 -->
        <div class="card" style="flex:1">
          <div class="caption">🕳️ 待安排执法场次 <span class="hint">{{ unassignedMatches.length }} 场</span></div>
          <div class="pad" style="display:flex;flex-direction:column;gap:7px;max-height:210px;overflow:auto">
            <div v-for="m in unassignedMatches" :key="m.id" class="miss-line">
              {{ m.date_label }} {{ m.time_label }} · {{ sportName(m.sport_id) }} {{ m.stage }}{{ m.group_name || '' }} · {{ m.teamA?.name }} vs {{ m.teamB?.name }} · 📍{{ m.venue?.name }}
            </div>
            <div v-if="!unassignedMatches.length" class="empty" style="padding:14px">✔ 待赛场次均已安排执法裁判</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 项目明细 -->
    <div class="card mt">
      <div class="caption">🗂️ 赛事项目明细与规则</div>
      <div class="pad">
        <table>
          <thead><tr><th>项目</th><th>类别</th><th>赛制</th><th>场地</th><th>已完成/总场次</th><th>执法排班</th><th>冠军归属</th></tr></thead>
          <tbody>
            <tr v-for="s in store.sports" :key="s.id">
              <td><b>{{ s.name }}</b></td>
              <td><span class="tag b">{{ s.category }}</span></td>
              <td>{{ s.format === 'roundrobin' ? '单循环积分制' : s.format === 'group_knockout' ? '小组赛 + 淘汰赛' : s.format === 'knockout' ? '单败淘汰' : '计时成绩' }}</td>
              <td>{{ s.venue }}</td>
              <td class="mono">{{ store.overview?.sportDone?.find(x=>x.id===s.id)?.done || 0 }}/{{ store.overview?.sportDone?.find(x=>x.id===s.id)?.total || 0 }}</td>
              <td>
                <span class="tag" :class="sportCoverage(s.id).unassigned > 0 ? 'y' : 'g'">{{ sportCoverage(s.id).covered }}/{{ sportCoverage(s.id).total }} 已排</span>
                <span v-if="sportCoverage(s.id).conflicts" class="tag r" style="margin-left:4px">⚠{{ sportCoverage(s.id).conflicts }}</span>
              </td>
              <td class="ph">{{ s.finished ? '已产生' : '待结算' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.log-stat { display: flex; align-items: center; justify-content: space-between; background: var(--bg2); border-radius: 10px; padding: 10px 14px; }
.log-stat b { font-size: 20px; color: var(--accent); }
.miss-line { font-size: 12px; color: var(--ink); background: #fff8e6; border: 1px dashed #ffd98a; border-radius: 8px; padding: 6px 10px; }
</style>