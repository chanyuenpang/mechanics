import { compose } from './graph.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

export const registeredMechanicIds = view => view.mechanicRegistrations.map(item => item.mechanicId);

export const visibleMechanicIds = view => view.mechanicRegistrations
  .filter(item => item.visible)
  .map(item => item.mechanicId);

export const composeView = (workspace, view) => compose(workspace, visibleMechanicIds(view));

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
