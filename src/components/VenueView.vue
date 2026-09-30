<script setup>
import { ref, computed, reactive } from 'vue'
import { useEventStore } from '@/store/event'
import { venueConflicts, refereeConflicts, refereeWarnings, matchConflicts } from '@/utils/officiate.js'

const store = useEventStore()
const tab = ref('board')
const toast = ref('')
const showToast = (msg, bad) => { toast.value = (bad ? '⚠️ ' : '✅ ') + msg; setTimeout(() => toast.value = '', 3200) }

const ROLES = ['主裁判', '副裁判', '记录台']
const LEVELS = ['国家级', '一级', '二级']
const REF_STATUS = ['就绪', '休假', '停赛']

const sportName = id => store.sports.find(s => s.id === id)?.name || ''
const matchTitle = m => `${m.sport_name || sportName(m.sport_id)} · ${m.stage}${m.group_name ? ' · ' + m.group_name : ''}　${m.teamA?.name || '待定'} vs ${m.teamB?.name || '待定'}`

/* ============ KPI ============ */
const ofc = computed(() => store.officiating || {})
const venueBusy = computed(() => {
  const map = {}
  store.matches.forEach(m => { if (m.venue && m.status === 'scheduled') map[m.venue_id] = (map[m.venue_id] || 0) + 1 })
  return map
})

/* ============ 排班看板 ============ */
const dateFilter = ref('all')
const sportFilter = ref('all')
const dates = computed(() => [...new Set(store.matches.filter(m => m.status === 'scheduled').map(m => m.date_label))].sort())
const scheduled = computed(() => store.matches
  .filter(m => m.status === 'scheduled')
  .filter(m => dateFilter.value === 'all' || m.date_label === dateFilter.value)
  .filter(m => sportFilter.value === 'all' || m.sport_id === Number(sportFilter.value))
  .sort((a, b) => (a.date_label || '').localeCompare(b.date_label || '') || (a.time_label || '').localeCompare(b.time_label || '') || a.order_no - b.order_no))

// 每场的实时冲突
const cfOf = m => matchConflicts(store.matches, m)

/* ---- 安排裁判 ---- */
const assignDlg = reactive({ open: false, match: null, role: '主裁判', refereeId: null })
function openAssign(m, role) { Object.assign(assignDlg, { open: true, match: m, role, refereeId: null }) }
function closeAssign() { assignDlg.open = false }
const assignPreview = computed(() => {
  if (!assignDlg.open || !assignDlg.match || !assignDlg.refereeId) return null
  const rf = store.refOf(assignDlg.refereeId)
  const warnings = refereeWarnings(rf, sportName(assignDlg.match.sport_id))
  const conflicts = refereeConflicts(store.matches, assignDlg.refereeId, assignDlg.match.id)
  return { warnings, conflicts, has: warnings.length || conflicts.length }
})
const sameRoleRef = computed(() => assignDlg.match ? (assignDlg.match.referees || []).find(r => r.role === assignDlg.role) : null)
async function doAssign(force = false) {
  if (!assignDlg.refereeId) return showToast('请选择裁判', true)
  try {
    const r = await store.assignReferee(assignDlg.match.id, { referee_id: assignDlg.refereeId, role: assignDlg.role, force })
    showToast(force ? `已强制安排${r.replaced ? '（替换 ' + r.replaced + '）' : ''}` : `已安排 ${store.refOf(assignDlg.refereeId)?.name} 担任${assignDlg.role}${r.replaced ? '（替换 ' + r.replaced + '）' : ''}`)
    closeAssign()
  } catch (e) {
    if (!force && e.conflicts) showToast(e.message + ' —— 如确认无误可强制安排', true)
    else showToast(e.message, true)
  }
}

