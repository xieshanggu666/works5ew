<script setup>
import { ref, computed, reactive } from 'vue'
import { useEventStore } from '@/store/event'

const store = useEventStore()
const tab = ref('board')
const toast = ref('')
function flash(msg, ok = true) { toast.value = (ok ? '✅ ' : '⚠️ ') + msg; setTimeout(() => toast.value = '', 3200) }

const ROLE_NAME = { chief: '主裁', assistant: '助理裁判', recorder: '记录台' }
const LOG_NAME = {
  assign: '排班', force_assign: '强制排班', auto_assign: '自动排班',
  release: '解除安排', reassign: '临时调班', swap: '调班对调',
  match_change: '赛程变更', schedule_added: '赛程新增', schedule_rebuild: '赛程重排',
  match_finish: '完赛归档', void_release: '取消解除'
}
const LOG_CLS = {
  assign: 'b', force_assign: 'r', auto_assign: 'g', release: 'gray',
  reassign: 'o', swap: 'o', match_change: 'y', schedule_added: 'b',
  schedule_rebuild: 'y', match_finish: 'g', void_release: 'r'
}
const TIME_PRESETS = ['09:00', '09:20', '09:30', '09:40', '10:00', '10:20', '10:40', '11:00', '11:20', '12:30', '13:00', '14:00', '14:30', '15:30', '16:00']

/* ---------- 排班总览 ---------- */
const ballMatches = computed(() => store.matches
  .filter(m => m.status === 'scheduled' && m.team_a && m.team_b)
  .sort((a, b) => (a.time_label || '').localeCompare(b.time_label || '') || a.order_no - b.order_no))

const sportsWithScheduled = computed(() => store.sports.filter(s => ballMatches.value.some(m => m.sport_id === s.id && s.format !== 'track')))
const iconOf = s => ({ '球类': '🏀', '田径': '🏃', '水上': '🏊', '棋牌': '♟️' }[s.category] || '🏅')

const forms = reactive({})   // match_id -> { referee_id, role }
function formOf(mid) { if (!forms[mid]) forms[mid] = { referee_id: '', role: 'chief' }; return forms[mid] }
const avRefs = mid => store.referees.filter(r => !store.crewOf(mid).some(a => a.referee_id === r.id))
const clashText = n => n ? `⚠️ ${n} 场撞档` : '时段占用正常'
const skillWarn = (mid, rid) => {
  const r = store.referees.find(x => x.id === Number(rid)); const m = store.matches.find(x => x.id === mid)
  if (!r || !r.sport) return ''
  const sp = store.sports.find(s => s.id === m.sport_id)
  return r.sport === sp.name || r.sport === sp.category ? '' : `专长「${r.sport}」与本项不符`
}

// 分配裁判（冲突 / 专长不符 → 弹窗确认后可强制安排）
const forceDlg = reactive({ show: false, mid: 0, rid: 0, role: 'chief', title: '', reason: '', conflicts: null, mismatch: '' })
async function submitAssign(mid, force = false) {
  const f = formOf(mid)
  if (!f.referee_id) return flash('请先选择裁判', false)
  try {
    await store.assignReferee({ match_id: mid, referee_id: Number(f.referee_id), role: f.role, reason: forceDlg.reason || '排班', force })
    if (force) forceDlg.show = false
    f.referee_id = ''; f.role = 'chief'
    flash('执法安排已保存（已留痕）')
  } catch (e) {
    if (e.status === 409) {
      const m = store.matches.find(x => x.id === mid)
      forceDlg.show = true; forceDlg.mid = mid; forceDlg.rid = Number(f.referee_id); forceDlg.role = f.role
      forceDlg.title = m; forceDlg.conflicts = e.conflicts; forceDlg.mismatch = e.code === 'SKILL_MISMATCH' ? e.message : ''
      forceDlg.reason = ''
    } else flash(e.message, false)
  }
}

async function doAuto() {
  const r = await store.autoAssign()
  flash(`智能排班完成：成功 ${r.assigned.length} 场，跳过 ${r.skipped.length} 场`)
}

