// 读取合成资料，并把字符串形式的数字、日期与标记转成程序可用的类型。
// 原始记录在 data/*.json 中保持字符串格式，这里只做只读投影。

export const TABLE_NAMES = [
  'frame',
  'samples',
  'link_updates',
  'routes',
  'outlets',
  'capacity',
  'commitments',
]

const QUESTION = '?'

export function isUnknown(value) {
  return value === QUESTION || value === '*' || value === null || value === undefined
}

export function toNumber(value) {
  if (isUnknown(value)) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function toBoolean(value) {
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

// 组合编号在来源系统中以加号分隔，例如 "F3+F4"、"A+B"。
export function splitComposite(value) {
  if (isUnknown(value)) return []
  return String(value)
    .split('+')
    .map(part => part.trim())
    .filter(Boolean)
}

export function rowsOf(data, table) {
  const rows = data?.[table]
  if (!Array.isArray(rows)) throw new Error(`缺少资料表: ${table}`)
  return rows
}

export function parseFrame(data) {
  return rowsOf(data, 'frame').map(row => ({
    ...row,
    process: splitComposite(row.process),
  }))
}

export function parseSamples(data) {
  return rowsOf(data, 'samples').map(row => ({
    ...row,
    p: toNumber(row.p),
    processesAsked: splitComposite(row.process),
  }))
}

export function parseLinkUpdates(data) {
  return rowsOf(data, 'link_updates').map(row => ({
    ...row,
    lefts: splitComposite(row.left),
    rights: splitComposite(row.right),
  }))
}

export function parseRoutes(data) {
  return rowsOf(data, 'routes').map(row => ({
    ...row,
    plants: splitComposite(row.plants),
    size: toNumber(row.size),
    confirmed: toBoolean(row.confirmed),
  }))
}

export function parseOutlets(data) {
  return rowsOf(data, 'outlets').map(row => ({
    ...row,
    need: splitComposite(row.need),
    distinct: toNumber(row.distinct),
  }))
}

export function parseCapacity(data) {
  return rowsOf(data, 'capacity').map(row => ({
    ...row,
    hours: toNumber(row.hours),
    used: toNumber(row.used),
  }))
}

export function parseCommitments(data) {
  return rowsOf(data, 'commitments').map(row => ({
    ...row,
    processes: splitComposite(row.processes),
    hours: toNumber(row.hours),
  }))
}

export function parseAll(data) {
  return {
    frame: parseFrame(data),
    samples: parseSamples(data),
    link_updates: parseLinkUpdates(data),
    routes: parseRoutes(data),
    outlets: parseOutlets(data),
    capacity: parseCapacity(data),
    commitments: parseCommitments(data),
  }
}