/* ---- 调班 ---- */
const swapDlg = reactive({ open: false, match: null, from: null, toId: null })
function openSwap(m, refRow) { Object.assign(swapDlg, { open: true, match: m, from: refRow, toId: null }) }
function closeSwap() { swapDlg.open = false }
const swapPreview = computed(() => {
  if (!swapDlg.open || !swapDlg.toId) return null
  const rf = store.refOf(swapDlg.toId)
  const warnings = refereeWarnings(rf, sportName(swapDlg.match.sport_id))
  const conflicts = refereeConflicts(store.matches, swapDlg.toId, swapDlg.match.id)
  return { warnings, conflicts, has: warnings.length || conflicts.length }
})
async function doSwap(force = false) {
  if (!swapDlg.toId) return showToast('请选择接替裁判', true)
  try {
    const r = await store.swapReferee(swapDlg.match.id, { from_referee_id: swapDlg.from.id, to_referee_id: swapDlg.toId, force })
    showToast(`临时调班完成：${swapDlg.from.name} → ${store.refOf(swapDlg.toId)?.name}（${r.role}）`)
    closeSwap()
  } catch (e) { if (!force) showToast(e.message + ' —— 可强制调班', true); else showToast(e.message, true) }
}

/* ---- 撤出 ---- */
async function doRelease(m, refRow) {
  if (!confirm(`确认将 ${refRow.name} 撤出本场${refRow.role}安排？`)) return
  try { await store.releaseReferee(m.id, refRow.id, '临时调整'); showToast(`已撤出 ${refRow.name}，并留痕`) }
  catch (e) { showToast(e.message, true) }
}

/* ---- 改期/换场 ---- */
const schDlg = reactive({ open: false, match: null, form: {} })
function openSchedule(m) {
  schDlg.open = true; schDlg.match = m
  schDlg.form = { venue_id: m.venue_id, date_label: m.date_label, time_label: m.time_label, duration: m.duration }
}
function closeSchedule() { schDlg.open = false }
const schPreview = computed(() => {
  if (!schDlg.open) return null
  const vc = venueConflicts(store.matches, schDlg.match.id, schDlg.form)
  const probe = { ...schDlg.match, ...schDlg.form }
  const refCf = []
  ;(schDlg.match.referees || []).forEach(r => {
    const cf = store.matches.filter(x =>
      x.id !== schDlg.match.id && x.status === 'scheduled' &&
      (x.referees || []).some(y => y.id === r.id))
      .filter(x => {
        const s1 = String(schDlg.form.time_label || '').split(':').map(Number)
        const s2 = String(x.time_label || '').split(':').map(Number)
        if ((schDlg.form.date_label || '') !== (x.date_label || '')) return false
        const b1 = s1[0] * 60 + s1[1], b2 = s2[0] * 60 + s2[1]
        return b1 < b2 + (Number(x.duration) || 60) && b2 < b1 + (Number(schDlg.form.duration) || 60)
      })
    if (cf.length) refCf.push({ referee: r, matches: cf })
  })
  return { vc, refCf, has: vc.length || refCf.length }
})
async function doReschedule(force = false) {
  try {
    const r = await store.rescheduleMatch(schDlg.match.id, { ...schDlg.form, force })
    showToast(`已改期/换场${r.venue_conflicts || r.referee_conflicts ? '（含强制冲突，已标记并留痕）' : '，执法安排同步更新'}`)
    closeSchedule()
  } catch (e) { if (!force) showToast(e.message + ' —— 可确认后强制执行', true); else showToast(e.message, true) }
}

/* ============ 裁判台账 ============ */
const refForm = reactive({ open: false, id: null, name: '', sport: '', level: '一级', phone: '', status: '就绪' })
function openRefAdd() { Object.assign(refForm, { open: true, id: null, name: '', sport: '', level: '一级', phone: '', status: '就绪' }) }
function openRefEdit(r) { Object.assign(refForm, { open: true, id: r.id, name: r.name, sport: r.sport || '', level: r.level || '一级', phone: r.phone || '', status: r.status || '就绪' }) }
function closeRefForm() { refForm.open = false }
async function saveRefForm() {
  if (!refForm.name.trim()) return showToast('请填写裁判姓名', true)
  const payload = { name: refForm.name.trim(), sport: refForm.sport || null, level: refForm.level, phone: refForm.phone || null, status: refForm.status }
  try {
    if (refForm.id) await store.saveReferee(refForm.id, payload)
    else await store.addReferee(payload)
    showToast('裁判档案已保存'); closeRefForm()
  } catch (e) { showToast(e.message, true) }
}
const refLoad = computed(() => {
  // 待赛执法场次 + 冲突场数
  return store.referees.map(r => {
    const mids = new Set(store.matches.filter(m => m.status === 'scheduled' && (m.referees || []).some(x => x.id === r.id)).map(m => m.id))
    const conflicts = store.matches.filter(m => mids.has(m.id) && (m.referees.find(x => x.id === r.id)?.conflict_flag)).length
    return { ...r, load: mids.size, conflicts }
  }).sort((a, b) => b.load - a.load)
})
const maxLoad = computed(() => Math.max(1, ...refLoad.value.map(r => r.load)))

