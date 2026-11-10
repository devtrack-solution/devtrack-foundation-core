export const FOUNDATION_API_MAJOR = 1;

export interface CapabilityContract {
  readonly id: string;
  readonly major: number;
}

export interface CapabilityRequirement extends CapabilityContract {
  /** The requirement is mandatory only when this declared feature is selected. */
  readonly whenFeature?: string;
}

export type ModuleOrigin =
  | { readonly kind: 'native' }
  | {
      readonly kind: 'npm';
      readonly packageName: string;
      readonly version: string;
      readonly integrity: string;
    };

/** Metadata only: no framework modules, executable factories or service instances. */
export interface ModuleDescriptor {
  readonly id: string;
  readonly foundationApiMajor: number;
  readonly origin: ModuleOrigin;
  readonly features?: readonly string[];
  readonly provides: readonly CapabilityContract[];
  readonly requires: readonly CapabilityRequirement[];
}

export interface ModuleSelection {
  readonly descriptor: ModuleDescriptor;
  readonly enabledFeatures?: readonly string[];
}

export interface CapabilityBinding {
  readonly consumerId: string;
  readonly capabilityId: string;
  readonly providerId: string;
}

export interface CompositionInput {
  /** Only modules selected for this composition; the source catalog is separate. */
  readonly modules: readonly ModuleSelection[];
  readonly bindings?: readonly CapabilityBinding[];
}

export interface ResolvedModuleSelection {
  readonly id: string;
  readonly enabledFeatures: readonly string[];
}

export interface ResolvedComposition {
  readonly foundationApiMajor: number;
  /** Providers precede their consumers. Independent modules sort by identifier. */
  readonly modules: readonly ResolvedModuleSelection[];
  /** IDs from the same ordered selection list, retained for existing consumers. */
  readonly orderedModuleIds: readonly string[];
  readonly bindings: readonly CapabilityBinding[];
}