async function doRelease(a) {
  const reason = prompt(`解除「${a.referee.name}」在该场次的${ROLE_NAME[a.role]}安排，需填写原因并留痕：`, '临时工作调整')
  if (reason == null) return
  if (!reason.trim()) return flash('解除原因不能为空', false)
  try { await store.releaseAssignment(a.id, reason.trim()); flash('执法安排已解除并留痕') }
  catch (e) { flash(e.message, false) }
}

// 临时调班（改派 / 对调）
const reDlg = reactive({ show: false, aid: 0, mode: 'replace', target_id: '', new_ref: '', reason: '', error: '', from: null })
function openReassign(a) {
  reDlg.show = true; reDlg.aid = a.id; reDlg.mode = 'replace'; reDlg.target_id = ''; reDlg.new_ref = ''
  reDlg.reason = ''; reDlg.error = ''; reDlg.from = a
}
const swapTargets = computed(() => {
  if (!reDlg.from) return []
  return store.assignments.filter(a => a.id !== reDlg.from.id && a.role === 'chief' && a.match?.status === 'scheduled')
})
const replaceRefs = computed(() => {
  if (!reDlg.from) return []
  return store.referees.filter(r => r.id !== reDlg.from.referee_id && !store.crewOf(reDlg.from.match_id).some(a => a.referee_id === r.id))
})
async function submitReassign() {
  if (!reDlg.reason.trim()) { reDlg.error = '调班必须填写原因并留痕'; return }
  try {
    if (reDlg.mode === 'swap') {
      if (!reDlg.target_id) { reDlg.error = '请选择对调场次'; return }
      await store.reassignAssignment(reDlg.aid, { target_id: Number(reDlg.target_id), reason: reDlg.reason.trim() })
    } else {
      if (!reDlg.new_ref) { reDlg.error = '请选择改派裁判'; return }
      await store.reassignAssignment(reDlg.aid, { new_referee_id: Number(reDlg.new_ref), reason: reDlg.reason.trim() })
    }
    reDlg.show = false
    flash('临时调班完成，已同步检测冲突并留痕')
  } catch (e) { reDlg.error = e.message }
}

// 赛程变更（时间 / 场地），联动校验裁判与场地冲突
const scDlg = reactive({ show: false, mid: 0, time_label: '', venue_id: '', reason: '', error: '', conflicts: null, force: false })
function openSchedule(m) {
  scDlg.show = true; scDlg.mid = m.id; scDlg.time_label = m.time_label || ''; scDlg.venue_id = m.venue_id || ''
  scDlg.reason = ''; scDlg.error = ''; scDlg.conflicts = null; scDlg.force = false
}
async function submitSchedule(force = false) {
  try {
    await store.changeSchedule(scDlg.mid, { time_label: scDlg.time_label, venue_id: scDlg.venue_id ? Number(scDlg.venue_id) : null, reason: scDlg.reason.trim() || '赛程调整', force })
    scDlg.show = false
    flash('赛程已变更，执法安排联动校验完成')
  } catch (e) {
    if (e.status === 409) { scDlg.conflicts = e.conflicts; scDlg.force = true; scDlg.error = e.message }
    else { scDlg.error = e.message }
  }
}

/* ---------- 场地协同 ---------- */
const venueRows = computed(() => store.venues.map(v => {
  const ms = store.matches.filter(m => m.venue_id === v.id && m.status === 'scheduled')
  const slots = {}
  ms.forEach(m => { (slots[m.time_label] = slots[m.time_label] || []).push(m) })
  const clashSlots = Object.entries(slots).filter(([, list]) => list.length > 1)
  return { ...v, total: ms.length, clashCount: clashSlots.reduce((n, [, l]) => n + l.length, 0), slots }
}))
const clashList = computed(() => store.conflicts?.venue_conflicts || [])

/* ---------- 裁判名册 ---------- */
const newRef = reactive({ name: '', sport: '', level: '主裁' })
async function addReferee() {
  if (!newRef.name.trim()) return flash('裁判姓名不能为空', false)
  try { await store.addReferee({ name: newRef.name.trim(), sport: newRef.sport || null, level: newRef.level }); newRef.name = ''; newRef.sport = ''; flash('裁判已录入名册') }
  catch (e) { flash(e.message, false) }
}
const workloadOf = id => store.workload.find(w => w.id === id) || { done: 0, upcoming: 0 }
const refClashIds = computed(() => new Set((store.conflicts?.referee_conflicts || []).map(c => c.referee_id)))