/* ============ 场地日程 ============ */
const venueDate = ref('')
const venueDates = computed(() => [...new Set(store.matches.map(m => m.date_label))].sort())
const activeVenueDate = computed(() => venueDate.value || venueDates.value[0] || 'all')
const venueGrid = computed(() => store.venues.map(v => ({
  ...v,
  matches: store.matches
    .filter(m => m.venue_id === v.id && m.date_label === activeVenueDate.value)
    .sort((a, b) => (a.time_label || '').localeCompare(b.time_label || ''))
})))

/* ============ 留痕 ============ */
const logFilter = ref('all')
const LOG_META = {
  assign: { icon: '➕', text: '安排', cls: 'g' }, swap: { icon: '🔄', text: '调班', cls: 'b' },
  release: { icon: '➖', text: '释放', cls: 'gray' }, reschedule: { icon: '🗓️', text: '改期', cls: 'y' },
  sync: { icon: '🔗', text: '赛程联动', cls: 'o' }
}
const logs = computed(() => store.assignmentLogs
  .filter(l => logFilter.value === 'all' || l.action === logFilter.value))

/* ============ 资格状态标签 ============ */
const statusTag = s => ({ 就绪: 'g', 休假: 'y', 停赛: 'r' }[s] || 'gray')
</script>

