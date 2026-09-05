import { compose } from './graph.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

export const registeredMechanicIds = view => view.mechanicRegistrations.map(item => item.mechanicId);

export const visibleMechanicIds = view => view.mechanicRegistrations
  .filter(item => item.visible)
  .map(item => item.mechanicId);

// 结构展示仅是视图投影，绝不写回 definitions 或 mechanisms。
export const composeView = (workspace, view) => ({
  ...compose(workspace, visibleMechanicIds(view)),
  structuralPresentation: view.structuralPresentation,
});

export function registerMechanic(view, mechanicId) {
  if (registeredMechanicIds(view).includes(mechanicId)) {
    fail('VIEW_MECHANIC_ALREADY_REGISTERED', `机制已注册到当前视图：${mechanicId}`);
  }
  return {
    ...structuredClone(view),
    mechanicRegistrations: [...view.mechanicRegistrations.map(item => structuredClone(item)), { mechanicId, visible: true }],
  };
}

export function setMechanicVisibility(view, mechanicId, visible) {
  if (!registeredMechanicIds(view).includes(mechanicId)) {
    fail('VIEW_MECHANIC_NOT_REGISTERED', `机制尚未注册到当前视图：${mechanicId}`);
  }
  return {
    ...structuredClone(view),
    mechanicRegistrations: view.mechanicRegistrations.map(item => item.mechanicId === mechanicId
      ? { mechanicId, visible }
      : structuredClone(item)),
  };
}

export function removeMechanic(view, mechanicId) {
  if (!registeredMechanicIds(view).includes(mechanicId)) {
    fail('VIEW_MECHANIC_NOT_REGISTERED', `机制尚未注册到当前视图：${mechanicId}`);
  }
  return {
    ...structuredClone(view),
    mechanicRegistrations: view.mechanicRegistrations
      .filter(item => item.mechanicId !== mechanicId)
      .map(item => structuredClone(item)),
  };
}

export function moveMechanic(view, mechanicId, targetIndex) {
  const registrations = view.mechanicRegistrations.map(item => structuredClone(item));
  const sourceIndex = registrations.findIndex(item => item.mechanicId === mechanicId);
  if (sourceIndex < 0) fail('VIEW_MECHANIC_NOT_REGISTERED', `机制尚未注册到当前视图：${mechanicId}`);
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= registrations.length) {
    fail('VIEW_MECHANIC_ORDER_INVALID', `机制顺序位置无效：${targetIndex}`);
  }
  const [registration] = registrations.splice(sourceIndex, 1); registrations.splice(targetIndex, 0, registration);
  return { ...structuredClone(view), mechanicRegistrations: registrations };
}