const conflictCount = computed(() => (store.conflicts?.referee_conflicts.length || 0) + (store.conflicts?.venue_conflicts.length || 0))
</script>

<template>
  <div v-if="store.loaded">
    <div class="page-h">
      <div><h2>📍 裁判排班与场地协同</h2><div class="sub">裁判分配 · 时间冲突检测 · 临时调班留痕 · 赛程变更联动执法安排</div></div>
      <div class="filters">
        <button class="chip" :class="{ on: tab === 'board' }" @click="tab = 'board'">🧑‍⚖️ 排班总览</button>
        <button class="chip" :class="{ on: tab === 'venue' }" @click="tab = 'venue'">🏟️ 场地协同<span v-if="clashList.length" class="dot-badge">{{ clashList.length }}</span></button>
        <button class="chip" :class="{ on: tab === 'refs' }" @click="tab = 'refs'">📋 裁判名册</button>
        <button class="chip" :class="{ on: tab === 'logs' }" @click="tab = 'logs'">🧾 变更留痕</button>
      </div>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>

    <!-- 顶部预警条 -->
    <div v-if="store.conflicts && (store.conflicts.unassigned.length || conflictCount || store.conflicts.skill_mismatch.length)" class="warnbar">
      <span v-if="store.conflicts.unassigned.length" class="warn-item o">🟠 {{ store.conflicts.unassigned.length }} 场待赛未安排主裁</span>
      <span v-if="store.conflicts.referee_conflicts.length" class="warn-item r">⛔ {{ store.conflicts.referee_conflicts.length }} 起裁判时间冲突</span>
      <span v-if="store.conflicts.venue_conflicts.length" class="warn-item r">🏟️ {{ store.conflicts.venue_conflicts.length }} 起场地同时段撞场</span>
      <span v-if="store.conflicts.skill_mismatch.length" class="warn-item y">⚠️ {{ store.conflicts.skill_mismatch.length }} 条跨专长执法</span>
    </div>

    <!-- ============ Tab 1：排班总览 ============ -->
    <template v-if="tab === 'board'">
      <div class="grid g4">
        <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#ff7a2f,#ffb27e)"></span><span class="ic">🗓️</span><b>{{ ballMatches.length }}</b><em>待赛场次</em></div>
        <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#22c15e,#7edda4)"></span><span class="ic">✅</span><b>{{ ballMatches.length - store.conflicts.unassigned.length }}</b><em>已安排主裁</em></div>
        <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#ffb92b,#ffd98a)"></span><span class="ic">🟠</span><b>{{ store.conflicts.unassigned.length }}</b><em>待安排</em></div>
        <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#dd5b5b,#f0a1a1)"></span><span class="ic">⛔</span><b>{{ conflictCount }}</b><em>冲突预警</em></div>
      </div>

      <div class="card mt">
        <div class="caption">
          <span>🧑‍⚖️ 待赛场次执法排班</span>
          <div class="row">
            <span class="hint">同裁判同时段自动拦截 · 专长不符提示</span>
            <button class="btn primary sm" @click="doAuto">🤖 一键智能排班</button>
          </div>
        </div>
        <div class="pad" style="display:flex;flex-direction:column;gap:14px">
          <div v-for="s in sportsWithScheduled" :key="s.id">
            <div class="sport-cap">{{ iconOf(s) }} {{ s.name }}</div>
            <div v-for="m in ballMatches.filter(x => x.sport_id === s.id)" :key="m.id" class="assign-card">
              <div class="ac-head">
                <span class="tag" :class="m.stage === '决赛' || m.stage === '季军' ? 'y' : 'b'">{{ m.stage }}{{ m.group_name ? ' · ' + m.group_name : '' }}</span>
                <b>{{ m.teamA?.name || '待定' }}</b><span class="vs">VS</span><b>{{ m.teamB?.name || '待定' }}</b>
                <span class="ph" style="margin-left:auto">⏱ {{ m.time_label || '时间待定' }} · 📍 {{ m.venue?.name || '未指定' }}</span>
              </div>
              <div class="ac-crew">
                <template v-if="store.crewOf(m.id).length">
                  <span v-for="a in store.crewOf(m.id)" :key="a.id" class="crew-chip">
                    <span class="tag gray">{{ ROLE_NAME[a.role] }}</span>
                    <b>{{ a.referee?.name }}</b>
                    <span v-if="a.referee?.sport && a.referee.sport !== s.name && a.referee.sport !== s.category" class="tag y" title="跨专长执法">跨项</span>
                    <button class="mini" title="临时调班" @click="openReassign(a)">🔄 调班</button>
                    <button class="mini danger" title="解除安排" @click="doRelease(a)">✕</button>
                  </span>
                </template>
                <span v-else class="tag o">🟠 尚无执法裁判</span>
              </div>
              <div class="ac-form">
                <select v-model="formOf(m.id).referee_id">
                  <option value="" disabled>选择裁判…</option>
                  <option v-for="r in avRefs(m.id)" :key="r.id" :value="r.id">{{ r.name }}（{{ r.sport || '综合执法' }} · {{ r.level }}）</option>
                </select>
                <select v-model="formOf(m.id).role">
                  <option value="chief">主裁</option>
                  <option value="assistant">助理裁判</option>
                  <option value="recorder">记录台</option>
                </select>
                <button class="btn primary sm" :disabled="!formOf(m.id).referee_id" @click="submitAssign(m.id)">➕ 安排执法</button>
                <button class="btn ghost sm" @click="openSchedule(m)">🕐 改赛程/场地</button>
                <span v-if="formOf(m.id).referee_id && skillWarn(m.id, formOf(m.id).referee_id)" class="tag y">{{ skillWarn(m.id, formOf(m.id).referee_id) }}，可强制安排</span>
              </div>
            </div>
          </div>
          <div v-if="!sportsWithScheduled.length" class="empty">暂无可排班的待赛场次</div>
        </div>
      </div>

      <!-- 全局冲突明细 -->
      <div v-if="store.conflicts?.referee_conflicts.length" class="card mt">
        <div class="caption"><span>⛔ 裁判时间冲突明细</span><span class="hint">请立即调班或解除其中一场安排</span></div>
        <div class="pad">
          <table>
            <thead><tr><th>裁判</th><th>时段</th><th>冲突场次 A</th><th></th><th>冲突场次 B</th></tr></thead>
            <tbody>
              <tr v-for="c in store.conflicts.referee_conflicts" :key="c.key">
                <td><b>{{ c.referee }}</b></td><td class="mono">{{ c.time }}</td>
                <td>{{ c.match_x.title }}</td><td class="ph">⚡</td><td>{{ c.match_y.title }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ============ Tab 2：场地协同 ============ -->
    <template v-else-if="tab === 'venue'">
      <div class="grid g3">
        <div v-for="v in venueRows" :key="v.id" class="card stat" :class="{ clash: v.clashCount }">
          <span class="bar" :style="{ background: v.clashCount ? 'linear-gradient(90deg,#e5484d,#f0a1a1)' : 'linear-gradient(90deg, var(--accent3), #7cc4ff)' }"></span>
          <span class="ic">🏟️</span>
          <b>{{ v.name }}</b>
          <em>待赛 {{ v.total }} 场 · <span :style="{ color: v.clashCount ? '#e5484d' : 'inherit', fontWeight: v.clashCount ? 800 : 400 }">{{ clashText(v.clashCount) }}</span></em>
        </div>
      </div>

      <div class="card mt">
        <div class="caption"><span>🕐 各场地时段排布</span><span class="hint">同场地同时段多场即撞场，可就地调整赛程</span></div>
        <div class="pad" style="display:flex;flex-direction:column;gap:16px">
          <div v-for="v in venueRows" :key="'t' + v.id">
            <div class="sport-cap">📍 {{ v.name }}</div>
            <div v-if="!v.total" class="empty" style="padding:14px">暂无待赛占用</div>
            <div v-for="(list, t) in v.slots" :key="t" class="slot-row" :class="{ hot: list.length > 1 }">
              <span class="slot-time mono">{{ t }}</span>
              <span v-for="m in list" :key="m.id" class="slot-match">
                <b>{{ store.sports.find(s => s.id === m.sport_id)?.name }}</b> · {{ m.stage }}{{ m.group_name || '' }}
                {{ m.teamA?.name }} VS {{ m.teamB?.name }}
                <span class="tag gray">{{ store.chiefOf(m.id)?.referee?.name || '主裁待安排' }}</span>
                <button class="mini" @click="tab = 'board'">去处理</button>
              </span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="clashList.length" class="card mt">
        <div class="caption"><span>⛔ 场地撞场预警</span></div>
        <div class="pad">
          <table>
            <thead><tr><th>场地</th><th>时段</th><th>场次 A</th><th></th><th>场次 B</th></tr></thead>
            <tbody>
              <tr v-for="c in clashList" :key="c.key">
                <td><b>{{ c.venue }}</b></td><td class="mono">{{ c.time }}</td>
                <td>{{ c.match_x.title }}</td><td class="ph">⚡</td><td>{{ c.match_y.title }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ============ Tab 3：裁判名册 ============ -->
    <template v-else-if="tab === 'refs'">
      <div class="card">
        <div class="caption"><span>🧑‍⚖️ 裁判名册与执法负荷</span><span class="hint">已完赛/待赛场次自动汇总</span></div>
        <div class="pad">
          <table>
            <thead><tr><th>姓名</th><th>专长项目</th><th>等级</th><th>状态</th><th>已执法</th><th>待执法</th><th>冲突</th></tr></thead>
            <tbody>
              <tr v-for="r in store.referees" :key="r.id">
                <td><b>{{ r.name }}</b></td>
                <td>{{ r.sport || '综合执法' }}</td>
                <td>{{ r.level }}</td>
                <td><span class="tag" :class="refClashIds.has(r.id) ? 'r' : 'g'">{{ refClashIds.has(r.id) ? '时间冲突' : (r.status || '就绪') }}</span></td>
                <td class="mono">{{ workloadOf(r.id).done || 0 }}</td>
                <td class="mono">{{ workloadOf(r.id).upcoming || 0 }}</td>
                <td><span v-if="refClashIds.has(r.id)" class="tag r">需调班</span><span v-else class="tag gray">正常</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="card mt">
        <div class="caption"><span>➕ 录入裁判</span></div>
        <div class="pad row wrap">
          <input v-model="newRef.name" placeholder="裁判姓名" style="width:140px" />
          <input v-model="newRef.sport" placeholder="专长项目（空=综合执法）" style="width:200px" list="sport-list" />
          <datalist id="sport-list">
            <option v-for="s in store.sports.filter(x => x.format !== 'track')" :key="s.id" :value="s.name" />
          </datalist>
          <select v-model="newRef.level" style="width:120px">
            <option value="主裁">主裁</option><option value="助理裁判">助理裁判</option><option value="记录台">记录台</option>
          </select>
          <button class="btn primary sm" @click="addReferee">录入</button>
        </div>
      </div>
    </template>

    <!-- ============ Tab 4：变更留痕 ============ -->
    <template v-else>
      <div class="card">
        <div class="caption"><span>🧾 排班与赛程变更留痕</span><span class="hint">排班 / 强制覆盖 / 调班 / 赛程变更 / 完赛归档 全程可追溯</span></div>
        <div class="pad">
          <table>
            <thead><tr><th>时间</th><th>操作</th><th>详情</th><th>原因</th><th>操作人</th></tr></thead>
            <tbody>
              <tr v-for="l in store.assignmentLogs" :key="l.id">
                <td class="mono ph" style="white-space:nowrap">{{ l.created_at }}</td>
                <td><span class="tag" :class="LOG_CLS[l.action] || 'gray'">{{ LOG_NAME[l.action] || l.action }}</span></td>
                <td>{{ l.detail }}</td>
                <td class="ph">{{ l.reason || '—' }}</td>
                <td><b>{{ l.operator }}</b></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- 强制安排确认弹窗 -->
    <div v-if="forceDlg.show" class="modal-mask" @click.self="forceDlg.show = false">
      <div class="modal">
        <h3>⚠️ 存在冲突/专长不符，确认强制安排？</h3>
        <div v-if="forceDlg.conflicts?.referee?.length" class="conf-box">
          <b>时间冲突：</b>
          <div v-for="(c, i) in forceDlg.conflicts.referee" :key="i" class="conf-line">⛔ {{ c.title }}</div>
        </div>
        <div v-if="forceDlg.mismatch" class="conf-box y">{{ forceDlg.mismatch }}</div>
        <div class="pad-note">强制安排将写入留痕（标记为"强制排班"），并在裁判名册中持续预警。</div>
        <textarea v-model="forceDlg.reason" rows="2" placeholder="强制安排原因（必填留痕）" style="width:100%"></textarea>
        <div class="row spread mt16">
          <button class="btn ghost sm" @click="forceDlg.show = false">取消</button>
          <button class="btn primary sm" :disabled="!forceDlg.reason.trim()" @click="submitAssign(forceDlg.mid, true)">确认强制安排</button>
        </div>
      </div>
    </div>

    <!-- 临时调班弹窗 -->
    <div v-if="reDlg.show" class="modal-mask" @click.self="reDlg.show = false">
      <div class="modal">
        <h3>🔄 临时调班</h3>
        <div class="pad-note">原安排：<b>{{ reDlg.from?.referee?.name }}</b> 担任 {{ ROLE_NAME[reDlg.from?.role] }}（{{ reDlg.from?.match ? reDlg.from.match.stage : '' }} · {{ reDlg.from?.match?.time_label }}）</div>
        <div class="row wrap mt8">
          <label class="row"><input type="radio" value="replace" v-model="reDlg.mode" /> 改派其他裁判</label>
          <label class="row"><input type="radio" value="swap" v-model="reDlg.mode" /> 与另一场主裁对调</label>
        </div>
        <select v-if="reDlg.mode === 'replace'" v-model="reDlg.new_ref" class="mt8" style="width:100%">
          <option value="" disabled>选择接替裁判…</option>
          <option v-for="r in replaceRefs" :key="r.id" :value="r.id">{{ r.name }}（{{ r.sport || '综合执法' }}）</option>
        </select>
        <select v-else v-model="reDlg.target_id" class="mt8" style="width:100%">
          <option value="" disabled>选择对调场次的主裁安排…</option>
          <option v-for="a in swapTargets" :key="a.id" :value="a.id">{{ a.referee?.name }} → {{ a.match?.time_label }} {{ a.match?.stage }}{{ a.match?.group_name || '' }}</option>
        </select>
        <textarea v-model="reDlg.reason" rows="2" class="mt8" placeholder="调班原因（必填，将写入留痕）" style="width:100%"></textarea>
        <div v-if="reDlg.error" class="tag r mt8">{{ reDlg.error }}</div>
        <div class="row spread mt16">
          <button class="btn ghost sm" @click="reDlg.show = false">取消</button>
          <button class="btn primary sm" @click="submitReassign">确认调班</button>
        </div>
      </div>
    </div>

    <!-- 赛程变更弹窗 -->
    <div v-if="scDlg.show" class="modal-mask" @click.self="scDlg.show = false">
      <div class="modal">
        <h3>🕐 调整赛程时间 / 场地</h3>
        <div class="row wrap mt8" style="gap:12px">
          <label>开赛时间
            <input v-model="scDlg.time_label" list="time-presets" placeholder="如 10:00" style="width:130px;margin-left:6px" />
            <datalist id="time-presets"><option v-for="t in TIME_PRESETS" :key="t" :value="t" /></datalist>
          </label>
          <label>比赛场地
            <select v-model="scDlg.venue_id" style="width:160px;margin-left:6px">
              <option value="">保持原场地</option>
              <option v-for="v in store.venues" :key="v.id" :value="v.id">{{ v.name }}</option>
            </select>
          </label>
        </div>
        <textarea v-model="scDlg.reason" rows="2" class="mt8" placeholder="变更原因（将写入留痕）" style="width:100%"></textarea>
        <div v-if="scDlg.conflicts" class="conf-box mt8">
          <div v-if="scDlg.conflicts.venue?.length"><b>🏟️ 场地撞场：</b><div v-for="(c,i) in scDlg.conflicts.venue" :key="'v'+i" class="conf-line">⛔ {{ c.title }}</div></div>
          <div v-if="scDlg.conflicts.referee?.length"><b>🧑‍⚖️ 裁判时间冲突：</b><div v-for="(c,i) in scDlg.conflicts.referee" :key="'r'+i" class="conf-line">⛔ {{ c.referee }} 同时执法 {{ c.title }}</div></div>
        </div>
        <div class="row spread mt16">
          <button class="btn ghost sm" @click="scDlg.show = false">取消</button>
          <div class="row">
            <button v-if="scDlg.conflicts" class="btn ghost sm" @click="submitSchedule(true)">强制生效并留痕</button>
            <button class="btn primary sm" @click="submitSchedule(false)">保存变更</button>
          </div>
        </div>
        <div v-if="scDlg.error" class="tag r mt8">{{ scDlg.error }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dot-badge { background: #e5484d; color: #fff; border-radius: 20px; font-size: 10px; padding: 1px 6px; margin-left: 4px; }
.warnbar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.warn-item { font-size: 12px; font-weight: 700; padding: 7px 13px; border-radius: 10px; }
.warn-item.o { background: #fff1e6; color: var(--accent); }
.warn-item.r { background: #ffecec; color: #e5484d; }
.warn-item.y { background: #fff6dd; color: #c98a00; }
.stat.clash { border-color: #f3b4b6; }
.sport-cap { font-size: 12px; font-weight: 800; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; margin: 4px 0 8px; }
.assign-card { border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; background: #fff; box-shadow: var(--shadow-sm); margin-bottom: 10px; }
.ac-head { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.ac-head .vs { color: var(--muted); font-size: 11px; font-weight: 700; }
.ac-crew { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
.crew-chip { display: inline-flex; align-items: center; gap: 6px; background: var(--bg2); border-radius: 10px; padding: 4px 8px; font-size: 12px; }
.ac-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.ac-form select { padding: 7px 9px; }
.mini { background: #fff; border: 1px solid var(--line); border-radius: 7px; font-size: 11px; padding: 2px 7px; color: var(--muted); }
.mini:hover { border-color: var(--accent); color: var(--accent); }
.mini.danger:hover { border-color: #e5484d; color: #e5484d; }
.slot-row { display: flex; gap: 10px; align-items: flex-start; padding: 9px 12px; border-radius: 10px; background: #fbfcfe; border: 1px dashed var(--line); margin-bottom: 7px; flex-wrap: wrap; }
.slot-row.hot { background: #fff5f5; border-color: #f0a1a1; }
.slot-time { font-weight: 800; min-width: 52px; color: var(--accent3); }
.slot-match { font-size: 12px; display: inline-flex; align-items: center; gap: 6px; background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 5px 9px; }
.hint { font-size: 12px; color: var(--muted); font-weight: 500; margin-right: 10px; }
.modal-mask { position: fixed; inset: 0; background: rgba(29,39,51,.42); display: grid; place-items: center; z-index: 1000; }
.modal { background: #fff; border-radius: 16px; padding: 22px; width: 520px; max-width: calc(100vw - 40px); box-shadow: var(--shadow); }
.modal h3 { font-size: 17px; margin-bottom: 12px; }
.modal textarea, .modal select, .modal input { margin-top: 0; }
.conf-box { background: #fff5f5; border: 1px solid #f0a1a1; border-radius: 10px; padding: 10px 12px; font-size: 12px; margin-top: 10px; }
.conf-box.y { background: #fff6dd; border-color: #f0d68a; }
.conf-line { margin-top: 5px; }
.pad-note { font-size: 12px; color: var(--muted); background: var(--bg2); border-radius: 9px; padding: 8px 11px; }
</style>
