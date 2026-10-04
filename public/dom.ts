/** Required template elements fail at initialization rather than during an action. */
export function requiredElement<T extends HTMLElement>(
  selector: string,
  constructor: { new (): T },
  root: ParentNode = document,
): T {
  const element = root.querySelector(selector);
  if (!(element instanceof constructor)) {
    throw new Error(`Missing or invalid template element: ${selector}`);
  }
  return element;
}
