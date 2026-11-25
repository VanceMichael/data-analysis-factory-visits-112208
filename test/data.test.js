import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const tableNames = ["frame", "samples", "link_updates", "routes", "outlets", "capacity", "commitments"]
const records = new Map()

for (const name of tableNames) {
  const file = new URL(`../data/${name}.json`, import.meta.url)
  records.set(name, JSON.parse(await readFile(file, 'utf8')))
}

test('每张来源表保留一致的字段及原始值格式', () => {
  for (const [name, rows] of records) {
    assert.ok(rows.length > 0, name)
    const columns = Object.keys(rows[0])
    for (const row of rows) {
      assert.deepEqual(Object.keys(row), columns, name)
      assert.ok(Object.values(row).every(value => typeof value === 'string'), name)
    }
  }
})

test('关联的来源记录保留各自的引用字段', () => {
  const [left, leftKey, leftId, right, rightKey, rightId, leftField, rightField] =
    ["link_updates", "left", "F4", "frame", "plant", "F4", "state", "process"]
  const leftRows = records.get(left).filter(row => row[leftKey] === leftId)
  const rightRows = records.get(right).filter(row => row[rightKey] === rightId)
  assert.ok(leftRows.length > 0)
  assert.ok(rightRows.length > 0)
  assert.ok(leftRows.every(row => row[leftField]))
  assert.ok(rightRows.every(row => row[rightField]))
})

const plants = new Set(records.get('frame').map(row => row.plant))
const split = value => (value === '?' ? [] : value.split('+'))

test('访问记录引用的工厂都在底册中', () => {
  for (const row of records.get('samples')) {
    assert.ok(plants.has(row.plant), `samples.plant ${row.plant}`)
  }
})

test('同线更新两端都可解析到底册工厂', () => {
  for (const row of records.get('link_updates')) {
    for (const plant of [...split(row.left), ...split(row.right)]) {
      assert.ok(plants.has(plant), `link_updates ${plant}`)
    }
  }
})

test('路线、产能、订单引用的工厂/工序可核对', () => {
  for (const route of records.get('routes')) {
    const listed = split(route.plants)
    assert.equal(listed.length, Number(route.size), `route ${route.route} size`)
    for (const plant of listed) assert.ok(plants.has(plant), `route ${route.route} ${plant}`)
  }
  for (const row of records.get('capacity')) {
    assert.ok(plants.has(row.facility), `capacity.facility ${row.facility}`)
  }
})

test('买家需求的工序与订单工序一致可核对', () => {
  const frameProcesses = new Set(records.get('frame').flatMap(row => split(row.process)))
  const capacityProcesses = new Set(records.get('capacity').map(row => row.process))
  const commitmentProcesses = new Set(records.get('commitments').flatMap(row => split(row.processes)))
  for (const process of commitmentProcesses) {
    assert.ok(frameProcesses.has(process), `订单工序 ${process} 不在底册`)
  }
  for (const outlet of records.get('outlets')) {
    for (const process of split(outlet.need)) {
      assert.ok(frameProcesses.has(process) || capacityProcesses.has(process), `买家工序 ${process}`)
    }
  }
})

test('概率字段只在对抽签样本时给出', () => {
  for (const row of records.get('samples')) {
    if (row.method === '抽签') {
      const p = Number(row.p)
      assert.ok(Number.isFinite(p) && p > 0 && p <= 1, `抽签 ${row.plant} p=${row.p}`)
    } else {
      assert.equal(row.p, '?', `非抽签 ${row.plant} 不应有 p`)
    }
  }
})