<template>
  <div v-if="store.loaded">
    <div class="page-h">
      <div><h2>📍 裁判排班与场地协同</h2><div class="sub">裁判分配 · 时间冲突检测 · 临时调班留痕 · 赛程变更自动同步执法安排</div></div>
      <div v-if="toast" class="toast">{{ toast }}</div>
      <div class="filters">
        <button class="chip" :class="{ on: tab === 'board' }" @click="tab='board'">🧑‍⚖️ 排班看板</button>
        <button class="chip" :class="{ on: tab === 'roster' }" @click="tab='roster'">📇 裁判台账</button>
        <button class="chip" :class="{ on: tab === 'venue' }" @click="tab='venue'">🗺️ 场地日程</button>
        <button class="chip" :class="{ on: tab === 'logs' }" @click="tab='logs'">📜 操作留痕<span v-if="store.assignmentLogs.length" class="log-badge">{{ store.assignmentLogs.length }}</span></button>
      </div>
    </div>

    <!-- KPI -->
    <div class="grid g4">
      <div class="card stat">
        <span class="bar" :style="{ background: 'linear-gradient(90deg, var(--accent2), #7edda4)' }"></span>
        <span class="ic">✅</span><b>{{ ofc.covered || 0 }}<span class="kpi-sub">/{{ ofc.total_scheduled || 0 }}</span></b>
        <em>已排班 / 待赛场次</em>
      </div>
      <div class="card stat">
        <span class="bar" :style="{ background: 'linear-gradient(90deg,#ffb92b,#ffd98a)' }"></span>
        <span class="ic">🕳️</span><b>{{ ofc.unassigned || 0 }}</b><em>未安排执法场次</em>
      </div>
      <div class="card stat">
        <span class="bar" :style="{ background: 'linear-gradient(90deg,#e5484d,#f0a1a1)' }"></span>
        <span class="ic">⚠️</span><b>{{ ofc.conflict_matches || 0 }}</b><em>存在冲突的场次</em>
      </div>
      <div class="card stat">
        <span class="bar" :style="{ background: 'linear-gradient(90deg, var(--accent3), #7cc4ff)' }"></span>
        <span class="ic">🧑‍⚖️</span><b>{{ store.referees.length }}</b><em>在册裁判（{{ store.referees.filter(r=>r.status==='就绪').length }} 人就绪）</em>
      </div>
    </div>

    <!-- ============ 排班看板 ============ -->
    <template v-if="tab==='board'">
      <div class="card mt">
        <div class="caption">
          <span>🗓️ 待赛场次执法排班</span>
          <div class="filters">
            <button class="chip sm" :class="{ on: dateFilter==='all' }" @click="dateFilter='all'">全部比赛日</button>
            <button v-for="d in dates" :key="d" class="chip sm" :class="{ on: dateFilter===d }" @click="dateFilter=d">{{ d }}</button>
            <button class="chip sm" :class="{ on: sportFilter==='all' }" @click="sportFilter='all'">全部项目</button>
            <button v-for="s in store.sports" :key="s.id" class="chip sm" :class="{ on: sportFilter===String(s.id) }" @click="sportFilter=String(s.id)">{{ s.name }}</button>
          </div>
        </div>
        <div class="pad" style="display:flex;flex-direction:column;gap:14px">
          <div v-for="m in scheduled" :key="m.id" class="assign-card" :class="{ conflict: cfOf(m).venue.length || cfOf(m).referees.length }">
            <div class="ac-head">
              <div>
                <span class="tag b">{{ m.date_label }} · {{ m.time_label }}</span>
                <span class="tag gray" style="margin-left:6px">⏱ {{ m.duration }} 分钟</span>
                <span class="tag gray" style="margin-left:6px">📍 {{ m.venue?.name || '未定场地' }}</span>
                <b style="margin-left:8px;font-size:14px">{{ matchTitle(m) }}</b>
              </div>
              <div class="row">
                <button class="btn ghost sm" @click="openSchedule(m)">🗓️ 改期/换场</button>
              </div>
            </div>

            <!-- 冲突提示 -->
            <div v-if="cfOf(m).venue.length" class="cf-line venue-cf">
              ⛔ <b>场地冲突：</b>
              <span v-for="(c, i) in cfOf(m).venue" :key="c.id">{{ i ? '；' : '' }}{{ c.date_label }} {{ c.time_label }} {{ c.venue?.name }} 另有 {{ matchTitle(c) }}</span>
            </div>
            <div v-for="rc in cfOf(m).referees" :key="rc.referee.id" class="cf-line ref-cf">
              ⏰ <b>{{ rc.referee.name }}（{{ rc.referee.role }}）时间冲突：</b>
              <span v-for="(c, i) in rc.matches" :key="c.id">{{ i ? '；' : '' }}{{ c.date_label }} {{ c.time_label }} {{ c.venue?.name }} · {{ matchTitle(c) }}</span>
            </div>

            <!-- 执法名单 -->
            <div class="ac-roster">
              <div v-for="role in ROLES" :key="role" class="role-cell">
                <div class="role-name">{{ role }}</div>
                <template v-if="(m.referees||[]).find(r=>r.role===role)">
                  <template v-for="r in m.referees.filter(x=>x.role===role)" :key="r.assignment_id">
                    <div class="ref-chip" :class="{ flagged: r.conflict_flag }">
                      <span>🧑‍⚖️ <b>{{ r.name }}</b>
                        <span class="tag gray" style="margin-left:4px">{{ r.level }}</span>
                        <span v-if="r.sport" class="tag gray" style="margin-left:2px">{{ r.sport }}</span>
                        <span v-if="r.conflict_flag" class="tag r" style="margin-left:2px">⚠ 时间冲突</span>
                      </span>
                      <span class="ref-ops">
                        <button class="link-btn" @click="openSwap(m, r)">🔄 调班</button>
                        <button class="link-btn danger" @click="doRelease(m, r)">撤出</button>
                      </span>
                    </div>
                  </template>
                </template>
                <button v-else class="btn primary sm" @click="openAssign(m, role)">➕ 安排{{ role }}</button>
              </div>
            </div>
          </div>
          <div v-if="!scheduled.length" class="empty">当前筛选下没有待赛场次</div>
        </div>
      </div>
    </template>

    <!-- ============ 裁判台账 ============ -->
    <template v-else-if="tab==='roster'">
      <div class="card">
        <div class="caption"><span>📇 裁判档案与负荷</span><button class="btn primary sm" @click="openRefAdd">➕ 录入裁判</button></div>
        <div class="pad">
          <table>
            <thead><tr><th>姓名</th><th>执法专项</th><th>等级</th><th>联系电话</th><th>状态</th><th style="width:200px">待赛负荷</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="r in refLoad" :key="r.id">
                <td><b>🧑‍⚖️ {{ r.name }}</b><span v-if="r.conflicts" class="tag r" style="margin-left:6px">⚠{{ r.conflicts }} 场冲突</span></td>
                <td>{{ r.sport || '综合执法' }}</td>
                <td><span class="tag b">{{ r.level }}</span></td>
                <td class="ph">{{ r.phone || '—' }}</td>
                <td><span class="tag" :class="statusTag(r.status)">{{ r.status }}</span></td>
                <td>
                  <div class="row" style="gap:8px">
                    <div class="hbar" style="flex:1"><i :style="{ width: (r.load/maxLoad*100)+'%', background: r.conflicts ? '#e5484d' : 'var(--accent3)' }"></i></div>
                    <b class="mono">{{ r.load }} 场</b>
                  </div>
                </td>
                <td><button class="btn ghost sm" @click="openRefEdit(r)">✏️ 编辑</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ============ 场地日程 ============ -->
    <template v-else-if="tab==='venue'">
      <div class="card">
        <div class="caption">
          <span>🗺️ 场地日程（同一比赛日各场地占用）</span>
          <div class="filters">
            <button v-for="d in venueDates" :key="d" class="chip sm" :class="{ on: activeVenueDate===d }" @click="venueDate=d">{{ d }}</button>
          </div>
        </div>
        <div class="pad" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">
          <div v-for="v in venueGrid" :key="v.id" class="venue-col">
            <div class="venue-head">🏟️ {{ v.name }} <span class="tag gray">{{ v.matches.length }} 场</span></div>
            <div v-if="!v.matches.length" class="empty" style="padding:20px">当日无安排</div>
            <div v-for="m in v.matches" :key="m.id" class="venue-slot" :class="m.status">
              <div class="vs-time">{{ m.time_label }}<span class="tag gray" style="margin-left:4px">{{ m.duration }}′</span></div>
              <div class="vs-title">{{ matchTitle(m) }}</div>
              <div class="vs-refs">
                <span v-for="r in (m.referees||[])" :key="r.assignment_id" class="mini-ref" :class="{ flagged: r.conflict_flag }">
                  {{ r.role }}: {{ r.name }}<span v-if="r.conflict_flag">⚠</span>
                </span>
                <span v-if="!(m.referees||[]).length" class="ph">未安排执法</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ============ 操作留痕 ============ -->
    <template v-else>
      <div class="card">
        <div class="caption">
          <span>📜 排班操作留痕（分配 / 调班 / 释放 / 改期 / 赛程联动，全部可追溯）</span>
          <div class="filters">
            <button class="chip sm" :class="{ on: logFilter==='all' }" @click="logFilter='all'">全部</button>
            <button v-for="(meta, key) in LOG_META" :key="key" class="chip sm" :class="{ on: logFilter===key }" @click="logFilter=key">{{ meta.icon }} {{ meta.text }}</button>
          </div>
        </div>
        <div class="pad">
          <table>
            <thead><tr><th style="width:150px">时间</th><th style="width:90px">动作</th><th style="width:100px">裁判</th><th style="width:80px">角色</th><th>详情</th><th style="width:90px">操作人</th></tr></thead>
            <tbody>
              <tr v-for="l in logs" :key="l.id">
                <td class="ph mono" style="font-size:12px">{{ l.created_at }}</td>
                <td><span class="tag" :class="LOG_META[l.action]?.cls">{{ LOG_META[l.action]?.icon }} {{ LOG_META[l.action]?.text }}</span></td>
                <td><b>{{ l.referee_name || '—' }}</b></td>
                <td class="ph">{{ l.role || '—' }}</td>
                <td style="font-size:12.5px">
                  <span class="ph" v-if="l.sport_name">[{{ l.sport_name }}{{ l.group_name ? ' · ' + l.group_name : '' }}{{ l.team_a_name ? ' · ' + l.team_a_name + ' vs ' + l.team_b_name : '' }} · {{ l.date_label || '' }} {{ l.time_label || '' }}] </span>{{ l.detail }}
                </td>
                <td><span class="tag" :class="l.operator==='系统' ? 'o' : 'gray'">{{ l.operator }}</span></td>
              </tr>
            </tbody>
          </table>
          <div v-if="!logs.length" class="empty">暂无留痕记录</div>
        </div>
      </div>
    </template>

    <!-- ===== 安排裁判弹窗 ===== -->
    <div v-if="assignDlg.open" class="modal-mask" @click.self="closeAssign">
      <div class="modal">
        <div class="modal-h">➕ 安排{{ assignDlg.role }} <button class="link-btn" @click="closeAssign">✕</button></div>
        <div class="modal-b">
          <div class="ph" style="margin-bottom:10px">{{ assignDlg.match && matchTitle(assignDlg.match) }} · {{ assignDlg.match?.date_label }} {{ assignDlg.match?.time_label }} · {{ assignDlg.match?.venue?.name }}</div>
          <div v-if="sameRoleRef" class="cf-line ref-cf" style="margin-bottom:10px">当前{{ assignDlg.role }}为 <b>{{ sameRoleRef.name }}</b>，安排新裁判将自动替换并留痕。</div>
          <select v-model.number="assignDlg.refereeId" style="width:100%">
            <option :value="null" disabled>选择裁判</option>
            <option v-for="r in store.referees" :key="r.id" :value="r.id">
              {{ r.name }}（{{ r.level }} · {{ r.sport || '综合执法' }} · {{ r.status }}）
            </option>
          </select>
          <div v-if="assignPreview" style="margin-top:12px">
            <div v-for="(w, i) in assignPreview.warnings" :key="'w'+i" class="cf-line warn">🟡 {{ w }}</div>
            <div v-for="(c, i) in assignPreview.conflicts" :key="'c'+i" class="cf-line ref-cf">⏰ 与已排执法冲突：{{ matchTitle(c) }}（{{ c.date_label }} {{ c.time_label }} · {{ c.venue?.name }}）</div>
            <div v-if="!assignPreview.has" class="cf-line ok">✔ 无时间冲突，资格匹配</div>
          </div>
        </div>
        <div class="modal-f">
          <button class="btn ghost" @click="closeAssign">取消</button>
          <button v-if="assignPreview?.has" class="btn" style="background:#fff1e6;color:var(--accent)" @click="doAssign(true)">⚠ 强制安排</button>
          <button class="btn primary" :disabled="assignPreview?.has" @click="doAssign(false)">确认安排</button>
        </div>
      </div>
    </div>

    <!-- ===== 调班弹窗 ===== -->
    <div v-if="swapDlg.open" class="modal-mask" @click.self="closeSwap">
      <div class="modal">
        <div class="modal-h">🔄 临时调班 <button class="link-btn" @click="closeSwap">✕</button></div>
        <div class="modal-b">
          <div class="ph" style="margin-bottom:8px">{{ swapDlg.match && matchTitle(swapDlg.match) }}</div>
          <div style="margin-bottom:12px">调下：<b>{{ swapDlg.from?.name }}</b>（{{ swapDlg.from?.role }}） → 接替裁判：</div>
          <select v-model.number="swapDlg.toId" style="width:100%">
            <option :value="null" disabled>选择接替裁判</option>
            <option v-for="r in store.referees.filter(x=>x.id!==swapDlg.from?.id)" :key="r.id" :value="r.id">
              {{ r.name }}（{{ r.level }} · {{ r.sport || '综合执法' }} · {{ r.status }}）
            </option>
          </select>
          <div v-if="swapPreview" style="margin-top:12px">
            <div v-for="(w, i) in swapPreview.warnings" :key="'w'+i" class="cf-line warn">🟡 {{ w }}</div>
            <div v-for="(c, i) in swapPreview.conflicts" :key="'c'+i" class="cf-line ref-cf">⏰ 与已排执法冲突：{{ matchTitle(c) }}（{{ c.date_label }} {{ c.time_label }} · {{ c.venue?.name }}）</div>
            <div v-if="!swapPreview.has" class="cf-line ok">✔ 无时间冲突，资格匹配</div>
          </div>
        </div>
        <div class="modal-f">
          <button class="btn ghost" @click="closeSwap">取消</button>
          <button v-if="swapPreview?.has" class="btn" style="background:#fff1e6;color:var(--accent)" @click="doSwap(true)">⚠ 强制调班</button>
          <button class="btn primary" :disabled="swapPreview?.has" @click="doSwap(false)">确认调班</button>
        </div>
      </div>
    </div>

    <!-- ===== 改期/换场弹窗 ===== -->
    <div v-if="schDlg.open" class="modal-mask" @click.self="closeSchedule">
      <div class="modal">
        <div class="modal-h">🗓️ 改期 / 换场 <button class="link-btn" @click="closeSchedule">✕</button></div>
        <div class="modal-b">
          <div class="ph" style="margin-bottom:12px">{{ schDlg.match && matchTitle(schDlg.match) }}</div>
          <div class="form-grid">
            <label>比赛日<input v-model="schDlg.form.date_label" placeholder="如 第1比赛日 / 2026-05-01"></label>
            <label>开赛时间<input v-model="schDlg.form.time_label" placeholder="HH:MM"></label>
            <label>时长(分钟)<input v-model.number="schDlg.form.duration" type="number" min="10" step="5"></label>
            <label>场地
              <select v-model.number="schDlg.form.venue_id">
                <option v-for="v in store.venues" :key="v.id" :value="v.id">{{ v.name }}</option>
              </select>
            </label>
          </div>
          <div v-if="schPreview" style="margin-top:12px">
            <div v-for="(c, i) in schPreview.vc" :key="'v'+i" class="cf-line venue-cf">⛔ 场地冲突：{{ c.date_label }} {{ c.time_label }} {{ c.venue?.name }} 已有 {{ matchTitle(c) }}</div>
            <div v-for="(rc, i) in schPreview.refCf" :key="'r'+i" class="cf-line ref-cf">⏰ {{ rc.referee.name }}（{{ rc.referee.role }}）改期后与 {{ rc.matches.map(x=>matchTitle(x)).join('；') }} 时间重叠</div>
            <div v-if="!schPreview.has" class="cf-line ok">✔ 改期后无场地与裁判冲突，全部执法安排同步保留</div>
          </div>
        </div>
        <div class="modal-f">
          <button class="btn ghost" @click="closeSchedule">取消</button>
          <button v-if="schPreview?.has" class="btn" style="background:#fff1e6;color:var(--accent)" @click="doReschedule(true)">⚠ 强制执行（自动标记冲突）</button>
          <button class="btn primary" :disabled="schPreview?.has" @click="doReschedule(false)">保存并同步排班</button>
        </div>
      </div>
    </div>

    <!-- ===== 裁判档案弹窗 ===== -->
    <div v-if="refForm.open" class="modal-mask" @click.self="closeRefForm">
      <div class="modal">
        <div class="modal-h">{{ refForm.id ? '✏️ 编辑裁判档案' : '➕ 录入裁判' }} <button class="link-btn" @click="closeRefForm">✕</button></div>
        <div class="modal-b">
          <div class="form-grid">
            <label>姓名<input v-model="refForm.name" placeholder="裁判姓名"></label>
            <label>执法专项
              <select v-model="refForm.sport">
                <option value="">综合执法</option>
                <option v-for="s in store.sports" :key="s.id" :value="s.name">{{ s.name }}</option>
              </select>
            </label>
            <label>等级
              <select v-model="refForm.level"><option v-for="l in LEVELS" :key="l" :value="l">{{ l }}</option></select>
            </label>
            <label>联系电话<input v-model="refForm.phone" placeholder="选填"></label>
            <label>在岗状态
              <select v-model="refForm.status"><option v-for="s in REF_STATUS" :key="s" :value="s">{{ s }}</option></select>
            </label>
          </div>
        </div>
        <div class="modal-f">
          <button class="btn ghost" @click="closeRefForm">取消</button>
          <button class="btn primary" @click="saveRefForm">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.kpi-sub { font-size: 14px; color: var(--muted); font-weight: 600; }
