import { describe, expect, it } from 'vitest';
import { InboundStatsTracker, OutboundStatsTracker } from './stats';

type Report = Record<string, unknown> & { type: string; id: string };

function fakePc(local: Partial<Report>, remote: Partial<Report>): RTCPeerConnection {
  const reports: Report[] = [
    { type: 'transport', id: 'T', selectedCandidatePairId: 'P' },
    {
      type: 'candidate-pair',
      id: 'P',
      localCandidateId: 'L',
      remoteCandidateId: 'R',
      currentRoundTripTime: 0.012,
    },
    { type: 'local-candidate', id: 'L', ...local },
    { type: 'remote-candidate', id: 'R', ...remote },
  ];
  const map = new Map(reports.map((r) => [r.id, r]));
  return { getStats: async () => map } as unknown as RTCPeerConnection;
}

describe('stats: TURN detection', () => {
  it('reports a direct connection by its candidate type', async () => {
    const stats = await new InboundStatsTracker().sample(
      fakePc({ candidateType: 'host' }, { candidateType: 'host' }),
    );
    expect(stats.candidateType).toBe('host');
    expect(stats.rttMs).toBe(12);
  });

  it('reports a relay candidate as relay', async () => {
    const stats = await new InboundStatsTracker().sample(
      fakePc({ candidateType: 'relay' }, { candidateType: 'host' }),
    );
    expect(stats.candidateType).toBe('relay');
  });

  it('treats a TURN-allocated prflx candidate as relay', async () => {
    // Seen live with Chrome: the relayed local candidate is reported as prflx.
    const stats = await new InboundStatsTracker().sample(
      fakePc(
        { candidateType: 'prflx', relayProtocol: 'udp', url: 'turn:127.0.0.1:3478?transport=udp' },
        { candidateType: 'host' },
      ),
    );
    expect(stats.candidateType).toBe('relay');
  });

  it('reports relay when only the remote side relays', async () => {
    const stats = await new OutboundStatsTracker().sample(
      fakePc({ candidateType: 'host' }, { candidateType: 'relay' }),
    );
    expect(stats.candidateType).toBe('relay');
  });

  it('does not mistake a STUN url for a relay', async () => {
    const stats = await new InboundStatsTracker().sample(
      fakePc({ candidateType: 'srflx', url: 'stun:127.0.0.1:3478' }, { candidateType: 'host' }),
    );
    expect(stats.candidateType).toBe('srflx');
  });
});
