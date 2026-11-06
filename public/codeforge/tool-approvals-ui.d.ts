export type ToolApprovalCardPayload = {
  id?: unknown;
  approvalUrl?: unknown;
  label?: unknown;
  description?: unknown;
  destructive?: unknown;
  preview?: unknown;
};

/** Render a non-executable approval summary and a same-origin review link. */
export declare function renderToolApprovalCard(
  container: Element,
  approval: ToolApprovalCardPayload,
): boolean;
