import type { ArchitectureCapabilitiesRow } from '@features/generation/core/architectureCapabilities';

import { apiFetchJson } from '@platform/transport/http';

/**
 * The architecture capability table.
 *
 * A static list -- the same for every install and every user -- describing what each model
 * architecture supports. Lives under the model-manager router because that is where architectures
 * are addressed, but it is not model-record data: nothing here depends on what is installed.
 */
const CAPABILITIES_PATH = '/api/v2/models/capabilities';

export const getArchitectureCapabilities = (signal?: AbortSignal): Promise<ArchitectureCapabilitiesRow[]> =>
  apiFetchJson<ArchitectureCapabilitiesRow[]>(CAPABILITIES_PATH, { signal });
