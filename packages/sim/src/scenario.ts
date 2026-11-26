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

const WRENCH = '\u{1F527}';

/**
 * Text a user may type, mostly plain but also non-ASCII, emoji (surrogate pairs) and lengths at the
 * limits: a title of exactly `max` UTF-16 units ending in an emoji, a description longer than its
 * limit with an emoji across the cut. With `invalid`, sometimes text the server must reject: empty,
 * one unit too long, a NUL character or an unpaired surrogate.
 */
function text(random: Random, field: 'title' | 'description' | 'name', invalid: boolean): string {
  const max = field === 'title' ? 200 : field === 'name' ? 100 : 5000;
  const words = field === 'name' ? ['Seal', 'Bearing', 'Filter', 'Fuse'] : ['Pump', 'Valve', 'Belt', 'Motor', 'Sensor'];
  const variant = random.weighted({ plain: 80, unicode: 12, limit: 5, invalid: invalid ? 3 : 0 });
  switch (variant) {
    case 'plain':
      return `${random.pick(words)} ${random.hex(3)}`;
    case 'unicode':
      return `${random.pick(['Насос', 'Ventil ü', '泵', 'Ćwiek', 'e\u0301'])} ${WRENCH} ${random.hex(2)}`;
    case 'limit':
      // Description: longer than the limit, the emoji's halves on both sides of the cut. Otherwise:
      // exactly the limit, the emoji in the last two units.
      return field === 'description' ? `${'x'.repeat(max - 1)}${WRENCH}tail` : `${'x'.repeat(max - 2)}${WRENCH}`;
    case 'invalid':
      return random.pick(['', 'x'.repeat(max + 1), 'pump\u0000room', 'pump \ud83d']);
  }
}

/**
 * A row to act on. Users of one site mostly work on the same few open jobs, so most picks come from
 * a small "hot" set (the rows with the lowest ids, the same set on every client that has them);
 * that is what makes clients write the same rows concurrently.
 */
function pickRow(rows: readonly Row[], random: Random): Row | undefined {
  if (rows.length === 0) return undefined;
  const byId = [...rows].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
  return random.chance(0.75) ? random.pick(byId.slice(0, 2)) : random.pick(byId);
}

/**
 * Turns an action kind into a concrete mutation, as a user of the client would produce it from what
 * the client shows. Users act only on rows of sites they can access. When there is nothing to act
 * on (no ticket to edit yet), the user creates a ticket instead.
 */
export function generateAction(kind: ActionKind, view: ActorView, random: Random, invalidText = false): Action {
  const title = () => text(random, 'title', invalidText);
  const description = () => (random.chance(0.3) ? text(random, 'description', invalidText) : '');
  const ticket = pickRow(view.tickets, random);
  const part = pickRow(view.parts, random);
  const create = (): Action => ({
    name: 'ticket.create',
    args: {
      id: random.uuid(),
      siteId: random.pick(view.sites),
      title: title(),
      description: description(),
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
          title: title(),
          description: random.chance(0.5) ? description() : ticket.description,
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
          name: text(random, 'name', invalidText),
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