.log-badge { background: var(--accent); color: #fff; border-radius: 20px; padding: 0 7px; font-size: 10px; margin-left: 3px; }
.chip.sm { padding: 4px 10px; font-size: 11px; }
.assign-card { border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; background: #fff; box-shadow: var(--shadow-sm); }
.assign-card.conflict { border-color: #f3c1c3; background: linear-gradient(180deg, #fff8f8, #fff); }
.ac-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.ac-roster { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 10px; }
.role-cell { background: var(--bg2); border-radius: 11px; padding: 10px 12px; }
.role-name { font-size: 11px; font-weight: 800; color: var(--muted); margin-bottom: 7px; letter-spacing: .5px; }
.ref-chip { display: flex; justify-content: space-between; align-items: center; gap: 6px; background: #fff; border: 1px solid var(--line); border-radius: 9px; padding: 6px 9px; font-size: 12.5px; }
.ref-chip.flagged { border-color: #f0a1a1; background: #fff6f6; }
.ref-ops { display: flex; gap: 4px; flex-shrink: 0; }
.link-btn { background: none; color: var(--accent3); font-size: 11.5px; font-weight: 700; padding: 2px 4px; border-radius: 6px; }
.link-btn:hover { background: #e8f2ff; }
.link-btn.danger { color: #e5484d; }
.link-btn.danger:hover { background: #ffecec; }
.cf-line { font-size: 12px; border-radius: 9px; padding: 7px 10px; margin-top: 7px; line-height: 1.6; }
.venue-cf { background: #ffecec; color: #b33; border: 1px dashed #f0a1a1; }
.ref-cf { background: #fff6e8; color: #a05a00; border: 1px dashed #ffce85; }
.cf-line.warn { background: #fff8e6; color: #a07a00; border: 1px dashed #ffd98a; }
.cf-line.ok { background: #e6f7ec; color: #178a47; border: 1px dashed #9fe0b6; }
.venue-col { border: 1px solid var(--line); border-radius: 12px; padding: 10px; background: #fff; }
.venue-head { font-weight: 800; font-size: 13px; padding-bottom: 8px; border-bottom: 1px solid var(--line); margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
.venue-slot { border-left: 3px solid var(--accent3); background: var(--bg2); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
.venue-slot.finished { border-left-color: var(--accent2); }
.venue-slot.void { border-left-color: #e5484d; opacity: .75; }
.vs-time { font-weight: 800; font-size: 12.5px; margin-bottom: 3px; }
.vs-title { font-size: 12.5px; font-weight: 600; }
.vs-refs { margin-top: 5px; display: flex; flex-direction: column; gap: 2px; }
.mini-ref { font-size: 11px; color: var(--muted); }
.mini-ref.flagged { color: #e5484d; font-weight: 700; }
/* 弹窗 */
.modal-mask { position: fixed; inset: 0; background: rgba(29,39,51,.42); display: grid; place-items: center; z-index: 1000; }
.modal { background: #fff; border-radius: 16px; width: min(620px, 92vw); box-shadow: 0 20px 60px rgba(0,0,0,.25); overflow: hidden; }
.modal-h { padding: 15px 20px; font-weight: 800; font-size: 15px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; }
.modal-b { padding: 18px 20px; max-height: 62vh; overflow: auto; }
.modal-f { padding: 13px 20px; border-top: 1px solid var(--line); display: flex; justify-content: flex-end; gap: 9px; background: #fbfcfe; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-grid label { font-size: 12px; font-weight: 700; color: var(--muted); display: flex; flex-direction: column; gap: 5px; }
.form-grid input, .form-grid select { width: 100%; }
@media (max-width: 900px) { .ac-roster, .form-grid { grid-template-columns: 1fr; } }
</style>
