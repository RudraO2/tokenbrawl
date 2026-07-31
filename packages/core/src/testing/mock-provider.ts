import type { ProviderId } from '@tokenbrawl/contracts';
import type { ProviderClient, ProviderRequest, ProviderResponse } from '../deployment';

/**
 * A recording, scripted `ProviderClient`. Story 3.1 ships no real provider, and
 * even once E3 does, the Deployment path must stay testable without a network:
 * every assertion about what was *sent* (INV-4's cap, INV-7's Scaffold) needs
 * the request body, which only a fake can hand back.
 *
 * Test-only, and under `testing/` for the same reason the mock Agent and mock
 * Environment are: no shipped module may import it.
 */

export interface MockProviderClient extends ProviderClient {
  /** Every request `complete()` was handed, in call order -- what was actually sent, not a re-derived assumption. */
  readonly capturedRequests: () => readonly ProviderRequest[];
  readonly callCount: () => number;
}

export interface MockProviderConfig {
  readonly provider?: ProviderId;
  readonly endpoint?: string;
  readonly model?: string;
  /** Responses in call order. A bare string is shorthand for text with zero reported usage. */
  readonly script: readonly (string | ProviderResponse)[];
}

const DEFAULT_ENDPOINT = 'https://mock.invalid/openai/v1/chat/completions';

function toResponse(scripted: string | ProviderResponse): ProviderResponse {
  return typeof scripted === 'string'
    ? { text: scripted, usage: { tokensSpent: 0, reasoningTokens: null } }
    : scripted;
}

export function createMockProviderClient(config: MockProviderConfig): MockProviderClient {
  const provider: ProviderId = config.provider ?? 'groq';
  const endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
  const model = config.model ?? 'mock-model';

  const requests: ProviderRequest[] = [];

  return {
    provider,
    endpoint,
    model,

    capturedRequests: () => requests,
    callCount: () => requests.length,

    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      const index = requests.length;
      requests.push(request);

      if (index >= config.script.length) {
        throw new Error(
          `Mock provider "${provider}:${model}" exhausted its script after ${config.script.length} response(s).`,
        );
      }

      return toResponse(config.script[index]);
    },
  };
}
