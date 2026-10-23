import { executeServerCommand } from "@web/test-runner-commands";

export interface AXNode {
  role: string;
  name?: string;
  description?: string;
  /** "true" when it is invalid, left out when it isn't */
  invalid?: string;
  required?: boolean;
  /** A heading's level */
  level?: number;
  children?: AXNode[];
}

/** Full accessibility tree of the page, as Chrome computes it. */
export function fullA11ySnapshot(): Promise<AXNode> {
  return executeServerCommand<AXNode, undefined>("full-a11y-snapshot");
}

/** Each heading's level and name, in reading order. */
export function headingOutline(node: AXNode): [number, string][] {
  return findByRole(node, "heading").map((heading) => [
    heading.level!,
    heading.name!.trim(),
  ]);
}

/** All nodes with the given role, depth first. */
export function findByRole(node: AXNode, role: string): AXNode[] {
  const found = node.role === role ? [node] : [];
  for (const child of node.children ?? []) {
    found.push(...findByRole(child, role));
  }
  return found;
}
