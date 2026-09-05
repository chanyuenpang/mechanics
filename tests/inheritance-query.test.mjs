import test from 'node:test';
import assert from 'node:assert/strict';
import { queryWorkspace, formatQueryText } from '../src/domain/query.mjs';
import { validateWorkspace } from '../src/domain/validate.mjs';
const node = id => ({ id, label: id, description: '测试', agentLocked: false });
const qualified = (id, baseConceptId, qualifiers) => ({ ...node(id), baseConceptId, qualifiers });
const specialize = (source, target) => ({ id: source + '-2-' + target, source, target, relation: 'specializes', ruleText: '' });
const influence = (source, target, inheritance) => ({ id: source + '-2-' + target, source, target, relation: 'influence', sign: 1, inheritance, ruleText: '' });
function workspace(nodes, edges) { const data={manifest:{schemaVersion:8,kind:'workspace',id:'sample',name:'测试',definitions:'definitions.graph.json',agentExportPath:'game-mechanics',compositions:[]},definitions:{schemaVersion:4,kind:'definitions',workspaceId:'sample',nodes,positions:{}},mechanics:[{schemaVersion:4,kind:'mechanic',workspaceId:'sample',id:'rules',name:'规则',scope:'测试',nodeIds:nodes.map(n=>n.id),edges,positions:{}}],views:[],files:[{kind:'mechanic',id:'rules',path:'rules.mechanic.json'}],revision:'test',resourceRevisions:{definitions:'d',mechanics:{rules:'r'}}};validateWorkspace(data);return data;}

test('默认只返回 declaration；显式继承返回带完整 provenance 的单跳 derived', () => {
 const data=workspace([node('damage'),node('effect'),qualified('damage-to-boss','damage',[{key:'target',value:{kind:'literal',value:'boss'}}])],[influence('damage','effect',{mode:'specializeEndpoint',endpoints:['source'],maxSpecializationHops:1}),specialize('damage-to-boss','damage')]);
 const canonical=structuredClone({nodes:data.definitions.nodes,edges:data.mechanics[0].edges});
 const plain=queryWorkspace(data,{command:'graph',mechanic:'rules'});assert.equal(plain.declarations.length,1);assert.deepEqual(plain.derived,[]);assert.equal('derived' in plain.declarations[0],false);assert.equal('specializationPath' in plain.declarations[0],false);assert.equal('substitutedEndpoint' in plain.declarations[0],false);assert.equal('inheritancePolicy' in plain.declarations[0],false);
 const noInheritedImpact=queryWorkspace(data,{command:'impact',mechanic:'rules',from:'damage-to-boss',to:'effect'});assert.equal(noInheritedImpact.evidence.paths.length,0);
 const expanded=queryWorkspace(data,{command:'graph',mechanic:'rules',includeInherited:true});assert.equal(expanded.derived.length,1);const edge=expanded.derived[0];assert.equal(edge.source,'damage-to-boss');assert.equal(edge.substitutedEndpoint,'source');assert.deepEqual(edge.inheritancePolicy,{mode:'specializeEndpoint',endpoints:['source'],maxSpecializationHops:1});assert.equal(edge.applicability,'not_evaluated');assert.deepEqual(JSON.parse(JSON.stringify(edge.origin)),{mechanicId:'rules',edgeId:'damage-2-effect',file:'rules.mechanic.json'});assert.equal(edge.specializationPath.length,1);
 const impact=queryWorkspace(data,{command:'impact',mechanic:'rules',from:'damage-to-boss',to:'effect',includeInherited:true});assert.equal(impact.evidence.paths.length,1);const step=impact.evidence.paths[0].steps[0];assert.equal(step.derived,true);assert.deepEqual(step.origin,{mechanicId:'rules',edgeId:'damage-2-effect',file:'rules.mechanic.json'});assert.deepEqual(step.specializationPath,[{mechanicId:'rules',edgeId:'damage-to-boss-2-damage',source:'damage-to-boss',target:'damage'}]);assert.equal(step.substitutedEndpoint,'source');assert.deepEqual(step.inheritancePolicy,{mode:'specializeEndpoint',endpoints:['source'],maxSpecializationHops:1});
 const text=formatQueryText(impact);assert.ok(text.includes('继承派生：来源 rules/damage-2-effect'));assert.ok(text.includes('替换端点 source'));assert.equal(text.includes('undefined'), false);
 assert.deepEqual({nodes:data.definitions.nodes,edges:data.mechanics[0].edges},canonical);
});
test('未列端点、hop 上限和 derived 不级联均不产生额外规则', () => {
 const data=workspace([node('damage'),node('effect'),node('a'),node('b')],[influence('damage','effect',{mode:'specializeEndpoint',endpoints:['target'],maxSpecializationHops:1}),specialize('a','damage'),specialize('b','a')]);
 assert.deepEqual(queryWorkspace(data,{command:'graph',mechanic:'rules',includeInherited:true}).derived,[]);
 data.mechanics[0].edges[0].inheritance={mode:'specializeEndpoint',endpoints:['source'],maxSpecializationHops:1};
 const result=queryWorkspace(data,{command:'graph',mechanic:'rules',includeInherited:true});assert.equal(result.derived.length,1);assert.equal(result.derived[0].source,'a');
});
test('双同优特化路径与 qualifier 绑定冲突明确失败', () => {
 const ambiguous=workspace([node('damage'),node('effect'),node('a'),node('b'),node('c')],[influence('damage','effect',{mode:'specializeEndpoint',endpoints:['source'],maxSpecializationHops:2}),specialize('a','damage'),specialize('b','damage'),specialize('c','a'),specialize('c','b')]);
 assert.throws(()=>queryWorkspace(ambiguous,{command:'graph',mechanic:'rules',includeInherited:true}),{code:'INHERITANCE_AMBIGUOUS'});
 const conflict=workspace([node('damage'),node('effect'),qualified('damage-boss','damage',[{key:'target',value:{kind:'literal',value:'boss'}}]),qualified('effect-other','effect',[{key:'target',value:{kind:'literal',value:'other'}}])],[influence('damage','effect-other',{mode:'specializeEndpoint',endpoints:['source'],maxSpecializationHops:1}),specialize('damage-boss','damage')]);
 assert.throws(()=>queryWorkspace(conflict,{command:'graph',mechanic:'rules',includeInherited:true}),{code:'INHERITANCE_BINDING_CONFLICT'});
});
