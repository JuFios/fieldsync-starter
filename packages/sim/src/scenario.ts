import { ALLOWED_TRANSITIONS, type MutatorName, type Row, type TicketStatus } from '@fieldsync/sync-core';
import type { ActionKind, Profile } from './profiles';
import type { Random } from './random';
import type { Fixtures, SimUser } from './types';

/** A concrete user action: the mutation a user's click produces. */
export interface Action {
  name: MutatorName;
  args: Record<string, unknown>;
}

/** Builds the sites and users of a profile with ids and tokens drawn from `random`. */
export function buildFixtures(profile: Profile, random: Random): Fixtures {
  const sites = Array.from({ length: profile.sites }, (_, i) => ({ id: random.uuid(), name: `Site ${i + 1}` }));
  const users: SimUser[] = profile.users.map((spec, i) => ({
    id: random.uuid(),
    name: `${spec.role} ${i + 1}`,
    role: spec.role,
    token: random.hex(24),
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

function title(random: Random): string {
  return `${random.pick(['Pump', 'Valve', 'Belt', 'Motor', 'Sensor', 'Panel'])} ${random.hex(3)}`;
}

/**
 * Turns an action kind into a concrete mutation, as a user of the client would produce it from what
 * the client shows. Users act only on rows of sites they can access. When there is nothing to act
 * on (no ticket to edit yet), the user creates a ticket instead.
 */
export function generateAction(kind: ActionKind, view: ActorView, random: Random): Action {
  const ticket = view.tickets.length > 0 ? random.pick(view.tickets) : undefined;
  const part = view.parts.length > 0 ? random.pick(view.parts) : undefined;
  const create = (): Action => ({
    name: 'ticket.create',
    args: {
      id: random.uuid(),
      siteId: random.pick(view.sites),
      title: title(random),
      description: random.chance(0.3) ? `Notes ${random.hex(4)}` : '',
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
          title: title(random),
          description: random.chance(0.5) ? `Notes ${random.hex(4)}` : ticket.description,
        },
      };
    case 'change-status': {
      if (!ticket) return create();
      const from = ticket.status as TicketStatus;
      const allowed = ALLOWED_TRANSITIONS[from];
      // Mostly what the UI offers; sometimes a transition it would not (an outdated screen).
      const to = allowed.length > 0 && random.chance(0.9) ? random.pick(allowed) : random.pick(STATUSES);
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
          id: random.uuid(),
          ticketId: ticket.id,
          siteId: ticket.siteId,
          name: random.pick(['Seal', 'Bearing', 'Filter', 'Fuse']),
          quantity: random.int(1, 3),
        },
      };
    case 'increase-part':
      if (!part) return create();
      return { name: 'part.adjust', args: { id: part.id, siteId: part.siteId, delta: random.int(1, 3) } };
    case 'adjust-part':
      if (!part) return create();
      return { name: 'part.adjust', args: { id: part.id, siteId: part.siteId, delta: random.int(-3, 3) } };
  }
}
