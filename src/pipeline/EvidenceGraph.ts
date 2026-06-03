import { ReasonCode } from '../types';
import { Evidence } from './types';

export class EvidenceGraph {
  private items: Evidence[] = [];

  add(evidence: Evidence): void {
    this.items.push(evidence);
  }

  getBySource(source: string): Evidence[] {
    return this.items.filter((e) => e.source === source);
  }

  getBySubject(subject: string): Evidence[] {
    return this.items.filter((e) => e.subject === subject);
  }

  getAll(): Evidence[] {
    return [...this.items];
  }

  block(claimId: string, reason: ReasonCode): void {
    for (const item of this.items) {
      if (item.claimId === claimId) {
        item.blocked = true;
        item.blockReason = reason;
      }
    }
  }
}
