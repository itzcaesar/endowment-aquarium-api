import { randomBytes } from 'node:crypto';

import { accessoryCodes, colorCodes } from '@telu/contracts';
import type { Sql, TransactionSql } from 'postgres';

import { calculateHunger, moodForHunger } from '../fish/hunger-service.js';
import { AppError } from '../../shared/errors.js';
import type {
  AuditQuery,
  DonorListQuery,
  DonorUpdateInput,
  FishCreateInput,
  FishListQuery,
  FishUpdateInput,
  InventoryUpdateInput,
} from './admin-schemas.js';

type Db = Sql | TransactionSql;

export interface AdminActor {
  ip: string | null;
}

/** postgres-js may return timestamps as strings when prepared statements are disabled. */
function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return new Date(value).toISOString();
}

/** Shows only the region prefix and last four digits of a NIK. */
export function maskNik(nik: string | null): string | null {
  if (!nik) return null;
  return `${nik.slice(0, 4)}${'•'.repeat(Math.max(nik.length - 8, 0))}${nik.slice(-4)}`;
}

interface FishRow {
  id: string;
  aquarium_id: string;
  public_slug: string;
  donor_id: string;
  donor_name: string | null;
  donor_nik: string | null;
  tier_code: string;
  species_code: string;
  species_name: string;
  unity_asset_code: string;
  display_name: string | null;
  color_code: string;
  accessory_code: string;
  hunger: number;
  last_fed_at: Date | string | null;
  is_active: boolean;
  donation_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toAdminFish(row: FishRow, now: Date) {
  const createdAt = new Date(row.created_at);
  const lastFedAt = row.last_fed_at === null ? null : new Date(row.last_fed_at);
  const hunger = calculateHunger(row.hunger, lastFedAt ?? createdAt, now);
  return {
    id: row.id,
    aquariumId: row.aquarium_id,
    publicSlug: row.public_slug,
    donor: { id: row.donor_id, name: row.donor_name, nikMasked: maskNik(row.donor_nik) },
    tierCode: row.tier_code,
    species: { code: row.species_code, name: row.species_name },
    assetCode: row.unity_asset_code,
    displayName: row.display_name,
    colorCode: row.color_code,
    accessoryCode: row.accessory_code,
    hunger,
    mood: moodForHunger(hunger),
    lastFedAt: iso(row.last_fed_at),
    isActive: row.is_active,
    source: row.donation_id ? 'Donation webhook' : 'NIK sync or admin',
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export type AdminFish = ReturnType<typeof toAdminFish>;

function pageOf<T>(items: T[], total: number, page: number, pageSize: number) {
  return { items, page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export class AdminService {
  public constructor(private readonly sql: Sql) {}

  // ---------------------------------------------------------------- catalog
  public async catalog() {
    const [tiers, species] = await Promise.all([
      this.sql<{ code: string; name: string; min_amount: string; max_amount: string | null }[]>`
        select code, name, min_amount::text, max_amount::text
        from fish_tiers order by rarity_order`,
      this.sql<
        {
          code: string;
          name: string;
          default_tier_code: string;
          unity_asset_code: string;
          active: boolean;
        }[]
      >`
        select code, name, default_tier_code, unity_asset_code, active
        from fish_species order by code`,
    ]);
    return {
      tiers: tiers.map((tier) => ({
        code: tier.code,
        name: tier.name,
        minAmount: Number(tier.min_amount),
        maxAmount: tier.max_amount === null ? null : Number(tier.max_amount),
      })),
      species: species.map((item) => ({
        code: item.code,
        name: item.name,
        defaultTierCode: item.default_tier_code,
        assetCode: item.unity_asset_code,
        active: item.active,
      })),
      colorCodes: [...colorCodes],
      accessoryCodes: [...accessoryCodes],
    };
  }

  // ------------------------------------------------------------------- fish
  private fishSelect(db: Db) {
    return db`
      select f.id, f.aquarium_id, a.public_slug, d.id as donor_id, d.display_name as donor_name,
             d.nik as donor_nik, f.tier_code, f.species_code, s.name as species_name,
             s.unity_asset_code, f.display_name, f.color_code, f.accessory_code, f.hunger,
             f.last_fed_at, f.is_active, f.donation_id, f.created_at, f.updated_at
      from fish f
      join aquariums a on a.id = f.aquarium_id
      join donors d on d.id = a.donor_id
      join fish_species s on s.code = f.species_code`;
  }

  public async listFish(query: FishListQuery, now: Date) {
    const sql = this.sql;
    const search = query.search ? `%${query.search.replace(/[%_\\]/g, '\\$&')}%` : null;
    const where = sql`
      where true
      ${query.status === 'active' ? sql`and f.is_active` : query.status === 'inactive' ? sql`and not f.is_active` : sql``}
      ${query.tier ? sql`and f.tier_code = ${query.tier}` : sql``}
      ${query.species ? sql`and f.species_code = ${query.species}` : sql``}
      ${query.donorId ? sql`and d.id = ${query.donorId}::uuid` : sql``}
      ${
        search
          ? sql`and (d.display_name ilike ${search} or f.display_name ilike ${search}
                 or a.public_slug ilike ${search} or d.nik = ${query.search ?? ''}
                 or f.id::text = ${query.search ?? ''})`
          : sql``
      }`;
    const offset = (query.page - 1) * query.pageSize;
    const [rows, counts] = await Promise.all([
      sql<FishRow[]>`${this.fishSelect(sql)} ${where}
        order by f.created_at desc limit ${query.pageSize} offset ${offset}`,
      sql<{ total: number }[]>`
        select count(*)::int as total from fish f
        join aquariums a on a.id = f.aquarium_id
        join donors d on d.id = a.donor_id ${where}`,
    ]);
    return pageOf(
      rows.map((row) => toAdminFish(row, now)),
      counts[0]?.total ?? 0,
      query.page,
      query.pageSize,
    );
  }

  public async getFish(id: string, now: Date, db: Db = this.sql): Promise<AdminFish> {
    const rows = await db<FishRow[]>`${this.fishSelect(db)} where f.id = ${id}::uuid`;
    const row = rows[0];
    if (!row) throw new AppError(404, 'FISH_NOT_FOUND', 'Fish tidak ditemukan');
    return toAdminFish(row, now);
  }

  private async speciesFor(db: Db, speciesCode: string) {
    const rows = await db<{ code: string; default_tier_code: string; active: boolean }[]>`
      select code, default_tier_code, active from fish_species where code = ${speciesCode}`;
    const species = rows[0];
    if (!species) throw new AppError(400, 'UNKNOWN_SPECIES', 'Species tidak dikenal');
    return species;
  }

  public async createFish(input: FishCreateInput, actor: AdminActor, now: Date) {
    return this.sql.begin(async (tx) => {
      const donors = await tx<
        { id: string }[]
      >`select id from donors where id = ${input.donorId}::uuid`;
      if (!donors[0]) throw new AppError(404, 'DONOR_NOT_FOUND', 'Donor tidak ditemukan');
      const species = await this.speciesFor(tx, input.speciesCode);
      if (!species.active) throw new AppError(400, 'SPECIES_INACTIVE', 'Species tidak aktif');
      const tierCode = input.tierCode ?? species.default_tier_code;

      const slug = `aqr-${randomBytes(9).toString('base64url')}`;
      await tx`insert into aquariums (donor_id, public_slug) values (${input.donorId}::uuid, ${slug})
               on conflict (donor_id) do nothing`;
      const aquarium = (
        await tx<{ id: string }[]>`select id from aquariums where donor_id = ${input.donorId}::uuid`
      )[0];
      if (!aquarium)
        throw new AppError(500, 'AQUARIUM_CREATE_FAILED', 'Aquarium tidak dapat dibuat');

      const created = await tx<{ id: string }[]>`
        insert into fish (aquarium_id, tier_code, species_code, display_name, color_code, accessory_code)
        values (${aquarium.id}::uuid, ${tierCode}, ${species.code}, ${input.displayName ?? null},
                ${input.colorCode}, ${input.accessoryCode})
        returning id`;
      const fishId = created[0]?.id;
      if (!fishId) throw new AppError(500, 'FISH_CREATE_FAILED', 'Fish tidak dapat dibuat');

      await this.gameEvent(tx, aquarium.id, fishId, 'fish.created', {
        tierCode,
        speciesCode: species.code,
        source: 'admin',
      });
      const fish = await this.getFish(fishId, now, tx);
      await this.audit(tx, actor, 'fish.create', 'fish', fishId, { after: fish }, input.reason);
      return fish;
    });
  }

  public async updateFish(id: string, input: FishUpdateInput, actor: AdminActor, now: Date) {
    return this.sql.begin(async (tx) => {
      const before = await this.getFish(id, now, tx);
      await tx`select id from fish where id = ${id}::uuid for update`;

      const speciesCode = input.speciesCode ?? before.species.code;
      if (input.speciesCode) await this.speciesFor(tx, input.speciesCode);
      const nowIso = now.toISOString();
      await tx`
        update fish set
          display_name = ${input.displayName === undefined ? before.displayName : input.displayName},
          tier_code = ${input.tierCode ?? before.tierCode},
          species_code = ${speciesCode},
          color_code = ${input.colorCode ?? before.colorCode},
          accessory_code = ${input.accessoryCode ?? before.accessoryCode},
          is_active = ${input.isActive ?? before.isActive},
          ${
            input.hunger === undefined
              ? tx``
              : tx`hunger = ${input.hunger}, last_fed_at = ${nowIso}::timestamptz,`
          }
          updated_at = ${nowIso}::timestamptz
        where id = ${id}::uuid`;
      const after = await this.getFish(id, now, tx);

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const compare: Array<[string, unknown, unknown]> = [
        ['displayName', before.displayName, after.displayName],
        ['tierCode', before.tierCode, after.tierCode],
        ['speciesCode', before.species.code, after.species.code],
        ['colorCode', before.colorCode, after.colorCode],
        ['accessoryCode', before.accessoryCode, after.accessoryCode],
        ['isActive', before.isActive, after.isActive],
      ];
      for (const [key, from, to] of compare) if (from !== to) changes[key] = { from, to };
      if (input.hunger !== undefined) changes.hunger = { from: before.hunger, to: input.hunger };

      // Emit the same event types the Unity client already understands.
      const aquariumId = after.aquariumId;
      if (changes.isActive) {
        await this.gameEvent(
          tx,
          aquariumId,
          id,
          after.isActive ? 'fish.reactivated' : 'fish.deactivated',
          {
            reason: 'admin',
          },
        );
      }
      if (changes.tierCode || changes.speciesCode) {
        await this.gameEvent(tx, aquariumId, id, 'fish.tier_changed', {
          tierCode: after.tierCode,
          speciesCode: after.species.code,
          source: 'admin',
        });
      }
      if (changes.colorCode || changes.accessoryCode || changes.displayName) {
        await this.gameEvent(tx, aquariumId, id, 'fish.customized', {
          colorCode: after.colorCode,
          accessoryCode: after.accessoryCode,
          source: 'admin',
        });
      }
      if (changes.hunger) {
        await this.gameEvent(tx, aquariumId, id, 'fish.fed', {
          hunger: input.hunger,
          source: 'admin',
        });
      }

      await this.audit(tx, actor, 'fish.update', 'fish', id, changes, input.reason);
      return after;
    });
  }

  // ----------------------------------------------------------------- donors
  public async listDonors(query: DonorListQuery) {
    const sql = this.sql;
    const search = query.search ? `%${query.search.replace(/[%_\\]/g, '\\$&')}%` : null;
    const where = sql`
      where true
      ${query.source === 'nik' ? sql`and d.nik is not null` : query.source === 'webhook' ? sql`and d.nik is null` : sql``}
      ${
        search
          ? sql`and (d.display_name ilike ${search} or a.public_slug ilike ${search}
                 or d.nik = ${query.search ?? ''} or d.id::text = ${query.search ?? ''})`
          : sql``
      }`;
    const offset = (query.page - 1) * query.pageSize;
    const [rows, counts] = await Promise.all([
      sql<
        {
          id: string;
          display_name: string | null;
          nik: string | null;
          show_name_publicly: boolean;
          total_donation: string;
          tier: string | null;
          last_synced_at: Date | string | null;
          created_at: Date | string;
          public_slug: string | null;
          active_fish: number;
          points: number | null;
        }[]
      >`
        select d.id, d.display_name, d.nik, d.show_name_publicly, d.total_donation::text, d.tier,
               d.last_synced_at, d.created_at, a.public_slug,
               (select count(*)::int from fish f where f.aquarium_id = a.id and f.is_active) as active_fish,
               i.points
        from donors d
        left join aquariums a on a.donor_id = d.id
        left join player_inventory i on i.donor_id = d.id
        ${where}
        order by d.created_at desc limit ${query.pageSize} offset ${offset}`,
      sql<{ total: number }[]>`
        select count(*)::int as total from donors d left join aquariums a on a.donor_id = d.id ${where}`,
    ]);
    return pageOf(
      rows.map((row) => ({
        id: row.id,
        name: row.display_name,
        nikMasked: maskNik(row.nik),
        source: row.nik ? 'nik' : 'webhook',
        showNamePublicly: row.show_name_publicly,
        totalDonation: Number(row.total_donation),
        tierCode: row.tier,
        publicSlug: row.public_slug,
        activeFish: row.active_fish,
        points: row.points ?? 0,
        lastSyncedAt: iso(row.last_synced_at),
        createdAt: iso(row.created_at),
      })),
      counts[0]?.total ?? 0,
      query.page,
      query.pageSize,
    );
  }

  public async getDonor(id: string, now: Date, db: Db = this.sql) {
    const rows = await db<
      {
        id: string;
        display_name: string | null;
        nik: string | null;
        show_name_publicly: boolean;
        total_donation: string;
        tier: string | null;
        last_synced_at: Date | string | null;
        created_at: Date | string;
        aquarium_id: string | null;
        public_slug: string | null;
        points: number | null;
        owned_accessories: string[] | string | null;
      }[]
    >`
      select d.id, d.display_name, d.nik, d.show_name_publicly, d.total_donation::text, d.tier,
             d.last_synced_at, d.created_at, a.id as aquarium_id, a.public_slug,
             i.points, i.owned_accessories
      from donors d
      left join aquariums a on a.donor_id = d.id
      left join player_inventory i on i.donor_id = d.id
      where d.id = ${id}::uuid`;
    const donor = rows[0];
    if (!donor) throw new AppError(404, 'DONOR_NOT_FOUND', 'Donor tidak ditemukan');

    const [fishRows, donations] = await Promise.all([
      donor.aquarium_id
        ? db<FishRow[]>`${this.fishSelect(db)} where f.aquarium_id = ${donor.aquarium_id}::uuid
                        order by f.created_at desc`
        : Promise.resolve([] as FishRow[]),
      db<
        {
          id: string;
          amount: string;
          currency: string;
          status: string;
          donated_at: Date | string;
        }[]
      >`
        select id, amount::text, currency, status::text, donated_at from donations
        where donor_id = ${id}::uuid order by donated_at desc limit 20`,
    ]);
    const owned =
      typeof donor.owned_accessories === 'string'
        ? (JSON.parse(donor.owned_accessories) as string[])
        : (donor.owned_accessories ?? []);

    return {
      id: donor.id,
      name: donor.display_name,
      nikMasked: maskNik(donor.nik),
      source: donor.nik ? 'nik' : 'webhook',
      canResync: donor.nik !== null,
      showNamePublicly: donor.show_name_publicly,
      totalDonation: Number(donor.total_donation),
      tierCode: donor.tier,
      lastSyncedAt: iso(donor.last_synced_at),
      createdAt: iso(donor.created_at),
      aquarium: donor.aquarium_id ? { id: donor.aquarium_id, publicSlug: donor.public_slug } : null,
      inventory: { points: donor.points ?? 0, ownedAccessories: owned },
      fish: fishRows.map((row) => toAdminFish(row, now)),
      donations: donations.map((row) => ({
        id: row.id,
        amount: Number(row.amount),
        currency: row.currency,
        status: row.status,
        donatedAt: iso(row.donated_at),
      })),
    };
  }

  /** Returns the raw NIK only for the server-side re-sync, never to the browser. */
  public async donorNik(id: string): Promise<string> {
    const rows = await this.sql<
      { nik: string | null }[]
    >`select nik from donors where id = ${id}::uuid`;
    if (!rows[0]) throw new AppError(404, 'DONOR_NOT_FOUND', 'Donor tidak ditemukan');
    if (!rows[0].nik) {
      throw new AppError(
        409,
        'DONOR_HAS_NO_NIK',
        'Donor ini berasal dari webhook dan tidak memiliki NIK',
      );
    }
    return rows[0].nik;
  }

  public async updateDonor(id: string, input: DonorUpdateInput, actor: AdminActor, now: Date) {
    return this.sql.begin(async (tx) => {
      const before = await this.getDonor(id, now, tx);
      await tx`
        update donors set
          display_name = ${input.displayName ?? before.name},
          show_name_publicly = ${input.showNamePublicly ?? before.showNamePublicly},
          updated_at = ${now.toISOString()}::timestamptz
        where id = ${id}::uuid`;
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (input.displayName !== undefined && input.displayName !== before.name)
        changes.displayName = { from: before.name, to: input.displayName };
      if (
        input.showNamePublicly !== undefined &&
        input.showNamePublicly !== before.showNamePublicly
      )
        changes.showNamePublicly = { from: before.showNamePublicly, to: input.showNamePublicly };
      await this.audit(tx, actor, 'donor.update', 'donor', id, changes, input.reason);
      return this.getDonor(id, now, tx);
    });
  }

  public async updateInventory(
    id: string,
    input: InventoryUpdateInput,
    actor: AdminActor,
    now: Date,
  ) {
    return this.sql.begin(async (tx) => {
      const donors = await tx<{ id: string }[]>`select id from donors where id = ${id}::uuid`;
      if (!donors[0]) throw new AppError(404, 'DONOR_NOT_FOUND', 'Donor tidak ditemukan');
      await tx`insert into player_inventory (donor_id) values (${id}::uuid) on conflict (donor_id) do nothing`;
      const rows = await tx<{ points: number; owned_accessories: string[] | string }[]>`
        select points, owned_accessories from player_inventory where donor_id = ${id}::uuid for update`;
      const current = rows[0];
      if (!current)
        throw new AppError(500, 'INVENTORY_UNAVAILABLE', 'Inventory tidak dapat dibaca');
      const owned: string[] =
        typeof current.owned_accessories === 'string'
          ? (JSON.parse(current.owned_accessories) as string[])
          : current.owned_accessories;

      const points = current.points + (input.pointsDelta ?? 0);
      if (points < 0) {
        throw new AppError(
          409,
          'POINTS_WOULD_BE_NEGATIVE',
          `Poin tidak cukup (saat ini ${current.points})`,
        );
      }
      if (points > 2_147_483_647) throw new AppError(400, 'POINTS_TOO_LARGE', 'Poin terlalu besar');
      const revoke = new Set(input.revokeAccessories ?? []);
      const nextOwned = [...new Set([...owned, ...(input.grantAccessories ?? [])])].filter(
        (code) => !revoke.has(code as never),
      );

      await tx`
        update player_inventory set points = ${points},
          owned_accessories = ${JSON.stringify(nextOwned)}::jsonb,
          updated_at = ${now.toISOString()}::timestamptz
        where donor_id = ${id}::uuid`;
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (points !== current.points) changes.points = { from: current.points, to: points };
      if (JSON.stringify(nextOwned) !== JSON.stringify(owned)) {
        changes.ownedAccessories = { from: owned, to: nextOwned };
      }
      await this.audit(tx, actor, 'inventory.update', 'inventory', id, changes, input.reason);
      return { points, ownedAccessories: nextOwned };
    });
  }

  // ------------------------------------------------------------------ audit
  public async recordAudit(
    actor: AdminActor,
    action: string,
    targetType: string,
    targetId: string,
    changes: Record<string, unknown>,
    reason?: string,
  ) {
    await this.audit(this.sql, actor, action, targetType, targetId, changes, reason);
  }

  public async listAudit(query: AuditQuery) {
    const sql = this.sql;
    const where = sql`
      where true
      ${query.targetType ? sql`and target_type = ${query.targetType}` : sql``}
      ${query.targetId ? sql`and target_id = ${query.targetId}` : sql``}`;
    const offset = (query.page - 1) * query.pageSize;
    const [rows, counts] = await Promise.all([
      sql<
        {
          id: string;
          action: string;
          target_type: string;
          target_id: string;
          changes: Record<string, unknown> | string;
          reason: string | null;
          actor_ip: string | null;
          created_at: Date | string;
        }[]
      >`select id::text, action, target_type, target_id, changes, reason, actor_ip, created_at
        from admin_audit_log ${where} order by admin_audit_log.id desc limit ${query.pageSize} offset ${offset}`,
      sql<{ total: number }[]>`select count(*)::int as total from admin_audit_log ${where}`,
    ]);
    return pageOf(
      rows.map((row) => ({
        id: Number(row.id),
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        changes:
          typeof row.changes === 'string'
            ? (JSON.parse(row.changes) as Record<string, unknown>)
            : row.changes,
        reason: row.reason,
        actorIp: row.actor_ip,
        createdAt: iso(row.created_at),
      })),
      counts[0]?.total ?? 0,
      query.page,
      query.pageSize,
    );
  }

  private async audit(
    db: Db,
    actor: AdminActor,
    action: string,
    targetType: string,
    targetId: string,
    changes: Record<string, unknown>,
    reason?: string,
  ) {
    await db`
      insert into admin_audit_log (action, target_type, target_id, changes, reason, actor_ip)
      values (${action}, ${targetType}, ${targetId}, ${JSON.stringify(changes)}::jsonb,
              ${reason && reason.length > 0 ? reason : null}, ${actor.ip})`;
  }

  private async gameEvent(
    db: Db,
    aquariumId: string,
    fishId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ) {
    await db`
      insert into game_events (aquarium_id, fish_id, event_type, payload)
      values (${aquariumId}::uuid, ${fishId}::uuid, ${eventType}, ${JSON.stringify(payload)}::jsonb)`;
  }
}
