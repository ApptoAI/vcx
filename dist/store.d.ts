export declare const STORE_VERSION: 2;
export declare const STORE_FILENAME = "profiles.json";
export declare const LEGACY_STORE_FILENAME = "credentials.json";
export declare const PROFILE_NAME_PATTERN: RegExp;
export interface Profile {
    username?: string;
    createdAt: string;
    updatedAt: string;
}
export interface StoreV2 {
    version: typeof STORE_VERSION;
    activeProfile: string | null;
    profiles: Record<string, Profile>;
}
export declare class StoreError extends Error {
    name: string;
}
export declare function emptyStore(): StoreV2;
export declare function getConfigDir(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string): string;
export declare function getStorePath(configDir?: string): string;
export declare function getLegacyStorePath(configDir?: string): string;
export declare function getProfilesDir(configDir?: string): string;
export declare function getProfileDir(name: string, configDir?: string): string;
export declare function assertProfileName(name: string): void;
export declare function ensureConfigDir(configDir?: string): Promise<void>;
export declare function readStore(configDir?: string): Promise<StoreV2>;
export declare function writeStore(store: StoreV2, configDir?: string): Promise<void>;
export declare function createStagedProfileDir(configDir?: string, label?: string): Promise<string>;
export declare function writeTokenAuth(profileDir: string, token: string): Promise<void>;
export declare function installStagedProfile(stagedDir: string, name: string, configDir?: string, commit?: () => Promise<void>): Promise<void>;
export declare function removeProfileData(name: string, configDir?: string, commit?: () => Promise<void>): Promise<void>;
export declare function withStoreLock<T>(configDir: string, callback: () => Promise<T>): Promise<T>;
//# sourceMappingURL=store.d.ts.map