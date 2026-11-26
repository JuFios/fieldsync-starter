import { InitialSchema1795564800000 } from './1795564800000-initial-schema';
import { MutationResults1795651200000 } from './1795651200000-mutation-results';
import { LogHead1795737600000 } from './1795737600000-log-head';
import { PartTicketIndex1795824000000 } from './1795824000000-part-ticket-index';
import { DeleteOrphanParts1795910400000 } from './1795910400000-delete-orphan-parts';

/** All migrations, oldest first. Listed explicitly so the build output needs no file globbing. */
export const MIGRATIONS = [
  InitialSchema1795564800000,
  MutationResults1795651200000,
  LogHead1795737600000,
  PartTicketIndex1795824000000,
  DeleteOrphanParts1795910400000,
];
