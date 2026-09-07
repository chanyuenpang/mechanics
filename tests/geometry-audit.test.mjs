import test from 'node:test';
import assert from 'node:assert/strict';
import { measureGeometry } from '../src/web/hierarchical-layout.mjs';

function auditFixture(seed) {
  let state = seed;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const jitter = [0, 0.0000005, 11.9999995, 12, 12.0000005];
  const nodes = [], edges = [], positions = {}, sizes = {}, routes = [];
  for (let i = 0; i < 24; i++) {
    const points = [{ x: (next() % 11 - 5) * 20, y: (next() % 11 - 5) * 20 + jitter[next() % jitter.length] }];
    for (let j = 0; j < 4; j++) {
      const axis = (i + j) % 2 ? 'x' : 'y', previous = points.at(-1);
      points.push({ ...previous, [axis]: previous[axis] + (next() % 5 + 1) * 20 * (next() % 2 ? -1 : 1) });
    }
    const id = 'e' + i, source = 's' + i, target = 't' + i;
    for (const [id, point] of [[source, points[0]], [target, points.at(-1)]]) {
      nodes.push({ id }); positions[id] = point; sizes[id] = { width: 0.5, height: 0.5 };
    }
    edges.push({ id, source, target, bundleMembers: Array.from({ length: i % 3 + 1 }, () => ({})) }); routes.push([id, { points }]);
  }
  return { graph: { nodes, edges }, geometry: { positions, sizes, routes } };
}


// 固定期望来自优化前的全量段对审计，包含 EPS、12px 两侧、自交及通道权重。
const expected = [
  {
    "seed": 42,
    "metric": {
      "missing": 0,
      "invalid": 0,
      "nodeOverlaps": 3,
      "nodeHits": 0,
      "selfCrossings": 4,
      "crossings": 164,
      "contacts": 327,
      "sharedEndpointCrossings": 0,
      "overlaps": 1372,
      "nearParallel": 2320,
      "bends": 72,
      "length": 6080,
      "area": 165000,
      "width": 400,
      "height": 412.5
    }
  },
  {
    "seed": 12345,
    "metric": {
      "missing": 0,
      "invalid": 0,
      "nodeOverlaps": 4,
      "nodeHits": 0,
      "selfCrossings": 3,
      "crossings": 355,
      "contacts": 472,
      "sharedEndpointCrossings": 0,
      "overlaps": 1764,
      "nearParallel": 2960,
      "bends": 72,
      "length": 5880,
      "area": 142970,
      "width": 420.5,
      "height": 340
    }
  },
  {
    "seed": 987654,
    "metric": {
      "missing": 0,
      "invalid": 0,
      "nodeOverlaps": 4,
      "nodeHits": 0,
      "selfCrossings": 2,
      "crossings": 170,
      "contacts": 303,
      "sharedEndpointCrossings": 0,
      "overlaps": 1276,
      "nearParallel": 800,
      "bends": 72,
      "length": 5780,
      "area": 148800,
      "width": 400,
      "height": 372
    }
  }
];

test('空间快筛保持完整审计的边界交叉、重叠、近邻与自交计数', () => {
  for (const { seed, metric } of expected) {
    const { graph, geometry } = auditFixture(seed);
    assert.deepEqual(measureGeometry(graph, geometry), metric, '种子 ' + seed);
  }
});
