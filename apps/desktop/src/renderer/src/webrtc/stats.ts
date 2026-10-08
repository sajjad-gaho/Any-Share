/**
 * Connection statistics from RTCPeerConnection.getStats(), reduced to what
 * the viewer shows and the host's adaptive quality needs. Nothing is stored.
 */
import { lossBetween } from '@remote-desktop/webrtc';

export interface SessionStats {
  rttMs: number | null;
  lossRate: number | null;
  bitrateKbps: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  /** 'relay' when traffic goes through TURN. */
  candidateType: string | null;
}

interface Counters {
  at: number;
  bytes: number;
  packetsLost: number;
  packetsReceived: number;
}

type Report = Record<string, unknown> & { type: string; id: string };

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Whether a candidate goes through TURN. Chrome can report a relayed local
 * candidate as `prflx` (learned from a peer's check before its own gathering
 * finished) while still giving the TURN `relayProtocol` / `url`.
 */
function isRelayed(candidate: Report | undefined): boolean {
  if (!candidate) return false;
  if (candidate['candidateType'] === 'relay') return true;
  const url = candidate['url'];
  return (
    typeof candidate['relayProtocol'] === 'string' ||
    (typeof url === 'string' && /^turns?:/.test(url))
  );
}

/** Shared: RTT and candidate type of the selected ICE candidate pair. */
function selectedPair(reports: Report[]): { rttMs: number | null; candidateType: string | null } {
  const transport = reports.find((r) => r.type === 'transport');
  const pairId = transport?.['selectedCandidatePairId'];
  const pair =
    reports.find((r) => r.type === 'candidate-pair' && r.id === pairId) ??
    reports.find(
      (r) => r.type === 'candidate-pair' && r['nominated'] === true && r['state'] === 'succeeded',
    );
  const rtt = num(pair?.['currentRoundTripTime']);
  const local = reports.find((r) => r.id === pair?.['localCandidateId']);
  const remote = reports.find((r) => r.id === pair?.['remoteCandidateId']);
  // Either side relaying means the media path goes through TURN.
  const candidateType =
    isRelayed(local) || isRelayed(remote)
      ? 'relay'
      : typeof local?.['candidateType'] === 'string'
        ? (local['candidateType'] as string)
        : null;
  return { rttMs: rtt === null ? null : Math.round(rtt * 1000), candidateType };
}

/** Controller side: what is being received. */
export class InboundStatsTracker {
  private previous: Counters | null = null;

  async sample(pc: RTCPeerConnection): Promise<SessionStats> {
    const reports = [...(await pc.getStats()).values()] as Report[];
    const inbound = reports.find((r) => r.type === 'inbound-rtp' && r['kind'] === 'video');
    const { rttMs, candidateType } = selectedPair(reports);
    const now = performance.now();
    const current: Counters = {
      at: now,
      bytes: num(inbound?.['bytesReceived']) ?? 0,
      packetsLost: num(inbound?.['packetsLost']) ?? 0,
      packetsReceived: num(inbound?.['packetsReceived']) ?? 0,
    };
    const previous = this.previous;
    this.previous = current;
    const seconds = previous ? (now - previous.at) / 1000 : 0;
    return {
      rttMs,
      lossRate: lossBetween(previous, current),
      bitrateKbps:
        previous && seconds > 0
          ? Math.round(((current.bytes - previous.bytes) * 8) / seconds / 1000)
          : null,
      fps: num(inbound?.['framesPerSecond']),
      width: num(inbound?.['frameWidth']),
      height: num(inbound?.['frameHeight']),
      candidateType,
    };
  }
}

/** Host side: RTT and loss as reported back by the receiver (RTCP). */
export class OutboundStatsTracker {
  async sample(pc: RTCPeerConnection): Promise<SessionStats> {
    const reports = [...(await pc.getStats()).values()] as Report[];
    const outbound = reports.find((r) => r.type === 'outbound-rtp' && r['kind'] === 'video');
    const remote = reports.find((r) => r.type === 'remote-inbound-rtp' && r['kind'] === 'video');
    const pair = selectedPair(reports);
    const remoteRtt = num(remote?.['roundTripTime']);
    return {
      rttMs: remoteRtt !== null ? Math.round(remoteRtt * 1000) : pair.rttMs,
      lossRate: num(remote?.['fractionLost']),
      bitrateKbps: null,
      fps: num(outbound?.['framesPerSecond']),
      width: num(outbound?.['frameWidth']),
      height: num(outbound?.['frameHeight']),
      candidateType: pair.candidateType,
    };
  }
}
