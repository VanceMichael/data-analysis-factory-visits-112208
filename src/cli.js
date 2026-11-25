#!/usr/bin/env node
// 顾问用命令行：查看某工序缺哪类证据、下一轮名单、联合供货区间与披露视图。
import { readFile } from 'node:fs/promises'
import { parseAll } from './parse.js'
import { projectView, explainCandidate } from './project.js'

async function loadData(dir) {
  const tables = ['frame', 'samples', 'link_updates', 'routes', 'outlets', 'capacity', 'commitments']
  const data = {}
  for (const table of tables) {
    data[table] = JSON.parse(await readFile(new URL(`${table}.json`, dir), 'utf8'))
  }
  return parseAll(data)
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

const argv = process.argv.slice(2)
const dataDir = argValue(argv, '--data') ?? new URL('../data/', import.meta.url)
const season = argValue(argv, '--season') ?? null
const readerLevel = argValue(argv, '--reader') ?? '公开'
const processArg = argValue(argv, '--process')
const processes = argValue(argv, '--processes')

const data = await loadData(dataDir)
const project = projectView(data, { season, readerLevel })

if (processArg || processes) {
  const panel = explainCandidate(project, {
    process: processArg ?? processes.split('+')[0],
    processes: processes ? processes.split('+') : undefined,
    readerLevel,
  })
  console.log(JSON.stringify(panel, null, 2))
} else {
  console.log(
    JSON.stringify(
      {
        season,
        entities: project.linkInfo.entities.map(e => ({
          id: e.id,
          plants: e.plants,
          processes: e.processes,
          restricted: e.restricted,
          merged: e.merged,
        })),
        estimates: Object.fromEntries(
          Object.entries(project.estimates).map(([p, est]) => [
            p,
            {
              observedUnits: est.observedUnits,
              coverage: est.coverage,
              visitedQualifiedShare: est.visitedQualifiedShare,
              canClaimWholePark: est.canClaimWholePark,
              tier: est.claimScope,
            },
          ]),
        ),
        joint: Object.fromEntries(
          Object.entries(project.jointResults).map(([key, r]) => [
            key,
            {
              state: r.state,
              lower: r.lowerBound,
              upper: r.cautiousUpperBound,
              observedJointCount: r.observedJointCount,
              explanation: r.explanation,
            },
          ]),
        ),
        nextRound: project.nextRound,
        view: project.view,
      },
      null,
      2,
    ),
  )
}
