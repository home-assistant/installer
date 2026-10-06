import { executeServerCommand } from "@web/test-runner-commands";

export interface AXNode {
  role: string;
  name?: string;
  children?: AXNode[];
}

/** Full accessibility tree of the page, as Chrome computes it. */
export function fullA11ySnapshot(): Promise<AXNode> {
  return executeServerCommand<AXNode, undefined>("full-a11y-snapshot");
}

/** All nodes with the given role, depth first. */
export function findByRole(node: AXNode, role: string): AXNode[] {
  const found = node.role === role ? [node] : [];
  for (const child of node.children ?? []) {
    found.push(...findByRole(child, role));
  }
  return found;
}
