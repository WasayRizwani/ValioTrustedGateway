export function draftExceptionFollowup(input: {
  customerId: string;
  intentId?: string;
  problem: string;
  details?: string;
}) {
  const subject = `[Agent Gateway] Exception: ${input.problem}`;
  const body = [
    `To: Valio Aimo Operations (mock)`,
    `From: Purchasing agent for ${input.customerId}`,
    `Intent: ${input.intentId ?? "n/a"}`,
    ``,
    `Problem type: ${input.problem}`,
    input.details ?? "No additional details provided.",
    ``,
    `Please advise on fulfilment options. This message was NOT sent via SMTP — demo mock only.`,
  ].join("\n");

  return {
    followUpId: `FU-${Date.now()}`,
    customerId: input.customerId,
    intentId: input.intentId ?? null,
    problem: input.problem,
    recipient: "Valio Aimo Operations (mock)",
    subject,
    body,
    status: "draft",
    follow_up_sent: false,
  };
}
