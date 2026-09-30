// 裁判排班与场地资源协同：前端时间重叠/冲突检测（与服务端口径一致）

export function toMin(t) {
  if (!t) return null
  const [h, m] = String(t).split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

// 两场比赛（同一比赛日）时间是否重叠：[start, start+duration)
export function overlaps(a, b) {
  if (!a || !b) return false
  if ((a.date_label || '') !== (b.date_label || '')) return false
  const s1 = toMin(a.time_label), s2 = toMin(b.time_label)
  if (s1 == null || s2 == null) return false
  return s1 < s2 + (Number(b.duration) || 60) && s2 < s1 + (Number(a.duration) || 60)
}

// 场地冲突：与指定场地/日期/时间重叠的其它待赛场次
export function venueConflicts(matches, matchId, { venue_id, date_label, time_label, duration } = {}) {
  const cur = matches.find(m => m.id === matchId)
  if (!cur || !venue_id) return []
  const probe = { ...cur, venue_id, date_label: date_label ?? cur.date_label, time_label: time_label ?? cur.time_label, duration: duration ?? cur.duration }
  return matches.filter(m =>
    m.id !== matchId && m.status === 'scheduled' && m.venue_id === venue_id && overlaps(probe, m)
  )
}

// 裁判冲突：该裁判在 probe（默认即该场）时间已被占用的其它待赛场次
export function refereeConflicts(matches, refereeId, matchId, override = {}) {
  const cur = matches.find(m => m.id === matchId)
  if (!cur || refereeId == null) return []
  const probe = { ...cur, ...override }
  return matches.filter(m =>
    m.id !== matchId && m.status === 'scheduled' &&
    (m.referees || []).some(r => r.id === refereeId) &&
    overlaps(probe, m)
  )
}

// 裁判资格警告（专项不符 / 休假）
export function refereeWarnings(referee, sportName) {
  if (!referee) return []
  const w = []
  if (referee.status === '休假') w.push(`${referee.name} 当前休假中，安排后需提前召回`)
  if (referee.sport && sportName && referee.sport !== sportName) w.push(`${referee.name} 专项为「${referee.sport}」，与本场「${sportName}」不符`)
  return w
}

// 一场比赛当前涉及的全部冲突（场地 + 各执法裁判）
export function matchConflicts(matches, m, override = {}) {
  if (!m) return { venue: [], referees: [] }
  const venue = override.venue_id !== undefined || override.time_label !== undefined
    ? venueConflicts(matches, m.id, {
        venue_id: override.venue_id ?? m.venue_id,
        date_label: override.date_label ?? m.date_label,
        time_label: override.time_label ?? m.time_label,
        duration: override.duration ?? m.duration
      })
    : venueConflicts(matches, m.id, { venue_id: m.venue_id })
  const referees = []
  ;(m.referees || []).forEach(r => {
    const cf = refereeConflicts(matches, r.id, m.id, override)
    if (cf.length) referees.push({ referee: r, matches: cf })
  })
  return { venue, referees }
}
