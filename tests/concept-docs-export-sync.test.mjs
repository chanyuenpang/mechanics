import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDocumentExportResult } from '../src/web/concept-docs.mjs';

test('导出成功以服务端 workspace 快照更新本地 revision 与选择', () => {
  const data = { revision: 'before', selections: [{ kind: 'mechanic', mechanicId: 'old' }] };
  const result = { revision: 'after', manifest: { exportSelections: [{ kind: 'view', viewId: 'current' }] } };
  let received = null;

  const revision = mergeDocumentExportResult(data, result, workspace => { received = workspace; });

  assert.equal(revision, 'after');
  assert.equal(data.revision, 'after');
  assert.deepEqual(data.selections, [{ kind: 'view', viewId: 'current' }]);
  assert.equal(received, result);
});

test('生成成功只推进 revision，不伪造未返回的导出选择', () => {
  const data = { revision: 'before', selections: [{ kind: 'mechanic', mechanicId: 'kept' }] };
  const result = { revision: 'after', manifest: {} };

  mergeDocumentExportResult(data, result);

  assert.equal(data.revision, 'after');
  assert.deepEqual(data.selections, [{ kind: 'mechanic', mechanicId: 'kept' }]);
});
