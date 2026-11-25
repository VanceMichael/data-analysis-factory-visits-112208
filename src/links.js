// 以厂址为识别单位，把已核实的"同线"关系并成一个独立能力单位。
// 共享生产设备的两个品牌不能算两份独立能力；品牌、接单方名称都不作为识别依据。

const PERMISSION_RANK = { 公开: 0, 受限: 1 }

export function permissionRank(level) {
  return PERMISSION_RANK[level] ?? -1
}

export function stricterPermission(a, b) {
  return permissionRank(a) >= permissionRank(b) ? a : b
}

export function canRead(readerLevel, rowLevel) {
  return permissionRank(readerLevel) >= permissionRank(rowLevel)
}

export function entityIdOf(plants) {
  return [...plants].sort().join('+')
}

class DisjointSet {
  constructor(ids) {
    this.parent = new Map(ids.map(id => [id, id]))
  }
  find(id) {
    let root = id
    while (this.parent.get(root) !== root) root = this.parent.get(root)
    while (this.parent.get(id) !== root) {
      const next = this.parent.get(id)
      this.parent.set(id, root)
      id = next
    }
    return root
  }
  union(a, b) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(rb, ra)
  }
}

// 只承认"确认同线"；"待核/疑似"保留为待办证据，不改变独立性。
// 默认应用全部已核实的同线更新：地址核实是对身份的追溯修正，
// 不应因为访问发生在上一季就继续把同一产线当两份能力。可用 asOfSeason 限定"当时已知"。
export function buildEntities(frame, linkUpdates, { asOfSeason = null } = {}) {
  const plants = frame.map(row => row.plant)
  const plantSet = new Set(plants)
  const dsu = new DisjointSet(plants)
  const pending = []
  const applied = []
  const ignored = []

  for (const link of linkUpdates) {
    if (asOfSeason && link.season > asOfSeason) {
      ignored.push({ ...link, why: '晚于观察时点' })
      continue
    }
    const pairs = []
    for (const left of link.lefts) {
      for (const right of link.rights) pairs.push([left, right])
    }
    for (const [left, right] of pairs) {
      if (!plantSet.has(left) || !plantSet.has(right)) {
        ignored.push({ ...link, why: '引用不在底册' })
        continue
      }
      if (link.state === '确认同线') {
        dsu.union(left, right)
        applied.push({ ...link, left, right })
      } else {
        pending.push({ ...link, left, right })
      }
    }
  }

  const buckets = new Map()
  for (const row of frame) {
    const root = dsu.find(row.plant)
    if (!buckets.has(root)) buckets.set(root, [])
    buckets.get(root).push(row)
  }

  const entities = []
  const plantToEntity = new Map()
  for (const rows of buckets.values()) {
    const members = rows.map(r => r.plant).sort()
    const id = entityIdOf(members)
    const areas = [...new Set(rows.map(r => r.area))].sort()
    const groups = [...new Set(rows.map(r => r.group))].sort()
    const processes = [...new Set(rows.flatMap(r => r.process))].sort()
    const equipmentByProcess = new Map()
    for (const row of rows) {
      for (const process of row.process) {
        if (!equipmentByProcess.has(process)) equipmentByProcess.set(process, new Set())
        equipmentByProcess.get(process).add(row.equipment)
      }
    }
    const perm = rows
      .map(r => r.for_partner)
      .reduce((acc, level) => stricterPermission(acc, level), '公开')
    const entity = {
      id,
      plants: members,
      groups,
      areas,
      area: areas.length === 1 ? areas[0] : '跨区',
      processes,
      processList: [...processes],
      equipmentByProcess: Object.fromEntries(
        [...equipmentByProcess].map(([process, set]) => [process, [...set].sort()]),
      ),
      restricted: perm === '受限',
      permission: perm,
      frameRows: rows,
      merged: members.length > 1,
    }
    entities.push(entity)
    for (const plant of members) plantToEntity.set(plant, entity)
  }

  entities.sort((a, b) => a.id.localeCompare(b.id))
  return { entities, plantToEntity, appliedLinks: applied, pendingLinks: pending, ignoredLinks: ignored }
}

// 同线合并后，产能不能再按原厂各记一份；同一单位同一工序同一窗口取并集上限。
export function reconcileCapacity(capacityRows, plantToEntity) {
  const out = []
  const buckets = new Map()
  for (const row of capacityRows) {
    const entity = plantToEntity.get(row.facility)
    if (!entity) {
      out.push({ ...row, entityId: row.facility, orphan: true, coalesced: false })
      continue
    }
    const key = `${entity.id}|${row.process}|${row.window}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push({ ...row, entityId: entity.id })
  }

  for (const rows of buckets.values()) {
    const first = rows[0]
    const coalesced = rows.length > 1
    const hours = Math.max(...rows.map(r => r.hours ?? 0))
    const used = Math.max(...rows.map(r => r.used ?? 0))
    const permission = rows
      .map(r => r.permission)
      .reduce((acc, level) => stricterPermission(acc, level), '公开')
    out.push({
      entityId: first.entityId,
      facility: first.facility,
      facilities: [...new Set(rows.map(r => r.facility))],
      process: first.process,
      window: first.window,
      hours,
      used,
      available: Math.max(0, hours - used),
      source: [...new Set(rows.map(r => r.source))].join('+'),
      permission,
      coalesced,
      coalescedFrom: coalesced ? rows.map(r => `${r.facility}:${r.hours}/${r.used}`) : undefined,
    })
  }

  out.sort((a, b) =>
    `${a.entityId}${a.process}${a.window}`.localeCompare(`${b.entityId}${b.process}${b.window}`),
  )
  return out
}

// 合并后重新计算某单位在某工序上的入样概率；两个厂各自被抽中时，
// 单位被抽中的概率是 1-(1-p1)(1-p2)，不能继续按两家各记一份样本。
export function combineIncludeProbability(ps) {
  const values = ps.filter(p => typeof p === 'number' && p > 0 && p <= 1)
  if (values.length === 0) return null
  return 1 - values.reduce((prod, p) => prod * (1 - p), 1)
}
