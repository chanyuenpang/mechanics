const namespace = 'http://www.w3.org/2000/svg';

export function icon(name, className = 'ui-icon') {
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('viewBox', '0 0 24 24');
  const use = document.createElementNS(namespace, 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}
