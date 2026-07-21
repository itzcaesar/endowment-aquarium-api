import { describe, expect, it } from 'vitest';

import { InMemoryMockStore } from '../../modules/donations/mock-store.js';

describe('mock donation store', () => {
  it('creates a confirmed event and reuses its original event ID for replay', () => {
    const store = new InMemoryMockStore();
    const record = store.create({
      donorExternalId: 'd-1',
      donorName: 'Donor',
      donorEmail: 'd@example.com',
      showName: true,
      amount: 50_000,
      currency: 'IDR',
    });
    expect(record.payload.eventType).toBe('donation.confirmed');
    expect(record.payload.eventId).toBe(record.eventId);
    expect(record.payload.data.donationId).toBe(record.donationId);
    const refund = store.createRefundEvent(record);
    expect(refund.eventId).not.toBe(record.eventId);
    expect(refund.payload.data.donationId).toBe(record.donationId);
  });
});
