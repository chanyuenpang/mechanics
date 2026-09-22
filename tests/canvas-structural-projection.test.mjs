import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphCanvas, badgeDisplayModel, badgeInteractionTargetId } from '../src/web/canvas.mjs';
import { structuralProjection } from '../src/domain/taxonomy-presentation.mjs';

const canonicalGraph = {
  nodes: [
    { id: 'damage', label: '伤害', description: '基础概念' },
    { id: 'target', label: '目标', description: '基础概念' },
    { id: 'damage-to-target', label: '对目标伤害', description: '限定概念', baseConceptId: 'damage', qualifiers: [
      { key: '目标', value: { kind: 'concept', conceptId: 'target' } },
      { key: '暴击', value: { kind: 'literal', value: true } },
    ] },
  ],
  edges: [
    { id: 'damage-to-target-2-damage', source: 'damage-to-target', target: 'damage', relation: 'specializes' },
    { id: 'damage-2-target', source: 'damage', target: 'target', relation: 'influence', sign: 1 },
  ],
};

const node = (projection, id) => projection.nodes.find(item => item.id === id);

test('结构投影在 line 模式保留全部边，并为限定概念生成基础和 qualifier 徽标', () => {
  const before = structuredClone(canonicalGraph);
  const projection = structuralProjection(canonicalGraph, 'line');

  assert.deepEqual(projection.edges.map(edge => edge.id), ['damage-to-target-2-damage', 'damage-2-target']);
  assert.deepEqual(node(projection, 'damage-to-target').badges, [
    { text: '基础：伤害', kind: 'base', sourceId: 'damage-to-target', targetId: 'damage' },
    { text: '目标：目标', kind: 'qualifier', sourceId: 'damage-to-target', targetId: 'target' },
    { text: '暴击：true', kind: 'qualifier', sourceId: 'damage-to-target' },
  ]);
  assert.deepEqual(canonicalGraph, before);
});

test('结构投影在 badge 模式过滤 specializes，并将出边投影为 is-a 徽标', () => {
  const before = structuredClone(canonicalGraph);
  const projection = structuralProjection(canonicalGraph, 'badge');

  assert.deepEqual(projection.edges.map(edge => edge.id), ['damage-2-target']);
  assert.deepEqual(node(projection, 'damage-to-target').badges.at(-1), {
    text: 'is-a：伤害', kind: 'is-a', sourceId: 'damage-to-target', targetId: 'damage',
  });
  assert.deepEqual(node(projection, 'damage').badges, []);
  assert.deepEqual(canonicalGraph, before);
});

test('端点限定投影只展示参与者限定，不冒充限定概念的基础或 is-a', () => {
  const scoped = { nodes: [{ id: 'scope:health:enemy', label: '气血', description: '气血', scopeProjection: true,
    canonicalNodeId: 'health', baseConceptId: 'health', qualifiers: [{ key: '阵营', value: { kind: 'literal', value: '敌方' } }] }], edges: [] };
  assert.deepEqual(node(structuralProjection(scoped), 'scope:health:enemy').badges, [
    { text: '阵营：敌方', kind: 'qualifier', sourceId: 'scope:health:enemy' },
  ]);
});

test('徽标只为投影中可见的目标提供交互目标', () => {
  const badge = { text: '目标：目标', targetId: 'target' };
  assert.equal(badgeInteractionTargetId(badge, new Set(['damage-to-target', 'target'])), 'target');
  assert.equal(badgeInteractionTargetId(badge, new Set(['damage-to-target'])), null);
  assert.equal(badgeInteractionTargetId({ text: '暴击：true' }, new Set(['damage-to-target'])), null);
});

test('badge 模式优先保留 is-a，并汇总其他来源到完整无障碍文本', () => {
  const badges = node(structuralProjection(canonicalGraph, 'badge'), 'damage-to-target').badges;
  const model = badgeDisplayModel(badges, 'badge');
  assert.equal(model.badges.length, 2);
  assert.equal(model.badges[0].kind, 'is-a');
  assert.equal(model.badges[0].text, 'is-a：伤害');
  assert.equal(model.badges[0].displayText, 'is-a');
  assert.equal(model.badges[0].accessibleText, 'is-a：伤害（概念 ID：damage）');
  assert.deepEqual(model.badges[1], { text: '其余：基础：伤害；目标：目标；暴击：true', kind: 'summary', sourceId: 'damage-to-target', accessibleText: '其余：基础：伤害；目标：目标；暴击：true', displayText: '其余：基础：伤害；目标：目标；暴击：true' });
  assert.match(model.fullText, /基础：伤害（概念 ID：damage）/);
  assert.match(model.fullText, /目标：目标（概念 ID：target）/);
  assert.match(model.fullText, /暴击：true/);
  assert.match(model.fullText, /is-a：伤害（概念 ID：damage）/);
});

test('长 is-a 目标仍显示完整标识，并将完整目标放在自身无障碍文本', () => {
  const longLabel = '这是一个超过固定节点徽标可容纳范围的上位概念名称';
  const model = badgeDisplayModel([{ text: 'is-a：' + longLabel, kind: 'is-a', sourceId: 'child', targetId: 'very-long-parent-id' }, { text: '基础：其他来源', kind: 'base', sourceId: 'child', targetId: 'other' }], 'badge');
  assert.equal(model.badges[0].displayText, 'is-a');
  assert.match(model.badges[0].displayText, /^is-a$/);
  assert.equal(model.badges[0].accessibleText, `is-a：${longLabel}（概念 ID：very-long-parent-id）`);
  assert.match(model.badges[1].accessibleText, /^其余：/);
  assert.doesNotMatch(model.badges[1].accessibleText, /very-long-parent-id/);
});

test('画布与路由请求共享同一显示投影：隐藏的 is-a 父概念不进入命中、几何或 Worker', async () => {
  const canvas = Object.create(GraphCanvas.prototype), requests = [];
  const source = {
    nodes: [{ id: 'child', label: '子概念' }, { id: 'parent', label: '父概念' }, { id: 'effect', label: '效果' }],
    edges: [
      { id: 'child-is-parent', source: 'child', target: 'parent', relation: 'specializes' },
      { id: 'child-affects-effect', source: 'child', target: 'effect', relation: 'influence', sign: 1 },
    ],
  };
  Object.assign(canvas, {
    positions: { child: { x: 0, y: 0 }, parent: { x: 300, y: 0 }, effect: { x: 600, y: 0 } }, mode: 'select',
    draw() {}, transform() {},
    callbacks: { computeGraph: request => { requests.push(request); return Promise.resolve({ routes: [], edgeIds: [], full: false }); } },
  });
  await canvas.update(source, canvas.positions, null, null, false,
    { taxonomyPresentation: { mode: 'label', expandedNodeIds: [] }, retainedNodeIds: ['child'] });
  assert.deepEqual(canvas.graph.nodes.map(node => node.id), ['child', 'effect']);
  assert.deepEqual(canvas.graph.edges.map(edge => edge.id), ['child-affects-effect']);
  assert.deepEqual(requests.map(request => request.payload.graph.nodes.map(node => node.id)), [['child', 'effect']]);
  assert.equal(requests[0].geometryKey.includes('parent'), false, '几何签名不能带着隐藏父概念');
});
