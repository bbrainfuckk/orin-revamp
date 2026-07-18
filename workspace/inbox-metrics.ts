export type InboxMetricMessage = {
  senderType: 'customer' | 'agent' | 'team';
  sentAt?: { toMillis: () => number };
};

export type InboxResponseMetrics = {
  firstResponseMs: number | null;
  averageBusinessResponseMs: number | null;
  averageCustomerResponseMs: number | null;
  customerMessages: number;
  businessMessages: number;
};

export function calculateInboxResponseMetrics(messages: InboxMetricMessage[]): InboxResponseMetrics {
  const businessDurations: number[] = [];
  const customerDurations: number[] = [];
  let awaitingBusinessSince: number | null = null;
  let awaitingCustomerSince: number | null = null;
  let firstCustomerAt: number | null = null;
  let firstResponseMs: number | null = null;
  let customerMessages = 0;
  let businessMessages = 0;

  for (const message of messages) {
    const at = message.sentAt?.toMillis();
    if (!Number.isFinite(at)) continue;
    if (message.senderType === 'customer') {
      customerMessages += 1;
      if (firstCustomerAt === null) firstCustomerAt = at!;
      awaitingBusinessSince = at!;
      if (awaitingCustomerSince !== null) {
        customerDurations.push(Math.max(0, at! - awaitingCustomerSince));
        awaitingCustomerSince = null;
      }
    } else {
      businessMessages += 1;
      if (awaitingBusinessSince !== null) {
        const duration = Math.max(0, at! - awaitingBusinessSince);
        businessDurations.push(duration);
        if (firstResponseMs === null && firstCustomerAt !== null) firstResponseMs = Math.max(0, at! - firstCustomerAt);
        awaitingBusinessSince = null;
      }
      awaitingCustomerSince = at!;
    }
  }

  const average = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  return {
    firstResponseMs,
    averageBusinessResponseMs: average(businessDurations),
    averageCustomerResponseMs: average(customerDurations),
    customerMessages,
    businessMessages,
  };
}

