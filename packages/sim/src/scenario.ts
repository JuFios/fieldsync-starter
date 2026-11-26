import { ALLOWED_TRANSITIONS, type MutatorName, type Row, type TicketStatus } from '@fieldsync/sync-core';
import type { ActionKind, Profile } from './profiles';
import type { Fixtures, SimUser } from './types';

/** A concrete user action: the mutation a user's click produces. */
export interface Action {
  name: MutatorName;
  args: Record<string, unknown>;
}

/**
 * The generated part of a user action. The rows a user acts on exist only once the run is under
 * way, so a command carries choices (which row, which status, what text) and {@link generateAction}
 * applies them to what the client shows when the command runs. Picks are taken modulo the number of
 * candidates, so they shrink towards the first candidate.
 */
export interface ActionParams {
  /** Act on one of the two "hot" rows (most picks: users of a site work on the same few jobs). */
  hot: boolean;
  pick: number;
  sitePick: number;
  title: string;
  description: string;
  /** When editing, keep the ticket's description instead of writing `description`. */
  keepDescription: boolean;
  /** Ask for a status the UI would not offer (an outdated screen) instead of an allowed one. */
  offScript: boolean;
  statusPick: number;
  partName: string;
  quantity: number;
  /** A positive adjustment (`increase-part`). */
  increase: number;
  /** Any adjustment, zero and negative included (`adjust-part`). */
  delta: number;
}

/** The id of the n-th object of a run (UUID version 4 layout), unique within the run. */
export function simUuid(kind: number, n: number): string {
  const hex = (n >>> 0).toString(16).padStart(12, '0');
  return `00000000-0000-4000-8${kind.toString(16).padStart(3, '0')}-${hex}`;
}

/**
 * The sites and users of a profile. Ids and tokens are derived from positions, not drawn at random:
 * they never matter to a scenario, and fixed values keep them out of the generated, shrunk input.
 */
export function buildFixtures(profile: Profile): Fixtures {
  const sites = Array.from({ length: profile.sites }, (_, i) => ({ id: simUuid(1, i + 1), name: `Site ${i + 1}` }));
  const users: SimUser[] = profile.users.map((spec, i) => ({
    id: simUuid(2, i + 1),
    name: `${spec.role} ${i + 1}`,
    role: spec.role,
    token: `sim-${profile.name}-user-${i + 1}`,
    sites:
      spec.role === 'admin'
        ? []
        : spec.sites.map((index) => {
            const site = sites[index];
            if (!site) throw new Error(`profile ${profile.name}: user ${i} names site ${index}, which does not exist`);
            return site.id;
          }),
  }));
  return { sites, users };
}

/** The sites a user may read and write: every site for an admin. Independent of the server's code. */
export function accessibleSites(user: SimUser, fixtures: Fixtures): ReadonlySet<string> {
  return new Set(user.role === 'admin' ? fixtures.sites.map((s) => s.id) : user.sites);
}

const STATUSES: readonly TicketStatus[] = ['open', 'in_progress', 'done', 'cancelled'];

/** What a user sees and may act on: the client's current view, limited to the user's sites. */
export interface ActorView {
  sites: readonly string[];
  tickets: readonly Row[];
  parts: readonly Row[];
}

const nth = <T>(items: readonly T[], pick: number): T => items[pick % items.length] as T;

/** The row to act on: rows are ordered by id, so the hot set is the same on every client that has it. */
function pickRow(rows: readonly Row[], params: ActionParams): Row | undefined {
  if (rows.length === 0) return undefined;
  const byId = [...rows].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
  return nth(params.hot ? byId.slice(0, 2) : byId, params.pick);
}

/**
 * Turns an action kind into a concrete mutation, as a user of the client would produce it from what
 * the client shows. Users act only on rows of sites they can access. When there is nothing to act
 * on (no ticket to edit yet), the user creates a ticket instead. `newId` is the id a new row gets,
 * as the client chooses it before the mutation.
 */
export function generateAction(kind: ActionKind, view: ActorView, params: ActionParams, newId: () => string): Action {
  const ticket = pickRow(view.tickets, params);
  const part = pickRow(view.parts, params);
  const create = (): Action => ({
    name: 'ticket.create',
    args: {
      id: newId(),
      siteId: nth(view.sites, params.sitePick),
      title: params.title,
      description: params.description,
    },
  });
  switch (kind) {
    case 'create-ticket':
      return create();
    case 'edit-ticket':
      if (!ticket) return create();
      return {
        name: 'ticket.update',
        args: {
          id: ticket.id,
          siteId: ticket.siteId,
          title: params.title,
          description: params.keepDescription ? ticket.description : params.description,
        },
      };
    case 'change-status': {
      if (!ticket) return create();
      const from = ticket.status as TicketStatus;
      const allowed = ALLOWED_TRANSITIONS[from];
      const to =
        allowed.length > 0 && !params.offScript ? nth(allowed, params.statusPick) : nth(STATUSES, params.statusPick);
      return { name: 'ticket.setStatus', args: { id: ticket.id, siteId: ticket.siteId, from, to } };
    }
    case 'delete-ticket':
      if (!ticket) return create();
      return { name: 'ticket.delete', args: { id: ticket.id, siteId: ticket.siteId } };
    case 'add-part':
      if (!ticket) return create();
      return {
        name: 'part.add',
        args: {
          id: newId(),
          ticketId: ticket.id,
          siteId: ticket.siteId,
          name: params.partName,
          quantity: params.quantity,
        },
      };
    case 'increase-part':
      if (!part) return create();
      return { name: 'part.adjust', args: { id: part.id, siteId: part.siteId, delta: params.increase } };
    case 'adjust-part':
      if (!part) return create();
      return { name: 'part.adjust', args: { id: part.id, siteId: part.siteId, delta: params.delta } };
  }
}
