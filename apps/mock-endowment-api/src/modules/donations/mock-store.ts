import { randomUUID } from 'node:crypto';

import type { ConfirmedWebhook, CreateMockDonationInput } from '@telu/contracts';

export interface MockDeliveryResult {
  statusCode: number;
  responseBody: unknown;
}

export interface MockDonationRecord {
  donationId: string;
  eventId: string;
  payload: ConfirmedWebhook;
  refunded: boolean;
  createdAt: string;
  lastDelivery: MockDeliveryResult | null;
}

export interface MockStore {
  create(input: CreateMockDonationInput): MockDonationRecord;
  list(): MockDonationRecord[];
  get(donationId: string): MockDonationRecord;
  markDelivery(donationId: string, delivery: MockDeliveryResult): void;
  createRefundEvent(record: MockDonationRecord): {
    eventId: string;
    payload: {
      eventId: string;
      eventType: 'donation.refunded';
      occurredAt: string;
      data: { donationId: string; status: 'REFUNDED' };
    };
  };
}

export class InMemoryMockStore implements MockStore {
  private readonly records = new Map<string, MockDonationRecord>();

  public create(input: CreateMockDonationInput): MockDonationRecord {
    const now = new Date().toISOString();
    const record: MockDonationRecord = {
      donationId: `don_${randomUUID()}`,
      eventId: `evt_${randomUUID()}`,
      payload: {
        eventId: '',
        eventType: 'donation.confirmed',
        occurredAt: now,
        data: {
          donationId: '',
          donor: {
            externalId: input.donorExternalId,
            name: input.donorName,
            email: input.donorEmail,
            showName: input.showName,
          },
          amount: input.amount,
          currency: input.currency,
          status: 'CONFIRMED',
          donatedAt: now,
        },
      },
      refunded: false,
      createdAt: now,
      lastDelivery: null,
    };
    record.payload.eventId = record.eventId;
    record.payload.data.donationId = record.donationId;
    this.records.set(record.donationId, record);
    return record;
  }

  public list(): MockDonationRecord[] {
    return [...this.records.values()];
  }

  public get(donationId: string): MockDonationRecord {
    const record = this.records.get(donationId);
    if (!record) throw new Error('MOCK_DONATION_NOT_FOUND');
    return record;
  }

  public markDelivery(donationId: string, delivery: MockDeliveryResult): void {
    this.get(donationId).lastDelivery = delivery;
  }

  public createRefundEvent(record: MockDonationRecord) {
    record.refunded = true;
    const now = new Date().toISOString();
    const eventId = `evt_${randomUUID()}`;
    return {
      eventId,
      payload: {
        eventId,
        eventType: 'donation.refunded' as const,
        occurredAt: now,
        data: { donationId: record.donationId, status: 'REFUNDED' as const },
      },
    };
  }
}
